//! What the phone keeps of the paired PC's Library between visits (`pc_link`): its listing,
//! saved after each time it is listed so the Library shows it at once, and the covers, one file
//! per book and cover revision, of which only those the listing names are kept.

use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, OptionalExtension};

use crate::devices::protocol::RemoteBook;
use crate::library::storage_error;
use crate::reading_sessions::LibraryKanji;

const LISTING: &str = "pc-library";
const KANJI: &str = "pc-kanji";

/// The PC's listing as last saved, or none before the first.
pub(crate) fn saved(connection: &Connection) -> Result<Option<Vec<RemoteBook>>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [LISTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
}

/// When the listing was last saved, and its length: what changes whenever it does, read without
/// the listing itself.
pub(crate) fn saved_stamp(connection: &Connection) -> Option<(i64, String)> {
    connection
        .query_row(
            "SELECT length(value), updated_at FROM preferences WHERE name = ?1",
            [LISTING],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
}

/// Saves the listing; returns whether it differs from the one saved before.
pub(crate) fn save(connection: &Connection, books: &[RemoteBook]) -> Result<bool, String> {
    let value = serde_json::to_string(books).map_err(|error| error.to_string())?;
    let before: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [LISTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if before.as_deref() == Some(value.as_str()) {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [LISTING, &value],
        )
        .map_err(storage_error)?;
    Ok(true)
}

/// The kanji of the PC's Library as last received, or none before the first.
pub(crate) fn saved_kanji(connection: &Connection) -> Result<Option<Vec<LibraryKanji>>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [KANJI],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
}

/// Saves the kanji of the PC's Library.
pub(crate) fn save_kanji(connection: &Connection, kanji: &[LibraryKanji]) -> Result<(), String> {
    let value = serde_json::to_string(kanji).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [KANJI, &value],
        )
        .map(|_| ())
        .map_err(storage_error)
}

/// Forgets the listing and the kanji, as unpairing does.
pub(crate) fn forget(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM preferences WHERE name IN (?1, ?2)",
            [LISTING, KANJI],
        )
        .map(|_| ())
        .map_err(storage_error)
}

/// The cover file of a book's cover revision.
pub(crate) fn cover_file(id: &str, revision: i64) -> String {
    format!("{id}-{revision}")
}

/// The cover files the listing names, in its order.
pub(crate) fn wanted_covers(books: &[RemoteBook]) -> Vec<(String, i64)> {
    books
        .iter()
        .filter_map(|book| Some((book.id.clone(), book.cover?)))
        .collect()
}

/// Removes the cover files in `directory` the listing no longer names: books the PC removed,
/// covers it replaced, and anything else there.
pub(crate) fn remove_stale_covers(directory: &Path, wanted: &[(String, i64)]) {
    let keep: HashSet<String> = wanted
        .iter()
        .map(|(id, revision)| cover_file(id, *revision))
        .collect();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !keep.contains(name.to_string_lossy().as_ref()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The bytes the files under `path` take, or 0 when it does not exist.
pub(crate) fn size_of(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| size_of(&entry.path())).sum())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::library::open_catalog;

    fn book(id: &str, cover: Option<i64>) -> RemoteBook {
        RemoteBook {
            id: id.to_owned(),
            title: Some(format!("Book {id}")),
            author: None,
            file_name: format!("{id}.epub"),
            size: 10,
            cover,
            progress: None,
            last_read_at: None,
            series: None,
            series_index: None,
            language: None,
            characters: None,
            words: None,
        }
    }

    #[test]
    fn the_listing_is_kept_until_forgotten() {
        let directory = tempdir().unwrap();
        let connection = open_catalog(&directory.path().join("phone.sqlite3")).unwrap();
        assert!(saved(&connection).unwrap().is_none());

        let books = vec![book("a", Some(2)), book("b", None)];
        assert!(save(&connection, &books).unwrap());
        assert!(
            !save(&connection, &books).unwrap(),
            "the same listing changes nothing"
        );
        let listed = saved(&connection).unwrap().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|book| book.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(listed[0].cover, Some(2));

        assert!(save(&connection, &books[..1]).unwrap());
        assert_eq!(saved(&connection).unwrap().unwrap().len(), 1);

        assert!(saved_kanji(&connection).unwrap().is_none());
        let kanji: Vec<LibraryKanji> =
            serde_json::from_str(r#"[{"language":"ja","books":1,"kanji":[{"character":"日","books":1,"completed":false}]}]"#)
                .unwrap();
        save_kanji(&connection, &kanji).unwrap();
        assert_eq!(saved_kanji(&connection).unwrap().unwrap(), kanji);

        forget(&connection).unwrap();
        assert!(saved(&connection).unwrap().is_none());
        assert!(saved_kanji(&connection).unwrap().is_none());
    }

    #[test]
    fn only_the_covers_the_listing_names_stay() {
        let directory = tempdir().unwrap();
        let covers = directory.path().join("pc-covers");
        std::fs::create_dir_all(&covers).unwrap();
        for name in ["a-1", "a-2", "b-5", "gone-3", "stray"] {
            std::fs::write(covers.join(name), b"image/jpeg\nxx").unwrap();
        }
        let books = [book("a", Some(2)), book("b", Some(5)), book("c", None)];
        let wanted = wanted_covers(&books);
        assert_eq!(wanted, [("a".to_owned(), 2), ("b".to_owned(), 5)]);

        remove_stale_covers(&covers, &wanted);
        let mut left: Vec<String> = std::fs::read_dir(&covers)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["a-2", "b-5"]);
        assert_eq!(size_of(&covers), 2 * 13);
        assert_eq!(size_of(&directory.path().join("missing")), 0);
    }
}
