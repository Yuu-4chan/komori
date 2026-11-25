//! Books Windows asks Komori to open from a folder ("Open with"): the Reader opens them by an ID
//! for this run, without adding them to the Library or keeping anything about them.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{epub, reader_content::ReaderArchives};

/// Tells the running window a book was opened from a folder.
const OPEN_FILE_EVENT: &str = "komori-open-file";

/// The book opened from a folder that the window has not taken yet.
#[derive(Default)]
pub struct OpenedFiles {
    pending: Mutex<Option<String>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedBook {
    id: String,
    title: Option<String>,
    author: Option<String>,
    language: Option<String>,
}

/// The EPUB a launch names: the first argument after the program that is an existing `.epub`
/// file, a relative one read from the launch's folder. Switches and other files are ignored.
pub(crate) fn launch_book(args: &[OsString], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find_map(|arg| {
        let text = arg.to_str()?;
        if text.starts_with('-') {
            return None;
        }
        let path = PathBuf::from(text);
        let is_epub = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"));
        if !is_epub {
            return None;
        }
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if !path.is_file() {
            return None;
        }
        path.into_os_string().into_string().ok()
    })
}

/// Registers the book this launch names, for the window to take once it starts.
pub(crate) fn register_launch(app: &AppHandle, args: &[OsString], cwd: &Path) -> bool {
    let Some(path) = launch_book(args, cwd) else {
        return false;
    };
    let id = app.state::<ReaderArchives>().open_file(path);
    let opened = app.state::<OpenedFiles>();
    *opened
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(id.to_string());
    true
}

/// A second launch naming a book opens it in the running window, which it shows.
pub(crate) fn second_launch(app: &AppHandle, args: Vec<String>, cwd: String) {
    let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
    if register_launch(app, &args, Path::new(&cwd)) {
        let _ = app.emit_to("main", OPEN_FILE_EVENT, ());
    }
    crate::window_lifecycle::second_launch(app);
}

/// The book opened from a folder that the window has not opened yet, once.
#[tauri::command]
pub fn take_opened_file(opened: State<'_, OpenedFiles>) -> Option<String> {
    opened
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/// The title, author and language of a book opened from a folder in this run.
#[tauri::command]
pub async fn get_opened_file(
    archives: State<'_, ReaderArchives>,
    id: String,
) -> Result<Option<OpenedBook>, String> {
    let Some(path) = archives.file_path(&id) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || read_book(id, &path))
        .await
        .map_err(|_| "The book could not be read.".to_owned())
}

fn read_book(id: String, path: &str) -> Option<OpenedBook> {
    let source = crate::book_source::open(path).ok()?;
    let metadata = epub::read(source).ok();
    let fallback = Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_owned);
    Some(match metadata {
        Some(metadata) => OpenedBook {
            id,
            title: metadata.title.or(fallback),
            author: metadata.author,
            language: metadata.details.language(),
        },
        // The Reader still says what it cannot open; the name comes from the file.
        None => OpenedBook {
            id,
            title: fallback,
            author: None,
            language: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_launch_names_its_first_existing_epub() {
        let folder = tempfile::tempdir().unwrap();
        let book = folder.path().join("Book.EPUB");
        std::fs::write(&book, b"book").unwrap();
        std::fs::write(folder.path().join("notes.txt"), b"notes").unwrap();
        let book_text = book.to_str().unwrap();

        assert_eq!(
            launch_book(&args(&["komori.exe", book_text]), Path::new("C:\\")),
            Some(book_text.to_owned())
        );
        // Switches, other files and missing books are passed over.
        assert_eq!(
            launch_book(
                &args(&[
                    "komori.exe",
                    "--flag",
                    "notes.txt",
                    "missing.epub",
                    "Book.EPUB"
                ]),
                folder.path()
            ),
            Some(book_text.to_owned())
        );
        assert_eq!(
            launch_book(&args(&[book_text]), folder.path()),
            None,
            "the program itself is never a book"
        );
        assert_eq!(launch_book(&args(&["komori.exe"]), folder.path()), None);
        assert_eq!(
            launch_book(&args(&["komori.exe", "missing.epub"]), folder.path()),
            None
        );
        let not_a_file = folder.path().join("folder.epub");
        std::fs::create_dir(&not_a_file).unwrap();
        assert_eq!(
            launch_book(
                &args(&["komori.exe", not_a_file.to_str().unwrap()]),
                folder.path()
            ),
            None
        );
    }

    #[test]
    fn an_opened_file_keeps_one_id_and_reads_its_name() {
        let archives = ReaderArchives::default();
        let first = archives.open_file("C:\\Books\\a.epub".to_owned());
        assert_eq!(archives.open_file("C:\\Books\\a.epub".to_owned()), first);
        let second = archives.open_file("C:\\Books\\b.epub".to_owned());
        assert_ne!(first, second);
        assert_eq!(
            archives.file_path(&first.to_string()).as_deref(),
            Some("C:\\Books\\a.epub")
        );
        assert_eq!(archives.file_path("C:\\Books\\a.epub"), None);
        assert_eq!(archives.file_path(&uuid::Uuid::new_v4().to_string()), None);

        let folder = tempfile::tempdir().unwrap();
        let broken = folder.path().join("Not really.epub");
        std::fs::write(&broken, b"not a zip").unwrap();
        assert_eq!(
            read_book("id".to_owned(), broken.to_str().unwrap()),
            Some(OpenedBook {
                id: "id".to_owned(),
                title: Some("Not really".to_owned()),
                author: None,
                language: None,
            })
        );
        assert_eq!(
            read_book(
                "id".to_owned(),
                folder.path().join("gone.epub").to_str().unwrap()
            ),
            None
        );
    }
}
