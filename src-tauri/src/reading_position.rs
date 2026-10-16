//! Komori-owned Reader resume positions, keyed by catalog ID.
//!
//! A position is a renderer-neutral locator: a spine position, an optional
//! short fingerprint of that section, and fractional progress through its text.
//! It never contains a source path, archive path, or renderer CFI.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::library::{open_catalog, storage_error, BookProgress, CatalogState};

// Generous for real books while keeping stored values bounded.
const MAX_SPINE_INDEX: i64 = 100_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub(crate) spine_index: i64,
    pub(crate) section_key: Option<String>,
    pub(crate) progress: f64,
}

impl ReadingPosition {
    pub(crate) fn is_valid(&self) -> bool {
        (0..=MAX_SPINE_INDEX).contains(&self.spine_index)
            && self.progress.is_finite()
            && (0.0..=1.0).contains(&self.progress)
            && self.section_key.as_deref().is_none_or(|key| {
                key.len() == 8
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    }
}

#[tauri::command]
pub async fn get_reading_position(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<Option<ReadingPosition>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || load(&database, &id))
        .await
        .map_err(|error| format!("Reading position task failed: {error}"))?
}

#[tauri::command]
pub async fn save_reading_position(
    catalog: State<'_, CatalogState>,
    id: String,
    position: ReadingPosition,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || save(&database, &id, &position))
        .await
        .map_err(|error| format!("Reading position task failed: {error}"))?
}

/// Records the whole-book progress the Reader counted, which the Library shows.
#[tauri::command]
pub async fn save_book_progress(
    catalog: State<'_, CatalogState>,
    id: String,
    progress: BookProgress,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Uuid::parse_str(&id).is_err() || !progress.is_valid() {
            return Ok(false);
        }
        save_progress_to(&open_catalog(&database)?, &id, &progress)
    })
    .await
    .map_err(|error| format!("Book progress task failed: {error}"))?
}

