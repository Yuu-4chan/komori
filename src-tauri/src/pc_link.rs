//! Settings > Sync and the PC's books in the Library on the phone: the pairing with one Komori PC (its
//! address, the certificate fingerprint it paired with, and the device token, kept in the
//! catalog's preferences), the PC's books and dictionaries, and their copies on the phone.
//!
//! A PC book opened here is downloaded into Komori's cache and imported like any other book;
//! only the one opened last stays there. Keep on this phone moves it into Komori's own storage.
//! Each copy keeps its catalog record (and so its reading state) for the PC's next sync, and is
//! listed once, as the PC's book. Unpairing removes the PC's books from the phone, and what the last
//! sync saw, so pairing again combines both sides. `sync_pc` syncs the reading state (`sync`).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
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
use crate::pc_listing;

const RECORD: &str = "pc-link";
const TRANSFER_EVENT: &str = "pc-transfer";
const PC_BOOKS: &str = "pc-books";
const PC_COVERS: &str = "pc-covers";
/// Tells the Library a PC cover is now on the phone.
const COVER_EVENT: &str = "pc-cover";

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
    #[serde(default)]
    last_synced: Option<String>,
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
            last_synced: None,
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
    last_synced: Option<String>,
}

impl From<&Link> for LinkView {
    fn from(link: &Link) -> Self {
        Self {
            address: link.address.clone(),
            port: link.port,
            paired: link.pinned().is_some(),
            pc_name: link.pc_name.clone(),
            sync_on: link.sync_on,
            last_synced: link.last_synced.clone(),
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
    stop_covers();
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
        crate::sync::forget(&connection)?;
        pc_listing::forget(&connection)?;
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

/// One sync at a time: leaving the Reader while one runs waits for it, then syncs again.
static SYNCING: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    #[serde(flatten)]
    link: LinkView,
    /// Whether the phone's books changed, for the pages showing them to read them again.
    changed: bool,
    /// The phone's books whose place the PC's moved, for an open Reader to follow.
    moved: Vec<String>,
}

/// Syncs the reading state with the PC (see `sync`): places, bookmarks, notes and sessions.
#[tauri::command]
pub async fn sync_pc(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
) -> Result<SyncResult, String> {
    let database = catalog_path(&catalog);
    let _syncing = SYNCING.lock().await;
    let link = {
        let database = database.clone();
        blocking(move || read_link(&database)).await?
    };
    let client = link.client()?;
    let own = link
        .device_id
        .clone()
        .ok_or_else(|| LinkError::NotPaired.code())?;
    client.hello().await.map_err(|error| error.code())?;
    let request = {
        let database = database.clone();
        blocking(move || Ok(crate::sync::pull_request(&open_catalog(&database)?))).await?
    };
    let pulled = client
        .sync_pull(&request)
        .await
        .map_err(|error| error.code())?;
    let plan = {
        let database = database.clone();
        blocking(move || crate::sync::plan(&open_catalog(&database)?, &own, &pulled)).await?
    };
    // Even with nothing to send, the PC notes that the phone synced.
    let answer = client
        .sync_push(&plan.push)
        .await
        .map_err(|error| error.code())?;
    let changed = plan.changes_phone();
    let (link, moved) = blocking(move || {
        let mut connection = open_catalog(&database)?;
        let moved = crate::sync::finish(&mut connection, &plan, &answer)?;
        let mut link = load(&connection)?;
        link.last_synced = Some(
            connection
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                    row.get(0)
                })
                .map_err(storage_error)?,
        );
        save(&connection, &link)?;
        Ok((LinkView::from(&link), moved))
    })
    .await?;
    if changed {
        let _ = app.emit(crate::book_details::DETAILS_EVENT, ());
    }
    Ok(SyncResult {
        link,
        changed,
        moved,
    })
}

