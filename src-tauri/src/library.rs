use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::interface_text::{self, Text};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::{
    appearance_preferences, book_details,
    bulk_progress::{
        compaction_needed, reclaim, BatchProgress, RemovalBatch, COMPACTION_MINIMUM_FREE,
    },
    covers,
    dictionary::store::CompactionResult,
    epub,
    title_series::{self, TitledBook},
};

const SCHEMA_VERSION: i64 = 7;
const COVER_RESOLVER_VERSION: i64 = 2;
const CATALOG_FILE_NAME: &str = "library.sqlite3";

#[derive(Debug)]
pub struct CatalogState {
    pub(crate) database: PathBuf,
    pub(crate) write_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBook {
    id: String,
    title: Option<String>,
    author: Option<String>,
    file_name: String,
    imported_at: String,
    availability: &'static str,
    has_cover: bool,
    /// Where the webview loads the cover's thumbnail; changes whenever the cover does.
    cover_url: Option<String>,
    /// How far the Reader last counted the book, when it has been opened.
    progress: Option<BookProgress>,
    /// When the Reader last saved the book's position or progress.
    last_read_at: Option<String>,
    /// The book's shown language tag (`ja`, `zh-Hant`, `en`), when known.
    language: Option<String>,
    /// The series set by hand, or else the book's own, or else (when the Library names series
    /// from titles) one its title shares with other volumes.
    series: Option<String>,
    series_index: Option<f64>,
    /// Whether the series (or having none) was set by hand.
    series_manual: bool,
    /// Letters and numbers in a Chinese, Japanese, or Korean book's text.
    characters: Option<i64>,
    /// Distinct kanji in a Chinese, Japanese, or Korean book's text.
    unique_kanji: Option<i64>,
    /// Words in any other book's text.
    words: Option<i64>,
}

/// Whole-book progress as the Reader's footer counts it: units before the displayed page.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProgress {
    pub(crate) unit: String,
    pub(crate) current: i64,
    pub(crate) total: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    file_name: String,
    pub(crate) status: &'static str,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub(crate) canceled: bool,
    pub(crate) results: Vec<ImportResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkResult {
    status: &'static str,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    id: String,
    status: &'static str,
    message: Option<String>,
}

pub fn initialize_catalog(app: &AppHandle) -> Result<CatalogState, String> {
    let database = resolve_database_path(app)?;
    let schema_before = schema_version_at(&database)?;
    let connection = open_at_startup(&database)?;

    // cfg! (not #[cfg]) keeps these values used in release builds without logging there.
    if cfg!(debug_assertions) {
        let schema_after: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage_error)?;
        eprintln!(
            "Komori catalog initialized at {} (schema {schema_before} -> {schema_after})",
            database.display()
        );
    }

    Ok(CatalogState {
        database,
        write_lock: Arc::default(),
    })
}

/// Opens (and migrates) the catalog before the window loads. Covers of books from before the
/// current cover resolver are left to `backfill_covers_at` on a background thread.
fn open_at_startup(database: &Path) -> Result<Connection, String> {
    open_catalog(database)
}

fn list_at(database: &Path) -> Result<Vec<LibraryBook>, String> {
    list_from_catalog(&open_catalog(database)?)
}

#[tauri::command]
pub async fn list_library(catalog: State<'_, CatalogState>) -> Result<Vec<LibraryBook>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let books = list_at(&database)?;
        #[cfg(debug_assertions)]
        eprintln!(
            "Komori Library loaded {} catalog records ({} with covers)",
            books.len(),
            books.iter().filter(|book| book.has_cover).count()
        );
        Ok(books)
    })
    .await
    .map_err(|error| format!("Library task failed: {error}"))?
}

/// Resolves one catalog record for the Reader without scanning every source or backfilling covers.
#[tauri::command]
pub async fn get_library_book(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<Option<LibraryBook>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_catalog(&database)?;
        get_book_from_catalog(&connection, &id)
    })
    .await
    .map_err(|error| format!("Library task failed: {error}"))?
}

#[tauri::command]
pub async fn import_books(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    operation_id: Option<String>,
) -> Result<ImportBatch, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    progress.phase("picking");
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::ImportEpubs))
        .add_filter(interface_text::text(language, Text::EpubBooks), &["epub"])
        .pick_files()
        .await;

    let Some(selected) = selected else {
        return Ok(ImportBatch {
            canceled: true,
            results: Vec::new(),
        });
    };

    let paths: Vec<PathBuf> = selected
        .iter()
        .map(|file| file.path().to_path_buf())
        .collect();
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = open_catalog(&database)?;
        Ok(ImportBatch {
            canceled: false,
            results: import_paths_with_progress(&mut connection, &paths, &mut progress),
        })
    })
    .await
    .map_err(|error| format!("Import task failed: {error}"))?
}

#[tauri::command]
pub async fn relink_book(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<RelinkResult, String> {
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::RelinkEpub))
        .add_filter(interface_text::text(language, Text::EpubBooks), &["epub"])
        .pick_file()
        .await
        .map(|file| file.path().to_path_buf());
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || relink_selection(&database, &id, selected))
        .await
        .map_err(|error| format!("Relink task failed: {error}"))?
}

#[tauri::command]
pub async fn remove_book(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    id: String,
    operation_id: Option<String>,
) -> Result<RemovalBatch<bool>, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let connection = open_catalog(&database)?;
        progress.start(1);
        let outcome = remove_book_from_catalog(&connection, &id);
        progress.completed_one();
        let results = outcome?;
        let maintenance = reclaim(
            &mut progress,
            results,
            || catalog_compaction_needed(&connection, &database, COMPACTION_MINIMUM_FREE),
            || compact_catalog(&connection, &database),
        );
        Ok(RemovalBatch {
            results,
            maintenance,
        })
    })
    .await
    .map_err(|error| format!("Remove task failed: {error}"))?
}

#[tauri::command]
pub async fn remove_books(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    ids: Vec<String>,
    operation_id: Option<String>,
) -> Result<RemovalBatch<Vec<RemoveResult>>, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let connection = open_catalog(&database)?;
        Ok(remove_and_reclaim(
            &connection,
            &database,
            ids,
            &mut progress,
            COMPACTION_MINIMUM_FREE,
        ))
    })
    .await
    .map_err(|error| format!("Bulk remove task failed: {error}"))?
}

/// The Library catalog's size on disk in bytes.
#[tauri::command]
pub async fn get_library_store_size(catalog: State<'_, CatalogState>) -> Result<u64, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::metadata(&database)
            .map(|metadata| metadata.len())
            .map_err(|_| "The Library catalog size could not be read.".to_string())
    })
    .await
    .map_err(|error| format!("Library size task failed: {error}"))?
}

/// Removals leave free pages that later imports reuse; only a large share is worth a rewrite.
fn catalog_compaction_needed(connection: &Connection, database: &Path, minimum: u64) -> bool {
    let size = std::fs::metadata(database).map_or(0, |metadata| metadata.len());
    compaction_needed(connection, size, minimum)
}

/// `VACUUM` builds a copy of the catalog without free pages and writes it back in one
/// transaction, waiting for other connections (such as a cover request) to finish; it needs free
/// disk space of about the catalog's size while it runs. A failure leaves the catalog as it was.
fn compact_catalog(connection: &Connection, database: &Path) -> Result<CompactionResult, String> {
    let size = || {
        std::fs::metadata(database)
            .map(|metadata| metadata.len())
            .map_err(|error| error.to_string())
    };
    let size_before = size()?;
    crate::bulk_progress::interruptible(connection, || connection.execute_batch("VACUUM"))
        .map_err(storage_error)?;
    Ok(CompactionResult::Compacted {
        size_before,
        size_after: size()?,
    })
}

fn resolve_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate Komori application data: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create Komori application data: {error}"))?;
    Ok(directory.join(CATALOG_FILE_NAME))
}

/// Opens an existing catalog read-write without creating it, so that SQLite rolls back a hot
/// journal left by a write that a close, kill or power loss interrupted; a read-only open fails.
fn schema_version_at(path: &Path) -> Result<i64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(storage_error)?;
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_error)
}

pub(crate) fn open_catalog(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(storage_error)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(storage_error)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_error)?;
    if version > SCHEMA_VERSION {
        return Err(crate::failure::LIBRARY_NEWER.into());
    }
    if version == 0 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS books (
                   id TEXT PRIMARY KEY,
                   source_path TEXT NOT NULL UNIQUE,
                   file_name TEXT NOT NULL,
                   title TEXT,
                   author TEXT,
                   cover_mime TEXT,
                   cover_bytes BLOB,
                   cover_discovery TEXT,
                   cover_resolver_version INTEGER NOT NULL DEFAULT 0,
                   imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    } else if version == 1 {
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE books ADD COLUMN cover_discovery TEXT;
                 ALTER TABLE books ADD COLUMN cover_resolver_version INTEGER NOT NULL DEFAULT 0;
                 UPDATE books
                    SET cover_discovery = 'legacy-import', cover_resolver_version = 1
                  WHERE cover_bytes IS NOT NULL;
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 3 {
        // Reader positions are Komori-owned book state; catalog removal cascades to them.
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS reading_positions (
                   book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
                   spine_index INTEGER NOT NULL,
                   section_key TEXT,
                   progress REAL NOT NULL,
                   updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 );
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 4 {
        // Application-wide Komori preferences, one validated JSON record per name.
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS preferences (
                   name TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 );
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 5 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS bookmarks (
                   id TEXT PRIMARY KEY,
                   book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                   locator TEXT NOT NULL,
                   label TEXT NOT NULL,
                   excerpt TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                   UNIQUE(book_id, locator)
                 );
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 6 {
        // Card-sized cover thumbnails are derived from the cached cover for its revision.
        let has_revision: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('books')
                                WHERE name = 'cover_revision')",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let add_revision = if has_revision {
            ""
        } else {
            "ALTER TABLE books ADD COLUMN cover_revision INTEGER NOT NULL DEFAULT 0;"
        };
        connection
            .execute_batch(&format!(
                "BEGIN;
                 {add_revision}
                 CREATE TABLE IF NOT EXISTS book_thumbnails (
                   book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
                   cover_revision INTEGER NOT NULL,
                   mime TEXT NOT NULL,
                   bytes BLOB NOT NULL
                 );
                 PRAGMA user_version = 6;
                 COMMIT;"
            ))
            .map_err(storage_error)?;
    }
    if version < 7 {
        // Clean existing cached titles once, including unavailable sources. Update only the
        // title in place so every catalog ID and its dependent reading state stay attached.
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        let titles: Vec<(String, String)> = {
            let mut statement = transaction
                .prepare("SELECT id, title FROM books WHERE title IS NOT NULL")
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(storage_error)?;
            rows.collect::<Result<_, _>>().map_err(storage_error)?
        };
        for (id, title) in titles {
            let cleaned = crate::title_cleaning::clean(&title);
            if cleaned.as_deref() != Some(title.as_str()) {
                transaction
                    .execute(
                        "UPDATE books SET title = ?1 WHERE id = ?2",
                        params![cleaned, id],
                    )
                    .map_err(storage_error)?;
            }
        }
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    // Additive Komori-owned book state. Created without a version bump so an older Komori,
    // which ignores the table, keeps opening the catalog; removal cascades to it.
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS book_progress (
               book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
               unit TEXT NOT NULL,
               current_units INTEGER NOT NULL,
               total_units INTEGER NOT NULL,
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );",
        )
        .map_err(storage_error)?;
    // Covers are stored inline before `imported_at` and `cover_revision`; the index lets listings
    // read both without walking every cover's pages. Older Komori versions open it unchanged.
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS books_imported
               ON books (imported_at DESC, id DESC, cover_revision)",
        )
        .map_err(storage_error)?;
    book_details::create_tables(&connection)?;
    crate::reading_sessions::create_tables(&connection)?;
    crate::library_folders::create_tables(&connection)?;
    crate::reader_notes::create_tables(&connection)?;
    crate::reader_background::create_table(&connection)?;
    crate::title_cleaning::refresh_catalog(&connection)?;
    Ok(connection)
}