/// Upserts the progress only while the catalog record exists.
pub(crate) fn save_progress_to(
    connection: &Connection,
    id: &str,
    progress: &BookProgress,
) -> Result<bool, String> {
    if !progress.is_valid() {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO book_progress (book_id, unit, current_units, total_units)
             SELECT id, ?2, ?3, ?4 FROM books WHERE id = ?1
             ON CONFLICT(book_id) DO UPDATE SET
               unit = excluded.unit,
               current_units = excluded.current_units,
               total_units = excluded.total_units,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![id, progress.unit, progress.current, progress.total],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

fn load(database: &Path, id: &str) -> Result<Option<ReadingPosition>, String> {
    if Uuid::parse_str(id).is_err() {
        return Ok(None);
    }
    let connection = open_catalog(database)?;
    load_from(&connection, id)
}

fn save(database: &Path, id: &str, position: &ReadingPosition) -> Result<bool, String> {
    if Uuid::parse_str(id).is_err() || !position.is_valid() {
        return Ok(false);
    }
    let connection = open_catalog(database)?;
    save_to(&connection, id, position)
}

pub(crate) fn load_from(
    connection: &Connection,
    id: &str,
) -> Result<Option<ReadingPosition>, String> {
    let stored = connection
        .query_row(
            "SELECT spine_index, section_key, progress FROM reading_positions WHERE book_id = ?1",
            [id],
            |row| {
                Ok(ReadingPosition {
                    spine_index: row.get(0)?,
                    section_key: row.get(1)?,
                    progress: row.get(2)?,
                })
            },
        )
        .optional();
    // An unreadable or out-of-range stored value simply means "no saved position".
    Ok(stored.ok().flatten().filter(ReadingPosition::is_valid))
}

/// Upserts the position only while the catalog record exists.
pub(crate) fn save_to(
    connection: &Connection,
    id: &str,
    position: &ReadingPosition,
) -> Result<bool, String> {
    if !position.is_valid() {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO reading_positions (book_id, spine_index, section_key, progress)
             SELECT id, ?2, ?3, ?4 FROM books WHERE id = ?1
             ON CONFLICT(book_id) DO UPDATE SET
               spine_index = excluded.spine_index,
               section_key = excluded.section_key,
               progress = excluded.progress,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![
                id,
                position.spine_index,
                position.section_key,
                position.progress
            ],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

#[cfg(test)]
pub(crate) fn position(
    spine_index: i64,
    section_key: Option<&str>,
    progress: f64,
) -> ReadingPosition {
    ReadingPosition {
        spine_index,
        section_key: section_key.map(str::to_owned),
        progress,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn catalog_with_book(database: &Path) {
        let connection = open_catalog(database).unwrap();
        connection
            .execute(
                "INSERT INTO books (id, source_path, file_name) VALUES (?1, 'C:/private/a.epub', 'a.epub')",
                [ID],
            )
            .unwrap();
    }

    #[test]
    fn saves_restores_and_overwrites_the_latest_position_across_reopen() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        catalog_with_book(&database);
        assert_eq!(load(&database, ID).unwrap(), None);

        assert!(save(&database, ID, &position(4, Some("0a1b2c3d"), 0.25)).unwrap());
        assert!(save(&database, ID, &position(6, None, 0.5)).unwrap());
        assert_eq!(load(&database, ID).unwrap(), Some(position(6, None, 0.5)));

        let json = serde_json::to_value(position(6, Some("0a1b2c3d"), 0.5)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "spineIndex": 6, "sectionKey": "0a1b2c3d", "progress": 0.5 })
        );
    }

    #[test]
    fn rejects_invalid_positions_and_unknown_or_malformed_ids() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        catalog_with_book(&database);
        for invalid in [
            position(-1, None, 0.0),
            position(MAX_SPINE_INDEX + 1, None, 0.0),
            position(0, None, 1.5),
            position(0, None, f64::NAN),
            position(0, Some("../Text"), 0.0),
            position(0, Some("0A1B2C3D"), 0.0),
        ] {
            assert!(!save(&database, ID, &invalid).unwrap());
        }
        assert!(!save(&database, "C:/private/a.epub", &position(0, None, 0.0)).unwrap());
        assert!(!save(
            &database,
            "22222222-2222-4222-8222-222222222222",
            &position(0, None, 0.0)
        )
        .unwrap());
        assert_eq!(load(&database, "../library.sqlite3").unwrap(), None);
        assert_eq!(load(&database, ID).unwrap(), None);
    }

    fn progress(unit: &str, current: i64, total: i64) -> BookProgress {
        BookProgress {
            unit: unit.into(),
            current,
            total,
        }
    }

    #[test]
    fn saves_valid_book_progress_only_for_catalog_books() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        catalog_with_book(&database);
        let connection = open_catalog(&database).unwrap();
        assert!(save_progress_to(&connection, ID, &progress("characters", 120, 480)).unwrap());
        assert!(save_progress_to(&connection, ID, &progress("words", 3, 12)).unwrap());
        let stored: (String, i64, i64) = connection
            .query_row(
                "SELECT unit, current_units, total_units FROM book_progress WHERE book_id = ?1",
                [ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, ("words".into(), 3, 12));
        for invalid in [
            progress("pages", 1, 2),
            progress("characters", 3, 2),
            progress("characters", -1, 2),
            progress("characters", 0, 0),
        ] {
            assert!(!save_progress_to(&connection, ID, &invalid).unwrap());
        }
        assert!(!save_progress_to(
            &connection,
            "22222222-2222-4222-8222-222222222222",
            &progress("characters", 1, 2)
        )
        .unwrap());
        connection
            .execute("DELETE FROM books WHERE id = ?1", [ID])
            .unwrap();
        let remaining: i64 = connection
            .query_row("SELECT count(*) FROM book_progress", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn a_corrupt_stored_position_loads_as_missing() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        catalog_with_book(&database);
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "INSERT INTO reading_positions (book_id, spine_index, section_key, progress)
                 VALUES (?1, 3, 'not-a-key', 7.0)",
                [ID],
            )
            .unwrap();
        assert_eq!(load_from(&connection, ID).unwrap(), None);
        connection
            .execute(
                "UPDATE reading_positions SET progress = 'text' WHERE book_id = ?1",
                [ID],
            )
            .unwrap();
        assert_eq!(load_from(&connection, ID).unwrap(), None);
    }
}
