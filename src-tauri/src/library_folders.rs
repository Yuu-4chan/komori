//! Book folders: folders the reader adds in Settings, whose new EPUBs Komori imports whenever it
//! starts or the Library is opened.
//!
//! `library_folders` holds each folder's canonical path behind an integer ID; the frontend sees
//! the folder's display path but names a folder only by its ID, so it never hands Komori a path.
//! `library_folder_files` remembers every EPUB a scan has met, by path, with the source stamp it
//! had and whether it is (or was) in the Library. A scan imports only files it has not met, so a
//! book removed from the Library is not imported again; a file that failed (a copy still being
//! written, say) is tried again once its size or modified time change. Removing a folder forgets
//! the files it met that are not in the Library, so adding it again brings them back. Both tables
//! are additive and created without a schema bump. Folders and their files are only read.
//!
//! On the phone a folder is the link Android's folder picker grants, whose read permission
//! Komori keeps, and its books are the links of its documents under it; the plugin lists them.
//! The folder's permission stays while it is a book folder or any book in the Library is read
//! through it.

#[cfg(desktop)]
use crate::interface_text::{self, Text};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    book_details::source_stamp,
    bulk_progress::BatchProgress,
    library::{import_paths, open_catalog, storage_error, CatalogState, ImportResult},
};

const MAX_FOLDERS: i64 = 64;
/// How deep a scan follows subfolders, and how many EPUBs one folder may hold.
const MAX_DEPTH: usize = 32;
const MAX_FILES: usize = 100_000;

/// One scan at a time: a second waits, then finds the first's files already met.
static SCANNING: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    id: i64,
    /// The folder as the reader knows it, without Windows' verbatim prefix.
    path: String,
    availability: &'static str,
    /// Library books whose source is in this folder or its subfolders.
    books: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFolderResult {
    /// `added`, `canceled`, `duplicate`, `tooMany`, or `failed`.
    status: &'static str,
    message: Option<String>,
    /// The new folder's first scan.
    results: Vec<ImportResult>,
}

pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS library_folders (
               id INTEGER PRIMARY KEY,
               path TEXT NOT NULL UNIQUE,
               added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             CREATE TABLE IF NOT EXISTS library_folder_files (
               path TEXT PRIMARY KEY,
               stamp TEXT,
               in_library INTEGER NOT NULL
             );",
        )
        .map_err(storage_error)
}

#[tauri::command]
pub async fn list_library_folders(
    catalog: State<'_, CatalogState>,
) -> Result<Vec<LibraryFolder>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || folders(&open_catalog(&database)?))
        .await
        .map_err(|error| format!("Folder task failed: {error}"))?
}

/// Picks a folder natively (on the phone, with Android's folder picker), adds it, and imports
/// its EPUBs at once.
#[tauri::command]
pub async fn add_library_folder(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    operation_id: Option<String>,
) -> Result<AddFolderResult, String> {
    #[cfg(desktop)]
    let window = app.clone();
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    progress.phase("picking");
    #[cfg(desktop)]
    let selected = {
        let language = interface_text::language(&catalog.database);
        crate::library::window_picker(&window)
            .set_title(interface_text::text(language, Text::AddBookFolder))
            .pick_folder()
            .await
            .map(|folder| folder.path().to_path_buf())
    };
    #[cfg(mobile)]
    let selected = crate::android::pick_folder().await?;
    let Some(selected) = selected else {
        return Ok(added("canceled", None));
    };
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = open_catalog(&database)?;
        #[cfg(desktop)]
        let result = add_folder_with_progress(&mut connection, &selected, &mut progress);
        #[cfg(mobile)]
        let result = add_tree_with_progress(&mut connection, selected, &mut progress);
        result
    })
    .await
    .map_err(|error| format!("Folder task failed: {error}"))?
}

/// Stops scanning a folder; its books stay in the Library.
#[tauri::command]
pub async fn remove_library_folder(
    catalog: State<'_, CatalogState>,
    id: i64,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = open_catalog(&database)?;
        let removed = remove_folder(&mut connection, id)?;
        #[cfg(mobile)]
        crate::library::release_unlinked(&connection);
        Ok(removed)
    })
    .await
    .map_err(|error| format!("Folder task failed: {error}"))?
}