/// The book's place on the PC and here, when both changed since they last synced.
#[tauri::command]
pub async fn get_pc_conflict(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<Option<crate::sync::Conflict>, String> {
    let database = catalog_path(&catalog);
    blocking(move || {
        if uuid::Uuid::parse_str(&id).is_err() {
            return Ok(None);
        }
        crate::sync::conflict_of(&open_catalog(&database)?, &id)
    })
    .await
}

/// Continues the book from the PC's place (`pc`) or this phone's (`phone`).
#[tauri::command]
pub async fn resolve_pc_conflict(
    catalog: State<'_, CatalogState>,
    id: String,
    keep: String,
) -> Result<bool, String> {
    let database = catalog_path(&catalog);
    blocking(move || {
        if uuid::Uuid::parse_str(&id).is_err() || !matches!(keep.as_str(), "pc" | "phone") {
            return Ok(false);
        }
        crate::sync::resolve(&mut open_catalog(&database)?, &id, keep == "pc")
    })
    .await
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

/// The listing's books with their copies on this phone.
fn with_copies(connection: &Connection, books: Vec<RemoteBook>) -> Result<Vec<PcBook>, String> {
    books
        .into_iter()
        .map(|book| {
            let copy = copy_of(connection, &book.id)?;
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
}

/// The PC's Library as last listed, without asking the PC; none before the first listing.
#[tauri::command]
pub async fn cached_pc_library(
    catalog: State<'_, CatalogState>,
) -> Result<Option<Vec<PcBook>>, String> {
    let database = catalog_path(&catalog);
    blocking(move || {
        let connection = open_catalog(&database)?;
        if load(&connection)?.pinned().is_none() {
            return Ok(None);
        }
        pc_listing::saved(&connection)?
            .map(|books| with_copies(&connection, books))
            .transpose()
    })
    .await
}

/// Lists the PC's Library and saves it, then fetches the covers the phone lacks in the
/// background and removes those the PC no longer has.
#[tauri::command]
pub async fn list_pc_library(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
) -> Result<Vec<PcBook>, String> {
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
    let wanted = pc_listing::wanted_covers(&library.books);
    let books = blocking(move || {
        let connection = open_catalog(&database)?;
        pc_listing::save(&connection, &library.books)?;
        with_copies(&connection, library.books)
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || fetch_covers(&app, wanted));
    Ok(books)
}

/// The kanji of the phone's books and the PC's as one, for Statistics: the PC's as it sends them
/// now, or as last received when it does not answer. The phone's copies of PC books count as
/// the PC's books, so they are left out of the phone's own while the PC's kanji are known.
#[tauri::command]
pub async fn list_pc_library_kanji(
    catalog: State<'_, CatalogState>,
) -> Result<Vec<crate::reading_sessions::LibraryKanji>, String> {
    let database = catalog_path(&catalog);
    let link = {
        let database = database.clone();
        blocking(move || read_link(&database)).await?
    };
    let fetched = match link.client() {
        Ok(client) => client.library_kanji().await.ok(),
        Err(_) => None,
    };
    blocking(move || {
        let connection = open_catalog(&database)?;
        if let Some(kanji) = &fetched {
            pc_listing::save_kanji(&connection, kanji)?;
        }
        let Some(pc) = fetched.map_or_else(
            || pc_listing::saved_kanji(&connection),
            |kanji| Ok(Some(kanji)),
        )?
        else {
            return crate::reading_sessions::kanji_from(&connection);
        };
        let own = crate::reading_sessions::kanji_skipping(&connection, &pc_book_ids(&connection))?;
        Ok(crate::reading_sessions::merge_kanji(own, pc))
    })
    .await
}

/// The covers still to fetch. One task fetches them, one at a time, so the covers never take
/// more of the PC's connections than one.
static COVER_QUEUE: std::sync::Mutex<pc_listing::CoverQueue> =
    std::sync::Mutex::new(pc_listing::CoverQueue::new());
/// When the PC last did not answer for a cover, in seconds; a screen asking for covers soon after
/// does not ask it again.
static UNREACHABLE_SINCE: AtomicU64 = AtomicU64::new(0);

fn cover_queue() -> std::sync::MutexGuard<'static, pc_listing::CoverQueue> {
    COVER_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Removes the covers the listing no longer names and fetches those the phone lacks, in the
/// listing's order, after any a screen asks for.
fn fetch_covers(app: &AppHandle, wanted: Vec<(String, i64)>) {
    let Ok(cache) = covers_directory(app) else {
        return;
    };
    pc_listing::remove_stale_covers(&cache, &wanted);
    let missing = wanted
        .into_iter()
        .filter(|(id, revision)| !cache.join(pc_listing::cover_file(id, *revision)).is_file())
        .collect();
    let mut queue = cover_queue();
    queue.list(missing);
    start_covers(app, &mut queue);
}

fn start_covers(app: &AppHandle, queue: &mut pc_listing::CoverQueue) {
    if queue.start() {
        tauri::async_runtime::spawn(run_covers(app.clone()));
    }
}

/// Stops fetching covers, as when the PC does not answer or the phone unpairs.
fn stop_covers() {
    cover_queue().clear();
}

#[derive(Clone, Serialize)]
struct CoverArrived<'a> {
    id: &'a str,
    revision: i64,
}

/// Fetches the queued covers into the cache until none is left, telling the Library of each.
async fn run_covers(app: AppHandle) {
    let database = app.state::<CatalogState>().database.clone();
    let client = tauri::async_runtime::spawn_blocking(move || read_link(&database))
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|link| link.client().ok());
    let (Some(client), Ok(cache)) = (client, covers_directory(&app)) else {
        stop_covers();
        return;
    };
    loop {
        let next = cover_queue().next();
        let Some((id, revision)) = next else {
            return;
        };
        let file = cache.join(pc_listing::cover_file(&id, revision));
        if file.is_file() {
            // Fetched since it was asked for: a screen that asked meanwhile hears of it again.
            let _ = app.emit(COVER_EVENT, CoverArrived { id: &id, revision });
            continue;
        }
        match client.cover(&id).await {
            Ok((mime, bytes)) => {
                UNREACHABLE_SINCE.store(0, Ordering::SeqCst);
                if store_cover(&cache, &file, &mime, &bytes) {
                    let _ = app.emit(COVER_EVENT, CoverArrived { id: &id, revision });
                }
            }
            // A cover the PC no longer has: the rest go on.
            Err(LinkError::NotFound | LinkError::Failed(_)) => {}
            Err(error) => {
                if error == LinkError::Unreachable {
                    UNREACHABLE_SINCE.store(now_seconds(), Ordering::SeqCst);
                }
                // The rest wait for the next listing.
                stop_covers();
                return;
            }
        }
    }
}

/// Keeps a cover from the PC in the cache: its type on the first line, then the image.
fn store_cover(cache: &Path, file: &Path, mime: &str, bytes: &[u8]) -> bool {
    if !mime.starts_with("image/") {
        return false;
    }
    let _ = std::fs::create_dir_all(cache);
    let mut stored = Vec::with_capacity(mime.len() + 1 + bytes.len());
    stored.extend_from_slice(mime.as_bytes());
    stored.push(b'\n');
    stored.extend_from_slice(bytes);
    let part = file.with_extension("part");
    if std::fs::write(&part, stored).is_err() {
        return false;
    }
    if std::fs::rename(&part, file).is_err() {
        let _ = std::fs::remove_file(&part);
        return false;
    }
    true
}

fn covers_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|root| root.join(PC_COVERS))
        .map_err(|error| error.to_string())
}

fn cached_cover(file: &Path) -> Option<CoverImage> {
    let (mime, bytes) = split_cover(&std::fs::read(file).ok()?)?;
    Some(CoverImage { mime, bytes })
}

/// What the PC's books take on this phone, in bytes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcStorage {
    /// The books kept on this phone.
    kept: u64,
    /// The book opened last, kept until another is opened.
    cached: u64,
    covers: u64,
}

