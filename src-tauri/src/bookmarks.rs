//! Catalog-owned saved places. No operation accesses an EPUB or accepts a path.
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::library::{open_catalog, storage_error, CatalogState};
use crate::reading_position::ReadingPosition;

const MAX_BOOKMARKS: i64 = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkLocator {
    pub spine_index: i64,
    pub section_key: String,
    pub progress: f64,
    pub content_key: String,
}

impl BookmarkLocator {
    pub(crate) fn canonical(&self) -> Option<String> {
        let position: ReadingPosition = serde_json::from_value(serde_json::json!({
            "spineIndex": self.spine_index, "sectionKey": self.section_key,
            "progress": self.progress
        }))
        .ok()?;
        if !position.is_valid()
            || self.content_key.len() != 64
            || !self
                .content_key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        // Stable place identity despite insignificant floating-point differences.
        let mut canonical = self.clone();
        canonical.progress = (self.progress * 1_000_000_000.0).round() / 1_000_000_000.0;
        serde_json::to_string(&canonical).ok()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    id: String,
    locator: BookmarkLocator,
    label: String,
    excerpt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    status: &'static str,
    bookmark: Option<Bookmark>,
}

pub(crate) fn text_valid(value: &str, max: usize) -> bool {
    value.chars().count() <= max && value.trim() == value && !value.chars().any(char::is_control)
}

#[tauri::command]
pub async fn list_bookmarks(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<Vec<Bookmark>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || list(&open_catalog(&database)?, &id))
        .await
        .map_err(|_| "Bookmark task failed".to_owned())?
}

#[tauri::command]
pub async fn create_bookmark(
    catalog: State<'_, CatalogState>,
    id: String,
    locator: BookmarkLocator,
    label: String,
    excerpt: String,
) -> Result<CreateResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || create(&database, &id, &locator, &label, &excerpt))
        .await
        .map_err(|_| "Bookmark task failed".to_owned())?
}

#[tauri::command]
pub async fn rename_bookmark(
    catalog: State<'_, CatalogState>,
    id: String,
    bookmark_id: String,
    label: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rename(&open_catalog(&database)?, &id, &bookmark_id, &label)
    })
    .await
    .map_err(|_| "Bookmark task failed".to_owned())?
}

#[tauri::command]
pub async fn remove_bookmark(
    catalog: State<'_, CatalogState>,
    id: String,
    bookmark_id: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        remove(&open_catalog(&database)?, &id, &bookmark_id)
    })
    .await
    .map_err(|_| "Bookmark task failed".to_owned())?
}