/// Removes a folder and forgets the files it met that are no longer in the Library, unless
/// another folder still covers them, so adding it again imports the books removed meanwhile.
pub(crate) fn remove_folder(connection: &mut Connection, id: i64) -> Result<bool, String> {
    let _scanning = SCANNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let transaction = connection.transaction().map_err(storage_error)?;
    let Some(path) = transaction
        .query_row(
            "SELECT path FROM library_folders WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?
    else {
        return Ok(false);
    };
    transaction
        .execute("DELETE FROM library_folders WHERE id = ?1", [id])
        .map_err(storage_error)?;
    let remaining: Vec<String> = {
        let mut statement = transaction
            .prepare("SELECT path FROM library_folders")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.map(|path| path.map(|path| prefix_of(&path)))
            .collect::<Result<_, _>>()
            .map_err(storage_error)?
    };
    let met: Vec<String> = {
        let mut statement = transaction
            .prepare(
                "SELECT path FROM library_folder_files
                 WHERE substr(path, 1, length(?1)) = ?1
                   AND path NOT IN (SELECT source_path FROM books)",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([prefix_of(&path)], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    for file in met.iter().filter(|file| {
        !remaining
            .iter()
            .any(|prefix| file.starts_with(prefix.as_str()))
    }) {
        transaction
            .execute("DELETE FROM library_folder_files WHERE path = ?1", [file])
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(true)
}

/// Imports the EPUBs every folder holds that no scan has met before.
#[tauri::command]
pub async fn scan_library_folders(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    operation_id: Option<String>,
) -> Result<Vec<ImportResult>, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = open_catalog(&database)?;
        scan_all_with_progress(&mut connection, &mut progress)
    })
    .await
    .map_err(|error| format!("Folder scan failed: {error}"))?
}

fn added(status: &'static str, message: Option<&str>) -> AddFolderResult {
    AddFolderResult {
        status,
        message: message.map(str::to_string),
        results: Vec::new(),
    }
}

#[cfg(test)]
pub(crate) fn add_folder(
    connection: &mut Connection,
    selected: &Path,
) -> Result<AddFolderResult, String> {
    add_folder_with_progress(connection, selected, &mut BatchProgress::silent())
}

#[cfg(any(desktop, test))]
fn add_folder_with_progress(
    connection: &mut Connection,
    selected: &Path,
    progress: &mut BatchProgress,
) -> Result<AddFolderResult, String> {
    let canonical = match selected.canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => return Ok(added("failed", Some(crate::failure::FOLDER_UNOPENABLE))),
    };
    let path = canonical.to_string_lossy().into_owned();
    if let Some(refused) = register(connection, &path)? {
        return Ok(refused);
    }
    let _scanning = SCANNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(AddFolderResult {
        status: "added",
        message: None,
        results: scan_paths(connection, &[path], progress)?,
    })
}

/// Adds the folder the phone's picker granted, and gives its permission back when it is not
/// added.
#[cfg(mobile)]
fn add_tree_with_progress(
    connection: &mut Connection,
    tree: String,
    progress: &mut BatchProgress,
) -> Result<AddFolderResult, String> {
    let refused = register(connection, &tree);
    if !matches!(refused, Ok(None)) {
        crate::library::release_unlinked(connection);
        return refused.map(|refused| refused.unwrap_or_else(|| added("failed", None)));
    }
    let _scanning = SCANNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(AddFolderResult {
        status: "added",
        message: None,
        results: scan_paths(connection, &[tree], progress)?,
    })
}

/// Records a new folder, or answers why it is not added: it is already a book folder, or there
/// are too many.
fn register(connection: &Connection, path: &str) -> Result<Option<AddFolderResult>, String> {
    let (exists, count): (bool, i64) = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM library_folders WHERE path = ?1),
                    (SELECT count(*) FROM library_folders)",
            [&path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if exists {
        return Ok(Some(added(
            "duplicate",
            Some(crate::failure::FOLDER_DUPLICATE),
        )));
    }
    if count >= MAX_FOLDERS {
        return Ok(Some(added("tooMany", Some(crate::failure::FOLDER_LIMIT))));
    }
    connection
        .execute("INSERT INTO library_folders (path) VALUES (?1)", [path])
        .map_err(storage_error)?;
    Ok(None)
}

