//! Settings > Sync and the Library's PC tab on the phone: the pairing with one Komori PC (its
//! address, the certificate fingerprint it paired with, and the device token, kept in the
//! catalog's preferences), the PC's books and dictionaries, and their copies on the phone.
//!
//! A PC book opened here is downloaded into Komori's cache and imported like any other book;
//! only the one opened last stays there. Keep on this phone moves it into Komori's own storage.
//! Each copy keeps its catalog record (and so its reading state) for the PC's next sync, and is
//! listed only under the PC. Unpairing removes the PC's books from the phone.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::covers::CoverImage;
use crate::devices::{
    client::{Client, LinkError},
    protocol::{self, decode, encode, RemoteBook, RemoteDictionary},
};
use crate::dictionary::store::{import_pack, open_store, DictionaryStoreState, PackImport};
use crate::library::{open_catalog, storage_error, CatalogState};

const RECORD: &str = "pc-link";
const TRANSFER_EVENT: &str = "pc-transfer";
const PC_BOOKS: &str = "pc-books";
const PC_COVERS: &str = "pc-covers";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    address: String,
    port: u16,
    #[serde(default = "on")]
    sync_on: bool,
    pc_name: Option<String>,
    fingerprint: Option<String>,
    token: Option<String>,
    device_id: Option<String>,
}

fn on() -> bool {
    true
}

impl Default for Link {
    fn default() -> Self {
        Self {
            address: String::new(),
            port: protocol::DEFAULT_PORT,
            sync_on: true,
            pc_name: None,
            fingerprint: None,
            token: None,
            device_id: None,
        }
    }
}

impl Link {
    fn pinned(&self) -> Option<([u8; 32], Vec<u8>)> {
        let fingerprint = decode(self.fingerprint.as_deref()?)?.try_into().ok()?;
        Some((fingerprint, decode(self.token.as_deref()?)?))
    }

    fn client(&self) -> Result<Client, String> {
        let (fingerprint, token) = self.pinned().ok_or_else(|| LinkError::NotPaired.code())?;
        Client::new(&self.address, self.port, Some(fingerprint), Some(&token))
            .map_err(|error| error.code())
    }
}

/// Settings > Sync as the page shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    address: String,
    port: u16,
    paired: bool,
    pc_name: Option<String>,
    sync_on: bool,
}

impl From<&Link> for LinkView {
    fn from(link: &Link) -> Self {
        Self {
            address: link.address.clone(),
            port: link.port,
            paired: link.pinned().is_some(),
            pc_name: link.pc_name.clone(),
            sync_on: link.sync_on,
        }
    }
}

fn load(connection: &Connection) -> Result<Link, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [RECORD],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default())
}

fn save(connection: &Connection, link: &Link) -> Result<(), String> {
    let value = serde_json::to_string(link).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [RECORD, &value],
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn ensure_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS pc_books (
               book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
               pc_book TEXT NOT NULL UNIQUE,
               kept INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(storage_error)
}

/// The catalog IDs of the books that came from the PC, which This phone does not list.
pub(crate) fn pc_book_ids(connection: &Connection) -> HashSet<String> {
    connection
        .prepare("SELECT book_id FROM pc_books")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<HashSet<String>, _>>()
        })
        .unwrap_or_default()
}

struct Copy {
    book: String,
    source: String,
    kept: bool,
}