#[tauri::command]
pub async fn pc_storage(app: AppHandle) -> Result<PcStorage, String> {
    let (kept, cached, covers) = (
        directory(&app, true)?,
        directory(&app, false)?,
        covers_directory(&app)?,
    );
    blocking(move || {
        Ok(PcStorage {
            kept: pc_listing::size_of(&kept),
            cached: pc_listing::size_of(&cached),
            covers: pc_listing::size_of(&covers),
        })
    })
    .await
}

/// Removes the PC's covers from the phone; they download again when shown or listed.
#[tauri::command]
pub async fn clear_pc_covers(app: AppHandle) -> Result<PcStorage, String> {
    let covers = covers_directory(&app)?;
    stop_covers();
    let _ = blocking(move || {
        let _ = std::fs::remove_dir_all(&covers);
        Ok(())
    })
    .await;
    pc_storage(app).await
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
            None => crate::library::import_file(&mut connection, &target, Some(&id))?,
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
    let pack = pc_listing::dictionary_pack(
        &app.path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?,
    );
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

/// A PC book's cover for the Library, from the cache at once. One not here yet is fetched ahead
/// of the rest, and `pc-cover` tells the Library when it arrives: the WebView's requests never
/// wait for the PC, which would hold up everything else the WebView loads.
pub(crate) fn pc_cover(app: &AppHandle, id: &str, revision: i64) -> Option<CoverImage> {
    let cache = covers_directory(app).ok()?;
    if let Some(cover) = cached_cover(&cache.join(pc_listing::cover_file(id, revision))) {
        return Some(cover);
    }
    if now_seconds() >= UNREACHABLE_SINCE.load(Ordering::SeqCst) + 20 {
        let mut queue = cover_queue();
        queue.ask(id, revision);
        start_covers(app, &mut queue);
    }
    None
}

/// A cached cover: its type on the first line, then the image.
fn split_cover(stored: &[u8]) -> Option<(String, Vec<u8>)> {
    let line = stored.iter().position(|&byte| byte == b'\n')?;
    let mime = std::str::from_utf8(&stored[..line]).ok()?.to_owned();
    mime.starts_with("image/")
        .then(|| (mime, stored[line + 1..].to_vec()))
}