const BOOK_COLUMNS: &str = "books.id, books.source_path, books.file_name, books.title,
                            books.author, books.imported_at, length(books.cover_bytes) IS NOT NULL,
                            progress.unit, progress.current_units, progress.total_units,
                            nullif(max(coalesce(progress.updated_at, ''),
                                       coalesce(position.updated_at, '')), ''),
                            books.cover_revision, details.language,
                            CASE WHEN manual.book_id IS NULL THEN details.series
                                 ELSE manual.series END,
                            CASE WHEN manual.book_id IS NULL THEN details.series_index
                                 ELSE manual.series_index END,
                            manual.book_id IS NOT NULL, details.characters,
                            details.unique_kanji, details.words";
const BOOK_SOURCE: &str = "books
     LEFT JOIN book_progress AS progress ON progress.book_id = books.id
     LEFT JOIN reading_positions AS position ON position.book_id = books.id
     LEFT JOIN book_details AS details ON details.book_id = books.id
     LEFT JOIN book_series AS manual ON manual.book_id = books.id";

fn list_sql() -> String {
    format!(
        "SELECT {BOOK_COLUMNS} FROM {BOOK_SOURCE}
         ORDER BY books.imported_at DESC, books.id DESC"
    )
}

pub(crate) fn list_from_catalog(connection: &Connection) -> Result<Vec<LibraryBook>, String> {
    let mut statement = connection.prepare(&list_sql()).map_err(storage_error)?;
    let rows = statement
        .query_map([], library_book_from_row)
        .map_err(storage_error)?;
    let mut books = rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?;
    if appearance_preferences::series_from_titles(connection) {
        let named = title_series::series_from_titles(
            &books
                .iter()
                .map(|book| TitledBook {
                    title: book.title.as_deref(),
                    series: book.series.as_deref(),
                    series_index: book.series_index,
                    series_manual: book.series_manual,
                })
                .collect::<Vec<_>>(),
        );
        for (book, named) in books.iter_mut().zip(named) {
            if let Some((series, index)) = named {
                book.series = Some(series);
                book.series_index = Some(index);
            }
        }
    }
    Ok(books)
}

fn get_book_from_catalog(connection: &Connection, id: &str) -> Result<Option<LibraryBook>, String> {
    // Catalog IDs are Komori UUIDs; malformed or path-shaped input is simply unknown.
    if Uuid::parse_str(id).is_err() {
        return Ok(None);
    }
    let mut book = connection
        .query_row(
            &format!("SELECT {BOOK_COLUMNS} FROM {BOOK_SOURCE} WHERE books.id = ?1"),
            [id],
            library_book_from_row,
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(book) = book
        .as_mut()
        .filter(|book| book.series.is_none() && !book.series_manual)
    {
        if appearance_preferences::series_from_titles(connection) {
            if let Some((series, index)) = series_from_catalog_titles(connection, id)? {
                book.series = Some(series);
                book.series_index = Some(index);
            }
        }
    }
    Ok(book)
}

/// The series one book's title names among every title in the catalog, read without the
/// rest of each book so the Reader opens as quickly as before.
fn series_from_catalog_titles(
    connection: &Connection,
    id: &str,
) -> Result<Option<(String, f64)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT books.id, books.title,
                    CASE WHEN manual.book_id IS NULL THEN details.series
                         ELSE manual.series END,
                    CASE WHEN manual.book_id IS NULL THEN details.series_index
                         ELSE manual.series_index END,
                    manual.book_id IS NOT NULL
             FROM books
             LEFT JOIN book_details AS details ON details.book_id = books.id
             LEFT JOIN book_series AS manual ON manual.book_id = books.id
             ORDER BY books.imported_at DESC, books.id DESC",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let Some(position) = rows.iter().position(|(book, ..)| book == id) else {
        return Ok(None);
    };
    let books: Vec<TitledBook<'_>> = rows
        .iter()
        .map(
            |(_, title, series, series_index, series_manual)| TitledBook {
                title: title.as_deref(),
                series: series.as_deref(),
                series_index: *series_index,
                series_manual: *series_manual,
            },
        )
        .collect();
    Ok(title_series::series_from_titles(&books).swap_remove(position))
}

fn library_book_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryBook> {
    let id: String = row.get(0)?;
    let source_path: String = row.get(1)?;
    let has_cover: bool = row.get(6)?;
    let cover_url = if has_cover {
        Some(covers::cover_url(&id, row.get(11)?))
    } else {
        None
    };
    Ok(LibraryBook {
        id,
        file_name: row.get(2)?,
        title: row.get(3)?,
        author: row.get(4)?,
        imported_at: row.get(5)?,
        availability: source_availability(&source_path),
        has_cover,
        cover_url,
        progress: book_progress_from_columns(row.get(7)?, row.get(8)?, row.get(9)?),
        last_read_at: row.get(10)?,
        language: row.get(12)?,
        series: row.get(13)?,
        series_index: row.get(14)?,
        series_manual: row.get(15)?,
        characters: row.get(16)?,
        unique_kanji: row.get(17)?,
        words: row.get(18)?,
    })
}

/// A stored progress row only when it is still well-formed.
fn book_progress_from_columns(
    unit: Option<String>,
    current: Option<i64>,
    total: Option<i64>,
) -> Option<BookProgress> {
    let progress = BookProgress {
        unit: unit?,
        current: current?,
        total: total?,
    };
    progress.is_valid().then_some(progress)
}

/// Generous for the longest real books while keeping stored values bounded.
const MAX_PROGRESS_UNITS: i64 = 1_000_000_000;

impl BookProgress {
    pub(crate) fn is_valid(&self) -> bool {
        matches!(self.unit.as_str(), "characters" | "words")
            && (1..=MAX_PROGRESS_UNITS).contains(&self.total)
            && (0..=self.total).contains(&self.current)
    }
}

/// Whether the source is still there, from its file attributes alone. Opening every EPUB made
/// large Libraries slow to list (and invites an antivirus scan of each file); the Reader still
/// opens and validates a source before reading it.
fn source_availability(source_path: &str) -> &'static str {
    match std::fs::metadata(source_path) {
        Ok(metadata) if metadata.is_file() => "available",
        Ok(_) => "unreadable",
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "unreadable",
    }
}

pub(crate) fn import_paths(connection: &mut Connection, paths: &[PathBuf]) -> Vec<ImportResult> {
    import_paths_with_progress(connection, paths, &mut BatchProgress::silent())
}

pub(crate) fn import_paths_with_progress(
    connection: &mut Connection,
    paths: &[PathBuf],
    progress: &mut BatchProgress,
) -> Vec<ImportResult> {
    progress.start(paths.len());
    paths
        .iter()
        .map(|path| {
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Selected file".into());
            let result = match import_one(connection, path) {
                Ok(status) => ImportResult {
                    file_name,
                    status,
                    message: None,
                },
                Err(message) => ImportResult {
                    file_name,
                    status: "failed",
                    message: Some(message),
                },
            };
            progress.completed_one();
            result
        })
        .collect()
}

fn import_one(connection: &mut Connection, path: &Path) -> Result<&'static str, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err(crate::failure::CHOOSE_EPUB.into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot access the source file: {error}"))?;
    let source =
        File::open(&canonical).map_err(|error| format!("Cannot read the source file: {error}"))?;
    if !source
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(crate::failure::NOT_A_FILE.into());
    }
    let private_path = canonical.to_string_lossy().into_owned();
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE source_path = ?1)",
            [&private_path],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if exists {
        return Ok("alreadyImported");
    }

    let metadata = epub::read(source)?;
    let file_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.epub".into());
    let cover_diagnostic = metadata.cover_diagnostic.code().to_string();
    let thumbnail = metadata
        .cover
        .as_ref()
        .and_then(|cover| covers::thumbnail(&cover.mime, &cover.bytes));
    let (cover_mime, cover_bytes) = metadata
        .cover
        .map_or((None, None), |cover| (Some(cover.mime), Some(cover.bytes)));
    let id = Uuid::new_v4().to_string();
    let transaction = connection.transaction().map_err(storage_error)?;
    // Another writer can add the same file while this one reads it; that is already imported.
    let inserted = transaction
        .execute(
            "INSERT INTO books
             (id, source_path, file_name, title, author, cover_mime, cover_bytes,
              cover_discovery, cover_resolver_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(source_path) DO NOTHING",
            params![
                id,
                private_path,
                file_name,
                metadata.title,
                metadata.author,
                cover_mime,
                cover_bytes,
                cover_diagnostic,
                COVER_RESOLVER_VERSION
            ],
        )
        .map_err(storage_error)?;
    if inserted == 0 {
        return Ok("alreadyImported");
    }
    if let Some(thumbnail) = thumbnail {
        covers::store_thumbnail(&transaction, &id, 0, &thumbnail)?;
    }
    let stamp = book_details::source_stamp(&canonical);
    book_details::store(&transaction, &id, &metadata.details, stamp.as_deref())?;
    transaction.commit().map_err(storage_error)?;
    Ok("imported")
}

fn relink_selection(
    database: &Path,
    id: &str,
    selected: Option<PathBuf>,
) -> Result<RelinkResult, String> {
    let Some(path) = selected else {
        return Ok(RelinkResult {
            status: "canceled",
            message: None,
        });
    };
    let mut connection = open_catalog(database)?;
    relink_one(&mut connection, id, &path)
}