pub(crate) fn folders(connection: &Connection) -> Result<Vec<LibraryFolder>, String> {
    let mut statement = connection
        .prepare("SELECT id, path FROM library_folders ORDER BY path COLLATE NOCASE")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    rows.into_iter()
        .map(|(id, path)| {
            let books: i64 = connection
                .query_row(
                    "SELECT count(*) FROM books WHERE substr(source_path, 1, length(?1)) = ?1",
                    [prefix_of(&path)],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            #[cfg(mobile)]
            if crate::android::is_document(&path) {
                let (label, availability) = crate::android::folder_info(&path);
                return Ok(LibraryFolder {
                    id,
                    availability,
                    path: label,
                    books,
                });
            }
            Ok(LibraryFolder {
                id,
                availability: match std::fs::metadata(&path) {
                    Ok(metadata) if metadata.is_dir() => "available",
                    Ok(_) => "unreadable",
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing",
                    Err(_) => "unreadable",
                },
                path: display_path(&path),
                books,
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn scan_all(connection: &mut Connection) -> Result<Vec<ImportResult>, String> {
    scan_all_with_progress(connection, &mut BatchProgress::silent())
}

fn scan_all_with_progress(
    connection: &mut Connection,
    progress: &mut BatchProgress,
) -> Result<Vec<ImportResult>, String> {
    let _scanning = SCANNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let paths: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT path FROM library_folders ORDER BY id")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    scan_paths(connection, &paths, progress)
}

/// An EPUB a folder holds: its path (on the phone, its document link), name and source stamp.
struct Found {
    key: String,
    stamp: Option<String>,
    #[cfg_attr(not(mobile), allow(dead_code))]
    name: String,
}

/// The folder's EPUBs, in a stable order; none when the folder cannot be read.
fn discover(folder: &str) -> Vec<Found> {
    #[cfg(mobile)]
    if crate::android::is_document(folder) {
        let mut files = crate::android::list_folder(folder, MAX_DEPTH, MAX_FILES)
            .unwrap_or_default()
            .into_iter()
            .map(|file| Found {
                stamp: Some(format!("{}:{}", file.size, file.modified)),
                key: file.uri,
                name: file.name,
            })
            .collect::<Vec<_>>();
        files.sort_by(|a, b| a.key.cmp(&b.key));
        return files;
    }
    let mut found = Vec::new();
    collect_epubs(Path::new(folder), 0, &mut found);
    found.sort();
    found
        .into_iter()
        .map(|path| {
            let key = path.to_string_lossy().into_owned();
            Found {
                stamp: source_stamp(&key),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                key,
            }
        })
        .collect()
}

fn import_found(connection: &mut Connection, found: &Found) -> ImportResult {
    #[cfg(mobile)]
    if crate::android::is_document(&found.key) {
        let document = crate::android::Document {
            uri: found.key.clone(),
            name: found.name.clone(),
        };
        return crate::library::import_documents(connection, std::slice::from_ref(&document))
            .remove(0);
    }
    import_paths(connection, &[PathBuf::from(&found.key)]).remove(0)
}

/// Imports the folder's EPUBs that no scan has met, or that failed and changed since. A missing
/// folder (a disconnected drive) is skipped until it returns.
fn scan_paths(
    connection: &mut Connection,
    folders: &[String],
    progress: &mut BatchProgress,
) -> Result<Vec<ImportResult>, String> {
    progress.phase("discovering");
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for folder in folders {
        files.extend(
            discover(folder)
                .into_iter()
                .filter(|found| seen.insert(found.key.clone())),
        );
    }
    let mut pending = Vec::new();
    for file in files {
        let met: Option<(Option<String>, bool)> = connection
            .query_row(
                "SELECT stamp, in_library FROM library_folder_files WHERE path = ?1",
                [&file.key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((met_stamp, in_library)) = met {
            if in_library || met_stamp == file.stamp {
                continue;
            }
        }
        pending.push(file);
    }
    progress.start(pending.len());
    let mut results = Vec::new();
    for file in pending {
        if progress.stopped() {
            break;
        }
        let result = import_found(connection, &file);
        // Count the committed import even if recording the scan stamp subsequently fails.
        progress.completed_one();
        connection
            .execute(
                "INSERT INTO library_folder_files (path, stamp, in_library) VALUES (?1, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE
                    SET stamp = excluded.stamp, in_library = excluded.in_library",
                params![file.key, file.stamp, result.status != "failed"],
            )
            .map_err(storage_error)?;
        results.push(result);
    }
    Ok(results)
}

/// Every `.epub` file in the folder and its subfolders, not following links.
fn collect_epubs(folder: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || files.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_epubs(&path, depth + 1, files);
        } else if kind.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
        {
            if files.len() >= MAX_FILES {
                return;
            }
            files.push(path);
        }
    }
}

/// The folder's path with a trailing separator, so `C:\Books` does not count `C:\Books 2`.
fn prefix_of(path: &str) -> String {
    if path.ends_with(std::path::MAIN_SEPARATOR) {
        path.to_string()
    } else {
        format!("{path}{}", std::path::MAIN_SEPARATOR)
    }
}

fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{list_from_catalog, remove_book_from_catalog, tests::fixture};
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    #[test]
    fn folder_progress_discovers_one_total_for_overlapping_folders_and_skips_known_files() {
        let directory = tempdir().unwrap();
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        fixture(&nested.join("good.epub"), Some("Good"), None, false);
        std::fs::write(nested.join("bad.epub"), "invalid").unwrap();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        for folder in [directory.path(), &nested] {
            connection
                .execute(
                    "INSERT INTO library_folders (path) VALUES (?1)",
                    [folder.canonicalize().unwrap().to_string_lossy().as_ref()],
                )
                .unwrap();
        }
        let (mut progress, events) = crate::bulk_progress::recording();
        let results = scan_all_with_progress(&mut connection, &mut progress).unwrap();
        assert_eq!(results.len(), 2);
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| (event.phase, event.completed, event.total))
                .collect::<Vec<_>>(),
            [
                ("discovering", 0, None),
                ("processing", 0, Some(2)),
                ("processing", 1, Some(2)),
                ("processing", 2, Some(2))
            ]
        );
        let (mut progress, events) = crate::bulk_progress::recording();
        assert!(scan_all_with_progress(&mut connection, &mut progress)
            .unwrap()
            .is_empty());
        assert_eq!(events.lock().unwrap().last().unwrap().total, Some(0));
    }

    /// Each file's outcome, by file name.
    fn statuses(results: &[ImportResult]) -> Vec<(String, &'static str)> {
        let mut statuses: Vec<_> = results
            .iter()
            .map(|result| (result.file_name().to_string(), result.status))
            .collect();
        statuses.sort();
        statuses
    }

    fn digest(path: &Path) -> Vec<u8> {
        Sha256::digest(std::fs::read(path).unwrap()).to_vec()
    }

    #[test]
    fn folders_import_new_books_once_and_never_bring_removed_ones_back() {
        let directory = tempdir().unwrap();
        let books = directory.path().join("Books");
        std::fs::create_dir_all(books.join("Series")).unwrap();
        fixture(&books.join("one.epub"), Some("One"), None, false);
        fixture(
            &books.join("Series").join("two.EPUB"),
            Some("Two"),
            None,
            true,
        );
        std::fs::write(books.join("notes.txt"), "not a book").unwrap();
        std::fs::write(books.join("broken.epub"), "not a zip").unwrap();
        let before = digest(&books.join("one.epub"));
        let database = directory.path().join("library.sqlite3");
        let mut connection = open_catalog(&database).unwrap();

        let result = add_folder(&mut connection, &books).unwrap();
        assert_eq!(result.status, "added");
        assert_eq!(
            statuses(&result.results),
            [
                ("broken.epub".to_string(), "failed"),
                ("one.epub".to_string(), "imported"),
                ("two.EPUB".to_string(), "imported"),
            ]
        );
        assert_eq!(
            add_folder(&mut connection, &books).unwrap().status,
            "duplicate"
        );
        let listed = folders(&connection).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].books, 2);
        assert_eq!(listed[0].availability, "available");
        assert!(!listed[0].path.starts_with(r"\\?\"));

        // Nothing new: nothing imported, the broken file is not tried again while unchanged.
        assert!(scan_all(&mut connection).unwrap().is_empty());

        // A new book is imported; a removed one stays removed.
        fixture(&books.join("three.epub"), Some("Three"), None, false);
        let one = list_from_catalog(&connection)
            .unwrap()
            .into_iter()
            .find(|book| book.file_name() == "one.epub")
            .unwrap();
        assert!(remove_book_from_catalog(&connection, one.id()).unwrap());
        assert_eq!(
            statuses(&scan_all(&mut connection).unwrap()),
            [("three.epub".to_string(), "imported")]
        );
        assert!(scan_all(&mut connection).unwrap().is_empty());
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 2);

        // A failed file that changes is tried again.
        fixture(&books.join("broken.epub"), Some("Fixed"), None, false);
        assert_eq!(
            statuses(&scan_all(&mut connection).unwrap()),
            [("broken.epub".to_string(), "imported")]
        );

        // Removing the folder keeps its books and stops scanning it.
        let id = folders(&connection).unwrap()[0].id;
        fixture(&books.join("four.epub"), Some("Four"), None, false);
        drop(connection);
        let mut connection = open_catalog(&database).unwrap();
        assert!(remove_folder(&mut connection, id).unwrap());
        assert!(!remove_folder(&mut connection, id).unwrap());
        assert!(scan_all(&mut connection).unwrap().is_empty());
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 3);
        assert!(folders(&connection).unwrap().is_empty());
        assert_eq!(digest(&books.join("one.epub")), before);

        // Adding it again brings back the book removed meanwhile and the new one; the books
        // still in the Library are not met again.
        let result = add_folder(&mut connection, &books).unwrap();
        assert_eq!(
            statuses(&result.results),
            [
                ("four.epub".to_string(), "imported"),
                ("one.epub".to_string(), "imported"),
            ]
        );
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 5);

        // Emptying the Library and removing the folder forgets every book it met.
        for book in list_from_catalog(&connection).unwrap() {
            assert!(remove_book_from_catalog(&connection, book.id()).unwrap());
        }
        assert!(scan_all(&mut connection).unwrap().is_empty());
        let id = folders(&connection).unwrap()[0].id;
        assert!(remove_folder(&mut connection, id).unwrap());
        assert_eq!(
            add_folder(&mut connection, &books).unwrap().results.len(),
            5
        );
        assert_eq!(list_from_catalog(&connection).unwrap().len(), 5);
    }

    #[test]
    fn removing_a_folder_keeps_what_another_folder_still_covers() {
        let directory = tempdir().unwrap();
        let books = directory.path().join("Books");
        let series = books.join("Series");
        std::fs::create_dir_all(&series).unwrap();
        fixture(&series.join("two.epub"), Some("Two"), None, false);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        add_folder(&mut connection, &books).unwrap();
        add_folder(&mut connection, &series).unwrap();
        let two = list_from_catalog(&connection).unwrap().remove(0);
        assert!(remove_book_from_catalog(&connection, two.id()).unwrap());
        let inner = folders(&connection)
            .unwrap()
            .into_iter()
            .find(|folder| folder.path.ends_with("Series"))
            .unwrap();
        assert!(remove_folder(&mut connection, inner.id).unwrap());
        // The outer folder still covers the book, so it stays removed.
        assert!(scan_all(&mut connection).unwrap().is_empty());
        assert!(list_from_catalog(&connection).unwrap().is_empty());
    }

    #[test]
    fn folder_counts_ignore_lookalike_folders_and_missing_folders_are_skipped() {
        let directory = tempdir().unwrap();
        let books = directory.path().join("Books");
        let other = directory.path().join("Books 2");
        std::fs::create_dir_all(&books).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        fixture(&other.join("other.epub"), Some("Other"), None, false);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, &[other.join("other.epub")]);
        assert!(add_folder(&mut connection, &books)
            .unwrap()
            .results
            .is_empty());
        assert_eq!(folders(&connection).unwrap()[0].books, 0);

        std::fs::remove_dir(&books).unwrap();
        assert_eq!(folders(&connection).unwrap()[0].availability, "missing");
        assert!(scan_all(&mut connection).unwrap().is_empty());
        assert_eq!(
            add_folder(&mut connection, &directory.path().join("nowhere"))
                .unwrap()
                .status,
            "failed"
        );
    }

    #[test]
    fn display_paths_drop_the_verbatim_prefix() {
        assert_eq!(display_path(r"\\?\C:\Books"), r"C:\Books");
        assert_eq!(display_path(r"\\?\UNC\server\share"), r"\\server\share");
        assert_eq!(display_path("/home/books"), "/home/books");
    }
}