fn copy_of(connection: &Connection, pc_book: &str) -> Result<Option<Copy>, String> {
    ensure_table(connection)?;
    connection
        .query_row(
            "SELECT pc_books.book_id, books.source_path, pc_books.kept
               FROM pc_books JOIN books ON books.id = pc_books.book_id
              WHERE pc_books.pc_book = ?1",
            [pc_book],
            |row| {
                Ok(Copy {
                    book: row.get(0)?,
                    source: row.get(1)?,
                    kept: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)
}

fn catalog_path(catalog: &State<'_, CatalogState>) -> PathBuf {
    catalog.database.clone()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn read_link(database: &Path) -> Result<Link, String> {
    load(&open_catalog(database)?)
}

fn directory(app: &AppHandle, kept: bool) -> Result<PathBuf, String> {
    let root = if kept {
        app.path().app_data_dir()
    } else {
        app.path().app_cache_dir()
    };
    root.map(|root| root.join(PC_BOOKS))
        .map_err(|error| error.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Transfer<'a> {
    kind: &'a str,
    id: &'a str,
    received: u64,
    total: u64,
}

fn reporter<'a>(app: &'a AppHandle, kind: &'a str, id: &'a str) -> impl FnMut(u64, u64) + 'a {
    let mut shown = 0u64;
    move |received, total| {
        // About every 1% (and the first and last), so a large file sends a hundred events.
        let step = (total / 100).max(64 * 1024);
        if received == 0 || received >= total || received >= shown + step {
            shown = received;
            let _ = app.emit(
                TRANSFER_EVENT,
                Transfer {
                    kind,
                    id,
                    received,
                    total,
                },
            );
        }
    }
}

#[tauri::command]
pub async fn get_pc_link(catalog: State<'_, CatalogState>) -> Result<LinkView, String> {
    let database = catalog_path(&catalog);
    blocking(move || Ok(LinkView::from(&read_link(&database)?))).await
}

#[tauri::command]
pub async fn set_pc_sync(catalog: State<'_, CatalogState>, on: bool) -> Result<LinkView, String> {
    let database = catalog_path(&catalog);
    blocking(move || {
        let connection = open_catalog(&database)?;
        let mut link = load(&connection)?;
        link.sync_on = on;
        save(&connection, &link)?;
        Ok(LinkView::from(&link))
    })
    .await
}

/// Where the paired PC is now, when its address or port changed.
#[tauri::command]
pub async fn set_pc_address(
    catalog: State<'_, CatalogState>,
    address: String,
    port: u16,
) -> Result<LinkView, String> {
    let database = catalog_path(&catalog);
    blocking(move || {
        let connection = open_catalog(&database)?;
        let mut link = load(&connection)?;
        link.address = address.trim().to_owned();
        link.port = port;
        save(&connection, &link)?;
        Ok(LinkView::from(&link))
    })
    .await
}

/// Pairs with the PC at `address:port` using the code it shows.
#[tauri::command]
pub async fn pair_pc(
    catalog: State<'_, CatalogState>,
    address: String,
    port: u16,
    code: String,
) -> Result<LinkView, String> {
    let database = catalog_path(&catalog);
    let address = address.trim().to_owned();
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    {
        let (database, address) = (database.clone(), address.clone());
        blocking(move || {
            let connection = open_catalog(&database)?;
            let mut link = load(&connection)?;
            link.address = address;
            link.port = port;
            save(&connection, &link)
        })
        .await?;
    }
    if address.is_empty() || port == 0 {
        return Err(LinkError::Unreachable.code());
    }
    if code.len() != 6 {
        return Err(LinkError::WrongCode.code());
    }
    let device = crate::android::device_name().await;
    let pairing = Client::new(&address, port, None, None)
        .map_err(|error| error.code())?
        .pair(&code, &device)
        .await
        .map_err(|error| error.code())?;
    blocking(move || {
        let connection = open_catalog(&database)?;
        let mut link = load(&connection)?;
        link.pc_name = Some(pairing.pc_name);
        link.fingerprint = Some(encode(&pairing.fingerprint));
        link.token = Some(encode(&pairing.token));
        link.device_id = Some(pairing.device);
        link.sync_on = true;
        save(&connection, &link)?;
        Ok(LinkView::from(&link))
    })
    .await
}

/// Forgets the PC: tells it to forget this phone when it can, and removes its books here.
#[tauri::command]
pub async fn unpair_pc(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
) -> Result<LinkView, String> {
    let database = catalog_path(&catalog);
    let link = {
        let database = database.clone();
        blocking(move || read_link(&database)).await?
    };
    if let Ok(client) = link.client() {
        let _ = client.forget().await;
    }
    let roots = [directory(&app, false)?, directory(&app, true)?];
    let covers = app
        .path()
        .app_cache_dir()
        .map(|root| root.join(PC_COVERS))
        .ok();
    blocking(move || {
        let connection = open_catalog(&database)?;
        ensure_table(&connection)?;
        let books: Vec<String> = connection
            .prepare("SELECT book_id FROM pc_books")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()
            })
            .map_err(storage_error)?;
        for book in books {
            crate::library::remove_book_from_catalog(&connection, &book)?;
        }
        connection
            .execute("DELETE FROM pc_books", [])
            .map_err(storage_error)?;
        for root in roots.iter().chain(covers.iter()) {
            let _ = std::fs::remove_dir_all(root);
        }
        let link = Link {
            address: link.address,
            port: link.port,
            ..Link::default()
        };
        save(&connection, &link)?;
        Ok(LinkView::from(&link))
    })
    .await
    .inspect(|_| {
        let _ = app.emit(crate::book_details::DETAILS_EVENT, ());
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcStatus {
    /// `connected`, or why not: `unreachable`, `notThePc`, `notPaired`, `otherVersion`.
    status: String,
    name: Option<String>,
}

/// Whether the paired PC answers now, under the name it gives.
#[tauri::command]
pub async fn check_pc(catalog: State<'_, CatalogState>) -> Result<PcStatus, String> {
    let database = catalog_path(&catalog);
    let link = blocking(move || read_link(&database)).await?;
    let client = link.client()?;
    // The library needs the token, so a PC that forgot this phone says so.
    let checked = async {
        let hello = client.hello().await?;
        client.library().await.map(|_| hello)
    };
    Ok(match checked.await {
        Ok(hello) => PcStatus {
            status: "connected".into(),
            name: Some(hello.name),
        },
        Err(error) => PcStatus {
            status: error.code(),
            name: link.pc_name,
        },
    })
}

/// A PC book with its copy on this phone, if any.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcBook {
    #[serde(flatten)]
    book: RemoteBook,
    cover_url: Option<String>,
    /// The copy's catalog ID, when the phone has its record.
    local_id: Option<String>,
    /// Whether the copy's file is on the phone now.
    on_phone: bool,
    kept: bool,
}

#[tauri::command]
pub async fn list_pc_library(catalog: State<'_, CatalogState>) -> Result<Vec<PcBook>, String> {
    let database = catalog_path(&catalog);
    let link = {
        let database = database.clone();
        blocking(move || read_link(&database)).await?
    };
    let library = link
        .client()?
        .library()
        .await
        .map_err(|error| error.code())?;
    blocking(move || {
        let connection = open_catalog(&database)?;
        library
            .books
            .into_iter()
            .map(|book| {
                let copy = copy_of(&connection, &book.id)?;
                Ok(PcBook {
                    cover_url: book
                        .cover
                        .map(|revision| crate::covers::pc_cover_url(&book.id, revision)),
                    on_phone: copy
                        .as_ref()
                        .is_some_and(|copy| Path::new(&copy.source).is_file()),
                    kept: copy.as_ref().is_some_and(|copy| copy.kept),
                    local_id: copy.map(|copy| copy.book),
                    book,
                })
            })
            .collect()
    })
    .await
}

/// Downloads the PC's book (unless its copy is already here) into the cache, or Komori's own
/// storage when `kept`, and returns its catalog ID.
async fn fetch_book(
    app: &AppHandle,
    database: &Path,
    id: &str,
    file_name: &str,
    kept: bool,
) -> Result<String, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(LinkError::NotFound.code());
    }
    let (link, copy) = {
        let (database, id) = (database.to_owned(), id.to_owned());
        blocking(move || {
            let connection = open_catalog(&database)?;
            Ok((load(&connection)?, copy_of(&connection, &id)?))
        })
        .await?
    };
    let target = directory(app, kept)?
        .join(id)
        .join(crate::devices::client::safe_file_name(file_name));
    if let Some(copy) = &copy {
        let current = Path::new(&copy.source);
        if current.is_file() {
            if copy.kept || !kept {
                return Ok(copy.book.clone());
            }
            // Keep on this phone: the cached copy moves into Komori's own storage.
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            if std::fs::rename(current, &target).is_err() {
                std::fs::copy(current, &target).map_err(|error| error.to_string())?;
                let _ = std::fs::remove_file(current);
            }
            if let Some(parent) = current.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    if !target.is_file() {
        let client = link.client()?;
        client
            .download(
                &format!("/v1/books/{id}/file"),
                &target,
                reporter(app, "book", id),
            )
            .await
            .map_err(|error| error.code())?;
    }
    let (database, id) = (database.to_owned(), id.to_owned());
    let cache = directory(app, false)?;
    blocking(move || {
        let mut connection = open_catalog(&database)?;
        ensure_table(&connection)?;
        let book = match copy {
            // The copy keeps its record, and so its reading state; only its file moved.
            Some(copy) => {
                let source = target.canonicalize().map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "UPDATE books SET source_path = ?2 WHERE id = ?1",
                        params![copy.book, source.to_string_lossy()],
                    )
                    .map_err(storage_error)?;
                copy.book
            }
            None => crate::library::import_file(&mut connection, &target)?,
        };
        connection
            .execute(
                "INSERT INTO pc_books (book_id, pc_book, kept) VALUES (?1, ?2, ?3)
                 ON CONFLICT(book_id) DO UPDATE SET kept = excluded.kept",
                params![book, id, kept],
            )
            .map_err(storage_error)?;
        if !kept {
            forget_cached(&connection, &cache, &book)?;
        }
        Ok(book)
    })
    .await
}

/// Removes the cached files of every PC book but `except`; their records stay.
fn forget_cached(connection: &Connection, cache: &Path, except: &str) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT books.source_path FROM pc_books JOIN books ON books.id = pc_books.book_id
              WHERE pc_books.kept = 0 AND pc_books.book_id <> ?1",
        )
        .map_err(storage_error)?;
    let sources = statement
        .query_map([except], |row| row.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let cache = cache.canonicalize().unwrap_or_else(|_| cache.to_owned());
    for source in sources {
        let source = Path::new(&source);
        if source.starts_with(&cache) {
            let _ = std::fs::remove_file(source);
            if let Some(parent) = source.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    Ok(())
}

/// Opens the PC's book on the phone, downloading it first unless it is here.
#[tauri::command]
pub async fn open_pc_book(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    id: String,
    file_name: String,
) -> Result<String, String> {
    fetch_book(&app, &catalog_path(&catalog), &id, &file_name, false).await
}

/// Keeps the PC's book in Komori's own storage on the phone.
#[tauri::command]
pub async fn keep_pc_book(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    id: String,
    file_name: String,
) -> Result<String, String> {
    fetch_book(&app, &catalog_path(&catalog), &id, &file_name, true).await
}

/// Removes the PC book's file from the phone; its record stays for the PC's next sync.
#[tauri::command]
pub async fn remove_pc_book(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<(), String> {
    let database = catalog_path(&catalog);
    let roots = [directory(&app, false)?, directory(&app, true)?];
    blocking(move || {
        let connection = open_catalog(&database)?;
        let Some(copy) = copy_of(&connection, &id)? else {
            return Ok(());
        };
        let source = Path::new(&copy.source);
        let owned = roots.iter().any(|root| {
            root.canonicalize()
                .is_ok_and(|root| source.starts_with(root))
        });
        if owned {
            let _ = std::fs::remove_file(source);
            if let Some(parent) = source.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        connection
            .execute(
                "UPDATE pc_books SET kept = 0 WHERE book_id = ?1",
                [&copy.book],
            )
            .map_err(storage_error)?;
        Ok(())
    })
    .await
}

/// A PC dictionary, and whether the phone has it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcDictionary {
    #[serde(flatten)]
    dictionary: RemoteDictionary,
    on_phone: bool,
}

#[tauri::command]
pub async fn list_pc_dictionaries(
    catalog: State<'_, CatalogState>,
    store: State<'_, DictionaryStoreState>,
) -> Result<Vec<PcDictionary>, String> {
    let database = catalog_path(&catalog);
    let link = blocking(move || read_link(&database)).await?;
    let dictionaries = link
        .client()?
        .dictionaries()
        .await
        .map_err(|error| error.code())?;
    let store = store.database().to_owned();
    blocking(move || {
        let connection = open_store(&store)?;
        dictionaries
            .into_iter()
            .map(|dictionary| {
                let on_phone = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM dictionaries WHERE title = ?1 AND revision = ?2)",
                        params![dictionary.title, dictionary.revision],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                Ok(PcDictionary {
                    dictionary,
                    on_phone,
                })
            })
            .collect()
    })
    .await
}

/// Copies the PC's dictionary into the phone's store; `imported` or `alreadyImported`.
#[tauri::command]
pub async fn copy_pc_dictionary(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    store: State<'_, DictionaryStoreState>,
    id: i64,
) -> Result<&'static str, String> {
    let database = catalog_path(&catalog);
    let link = blocking(move || read_link(&database)).await?;
    let client = link.client()?;
    let pack = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(format!("pc-dictionary-{}.sqlite3", uuid::Uuid::new_v4()));
    let label = id.to_string();
    client
        .download(
            &format!("/v1/dictionaries/{id}/pack"),
            &pack,
            reporter(&app, "dictionary", &label),
        )
        .await
        .map_err(|error| error.code())?;
    let (database, lock) = (store.database().to_owned(), store.write_lock());
    let imported = blocking(move || {
        let _writing = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let result =
            open_store(&database).and_then(|mut connection| import_pack(&mut connection, &pack));
        let _ = std::fs::remove_file(&pack);
        result
    })
    .await?;
    Ok(match imported {
        PackImport::Imported(_) => "imported",
        PackImport::AlreadyImported => "alreadyImported",
    })
}

/// A PC book's cover for the Library's PC tab, kept in the cache once fetched.
pub(crate) async fn pc_cover(app: &AppHandle, id: &str, revision: i64) -> Option<CoverImage> {
    let cache = app.path().app_cache_dir().ok()?.join(PC_COVERS);
    let file = cache.join(format!("{id}-{revision}"));
    if let Ok(bytes) = std::fs::read(&file) {
        let (mime, bytes) = split_cover(&bytes)?;
        return Some(CoverImage { mime, bytes });
    }
    let database = app.state::<CatalogState>().database.clone();
    let link = tauri::async_runtime::spawn_blocking(move || read_link(&database))
        .await
        .ok()?
        .ok()?;
    let (mime, bytes) = link.client().ok()?.cover(id).await.ok()?;
    if !mime.starts_with("image/") {
        return None;
    }
    let _ = std::fs::create_dir_all(&cache);
    let mut stored = Vec::with_capacity(mime.len() + 1 + bytes.len());
    stored.extend_from_slice(mime.as_bytes());
    stored.push(b'\n');
    stored.extend_from_slice(&bytes);
    let _ = std::fs::write(&file, stored);
    Some(CoverImage { mime, bytes })
}

/// A cached cover: its type on the first line, then the image.
fn split_cover(stored: &[u8]) -> Option<(String, Vec<u8>)> {
    let line = stored.iter().position(|&byte| byte == b'\n')?;
    let mime = std::str::from_utf8(&stored[..line]).ok()?.to_owned();
    mime.starts_with("image/")
        .then(|| (mime, stored[line + 1..].to_vec()))
}
