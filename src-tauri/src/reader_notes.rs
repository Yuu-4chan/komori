//! Catalog-owned plain-text annotations. Never opens or writes a source EPUB.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::{
    bookmarks::BookmarkLocator,
    library::{open_catalog, storage_error, CatalogState},
};

pub(crate) const MAX_NOTES: usize = 1000;
pub(crate) const MAX_NOTE_TEXT: usize = 4096;

pub(crate) fn text_valid(text: &str) -> bool {
    !text.is_empty()
        && text.trim() == text
        && text.chars().count() <= MAX_NOTE_TEXT
        && !text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

/// A note's own text; empty for a highlight, which marks a passage without a note.
pub(crate) fn body_valid(body: &str) -> bool {
    body.is_empty() || text_valid(body)
}

pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS reader_notes (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      locator TEXT NOT NULL,
      passage TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ); CREATE INDEX IF NOT EXISTS reader_notes_book ON reader_notes(book_id);",
        )
        .map_err(storage_error)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderNote {
    pub id: String,
    pub locator: BookmarkLocator,
    pub passage: String,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct CreateResult {
    status: &'static str,
    note: Option<ReaderNote>,
}

pub(crate) fn list(connection: &Connection, id: &str) -> Result<Vec<ReaderNote>, String> {
    if Uuid::parse_str(id).is_err() {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare("SELECT id, locator, passage, body FROM reader_notes WHERE book_id = ?1 ORDER BY created_at, id LIMIT 1000").map_err(storage_error)?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(storage_error)?;
    let mut notes = Vec::new();
    for row in rows {
        let (id, locator, passage, body) = row.map_err(storage_error)?;
        let Ok(locator) = serde_json::from_str::<BookmarkLocator>(&locator) else {
            continue;
        };
        if Uuid::parse_str(&id).is_ok()
            && locator.canonical().is_some()
            && text_valid(&passage)
            && body_valid(&body)
        {
            notes.push(ReaderNote {
                id,
                locator,
                passage,
                body,
            });
        }
    }
    Ok(notes)
}

pub(crate) fn create(
    connection: &mut Connection,
    id: &str,
    locator: BookmarkLocator,
    passage: String,
    body: String,
) -> Result<CreateResult, String> {
    let result = |status, note| Ok(CreateResult { status, note });
    let Some(canonical) = locator.canonical() else {
        return result("invalid", None);
    };
    if Uuid::parse_str(id).is_err() || !text_valid(&passage) || !body_valid(&body) {
        return result("invalid", None);
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    if transaction
        .query_row("SELECT 1 FROM books WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map_err(storage_error)?
        .is_none()
    {
        return result("unknown", None);
    }
    let count: usize = transaction
        .query_row(
            "SELECT count(*) FROM reader_notes WHERE book_id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if count >= MAX_NOTES {
        return result("limit", None);
    }
    let note = ReaderNote {
        id: Uuid::new_v4().to_string(),
        locator: serde_json::from_str(&canonical).map_err(|_| "Invalid location")?,
        passage,
        body,
    };
    transaction.execute("INSERT INTO reader_notes (id, book_id, locator, passage, body) VALUES (?1, ?2, ?3, ?4, ?5)", params![note.id, id, canonical, note.passage, note.body]).map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    result("created", Some(note))
}

pub(crate) fn edit(
    connection: &Connection,
    id: &str,
    note_id: &str,
    body: &str,
) -> Result<bool, String> {
    if Uuid::parse_str(id).is_err() || Uuid::parse_str(note_id).is_err() || !body_valid(body) {
        return Ok(false);
    }
    connection.execute("UPDATE reader_notes SET body = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE book_id = ?1 AND id = ?2", params![id, note_id, body]).map(|count| count == 1).map_err(storage_error)
}

pub(crate) fn remove(connection: &Connection, id: &str, note_id: &str) -> Result<bool, String> {
    if Uuid::parse_str(id).is_err() || Uuid::parse_str(note_id).is_err() {
        return Ok(false);
    }
    connection
        .execute(
            "DELETE FROM reader_notes WHERE book_id = ?1 AND id = ?2",
            params![id, note_id],
        )
        .map(|count| count == 1)
        .map_err(storage_error)
}

#[tauri::command]
pub async fn list_reader_notes(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<Vec<ReaderNote>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || list(&open_catalog(&database)?, &id))
        .await
        .map_err(|_| "Notes task failed".to_owned())?
}
#[tauri::command]
pub async fn create_reader_note(
    catalog: State<'_, CatalogState>,
    id: String,
    locator: BookmarkLocator,
    passage: String,
    body: String,
) -> Result<CreateResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create(&mut open_catalog(&database)?, &id, locator, passage, body)
    })
    .await
    .map_err(|_| "Notes task failed".to_owned())?
}
#[tauri::command]
pub async fn edit_reader_note(
    catalog: State<'_, CatalogState>,
    id: String,
    note_id: String,
    body: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        edit(&open_catalog(&database)?, &id, &note_id, &body)
    })
    .await
    .map_err(|_| "Notes task failed".to_owned())?
}
#[tauri::command]
pub async fn remove_reader_note(
    catalog: State<'_, CatalogState>,
    id: String,
    note_id: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || remove(&open_catalog(&database)?, &id, &note_id))
        .await
        .map_err(|_| "Notes task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "22222222-2222-4222-8222-222222222222";
    fn locator() -> BookmarkLocator {
        BookmarkLocator {
            spine_index: 1,
            section_key: "abcd1234".into(),
            progress: 0.25,
            content_key: "a".repeat(64),
        }
    }
    #[test]
    fn migration_crud_restart_ownership_relink_and_removal() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection.execute("INSERT INTO books (id, source_path, file_name) VALUES (?1, 'missing.epub', 'book.epub')", [ID]).unwrap();
        connection
            .execute_batch("DROP TABLE reader_notes; PRAGMA user_version = 6;")
            .unwrap();
        drop(connection);
        let mut connection = open_catalog(&database).unwrap();
        let saved = create(
            &mut connection,
            ID,
            locator(),
            "Selected 本文\nSecond line".into(),
            "Thought\n\tDetail".into(),
        )
        .unwrap();
        assert_eq!(saved.status, "created");
        let note = saved.note.unwrap();
        assert!(!edit(&connection, OTHER, &note.id, "Wrong book").unwrap());
        assert!(!remove(&connection, OTHER, &note.id).unwrap());
        assert!(edit(&connection, ID, &note.id, "Edited").unwrap());
        connection
            .execute(
                "UPDATE books SET source_path = 'relinked.epub' WHERE id = ?1",
                [ID],
            )
            .unwrap();
        drop(connection);
        let mut reopened = open_catalog(&database).unwrap();
        let notes = list(&reopened, ID).unwrap();
        assert_eq!(notes[0].body, "Edited");
        assert_eq!(notes[0].passage, note.passage);
        assert_eq!(notes[0].locator, note.locator);
        assert!(remove(&reopened, ID, &note.id).unwrap());
        assert!(!remove(&reopened, ID, &note.id).unwrap());
        create(
            &mut reopened,
            ID,
            locator(),
            "Passage".into(),
            "Note".into(),
        )
        .unwrap();
        reopened
            .execute("DELETE FROM books WHERE id = ?1", [ID])
            .unwrap();
        assert!(list(&reopened, ID).unwrap().is_empty());
        assert_eq!(
            create(
                &mut reopened,
                ID,
                locator(),
                "Passage".into(),
                "Note".into()
            )
            .unwrap()
            .status,
            "unknown"
        );
    }
    #[test]
    fn refuses_invalid_text_locators_corruption_and_book_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        connection.execute("INSERT INTO books (id, source_path, file_name) VALUES (?1, 'none.epub', 'book.epub')", [ID]).unwrap();
        for text in ["", " padded", "\0", "\r", &"本".repeat(4097)] {
            assert_eq!(
                create(&mut connection, ID, locator(), text.into(), "Note".into())
                    .unwrap()
                    .status,
                "invalid"
            );
            assert_eq!(
                create(
                    &mut connection,
                    ID,
                    locator(),
                    "Passage".into(),
                    text.into()
                )
                .unwrap()
                .status,
                if text.is_empty() {
                    "created"
                } else {
                    "invalid"
                }
            );
        }
        // An empty body is a highlight: a marked passage without a note, editable into one.
        let highlight = list(&connection, ID).unwrap().pop().unwrap();
        assert!(highlight.body.is_empty());
        assert!(edit(&connection, ID, &highlight.id, "Now a note").unwrap());
        assert!(edit(&connection, ID, &highlight.id, "").unwrap());
        assert!(!edit(&connection, ID, &highlight.id, " padded").unwrap());
        for location in [
            BookmarkLocator {
                spine_index: 100001,
                ..locator()
            },
            BookmarkLocator {
                progress: f64::NAN,
                ..locator()
            },
            BookmarkLocator {
                section_key: "path".into(),
                ..locator()
            },
            BookmarkLocator {
                content_key: "b".repeat(63),
                ..locator()
            },
        ] {
            assert_eq!(
                create(
                    &mut connection,
                    ID,
                    location,
                    "Passage".into(),
                    "Note".into()
                )
                .unwrap()
                .status,
                "invalid"
            );
        }
        let result = create(
            &mut connection,
            ID,
            locator(),
            "本".repeat(4096),
            "本".repeat(4096),
        )
        .unwrap();
        assert_eq!(result.status, "created");
        let note = result.note.unwrap();
        assert!(!edit(&connection, ID, &note.id, " padded").unwrap());
        for _ in 1..MAX_NOTES {
            create(
                &mut connection,
                ID,
                locator(),
                "Passage".into(),
                "Note".into(),
            )
            .unwrap();
        }
        assert_eq!(
            create(
                &mut connection,
                ID,
                locator(),
                "Passage".into(),
                "Note".into()
            )
            .unwrap()
            .status,
            "limit"
        );
        connection
            .execute(
                "UPDATE reader_notes SET locator = '{}' WHERE id = ?1",
                [&note.id],
            )
            .unwrap();
        assert_eq!(list(&connection, ID).unwrap().len(), 999);
        assert_eq!(
            create(
                &mut connection,
                "invalid",
                locator(),
                "Passage".into(),
                "Note".into()
            )
            .unwrap()
            .status,
            "invalid"
        );
    }
}