fn list(connection: &Connection, id: &str) -> Result<Vec<Bookmark>, String> {
    if Uuid::parse_str(id).is_err() {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare("SELECT id, locator, label, excerpt FROM bookmarks WHERE book_id = ?1 ORDER BY created_at, id LIMIT 1000").map_err(storage_error)?;
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
    let mut bookmarks = Vec::new();
    for row in rows {
        let (id, locator, label, excerpt) = row.map_err(storage_error)?;
        let Ok(locator) = serde_json::from_str::<BookmarkLocator>(&locator) else {
            continue;
        };
        if Uuid::parse_str(&id).is_ok()
            && locator.canonical().is_some()
            && text_valid(&label, 80)
            && text_valid(&excerpt, 160)
        {
            bookmarks.push(Bookmark {
                id,
                locator,
                label,
                excerpt,
            });
        }
    }
    Ok(bookmarks)
}

fn create(
    database: &Path,
    id: &str,
    locator: &BookmarkLocator,
    label: &str,
    excerpt: &str,
) -> Result<CreateResult, String> {
    let result = |status, bookmark| Ok(CreateResult { status, bookmark });
    let Some(canonical) = locator.canonical() else {
        return result("invalid", None);
    };
    if Uuid::parse_str(id).is_err() || !text_valid(label, 80) || !text_valid(excerpt, 160) {
        return result("invalid", None);
    }
    let mut connection = open_catalog(database)?;
    // Immediate transaction makes duplicate detection and the per-book bound atomic.
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let exists = transaction
        .query_row("SELECT 1 FROM books WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map_err(storage_error)?
        .is_some();
    if !exists {
        return result("unknown", None);
    }
    let duplicate = list(&transaction, id)?
        .into_iter()
        .find(|bookmark| bookmark.locator.canonical().as_deref() == Some(&canonical));
    if let Some(bookmark) = duplicate {
        return result("duplicate", Some(bookmark));
    }
    let count: i64 = transaction
        .query_row(
            "SELECT count(*) FROM bookmarks WHERE book_id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if count >= MAX_BOOKMARKS {
        return result("limit", None);
    }
    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        locator: serde_json::from_str(&canonical).map_err(|_| "Invalid bookmark".to_owned())?,
        label: label.to_owned(),
        excerpt: excerpt.to_owned(),
    };
    transaction.execute("INSERT INTO bookmarks (id, book_id, locator, label, excerpt) VALUES (?1, ?2, ?3, ?4, ?5)", params![bookmark.id, id, canonical, label, excerpt]).map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    result("created", Some(bookmark))
}

fn rename(
    connection: &Connection,
    id: &str,
    bookmark_id: &str,
    label: &str,
) -> Result<bool, String> {
    if Uuid::parse_str(id).is_err()
        || Uuid::parse_str(bookmark_id).is_err()
        || !text_valid(label, 80)
    {
        return Ok(false);
    }
    connection
        .execute(
            "UPDATE bookmarks SET label = ?3 WHERE book_id = ?1 AND id = ?2",
            params![id, bookmark_id, label],
        )
        .map(|count| count == 1)
        .map_err(storage_error)
}

fn remove(connection: &Connection, id: &str, bookmark_id: &str) -> Result<bool, String> {
    if Uuid::parse_str(id).is_err() || Uuid::parse_str(bookmark_id).is_err() {
        return Ok(false);
    }
    connection
        .execute(
            "DELETE FROM bookmarks WHERE book_id = ?1 AND id = ?2",
            params![id, bookmark_id],
        )
        .map(|count| count == 1)
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "22222222-2222-4222-8222-222222222222";
    fn target() -> BookmarkLocator {
        BookmarkLocator {
            spine_index: 1,
            section_key: "1234abcd".into(),
            progress: 0.25,
            content_key: "a".repeat(64),
        }
    }

    #[test]
    fn persists_deduplicates_manages_and_cascades_without_source_access() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let source = directory.path().join("source.epub");
        std::fs::write(&source, b"external source bytes").unwrap();
        let connection = open_catalog(&database).unwrap();
        for (id, path) in [(ID, source.to_str().unwrap()), (OTHER, "absent.epub")] {
            connection
                .execute(
                    "INSERT INTO books (id, source_path, file_name) VALUES (?1, ?2, 'book.epub')",
                    params![id, path],
                )
                .unwrap();
        }
        let first = create(&database, ID, &target(), "Study", "Useful passage").unwrap();
        assert_eq!(first.status, "created");
        let bookmark_id = first.bookmark.unwrap().id;
        assert_eq!(
            create(&database, ID, &target(), "Other label", "")
                .unwrap()
                .status,
            "duplicate"
        );
        assert!(!rename(&connection, OTHER, &bookmark_id, "Wrong book").unwrap());
        assert!(!remove(&connection, OTHER, &bookmark_id).unwrap());
        assert!(rename(&connection, ID, &bookmark_id, "Renamed").unwrap());
        drop(connection);
        let reopened = open_catalog(&database).unwrap();
        assert_eq!(list(&reopened, ID).unwrap()[0].label, "Renamed");
        reopened
            .execute(
                "UPDATE books SET source_path = 'replacement.epub' WHERE id = ?1",
                [ID],
            )
            .unwrap();
        assert_eq!(list(&reopened, ID).unwrap().len(), 1);
        assert!(remove(&reopened, ID, &bookmark_id).unwrap());
        create(&database, ID, &target(), "", "").unwrap();
        reopened
            .execute("DELETE FROM books WHERE id = ?1", [ID])
            .unwrap();
        assert!(list(&reopened, ID).unwrap().is_empty());
        assert_eq!(
            create(&database, ID, &target(), "", "").unwrap().status,
            "unknown"
        );
        assert_eq!(std::fs::read(source).unwrap(), b"external source bytes");
    }

    #[test]
    fn validates_bounds_and_migrates_existing_catalog() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection
            .execute_batch("DROP TABLE bookmarks; PRAGMA user_version = 4;")
            .unwrap();
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        connection.execute("INSERT INTO books (id, source_path, file_name) VALUES (?1, 'absent.epub', 'book.epub')", [ID]).unwrap();
        for invalid in [
            BookmarkLocator {
                progress: f64::NAN,
                ..target()
            },
            BookmarkLocator {
                spine_index: 100001,
                ..target()
            },
            BookmarkLocator {
                section_key: "../file".into(),
                ..target()
            },
            BookmarkLocator {
                content_key: "z".repeat(64),
                ..target()
            },
        ] {
            assert_eq!(
                create(&database, ID, &invalid, "", "").unwrap().status,
                "invalid"
            );
        }
        for label in ["a".repeat(81), "line\nbreak".into(), " spaced ".into()] {
            assert_eq!(
                create(&database, ID, &target(), &label, "").unwrap().status,
                "invalid"
            );
        }
        assert_eq!(
            create(&database, ID, &target(), "", &"a".repeat(161))
                .unwrap()
                .status,
            "invalid"
        );
        assert_eq!(
            create(&database, "../path", &target(), "", "")
                .unwrap()
                .status,
            "invalid"
        );
        for index in 0..MAX_BOOKMARKS {
            connection.execute("INSERT INTO bookmarks (id, book_id, locator, label, excerpt) VALUES (?1, ?2, ?3, '', '')", params![Uuid::new_v4().to_string(), ID, format!("invalid-{index}")]).unwrap();
        }
        assert!(list(&connection, ID).unwrap().is_empty());
        assert_eq!(
            create(&database, ID, &target(), "", "").unwrap().status,
            "limit"
        );
    }
}