pub(crate) fn relink_one(
    connection: &mut Connection,
    id: &str,
    path: &Path,
) -> Result<RelinkResult, String> {
    let target_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !target_exists {
        return Ok(RelinkResult {
            status: "failed",
            message: Some(crate::failure::BOOK_GONE.into()),
        });
    }

    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Ok(RelinkResult {
            status: "invalid",
            message: Some(crate::failure::CHOOSE_EPUB.into()),
        });
    }

    let canonical = match path.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(read_failed_relink_result()),
    };
    let source = match File::open(&canonical) {
        Ok(source) => source,
        Err(_) => return Ok(read_failed_relink_result()),
    };
    match source.metadata() {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Ok(RelinkResult {
                status: "invalid",
                message: Some(crate::failure::CHOOSE_EPUB_NOT_FOLDER.into()),
            });
        }
        Err(_) => return Ok(read_failed_relink_result()),
    }
    let metadata = match epub::read(source) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(RelinkResult {
                status: "invalid",
                message: Some(crate::failure::INVALID_EPUB.into()),
            });
        }
    };

    let private_path = canonical.to_string_lossy().into_owned();
    let duplicate: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM books WHERE source_path = ?1 AND id <> ?2
             )",
            params![private_path, id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if duplicate {
        return Ok(duplicate_relink_result());
    }

    let file_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.epub".into());
    let cover_diagnostic = metadata.cover_diagnostic.code().to_string();
    let thumbnail = metadata
        .cover
        .as_ref()
        .and_then(|cover| covers::thumbnail(&cover.mime, &cover.bytes));
    let (cover_mime, cover_bytes) = metadata
        .cover
        .map_or((None, None), |cover| (Some(cover.mime), Some(cover.bytes)));

    let transaction = connection.transaction().map_err(storage_error)?;
    let updated = match transaction.execute(
        "UPDATE books
            SET source_path = ?1, file_name = ?2, title = ?3, author = ?4,
                cover_mime = ?5, cover_bytes = ?6, cover_discovery = ?7,
                cover_resolver_version = ?8, cover_revision = cover_revision + 1
          WHERE id = ?9",
        params![
            private_path,
            file_name,
            metadata.title,
            metadata.author,
            cover_mime,
            cover_bytes,
            cover_diagnostic,
            COVER_RESOLVER_VERSION,
            id
        ],
    ) {
        Ok(updated) => updated,
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return Ok(duplicate_relink_result());
        }
        Err(error) => return Err(storage_error(error)),
    };
    if updated != 1 {
        return Ok(RelinkResult {
            status: "failed",
            message: Some(crate::failure::BOOK_GONE.into()),
        });
    }
    transaction
        .execute("DELETE FROM book_thumbnails WHERE book_id = ?1", [id])
        .map_err(storage_error)?;
    if let Some(thumbnail) = thumbnail {
        let revision: i64 = transaction
            .query_row(
                "SELECT cover_revision FROM books WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        covers::store_thumbnail(&transaction, id, revision, &thumbnail)?;
    }
    // The new source's own details replace the old; a series set by hand stays.
    let stamp = book_details::source_stamp(&canonical);
    book_details::store(&transaction, id, &metadata.details, stamp.as_deref())?;
    transaction.commit().map_err(storage_error)?;
    Ok(RelinkResult {
        status: "relinked",
        message: None,
    })
}

fn duplicate_relink_result() -> RelinkResult {
    RelinkResult {
        status: "duplicate",
        message: Some(crate::failure::EPUB_LINKED_ELSEWHERE.into()),
    }
}

fn read_failed_relink_result() -> RelinkResult {
    RelinkResult {
        status: "readFailed",
        message: Some(crate::failure::FILE_UNREADABLE.into()),
    }
}

/// Books whose covers are saved in one transaction by the background backfill.
const BACKFILL_CHUNK: usize = 50;

/// Resolves the covers of books imported before the current cover resolver, from the startup
/// background thread; the Library refreshes after each chunk that found covers. Returns how many
/// covers were found.
pub(crate) fn backfill_covers_at(
    database: &Path,
    app: Option<&AppHandle>,
) -> Result<usize, String> {
    let mut connection = open_catalog(database)?;
    backfill_missing_covers_in_chunks(&mut connection, BACKFILL_CHUNK, |found| {
        if let (Some(app), true) = (app, found > 0) {
            let _ = app.emit(crate::book_details::DETAILS_EVENT, ());
        }
    })
}

#[cfg(test)]
fn backfill_missing_covers(connection: &mut Connection) -> Result<usize, String> {
    backfill_missing_covers_in_chunks(connection, BACKFILL_CHUNK, |_| {})
}

/// Reads each pending book's cover outside any transaction, then saves `chunk` books' results in
/// one, calling `committed` with the covers it found once it is committed.
fn backfill_missing_covers_in_chunks(
    connection: &mut Connection,
    chunk: usize,
    mut committed: impl FnMut(usize),
) -> Result<usize, String> {
    let pending = {
        let mut statement = connection
            .prepare(
                "SELECT id, source_path
                   FROM books
                  WHERE cover_bytes IS NULL AND cover_resolver_version < ?1",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([COVER_RESOLVER_VERSION], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
    };

    let mut refreshed = 0;
    for books in pending.chunks(chunk.max(1)) {
        let resolved: Vec<_> = books
            .iter()
            .filter_map(|(id, source_path)| {
                let metadata = epub::read(File::open(source_path).ok()?).ok()?;
                Some((id, metadata))
            })
            .collect();
        let transaction = connection.transaction().map_err(storage_error)?;
        let mut found = 0;
        for (id, metadata) in resolved {
            match metadata.cover {
                Some(cover) => {
                    transaction
                        .execute(
                            "UPDATE books
                                SET cover_mime = ?1, cover_bytes = ?2, cover_discovery = ?3,
                                    cover_resolver_version = ?4, cover_revision = cover_revision + 1
                              WHERE id = ?5 AND cover_bytes IS NULL",
                            params![
                                cover.mime,
                                cover.bytes,
                                cover.discovery,
                                COVER_RESOLVER_VERSION,
                                id
                            ],
                        )
                        .map_err(storage_error)?;
                    found += 1;
                }
                None => {
                    transaction
                        .execute(
                            "UPDATE books
                                SET cover_discovery = ?1, cover_resolver_version = ?2
                              WHERE id = ?3 AND cover_bytes IS NULL",
                            params![metadata.cover_diagnostic.code(), COVER_RESOLVER_VERSION, id],
                        )
                        .map_err(storage_error)?;
                }
            }
        }
        transaction.commit().map_err(storage_error)?;
        refreshed += found;
        committed(found);
    }
    Ok(refreshed)
}

pub(crate) fn remove_book_from_catalog(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .execute("DELETE FROM books WHERE id = ?1", [id])
        .map(|removed| removed == 1)
        .map_err(storage_error)
}

#[cfg(test)]
fn remove_books_from_catalog(connection: &Connection, ids: Vec<String>) -> Vec<RemoveResult> {
    remove_books_with_progress(connection, ids, &mut BatchProgress::silent())
}

/// Books removed in one transaction, which other writers wait for: a few seconds at most.
const REMOVAL_CHUNK: usize = 200;

/// Removes books in transactions of `REMOVAL_CHUNK`, each book under its own savepoint, so one
/// refused deletion keeps the others and every book still gets its own outcome.
fn remove_books_with_progress(
    connection: &Connection,
    ids: Vec<String>,
    progress: &mut BatchProgress,
) -> Vec<RemoveResult> {
    progress.start(ids.len());
    let mut results: Vec<RemoveResult> = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(REMOVAL_CHUNK) {
        let first = results.len();
        let begun = connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(storage_error);
        for id in chunk {
            results.push(match &begun {
                Ok(()) => remove_one_book(connection, id.clone()),
                Err(message) => removal_failed(id.clone(), message.clone()),
            });
            progress.completed_one();
        }
        if begun.is_ok() {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                let message = storage_error(error);
                for result in &mut results[first..] {
                    if result.status == "removed" {
                        *result = removal_failed(std::mem::take(&mut result.id), message.clone());
                    }
                }
            }
        }
    }
    results
}

fn remove_one_book(connection: &Connection, id: String) -> RemoveResult {
    if let Err(error) = connection.execute_batch("SAVEPOINT removal") {
        return removal_failed(id, storage_error(error));
    }
    let result = match connection.execute("DELETE FROM books WHERE id = ?1", [&id]) {
        Ok(1) => RemoveResult {
            id,
            status: "removed",
            message: None,
        },
        Ok(_) => removal_failed(id, crate::failure::BOOK_GONE.into()),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK TO removal");
            removal_failed(id, storage_error(error))
        }
    };
    let _ = connection.execute_batch("RELEASE removal");
    result
}

fn removal_failed(id: String, message: String) -> RemoveResult {
    RemoveResult {
        id,
        status: "failed",
        message: Some(message),
    }
}

fn remove_and_reclaim(
    connection: &Connection,
    database: &Path,
    ids: Vec<String>,
    progress: &mut BatchProgress,
    minimum_free: u64,
) -> RemovalBatch<Vec<RemoveResult>> {
    let results = remove_books_with_progress(connection, ids, progress);
    let maintenance = reclaim(
        progress,
        results.iter().any(|result| result.status == "removed"),
        || catalog_compaction_needed(connection, database, minimum_free),
        || compact_catalog(connection, database),
    );
    RemovalBatch {
        results,
        maintenance,
    }
}

pub(crate) fn storage_error(error: rusqlite::Error) -> String {
    format!("Library storage error: {error}")
}

#[cfg(test)]
impl ImportResult {
    pub(crate) fn file_name(&self) -> &str {
        &self.file_name
    }
}

