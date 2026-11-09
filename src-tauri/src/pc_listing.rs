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

/// The PC covers the phone still has to fetch: those a screen asked for, the latest first,
/// before the rest of the listing in its order.
pub(crate) struct CoverQueue {
    asked: Vec<(String, i64)>,
    /// The listing's covers, the next one last.
    listing: Vec<(String, i64)>,
    /// Whether a task is fetching them.
    running: bool,
}

/// How many asked covers are remembered; older ones were scrolled past and wait for their turn
/// in the listing.
const ASKED: usize = 64;

impl CoverQueue {
    pub(crate) const fn new() -> Self {
        Self {
            asked: Vec::new(),
            listing: Vec::new(),
            running: false,
        }
    }

    /// A screen shows this cover now.
    pub(crate) fn ask(&mut self, id: &str, revision: i64) {
        self.asked
            .retain(|(other, other_revision)| !(other == id && *other_revision == revision));
        if self.asked.len() >= ASKED {
            self.asked.remove(0);
        }
        self.asked.push((id.to_owned(), revision));
    }

    /// The listing's covers the phone lacks, in order, in place of the last listing's.
    pub(crate) fn list(&mut self, mut missing: Vec<(String, i64)>) {
        missing.reverse();
        self.listing = missing;
    }

    /// Whether a task should start fetching them: some wait and none is fetching. The caller
    /// starts it.
    pub(crate) fn start(&mut self) -> bool {
        if self.running || self.is_empty() {
            return false;
        }
        self.running = true;
        true
    }

    /// The next cover to fetch; none ends the fetching task.
    pub(crate) fn next(&mut self) -> Option<(String, i64)> {
        let next = self.asked.pop().or_else(|| self.listing.pop());
        self.running = next.is_some();
        next
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.asked.is_empty() && self.listing.is_empty()
    }

    /// Forgets every cover waiting, which ends the fetching task.
    pub(crate) fn clear(&mut self) {
        self.asked.clear();
        self.listing.clear();
        self.running = false;
    }
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
    fn covers_a_screen_shows_come_first_the_latest_first_then_the_listing_in_order() {
        let cover = |id: &str| (id.to_owned(), 1);
        let mut queue = CoverQueue::new();
        assert!(!queue.start(), "nothing to fetch");
        queue.list(vec![cover("a"), cover("b"), cover("c")]);
        assert!(queue.start());
        assert!(!queue.start(), "one task fetches them");
        assert_eq!(queue.next(), Some(cover("a")));
        queue.ask("x", 1);
        queue.ask("y", 1);
        // Asked again: it moves to the front rather than coming twice.
        queue.ask("x", 1);
        assert_eq!(queue.next(), Some(cover("x")));
        assert_eq!(queue.next(), Some(cover("y")));
        assert_eq!(queue.next(), Some(cover("b")));
        // A new listing replaces what was left of the last.
        queue.list(vec![cover("d")]);
        assert!(!queue.start(), "the running task takes the new listing");
        assert_eq!(queue.next(), Some(cover("d")));
        assert_eq!(queue.next(), None);
        // The task ended: the next cover asked for starts another.
        queue.ask("w", 1);
        assert!(queue.start());
        assert_eq!(queue.next(), Some(cover("w")));

        // Only the covers asked last are remembered.
        for index in 0..ASKED + 10 {
            queue.ask(&index.to_string(), 1);
        }
        let asked: Vec<_> = std::iter::from_fn(|| queue.next()).collect();
        assert_eq!(asked.len(), ASKED);
        assert_eq!(asked[0], cover(&(ASKED + 9).to_string()));
        assert_eq!(asked[ASKED - 1], cover("10"));

        queue.ask("z", 1);
        queue.list(vec![cover("e")]);
        queue.clear();
        assert!(queue.is_empty());
        queue.ask("z", 1);
        assert!(queue.start(), "a cleared queue has no task");
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