#[cfg(test)]
impl LibraryBook {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn file_name(&self) -> &str {
        &self.file_name
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn bulk_progress_counts_failed_imports_and_partial_deletions_in_order() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        let mut connection = open_catalog(&database).unwrap();
        let first = directory.path().join("first.epub");
        let second = directory.path().join("second.epub");
        fixture(&first, Some("First"), None, false);
        fixture(&second, Some("Second"), None, false);
        let missing = directory.path().join("missing.epub");
        let (mut progress, events) = crate::bulk_progress::recording();
        let results = import_paths_with_progress(
            &mut connection,
            &[first.clone(), missing, first, second],
            &mut progress,
        );
        assert_eq!(
            results.iter().map(|item| item.status).collect::<Vec<_>>(),
            ["imported", "failed", "alreadyImported", "imported"]
        );
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| (event.completed, event.total))
                .collect::<Vec<_>>(),
            [
                (0, Some(4)),
                (1, Some(4)),
                (2, Some(4)),
                (3, Some(4)),
                (4, Some(4))
            ]
        );
        let books = list_from_catalog(&connection).unwrap();
        connection.execute_batch(&format!("CREATE TRIGGER refuse BEFORE DELETE ON books WHEN OLD.id = '{}' BEGIN SELECT RAISE(ABORT, 'refused'); END;", books[0].id)).unwrap();
        let kept = serde_json::to_value(&books[0]).unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let batch = remove_and_reclaim(
            &connection,
            &database,
            vec![books[1].id.clone(), books[0].id.clone(), "unknown".into()],
            &mut progress,
            COMPACTION_MINIMUM_FREE,
        );
        assert_eq!(
            batch
                .results
                .iter()
                .map(|item| item.status)
                .collect::<Vec<_>>(),
            ["removed", "failed", "failed"]
        );
        assert_eq!(batch.maintenance, Some(CompactionResult::NotNeeded));
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| event.completed)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        assert_eq!(
            serde_json::to_value(&list_from_catalog(&connection).unwrap()[0]).unwrap(),
            kept
        );
        let (mut progress, _) = crate::bulk_progress::recording();
        assert!(remove_and_reclaim(
            &connection,
            &database,
            vec![books[0].id.clone()],
            &mut progress,
            0,
        )
        .maintenance
        .is_none());
    }
    use crate::reading_position;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use rusqlite::OpenFlags;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    pub(crate) fn fixture(
        path: &Path,
        title: Option<&str>,
        author: Option<&str>,
        with_cover: bool,
    ) {
        let file = File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive
            .write_all(
                br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>"#,
            )
            .unwrap();
        archive.start_file("OEBPS/book.opf", options).unwrap();
        let title = title.map_or(String::new(), |value| {
            format!("<dc:title>{value}</dc:title>")
        });
        let author = author.map_or(String::new(), |value| {
            format!("<dc:creator>{value}</dc:creator>")
        });
        let manifest = if with_cover {
            "<manifest><item id=\"start\" href=\"start.xhtml\"/><item id=\"cover\" href=\"images/cover.png\" properties=\"cover-image\"/></manifest>"
        } else {
            "<manifest><item id=\"start\" href=\"start.xhtml\"/></manifest>"
        };
        archive
            .write_all(
                format!(
                    "<?xml version=\"1.0\"?><package xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><metadata>{title}{author}</metadata>{manifest}<spine><itemref idref=\"start\"/></spine></package>"
                )
                .as_bytes(),
            )
            .unwrap();
        archive.start_file("OEBPS/start.xhtml", options).unwrap();
        archive.write_all(b"<html><body/></html>").unwrap();
        if with_cover {
            archive
                .start_file("OEBPS/images/cover.png", options)
                .unwrap();
            archive
                .write_all(
                    &STANDARD
                        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
                        .unwrap(),
                )
                .unwrap();
        }
        archive.finish().unwrap();
    }

    pub(crate) fn tolerance_fixture(path: &Path, package: &str) {
        let mut archive = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, content) in [
            ("META-INF/container.xml", "<container><rootfiles><rootfile full-path=\"book.opf\"/></rootfiles></container>"),
            ("book.opf", package),
            ("chapter.xhtml", "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Working text</p></body></html>"),
            ("toc.ncx", "<ncx><navMap><navPoint><navLabel><text>Chapter</text></navLabel><content src=\"chapter.xhtml\"#chapter/></navPoint></navMap></ncx>"),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
    }

    pub(crate) const MISSING_DC_PACKAGE: &str = "<package version=\"3\"><metadata><dc:title xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Recovered</dc:title><dc:language>en</dc:language></metadata><manifest><item id=\"chapter\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chapter\"/></spine></package>";

    #[test]
    fn tolerant_import_and_relink_preserve_surviving_state_and_rollback() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let working = directory.path().join("working.epub");
        let recovered = directory.path().join("recovered.epub");
        let broken = directory.path().join("broken.epub");
        fixture(&working, Some("Working"), Some("Author"), true);
        tolerance_fixture(&recovered, MISSING_DC_PACKAGE);
        tolerance_fixture(&broken, "<package version=\"3\"><dc:title>Broken</package>");
        let sources = [&working, &recovered, &broken];
        let before: Vec<_> = sources.iter().map(|p| std::fs::read(p).unwrap()).collect();
        let mut connection = open_catalog(&database).unwrap();
        assert_eq!(
            import_paths(&mut connection, std::slice::from_ref(&working))[0].status,
            "imported"
        );
        let book = list_from_catalog(&connection).unwrap().remove(0);
        let original_row = catalog_row(&connection, &book.id);
        let position = reading_position::position(0, None, 0.5);
        reading_position::save_to(&connection, &book.id, &position).unwrap();
        let outcomes = import_paths(
            &mut connection,
            &[recovered.clone(), broken.clone(), working.clone()],
        );
        assert_eq!(
            outcomes.iter().map(|r| r.status).collect::<Vec<_>>(),
            ["imported", "failed", "alreadyImported"]
        );
        assert_eq!(catalog_row(&connection, &book.id), original_row);
        assert_eq!(
            reading_position::load_from(&connection, &book.id).unwrap(),
            Some(position.clone())
        );
        // A failed write after recovery must still roll back the catalog transaction.
        connection.execute_batch("CREATE TRIGGER refuse_recovered BEFORE INSERT ON books BEGIN SELECT RAISE(ABORT, 'refusal'); END;").unwrap();
        let retry = directory.path().join("retry.epub");
        tolerance_fixture(&retry, MISSING_DC_PACKAGE);
        assert_eq!(
            import_paths(&mut connection, std::slice::from_ref(&retry))[0].status,
            "failed"
        );
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 2);
        connection.execute_batch("DROP TRIGGER refuse_recovered; CREATE TRIGGER refuse_relink BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'refusal'); END;").unwrap();
        assert_ne!(
            relink_one(&mut connection, &book.id, &retry)
                .unwrap()
                .status,
            "relinked"
        );
        assert_eq!(catalog_row(&connection, &book.id), original_row);
        connection
            .execute_batch("DROP TRIGGER refuse_relink;")
            .unwrap();
        assert_eq!(
            relink_one(&mut connection, &book.id, &retry)
                .unwrap()
                .status,
            "relinked"
        );
        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        assert_eq!(
            get_book_from_catalog(&reopened, &book.id)
                .unwrap()
                .unwrap()
                .title
                .as_deref(),
            Some("Recovered")
        );
        assert_eq!(
            reading_position::load_from(&reopened, &book.id).unwrap(),
            Some(position)
        );
        for (source, bytes) in sources.iter().zip(before) {
            assert_eq!(std::fs::read(source).unwrap(), bytes);
        }
    }

    type CatalogRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Vec<u8>>,
        Option<String>,
        i64,
        String,
    );

    fn catalog_row(connection: &Connection, id: &str) -> CatalogRow {
        connection
            .query_row(
                "SELECT source_path, file_name, title, author, cover_mime, cover_bytes,
                        cover_discovery, cover_resolver_version, imported_at
                   FROM books WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .unwrap()
    }

    #[test]
    fn a_file_another_writer_adds_meanwhile_counts_as_already_imported() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("raced.epub");
        let database = directory.path().join("library.sqlite3");
        fixture(&source, Some("Raced"), None, false);
        let mut connection = open_catalog(&database).unwrap();
        // Another Komori adds the same file between the duplicate check and the insert.
        connection
            .execute_batch(
                "CREATE TEMP TRIGGER other_writer BEFORE INSERT ON books WHEN NEW.id <> 'other'
                 BEGIN
                   INSERT INTO books (id, source_path, file_name)
                   VALUES ('other', NEW.source_path, NEW.file_name);
                 END;",
            )
            .unwrap();
        let results = import_paths(&mut connection, std::slice::from_ref(&source));
        assert_eq!(results[0].status, "alreadyImported");
        assert_eq!(results[0].message, None);
    }

    #[test]
    fn import_is_durable_read_only_and_idempotent() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("sample.epub");
        let database = directory.path().join("library.sqlite3");
        fixture(
            &source,
            Some("  A Book(ドラゴンノベルス)【電子版特典付】  "),
            Some("An Author"),
            true,
        );
        let before = std::fs::read(&source).unwrap();
        let original_modified = source.metadata().unwrap().modified().unwrap();

        let mut connection = open_catalog(&database).unwrap();
        let first = import_paths(&mut connection, std::slice::from_ref(&source));
        assert_eq!(first[0].status, "imported");
        let second = import_paths(&mut connection, std::slice::from_ref(&source));
        assert_eq!(second[0].status, "alreadyImported");
        drop(connection);

        let reopened = open_catalog(&database).unwrap();
        let books = list_from_catalog(&reopened).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title.as_deref(), Some("A Book"));
        assert_eq!(books[0].author.as_deref(), Some("An Author"));
        assert_eq!(books[0].availability, "available");
        assert!(books[0].has_cover);
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(
            source.metadata().unwrap().modified().unwrap(),
            original_modified
        );
    }

    #[test]
    fn existing_titles_migrate_in_place_with_all_owned_state_and_restart_retention() {
        use rusqlite::types::Value;
        use std::collections::BTreeMap;

        fn snapshot(connection: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
            let mut tables = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .unwrap();
            let tables: Vec<String> = tables
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            tables
                .into_iter()
                .map(|table| {
                    let mut statement = connection
                        .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY 1"))
                        .unwrap();
                    let columns = statement.column_count();
                    let rows = statement
                        .query_map([], |row| {
                            (0..columns).map(|column| row.get(column)).collect()
                        })
                        .unwrap()
                        .collect::<Result<_, _>>()
                        .unwrap();
                    (table, rows)
                })
                .collect()
        }

        let directory = tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        let source = directory.path().join("existing.epub");
        fixture(&source, Some("Original"), Some("Author"), true);
        let bytes = std::fs::read(&source).unwrap();
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap().remove(0).id;
        let locator = crate::bookmarks::BookmarkLocator {
            spine_index: 2,
            section_key: "0a1b2c3d".into(),
            progress: 0.75,
            content_key: "a".repeat(64),
        };
        crate::reader_notes::create(
            &mut connection,
            &id,
            locator.clone(),
            "Passage".into(),
            "Thought".into(),
        )
        .unwrap();
        reading_position::save_to(
            &connection,
            &id,
            &reading_position::position(2, Some("0a1b2c3d"), 0.75),
        )
        .unwrap();
        connection.execute("INSERT INTO bookmarks (id, book_id, locator, label, excerpt) VALUES (?1, ?2, ?3, 'Place', 'Passage')", params![Uuid::new_v4().to_string(), id, locator.canonical().unwrap()]).unwrap();
        connection.execute("INSERT INTO book_progress (book_id, unit, current_units, total_units) VALUES (?1, 'characters', 75, 100)", [&id]).unwrap();
        connection.execute("INSERT INTO book_series (book_id, series, series_index) VALUES (?1, 'My series', 2)", [&id]).unwrap();
        connection.execute("INSERT INTO reading_sessions (id, book_id, started_at, ended_at, active_ms, unit, units_read, start_units, end_units, total_units, book_title) VALUES (?1, ?2, 1800000000000, 1800000001000, 1000, 'characters', 75, 0, 75, 100, 'Original')", params![Uuid::new_v4().to_string(), id]).unwrap();
        connection
            .execute(
                "UPDATE books SET title = '　【電子版】 Original！(GA文庫)　' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        for (name, title) in [
            ("only-tags", Some("【電子版】(GA文庫) ")),
            ("unrelated", Some("題名  (別の本)！")),
            ("missing-title", None),
        ] {
            connection
                .execute(
                    "INSERT INTO books (id, source_path, file_name, title) VALUES (?1, ?2, ?2, ?3)",
                    params![Uuid::new_v4().to_string(), name, title],
                )
                .unwrap();
        }
        connection.pragma_update(None, "user_version", 6).unwrap();
        let mut expected = snapshot(&connection);
        for row in expected.get_mut("books").unwrap() {
            if row[0] == Value::Text(id.clone()) {
                row[3] = Value::Text("Original！".into());
            } else if row[2] == Value::Text("only-tags".into()) {
                row[3] = Value::Null;
            }
        }
        drop(connection);

        // Unavailable EPUBs must be cleaned from cached metadata without opening a source.
        let moved = directory.path().join("moved.epub");
        std::fs::rename(&source, &moved).unwrap();
        for _ in 0..2 {
            let reopened = open_catalog(&database).unwrap();
            assert_eq!(snapshot(&reopened), expected);
            assert_eq!(
                get_book_from_catalog(&reopened, &id)
                    .unwrap()
                    .unwrap()
                    .title
                    .as_deref(),
                Some("Original！")
            );
            let version: i64 = reopened
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, SCHEMA_VERSION);
        }
        assert_eq!(std::fs::read(&moved).unwrap(), bytes);
    }

    #[test]
    fn tag_only_import_uses_the_existing_missing_title_fallback() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("tag-only.epub");
        fixture(
            &source,
            Some(" (GA文庫)【電子版】　"),
            Some("Author"),
            false,
        );
        let mut connection = open_catalog(&directory.path().join(CATALOG_FILE_NAME)).unwrap();
        assert_eq!(
            import_paths(&mut connection, &[source])[0].status,
            "imported"
        );
        let book = list_from_catalog(&connection).unwrap().remove(0);
        assert_eq!(book.title, None);
        assert_eq!(book.file_name, "tag-only.epub");
    }

    #[test]
    fn removal_is_catalog_scoped_persistent_and_preserves_source() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("remove-me.epub");
        let database = directory.path().join("library.sqlite3");
        fixture(&source, Some("Remove Me"), Some("Author"), true);
        let source_bytes = std::fs::read(&source).unwrap();
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let book = list_from_catalog(&connection).unwrap().remove(0);
        let derived_bytes: i64 = connection
            .query_row(
                "SELECT length(cover_bytes) FROM books WHERE id = ?1",
                [&book.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(derived_bytes > 0);
        let saved = reading_position::position(3, Some("0a1b2c3d"), 0.4);
        assert!(reading_position::save_to(&connection, &book.id, &saved).unwrap());

        assert!(remove_book_from_catalog(&connection, &book.id).unwrap());
        assert!(!remove_book_from_catalog(&connection, &book.id).unwrap());
        assert!(list_from_catalog(&connection).unwrap().is_empty());
        let remaining: i64 = connection
            .query_row(
                "SELECT count(*) FROM books WHERE id = ?1 OR source_path = ?2",
                params![book.id, source.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(
            reading_position::load_from(&connection, &book.id).unwrap(),
            None
        );
        let positions: i64 = connection
            .query_row("SELECT count(*) FROM reading_positions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(positions, 0);
        // A late save for the removed ID cannot recreate orphaned state.
        assert!(!reading_position::save_to(&connection, &book.id, &saved).unwrap());
        drop(connection);

        let reopened = open_catalog(&database).unwrap();
        assert!(list_from_catalog(&reopened).unwrap().is_empty());
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    }

    #[test]
    fn bulk_removal_preserves_successes_and_reports_missing_catalog_ids() {
        let directory = tempdir().unwrap();
        let first_source = directory.path().join("first.epub");
        let second_source = directory.path().join("second.epub");
        let database = directory.path().join("library.sqlite3");
        fixture(&first_source, Some("First"), None, false);
        fixture(&second_source, Some("Second"), None, false);
        let first_bytes = std::fs::read(&first_source).unwrap();
        let second_bytes = std::fs::read(&second_source).unwrap();
        let mut connection = open_catalog(&database).unwrap();
        import_paths(
            &mut connection,
            &[first_source.clone(), second_source.clone()],
        );
        let books = list_from_catalog(&connection).unwrap();
        let first_id = books
            .iter()
            .find(|book| book.title.as_deref() == Some("First"))
            .unwrap()
            .id
            .clone();
        let second_id = books
            .iter()
            .find(|book| book.title.as_deref() == Some("Second"))
            .unwrap()
            .id
            .clone();

        let saved = reading_position::position(1, None, 0.5);
        for id in [&first_id, &second_id] {
            assert!(reading_position::save_to(&connection, id, &saved).unwrap());
        }

        let results = remove_books_from_catalog(
            &connection,
            vec![first_id.clone(), "missing-catalog-id".into()],
        );

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, first_id);
        assert_eq!(results[0].status, "removed");
        assert!(results[0].message.is_none());
        assert_eq!(results[1].id, "missing-catalog-id");
        assert_eq!(results[1].status, "failed");
        assert_eq!(
            results[1].message.as_deref(),
            Some(crate::failure::BOOK_GONE)
        );

        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        let remaining = list_from_catalog(&reopened).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second_id);
        assert_eq!(
            reading_position::load_from(&reopened, &first_id).unwrap(),
            None
        );
        assert_eq!(
            reading_position::load_from(&reopened, &second_id).unwrap(),
            Some(saved)
        );
        assert_eq!(std::fs::read(first_source).unwrap(), first_bytes);
        assert_eq!(std::fs::read(second_source).unwrap(), second_bytes);
    }

    #[test]
    fn listing_reports_saved_progress_and_the_last_read_time() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("progress.epub");
        let database = directory.path().join("library.sqlite3");
        fixture(&source, Some("Progress"), Some("Author"), false);
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let book = list_from_catalog(&connection).unwrap().remove(0);
        assert_eq!(book.progress, None);
        assert_eq!(book.last_read_at, None);

        let saved = reading_position::position(1, None, 0.5);
        assert!(reading_position::save_to(&connection, &book.id, &saved).unwrap());
        let positioned = list_from_catalog(&connection).unwrap().remove(0);
        assert!(positioned.last_read_at.is_some());
        assert_eq!(positioned.progress, None);

        let progress = BookProgress {
            unit: "characters".into(),
            current: 250,
            total: 1000,
        };
        assert!(reading_position::save_progress_to(&connection, &book.id, &progress).unwrap());
        let listed = get_book_from_catalog(&connection, &book.id)
            .unwrap()
            .unwrap();
        assert_eq!(listed.progress, Some(progress));
        let serialized = serde_json::to_value(listed).unwrap();
        assert_eq!(
            serialized["progress"],
            serde_json::json!({ "unit": "characters", "current": 250, "total": 1000 })
        );
        assert!(serialized["lastReadAt"].is_string());

        // A malformed stored row lists as no progress rather than failing the Library.
        connection
            .execute("UPDATE book_progress SET current_units = 5000", [])
            .unwrap();
        assert_eq!(list_from_catalog(&connection).unwrap()[0].progress, None);
    }

    #[test]
    fn catalog_dto_serializes_the_stable_catalog_id_without_private_paths() {
        let book = LibraryBook {
            id: "stable-catalog-id".into(),
            title: Some("Book".into()),
            author: Some("Author".into()),
            file_name: "book.epub".into(),
            imported_at: "2026-09-23T00:00:00Z".into(),
            availability: "available",
            has_cover: true,
            cover_url: Some(covers::cover_url("stable-catalog-id", 2)),
            progress: None,
            last_read_at: None,
            language: Some("ja".into()),
            series: None,
            series_index: None,
            series_manual: false,
            characters: Some(1200),
            unique_kanji: Some(300),
            words: None,
        };

        let serialized = serde_json::to_value(book).unwrap();
        assert_eq!(serialized["id"], "stable-catalog-id");
        assert!(serialized["coverUrl"]
            .as_str()
            .unwrap()
            .ends_with("/stable-catalog-id/2"));
        assert_eq!(serialized["fileName"], "book.epub");
        assert_eq!(serialized["uniqueKanji"], 300);
        assert_eq!(serialized["seriesManual"], false);
        assert!(serialized.get("kanji").is_none());
        assert!(serialized.get("sourcePath").is_none());
        assert!(serialized.get("databasePath").is_none());
    }

    #[test]
    fn cached_cover_reopens_and_loads_by_the_serialized_catalog_id() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("covered.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&source, Some("Covered"), None, true);
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &[source]);
        let book = list_from_catalog(&connection).unwrap().remove(0);
        drop(connection);
        assert_eq!(
            book.cover_url.as_deref(),
            Some(covers::cover_url(&book.id, 0).as_str())
        );

        let reopened = open_catalog(&database).unwrap();
        let built: i64 = reopened
            .query_row(
                "SELECT cover_revision FROM book_thumbnails WHERE book_id = ?1",
                [&book.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(built, 0, "import stores the thumbnail with the book");
        let (revision, cover) = covers::load_thumbnail(&reopened, &book.id)
            .unwrap()
            .expect("cover should load by catalog ID after restart");
        assert_eq!(revision, 0);
        assert_eq!(cover.mime, "image/png");
        assert!(covers::load_thumbnail(&reopened, "missing-id")
            .unwrap()
            .is_none());
    }

    #[test]
    fn thumbnails_follow_cover_revisions_and_are_rebuilt_for_older_libraries() {
        let directory = tempdir().unwrap();
        let covered = directory.path().join("covered.epub");
        let plain = directory.path().join("plain.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&covered, Some("Covered"), None, true);
        fixture(&plain, Some("Plain"), None, false);
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &[covered, plain]);
        let books = list_from_catalog(&connection).unwrap();
        let covered = books.iter().find(|book| book.has_cover).unwrap();
        let plain = books.iter().find(|book| !book.has_cover).unwrap();
        assert_eq!(plain.cover_url, None);
        assert!(covers::load_thumbnail(&connection, &plain.id)
            .unwrap()
            .is_none());

        // A Library from before thumbnails, or a cover replaced since, has none current.
        connection
            .execute_batch(
                "DELETE FROM book_thumbnails;
                 UPDATE books SET cover_revision = 4 WHERE cover_bytes IS NOT NULL;",
            )
            .unwrap();
        assert_eq!(covers::build_missing_thumbnails(&database).unwrap(), 1);
        assert_eq!(covers::build_missing_thumbnails(&database).unwrap(), 0);
        let (revision, _) = covers::load_thumbnail(&connection, &covered.id)
            .unwrap()
            .unwrap();
        assert_eq!(revision, 4);

        // A stale thumbnail is rebuilt on request for the current revision.
        connection
            .execute(
                "UPDATE books SET cover_revision = 5 WHERE id = ?1",
                [&covered.id],
            )
            .unwrap();
        let (revision, _) = covers::load_thumbnail(&connection, &covered.id)
            .unwrap()
            .unwrap();
        assert_eq!(revision, 5);
        assert!(list_from_catalog(&connection)
            .unwrap()
            .iter()
            .any(|book| book.cover_url.as_deref()
                == Some(covers::cover_url(&covered.id, 5).as_str())));

        assert!(remove_book_from_catalog(&connection, &covered.id).unwrap());
        let thumbnails: i64 = connection
            .query_row("SELECT count(*) FROM book_thumbnails", [], |row| row.get(0))
            .unwrap();
        assert_eq!(thumbnails, 0, "removal cascades to the thumbnail");
    }

    #[test]
    fn compaction_returns_removed_books_space_and_keeps_every_record() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        let mut sources = Vec::new();
        for index in 0..6 {
            let source = directory.path().join(format!("book-{index}.epub"));
            fixture(&source, Some(&format!("Book {index}")), None, true);
            sources.push(source);
        }
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &sources);
        // Removed books leave their pages free; a large stand-in cover makes that measurable.
        connection
            .execute("UPDATE books SET cover_bytes = zeroblob(262144)", [])
            .unwrap();
        let books = list_from_catalog(&connection).unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let batch = remove_and_reclaim(
            &connection,
            &database,
            books[1..].iter().map(|book| book.id.clone()).collect(),
            &mut progress,
            0,
        );
        assert!(batch
            .results
            .iter()
            .all(|result| result.status == "removed"));
        let CompactionResult::Compacted {
            size_before,
            size_after,
        } = batch.maintenance.unwrap()
        else {
            panic!("the catalog should compact");
        };
        assert!(size_after < size_before, "{size_after} < {size_before}");
        assert_eq!(size_after, std::fs::metadata(&database).unwrap().len());
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.completed)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4, 5, 5]
        );
        assert!(events.iter().all(|event| event.total == Some(5)));
        assert_eq!(events.last().unwrap().phase, "reclaiming");
        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        let kept = list_from_catalog(&reopened).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, books[0].id);
        assert!(kept[0].has_cover);
    }

    #[test]
    fn a_small_removal_keeps_every_other_record_and_skips_compaction() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        let mut sources = Vec::new();
        for index in 0..3 {
            let source = directory.path().join(format!("book-{index}.epub"));
            fixture(&source, Some(&format!("Book {index}")), None, true);
            sources.push(source);
        }
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &sources);
        connection
            .execute("UPDATE books SET cover_bytes = zeroblob(262144)", [])
            .unwrap();
        let books = list_from_catalog(&connection).unwrap();
        let size = std::fs::metadata(&database).unwrap().len();
        let (mut progress, events) = crate::bulk_progress::recording();
        let batch = remove_and_reclaim(
            &connection,
            &database,
            vec![books[0].id.clone()],
            &mut progress,
            COMPACTION_MINIMUM_FREE,
        );
        assert_eq!(batch.results[0].status, "removed");
        assert_eq!(batch.maintenance, Some(CompactionResult::NotNeeded));
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.phase != "reclaiming"));
        assert_eq!(std::fs::metadata(&database).unwrap().len(), size);
        drop(connection);
        let kept = list_from_catalog(&open_catalog(&database).unwrap()).unwrap();
        assert_eq!(
            kept.iter()
                .map(|book| serde_json::to_value(book).unwrap())
                .collect::<Vec<_>>(),
            books[1..]
                .iter()
                .map(|book| serde_json::to_value(book).unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn removal_across_transaction_chunks_keeps_each_outcome() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        let connection = open_catalog(&database).unwrap();
        connection
            .execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 449)
                 INSERT INTO books (id, source_path, file_name)
                   SELECT 'book' || i, 'book' || i || '.epub', 'book.epub' FROM n;
                 CREATE TRIGGER refuse BEFORE DELETE ON books WHEN OLD.id = 'book250'
                   BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        let mut ids: Vec<String> = (0..450).map(|index| format!("book{index}")).collect();
        ids.insert(300, "unknown".into());
        let (mut progress, events) = crate::bulk_progress::recording();
        let results = remove_books_with_progress(&connection, ids.clone(), &mut progress);
        assert_eq!(
            results
                .iter()
                .map(|result| result.id.as_str())
                .collect::<Vec<_>>(),
            ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
        let failed: Vec<&str> = results
            .iter()
            .filter(|result| result.status == "failed")
            .map(|result| result.id.as_str())
            .collect();
        assert_eq!(failed, ["book250", "unknown"]);
        assert_eq!(events.lock().unwrap().last().unwrap().completed, 451);
        let left: Vec<String> = connection
            .prepare("SELECT id FROM books")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, ["book250"]);
        assert!(connection.is_autocommit());
    }

    #[test]
    fn whole_catalog_reads_follow_the_import_order_index() {
        let directory = tempdir().unwrap();
        let connection = open_catalog(&directory.path().join(CATALOG_FILE_NAME)).unwrap();
        for sql in [
            list_sql().as_str(),
            book_details::DETAILS_PENDING_SQL,
            crate::backup::BACKUP_BOOKS_SQL,
            crate::backup::CATALOG_BOOKS_SQL,
        ] {
            let plan: Vec<String> = connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map([], |row| row.get(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(
                plan.iter()
                    .any(|step| step.contains("SCAN books USING INDEX books_imported")),
                "{plan:?}"
            );
            assert!(
                !plan.iter().any(|step| step.contains("TEMP B-TREE")),
                "{plan:?}"
            );
        }
    }

    #[test]
    fn listing_availability_uses_file_attributes() {
        let directory = tempdir().unwrap();
        assert_eq!(
            source_availability(&directory.path().to_string_lossy()),
            "unreadable"
        );
        assert_eq!(
            source_availability(&directory.path().join("gone.epub").to_string_lossy()),
            "missing"
        );
        let present = directory.path().join("present.epub");
        fixture(&present, None, None, false);
        assert_eq!(source_availability(&present.to_string_lossy()), "available");
    }

    #[test]
    fn schema_probe_does_not_create_a_missing_catalog_and_observes_migration() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(CATALOG_FILE_NAME);
        assert_eq!(schema_version_at(&database).unwrap(), 0);
        assert!(!database.exists());

        drop(open_catalog(&database).unwrap());
        assert_eq!(schema_version_at(&database).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn mixed_batch_preserves_success_and_optional_metadata_gaps() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("untitled.epub");
        let invalid = directory.path().join("invalid.epub");
        let wrong_extension = directory.path().join("notes.txt");
        fixture(&source, None, None, false);
        std::fs::write(&invalid, b"not a zip").unwrap();
        std::fs::write(&wrong_extension, b"not an epub").unwrap();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();

        let result = import_paths(&mut connection, &[invalid, source.clone(), wrong_extension]);
        assert_eq!(
            result.iter().map(|item| item.status).collect::<Vec<_>>(),
            ["failed", "imported", "failed"]
        );
        assert_eq!(
            result[0].message.as_deref(),
            Some(crate::failure::EPUB_NOT_ARCHIVE)
        );
        assert_eq!(
            result[2].message.as_deref(),
            Some(crate::failure::CHOOSE_EPUB)
        );
        let books = list_from_catalog(&connection).unwrap();
        assert_eq!(books.len(), 1);
        assert!(books[0].title.is_none());
        assert!(books[0].author.is_none());
        assert!(!books[0].has_cover);
    }

    #[test]
    fn missing_source_stays_in_catalog() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("later-moved.epub");
        fixture(&source, Some("Keep My Place"), None, false);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap()[0].id.clone();
        std::fs::rename(&source, directory.path().join("moved.epub")).unwrap();

        let books = list_from_catalog(&connection).unwrap();
        assert_eq!(books[0].id, id);
        assert_eq!(books[0].title.as_deref(), Some("Keep My Place"));
        assert_eq!(books[0].availability, "missing");
    }

    #[test]
    fn single_book_lookup_matches_catalog_record_and_rejects_non_ids() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("reader-target.epub");
        fixture(&source, Some("Lookup"), Some("Author"), true);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap()[0].id.clone();

        let book = get_book_from_catalog(&connection, &id)
            .unwrap()
            .expect("an imported catalog ID resolves");
        assert_eq!(book.id, id);
        assert_eq!(book.title.as_deref(), Some("Lookup"));
        assert_eq!(book.availability, "available");
        assert!(book.has_cover);
        let serialized = serde_json::to_string(&book).unwrap();
        assert!(!serialized.contains(&source.to_string_lossy().into_owned()));

        for unknown in [
            Uuid::new_v4().to_string(),
            "../reader-target.epub".to_string(),
            source.to_string_lossy().into_owned(),
        ] {
            assert!(get_book_from_catalog(&connection, &unknown)
                .unwrap()
                .is_none());
        }

        std::fs::remove_file(&source).unwrap();
        let missing = get_book_from_catalog(&connection, &id).unwrap().unwrap();
        assert_eq!(missing.availability, "missing");
    }

    #[test]
    fn series_from_titles_names_volumes_unless_turned_off_and_after_series_set_by_hand() {
        let directory = tempdir().unwrap();
        let titles = [
            "Cat Tales 01",
            "Cat Tales 02",
            "Cat Tales 03",
            "Cat Tales 04",
            "Lone Book 01",
        ];
        let sources: Vec<PathBuf> = titles
            .iter()
            .enumerate()
            .map(|(index, title)| {
                let source = directory.path().join(format!("{index}.epub"));
                fixture(&source, Some(title), None, false);
                source
            })
            .collect();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, &sources);
        let shown = |connection: &Connection| -> BTreeMap<String, (Option<String>, Option<f64>)> {
            list_from_catalog(connection)
                .unwrap()
                .into_iter()
                .map(|book| (book.title.unwrap(), (book.series, book.series_index)))
                .collect()
        };
        let id_of = |title: &str| {
            list_from_catalog(&connection)
                .unwrap()
                .into_iter()
                .find(|book| book.title.as_deref() == Some(title))
                .unwrap()
                .id
        };
        let (second, third, fourth) = (
            id_of("Cat Tales 02"),
            id_of("Cat Tales 03"),
            id_of("Cat Tales 04"),
        );
        let cat_tales = |index| (Some("Cat Tales".to_owned()), Some(index));
        // On by default.
        assert_eq!(
            shown(&connection).into_values().collect::<Vec<_>>(),
            vec![
                cat_tales(1.0),
                cat_tales(2.0),
                cat_tales(3.0),
                cat_tales(4.0),
                (None, None)
            ]
        );

        // No series by hand for one volume, and the series by hand for another.
        connection
            .execute(
                "INSERT INTO book_series (book_id, series, series_index)
                 VALUES (?1, NULL, NULL), (?2, 'Cat Tales', 9)",
                params![third, fourth],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES ('appearance', ?1)",
                [r#"{"librarySeriesFromTitles":true}"#],
            )
            .unwrap();
        assert_eq!(
            shown(&connection).into_values().collect::<Vec<_>>(),
            vec![
                cat_tales(1.0),
                cat_tales(2.0),
                (None, None),
                cat_tales(9.0),
                (None, None)
            ]
        );
        // The Reader's lookup of one book agrees with the Library.
        let book = get_book_from_catalog(&connection, &second)
            .unwrap()
            .unwrap();
        assert_eq!((book.series, book.series_index), cat_tales(2.0));
        assert!(!book.series_manual);
        let book = get_book_from_catalog(&connection, &third).unwrap().unwrap();
        assert_eq!(book.series, None);

        connection
            .execute(
                "UPDATE preferences SET value = ?1",
                [r#"{"librarySeriesFromTitles":false}"#],
            )
            .unwrap();
        assert_eq!(shown(&connection)["Cat Tales 01"], (None, None));
        let book = get_book_from_catalog(&connection, &second)
            .unwrap()
            .unwrap();
        assert_eq!(book.series, None);
    }

    #[test]
    fn relink_preserves_catalog_identity_owned_state_and_source_bytes_across_restart() {
        let directory = tempdir().unwrap();
        let original = directory.path().join("original.epub");
        let moved_original = directory.path().join("original-moved.epub");
        let replacement = directory.path().join("replacement.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&original, Some("Old Metadata"), Some("Old Author"), false);
        fixture(
            &replacement,
            Some("【電子版】 Refreshed Metadata (MFブックス)"),
            Some("New Author"),
            true,
        );
        let original_hash = Sha256::digest(std::fs::read(&original).unwrap());
        let replacement_hash = Sha256::digest(std::fs::read(&replacement).unwrap());
        let original_modified = original.metadata().unwrap().modified().unwrap();
        let replacement_modified = replacement.metadata().unwrap().modified().unwrap();

        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&original));
        let before = list_from_catalog(&connection).unwrap().remove(0);
        let id = before.id.clone();
        let imported_at = before.imported_at.clone();
        connection
            .execute_batch(
                "CREATE TABLE book_owned_state (
                   book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
                   marker TEXT NOT NULL
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO book_owned_state (book_id, marker) VALUES (?1, 'preserved')",
                [&id],
            )
            .unwrap();
        crate::reader_notes::create(
            &mut connection,
            &id,
            crate::bookmarks::BookmarkLocator {
                spine_index: 2,
                section_key: "0a1b2c3d".into(),
                progress: 0.75,
                content_key: "a".repeat(64),
            },
            "Original passage".into(),
            "Preserved thought".into(),
        )
        .unwrap();
        let saved = reading_position::position(2, Some("0a1b2c3d"), 0.75);
        assert!(reading_position::save_to(&connection, &id, &saved).unwrap());
        std::fs::rename(&original, &moved_original).unwrap();
        assert_eq!(
            list_from_catalog(&connection).unwrap()[0].availability,
            "missing"
        );

        let result = relink_one(&mut connection, &id, &replacement).unwrap();
        assert_eq!(result.status, "relinked");
        assert!(result.message.is_none());
        let after = list_from_catalog(&connection).unwrap().remove(0);
        assert_eq!(after.id, id);
        assert_eq!(after.imported_at, imported_at);
        assert_eq!(after.title.as_deref(), Some("Refreshed Metadata"));
        assert_eq!(after.author.as_deref(), Some("New Author"));
        assert_eq!(after.file_name, "replacement.epub");
        assert_eq!(after.availability, "available");
        assert!(after.has_cover);
        let marker: String = connection
            .query_row(
                "SELECT marker FROM book_owned_state WHERE book_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, "preserved");
        let (revision, cover) = covers::load_thumbnail(&connection, &id).unwrap().unwrap();
        assert_eq!(revision, 1, "relinking starts a new cover revision");
        assert_eq!(cover.mime, "image/png");
        assert_eq!(
            after.cover_url.as_deref(),
            Some(covers::cover_url(&id, 1).as_str())
        );
        drop(connection);

        let reopened = open_catalog(&database).unwrap();
        let persisted = list_from_catalog(&reopened).unwrap().remove(0);
        assert_eq!(persisted.id, id);
        assert_eq!(persisted.title.as_deref(), Some("Refreshed Metadata"));
        assert_eq!(persisted.availability, "available");
        assert!(persisted.has_cover);
        let stored_path: String = reopened
            .query_row(
                "SELECT source_path FROM books WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored_path,
            replacement.canonicalize().unwrap().to_string_lossy()
        );
        let marker: String = reopened
            .query_row(
                "SELECT marker FROM book_owned_state WHERE book_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, "preserved");
        let notes = crate::reader_notes::list(&reopened, &id).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body, "Preserved thought");
        assert_eq!(notes[0].passage, "Original passage");
        // The Reader decides whether the kept position still resolves in the new source.
        assert_eq!(
            reading_position::load_from(&reopened, &id).unwrap(),
            Some(saved)
        );
        assert_eq!(
            Sha256::digest(std::fs::read(&moved_original).unwrap()),
            original_hash
        );
        assert_eq!(
            Sha256::digest(std::fs::read(&replacement).unwrap()),
            replacement_hash
        );
        assert_eq!(
            moved_original.metadata().unwrap().modified().unwrap(),
            original_modified
        );
        assert_eq!(
            replacement.metadata().unwrap().modified().unwrap(),
            replacement_modified
        );
    }

    #[test]
    fn canceled_relink_does_not_open_or_mutate_the_catalog() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("cancel.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&source, Some("Stay Put"), None, false);
        let source_hash = Sha256::digest(std::fs::read(&source).unwrap());
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap().remove(0).id;
        let before_row = catalog_row(&connection, &id);
        drop(connection);
        let before_database = std::fs::read(&database).unwrap();

        let result = relink_selection(&database, &id, None).unwrap();

        assert_eq!(result.status, "canceled");
        assert!(result.message.is_none());
        assert_eq!(std::fs::read(&database).unwrap(), before_database);
        let reopened = open_catalog(&database).unwrap();
        assert_eq!(catalog_row(&reopened, &id), before_row);
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()), source_hash);
    }

    #[test]
    fn invalid_epub_relink_leaves_the_original_record_untouched() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("valid.epub");
        let invalid = directory.path().join("invalid.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&source, Some("Original"), Some("Author"), true);
        std::fs::write(&invalid, b"not an epub archive").unwrap();
        let source_hash = Sha256::digest(std::fs::read(&source).unwrap());
        let invalid_hash = Sha256::digest(std::fs::read(&invalid).unwrap());
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap().remove(0).id;
        let before = catalog_row(&connection, &id);

        let result = relink_one(&mut connection, &id, &invalid).unwrap();

        assert_eq!(result.status, "invalid");
        assert_eq!(catalog_row(&connection, &id), before);
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()), source_hash);
        assert_eq!(
            Sha256::digest(std::fs::read(&invalid).unwrap()),
            invalid_hash
        );
    }

    #[test]
    fn failed_relink_read_leaves_the_original_record_untouched() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("valid.epub");
        let unavailable = directory.path().join("unavailable.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&source, Some("Original"), None, false);
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap().remove(0).id;
        let before = catalog_row(&connection, &id);

        let result = relink_one(&mut connection, &id, &unavailable).unwrap();

        assert_eq!(result.status, "readFailed");
        assert_eq!(catalog_row(&connection, &id), before);
    }

    #[test]
    fn duplicate_relink_target_is_rejected_without_merging_records() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.epub");
        let second = directory.path().join("second.epub");
        let database = directory.path().join(CATALOG_FILE_NAME);
        fixture(&first, Some("First"), None, false);
        fixture(&second, Some("Second"), None, true);
        let first_hash = Sha256::digest(std::fs::read(&first).unwrap());
        let second_hash = Sha256::digest(std::fs::read(&second).unwrap());
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &[first.clone(), second.clone()]);
        let books = list_from_catalog(&connection).unwrap();
        let first_id = books
            .iter()
            .find(|book| book.title.as_deref() == Some("First"))
            .unwrap()
            .id
            .clone();
        let second_id = books
            .iter()
            .find(|book| book.title.as_deref() == Some("Second"))
            .unwrap()
            .id
            .clone();
        let first_before = catalog_row(&connection, &first_id);
        let second_before = catalog_row(&connection, &second_id);

        let result = relink_one(&mut connection, &first_id, &second).unwrap();

        assert_eq!(result.status, "duplicate");
        assert_eq!(
            result.message.as_deref(),
            Some(crate::failure::EPUB_LINKED_ELSEWHERE)
        );
        assert_eq!(catalog_row(&connection, &first_id), first_before);
        assert_eq!(catalog_row(&connection, &second_id), second_before);
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 2);
        assert_eq!(Sha256::digest(std::fs::read(&first).unwrap()), first_hash);
        assert_eq!(Sha256::digest(std::fs::read(&second).unwrap()), second_hash);
    }

    #[test]
    fn catalog_schema_reopens_and_rejects_newer_versions() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        connection
            .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
            .unwrap();
        drop(connection);
        assert_eq!(
            open_catalog(&database).err().as_deref(),
            Some(crate::failure::LIBRARY_NEWER)
        );
    }

    #[test]
    fn catalog_rolls_back_a_hot_journal_left_by_an_interrupted_write() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "INSERT INTO books (id, source_path, file_name, title) VALUES ('kept', 'kept.epub', 'kept.epub', 'Kept')",
                [],
            )
            .unwrap();
        // A small page cache spills the open transaction's changes into the file, as a large
        // removal or compaction does, behind a journal of the original pages.
        connection
            .execute_batch(
                "PRAGMA cache_size = 2;
                 BEGIN;
                 DELETE FROM books;
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
                 INSERT INTO books (id, source_path, file_name, cover_bytes)
                   SELECT 'new' || i, 'new' || i || '.epub', 'new.epub', zeroblob(8192) FROM n;",
            )
            .unwrap();
        // Copying the catalog with its journal mid-transaction is what a kill leaves behind.
        let crashed = directory.path().join("crashed");
        std::fs::create_dir(&crashed).unwrap();
        let copy = crashed.join("library.sqlite3");
        std::fs::copy(&database, &copy).unwrap();
        std::fs::copy(
            directory.path().join("library.sqlite3-journal"),
            crashed.join("library.sqlite3-journal"),
        )
        .unwrap();
        drop(connection);

        assert_eq!(schema_version_at(&copy).unwrap(), SCHEMA_VERSION);
        let reopened = open_catalog(&copy).unwrap();
        let books: Vec<(String, Option<String>)> = reopened
            .prepare("SELECT id, title FROM books")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(books, vec![("kept".to_string(), Some("Kept".to_string()))]);
        assert!(!crashed.join("library.sqlite3-journal").exists());
    }

    #[test]
    fn version_one_catalog_migrates_for_cover_backfill() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE books (
                   id TEXT PRIMARY KEY,
                   source_path TEXT NOT NULL UNIQUE,
                   file_name TEXT NOT NULL,
                   title TEXT,
                   author TEXT,
                   cover_mime TEXT,
                   cover_bytes BLOB,
                   imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        drop(connection);

        let migrated = open_catalog(&database).unwrap();
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        migrated
            .prepare("SELECT cover_discovery, cover_resolver_version FROM books")
            .unwrap();
        migrated
            .prepare("SELECT book_id, spine_index, section_key, progress FROM reading_positions")
            .unwrap();
        migrated
            .prepare("SELECT name, value FROM preferences")
            .unwrap();
    }

    #[test]
    fn startup_and_listing_leave_legacy_covers_to_the_background() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut connection = open_catalog(&database).unwrap();
        let sources: Vec<PathBuf> = (0..3)
            .map(|index| {
                let source = directory.path().join(format!("legacy-{index}.epub"));
                fixture(&source, Some(&format!("Legacy {index}")), None, true);
                source
            })
            .collect();
        import_paths(&mut connection, &sources);
        connection
            .execute_batch(
                "UPDATE books SET cover_mime = NULL, cover_bytes = NULL, cover_discovery = NULL,
                                  cover_resolver_version = 0",
            )
            .unwrap();
        drop(connection);
        let covered = |database: &Path| -> i64 {
            open_catalog(database)
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM books WHERE cover_bytes IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };

        // The window opens and the Library lists before any EPUB is read for its cover.
        drop(open_at_startup(&database).unwrap());
        assert!(list_at(&database)
            .unwrap()
            .iter()
            .all(|book| !book.has_cover));
        assert_eq!(covered(&database), 0);

        // The background backfill commits each chunk, so other connections see covers arrive.
        let mut connection = open_catalog(&database).unwrap();
        let mut seen = Vec::new();
        let found = backfill_missing_covers_in_chunks(&mut connection, 2, |found| {
            seen.push((found, covered(&database)));
        })
        .unwrap();
        assert_eq!((found, seen), (3, vec![(2, 2), (1, 3)]));
        assert!(list_at(&database)
            .unwrap()
            .iter()
            .all(|book| book.has_cover));
        assert_eq!(backfill_covers_at(&database, None).unwrap(), 0);
    }

    #[test]
    fn existing_coverless_record_is_backfilled_without_changing_identity() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("backfill.epub");
        let before = std::fs::read(&source).unwrap_or_default();
        fixture(&source, Some("Backfill Me"), None, true);
        let source_bytes = std::fs::read(&source).unwrap();
        assert_ne!(source_bytes, before);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap()[0].id.clone();
        connection
            .execute(
                "UPDATE books
                    SET cover_mime = NULL, cover_bytes = NULL, cover_discovery = NULL,
                        cover_resolver_version = 0
                  WHERE id = ?1",
                [&id],
            )
            .unwrap();

        assert_eq!(backfill_missing_covers(&mut connection).unwrap(), 1);
        assert_eq!(backfill_missing_covers(&mut connection).unwrap(), 0);
        let books = list_from_catalog(&connection).unwrap();
        assert_eq!(books[0].id, id);
        assert!(books[0].has_cover);
        let discovery: String = connection
            .query_row(
                "SELECT cover_discovery FROM books WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(discovery, "epub3-cover-image");
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    }

    #[test]
    fn unsuccessful_backfill_records_native_diagnostic_without_cover_data() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("no-cover.epub");
        fixture(&source, Some("No Cover"), None, false);
        let source_bytes = std::fs::read(&source).unwrap();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        let id = list_from_catalog(&connection).unwrap()[0].id.clone();
        connection
            .execute(
                "UPDATE books SET cover_resolver_version = 0 WHERE id = ?1",
                [&id],
            )
            .unwrap();

        assert_eq!(backfill_missing_covers(&mut connection).unwrap(), 0);
        let state: (Option<String>, Option<Vec<u8>>, Option<String>, i64) = connection
            .query_row(
                "SELECT cover_mime, cover_bytes, cover_discovery, cover_resolver_version
                   FROM books WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            state,
            (
                None,
                None,
                Some("no-credible-cover-evidence".into()),
                COVER_RESOLVER_VERSION
            )
        );
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn diagnose_existing_coverless_catalog() {
        let database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open catalog read-only");
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        println!("catalog schema version: {schema_version}");
        let mut statement = connection
            .prepare(
                "SELECT file_name, source_path
                   FROM books
                  WHERE cover_bytes IS NULL
                  ORDER BY file_name",
            )
            .unwrap();
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!records.is_empty(), "catalog has no coverless records");

        let mut counts = BTreeMap::new();
        for (file_name, source_path) in &records {
            let diagnostic = File::open(source_path)
                .map_err(|_| ())
                .and_then(|source| epub::read(source).map_err(|_| ()))
                .map_or("invalid-or-unreadable-cover-target", |metadata| {
                    metadata.cover_diagnostic.code()
                });
            *counts.entry(diagnostic).or_insert(0usize) += 1;
            println!("{file_name}: {diagnostic}");
        }
        println!("coverless records: {}", records.len());
        for (diagnostic, count) in counts {
            println!("{diagnostic}: {count}");
        }
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn hash_existing_catalog_sources() {
        let database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open catalog read-only");
        let mut statement = connection
            .prepare("SELECT id, source_path FROM books ORDER BY id")
            .unwrap();
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut catalog_hash = Sha256::new();
        for (id, source_path) in &records {
            let source_hash = Sha256::digest(std::fs::read(source_path).unwrap());
            catalog_hash.update(id.as_bytes());
            catalog_hash.update([0]);
            catalog_hash.update(source_hash);
        }
        println!(
            "{} catalog sources; aggregate SHA-256 {:x}",
            records.len(),
            catalog_hash.finalize()
        );
    }

    #[test]
    #[ignore = "creates explicit disposable manual-validation EPUBs"]
    fn create_manual_removal_fixtures() {
        let directory = std::env::var_os("KOMORI_MANUAL_FIXTURE_DIR")
            .map(PathBuf::from)
            .expect("set KOMORI_MANUAL_FIXTURE_DIR");
        std::fs::create_dir_all(&directory).unwrap();
        for (file_name, title) in [
            ("komori-removal-smoke.epub", "Komori Single Removal Smoke"),
            ("komori-bulk-a.epub", "Komori Bulk Removal A"),
            ("komori-bulk-b.epub", "Komori Bulk Removal B"),
        ] {
            let path = directory.join(file_name);
            fixture(&path, Some(title), Some("Komori Validation"), true);
            println!("created {file_name}");
        }
    }

    #[test]
    #[ignore = "creates explicit disposable manual-validation EPUBs"]
    fn create_manual_relink_fixtures() {
        let directory = std::env::var_os("KOMORI_MANUAL_FIXTURE_DIR")
            .map(PathBuf::from)
            .expect("set KOMORI_MANUAL_FIXTURE_DIR");
        std::fs::create_dir_all(&directory).unwrap();
        for (file_name, title, author, with_cover) in [
            (
                "komori-relink-original.epub",
                "Komori Relink Original",
                "Original Author",
                false,
            ),
            (
                "komori-relink-duplicate.epub",
                "Komori Relink Duplicate Target",
                "Duplicate Author",
                true,
            ),
            (
                "komori-relink-replacement.epub",
                "Komori Relink Repaired",
                "Replacement Author",
                true,
            ),
        ] {
            let path = directory.join(file_name);
            fixture(&path, Some(title), Some(author), with_cover);
            println!("created {file_name}");
        }
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn inspect_manual_relink_catalog() {
        let database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open catalog read-only");
        let books = list_from_catalog(&connection).unwrap();
        for book in books {
            let discovery: Option<String> = connection
                .query_row(
                    "SELECT cover_discovery FROM books WHERE id = ?1",
                    [&book.id],
                    |row| row.get(0),
                )
                .unwrap();
            println!(
                "{} | {} | {} | {} | {}",
                book.id,
                book.file_name,
                book.title.as_deref().unwrap_or("Untitled book"),
                book.availability,
                discovery.as_deref().unwrap_or("no-cover-diagnostic")
            );
        }
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn validate_live_catalog_current_state() {
        let database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open catalog read-only");
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let (books, coverless): (i64, i64) = connection
            .query_row(
                "SELECT count(*),
                        coalesce(sum(CASE WHEN cover_bytes IS NULL THEN 1 ELSE 0 END), 0)
                   FROM books",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(schema_version, SCHEMA_VERSION);
        if let Ok(expected) = std::env::var("KOMORI_EXPECTED_BOOKS") {
            assert_eq!(books, expected.parse::<i64>().unwrap());
        }
        assert_eq!(coverless, 0, "every live record should now have a cover");
        println!(
            "live catalog schema {schema_version}; {books} books; {coverless} coverless records"
        );
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn validate_existing_coverless_catalog_backfill() {
        let source_database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        std::fs::copy(source_database, &database).unwrap();
        let mut connection = open_catalog(&database).unwrap();
        let pending: i64 = connection
            .query_row(
                "SELECT count(*) FROM books WHERE cover_bytes IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_paths = {
            let mut statement = connection
                .prepare("SELECT source_path FROM books WHERE cover_bytes IS NULL")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let before: Vec<_> = source_paths
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();

        let refreshed = backfill_missing_covers(&mut connection).unwrap();
        let remaining: i64 = connection
            .query_row(
                "SELECT count(*) FROM books WHERE cover_bytes IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(refreshed as i64, pending);
        assert_eq!(remaining, 0);
        let removal_target: String = connection
            .query_row(
                "SELECT id FROM books WHERE source_path = ?1 AND cover_bytes IS NOT NULL",
                [&source_paths[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert!(remove_book_from_catalog(&connection, &removal_target).unwrap());
        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        let removed_rows: i64 = reopened
            .query_row(
                "SELECT count(*) FROM books WHERE id = ?1",
                [&removal_target],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(removed_rows, 0);
        for (path, bytes) in source_paths.iter().zip(before) {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        println!(
            "backfilled all {refreshed} coverless records and removed one derived-data row from a catalog copy"
        );
    }

    #[test]
    #[ignore = "requires an explicit private Komori catalog path"]
    fn validate_representative_existing_covers() {
        let database = std::env::var_os("KOMORI_LIBRARY_DATABASE")
            .map(PathBuf::from)
            .expect("set KOMORI_LIBRARY_DATABASE");
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open catalog read-only");
        let mut statement = connection
            .prepare(
                "SELECT file_name, source_path
                   FROM books
                  WHERE cover_bytes IS NOT NULL
                  ORDER BY file_name
                  LIMIT 5",
            )
            .unwrap();
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(records.len(), 5);
        for (file_name, source_path) in records {
            let metadata = epub::read(File::open(source_path).unwrap()).unwrap();
            assert!(metadata.cover.is_some(), "{file_name} should still resolve");
            println!("{file_name}: {}", metadata.cover_diagnostic.code());
        }
    }

    #[test]
    #[ignore = "requires explicit read-only real EPUB sample paths"]
    fn real_corpus_smoke() {
        let samples = std::env::var("KOMORI_EPUB_SAMPLES").expect("set KOMORI_EPUB_SAMPLES");
        let paths: Vec<PathBuf> = samples.split('|').map(PathBuf::from).collect();
        assert!(!paths.is_empty());
        let before: Vec<Vec<u8>> = paths
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();
        let directory = tempdir().unwrap();
        let database = std::env::var_os("KOMORI_SMOKE_DATABASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.path().join("library.sqlite3"));
        let mut connection = open_catalog(&database).unwrap();
        let results = import_paths(&mut connection, &paths);
        for result in &results {
            println!("{}: {}", result.file_name, result.status);
            assert!(
                result.status == "imported" || result.status == "alreadyImported",
                "{:?}",
                result.message
            );
        }
        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        let books = list_from_catalog(&reopened).unwrap();
        for path in &paths {
            let file_name = path.file_name().unwrap().to_string_lossy();
            let book = books
                .iter()
                .find(|book| book.file_name == file_name && book.availability == "available")
                .expect("sample should stay available");
            assert!(
                book.has_cover,
                "{} should have a discovered cover",
                file_name
            );
            let discovery: String = reopened
                .query_row(
                    "SELECT cover_discovery FROM books WHERE id = ?1",
                    [&book.id],
                    |row| row.get(0),
                )
                .unwrap();
            println!("cover discovery: {discovery}");
        }
        for (path, bytes) in paths.iter().zip(before) {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }
}
