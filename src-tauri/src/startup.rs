//! Native startup choices. Windows owns the actual launch entry; the catalog owns the other
//! choices and the last opened catalog ID. No executable or source path crosses IPC.

mod launch;

use crate::library::{open_catalog, storage_error, CatalogState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, State};
use uuid::Uuid;

pub(crate) static CHANGING: Mutex<()> = Mutex::new(());
pub(crate) const RECORD: &str = "startup";
const LAST_BOOK: &str = "last-book";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub launch_at_startup: bool,
    pub restore_last_book: bool,
    pub remember_window_size: bool,
    pub minimize_to_tray: bool,
    /// Backups made before this choice existed leave it on.
    #[serde(default = "checks_for_updates")]
    pub check_for_updates: bool,
}

fn checks_for_updates() -> bool {
    true
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            launch_at_startup: false,
            restore_last_book: true,
            remember_window_size: true,
            minimize_to_tray: false,
            check_for_updates: true,
        }
    }
}

impl Preferences {
    pub(crate) fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        let field =
            |name: &str, fallback| value.get(name).and_then(Value::as_bool).unwrap_or(fallback);
        Self {
            launch_at_startup: field("launchAtStartup", defaults.launch_at_startup),
            restore_last_book: field("restoreLastBook", defaults.restore_last_book),
            remember_window_size: field("rememberWindowSize", defaults.remember_window_size),
            minimize_to_tray: field("minimizeToTray", defaults.minimize_to_tray),
            check_for_updates: field("checkForUpdates", defaults.check_for_updates),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Changes {
    launch_at_startup: Option<bool>,
    restore_last_book: Option<bool>,
    remember_window_size: Option<bool>,
    minimize_to_tray: Option<bool>,
    check_for_updates: Option<bool>,
}

pub(crate) fn load_from(connection: &Connection) -> Result<Preferences, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [RECORD],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(value
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| Preferences::from_stored(&value))
        .unwrap_or_default())
}

pub(crate) fn load(database: &Path) -> Result<Preferences, String> {
    load_from(&open_catalog(database)?)
}

pub(crate) fn save_to(connection: &Connection, preferences: Preferences) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![
                RECORD,
                serde_json::to_string(&preferences).map_err(|e| e.to_string())?
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

pub(crate) fn with_launch_update<T>(
    enabled: Option<bool>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    launch::with_update(enabled, operation)
}

#[tauri::command]
pub async fn get_startup_preferences(
    catalog: State<'_, CatalogState>,
) -> Result<Preferences, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CHANGING
            .lock()
            .map_err(|_| "Startup settings unavailable")?;
        let mut preferences = load(&database)?;
        preferences.launch_at_startup = launch::enabled()?;
        Ok(preferences)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_startup_preferences(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    changes: Changes,
) -> Result<Preferences, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Tray operations marshal to the main thread; hold no settings lock across one.
        if changes.minimize_to_tray == Some(true) {
            crate::window_lifecycle::ensure_tray(&app, true)?;
        }
        let _guard = CHANGING
            .lock()
            .map_err(|_| "Startup settings unavailable")?;
        let mut preferences = load(&database)?;
        preferences.launch_at_startup = launch::enabled()?;
        if let Some(value) = changes.launch_at_startup {
            preferences.launch_at_startup = value;
        }
        if let Some(value) = changes.restore_last_book {
            preferences.restore_last_book = value;
        }
        if let Some(value) = changes.remember_window_size {
            preferences.remember_window_size = value;
        }
        if let Some(value) = changes.minimize_to_tray {
            preferences.minimize_to_tray = value;
        }
        if let Some(value) = changes.check_for_updates {
            preferences.check_for_updates = value;
        }
        let result = with_launch_update(changes.launch_at_startup, || {
            save_to(&open_catalog(&database)?, preferences)?;
            Ok(preferences)
        });
        let actual = load(&database)?.minimize_to_tray;
        drop(_guard);
        crate::window_lifecycle::ensure_tray(&app, actual)?;
        if !actual {
            crate::window_lifecycle::show(&app);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_startup_book(catalog: State<'_, CatalogState>) -> Result<Option<String>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || startup_book(&open_catalog(&database)?))
        .await
        .map_err(|e| e.to_string())?
}

fn startup_book(connection: &Connection) -> Result<Option<String>, String> {
    if !load_from(connection)?.restore_last_book {
        return Ok(None);
    }
    let id: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [LAST_BOOK],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(id) = id.filter(|id| Uuid::parse_str(id).is_ok()) else {
        return Ok(None);
    };
    let path: Option<String> = connection
        .query_row(
            "SELECT source_path FROM books WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(path
        .filter(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
        .map(|_| id))
}

#[tauri::command]
pub async fn remember_last_book(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Uuid::parse_str(&id).is_err() {
            return Ok(false);
        }
        open_catalog(&database)?
            .execute(
                "INSERT INTO preferences (name, value) SELECT ?1, id FROM books WHERE id = ?2
             ON CONFLICT(name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![LAST_BOOK, id],
            )
            .map(|rows| rows == 1)
            .map_err(storage_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_invalid_fields_and_reopens_saved_choices() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(load(&database).unwrap(), Preferences::default());
        let preferences = Preferences {
            restore_last_book: false,
            remember_window_size: false,
            minimize_to_tray: true,
            check_for_updates: false,
            ..Preferences::default()
        };
        save_to(&open_catalog(&database).unwrap(), preferences).unwrap();
        assert_eq!(load(&database).unwrap(), preferences);
        assert_eq!(
            Preferences::from_stored(
                &serde_json::json!({"restoreLastBook": false, "rememberWindowSize": "false", "minimizeToTray": true})
            ),
            Preferences {
                remember_window_size: true,
                check_for_updates: true,
                ..preferences
            }
        );
        assert!(serde_json::from_value::<Preferences>(
            serde_json::json!({"launchAtStartup": false})
        )
        .is_err());
        // A backup from before the update choice existed keeps update checks on.
        assert!(
            serde_json::from_value::<Preferences>(serde_json::json!({
                "launchAtStartup": false, "restoreLastBook": true,
                "rememberWindowSize": true, "minimizeToTray": false
            }))
            .unwrap()
            .check_for_updates
        );
        assert!(serde_json::from_value::<Changes>(serde_json::json!({"path":"bad"})).is_err());
    }

    #[test]
    fn restore_uses_only_the_last_book_and_missing_removed_or_disabled_returns_library() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let source = directory.path().join("book.epub");
        std::fs::write(&source, b"read-only fixture").unwrap();
        let connection = open_catalog(&database).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(startup_book(&connection).unwrap(), None);
        connection
            .execute(
                "INSERT INTO books (id, source_path, file_name) VALUES (?1, ?2, 'book.epub')",
                params![id, source.to_string_lossy()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES (?1, ?2)",
                params![LAST_BOOK, id],
            )
            .unwrap();
        assert_eq!(startup_book(&connection).unwrap().as_deref(), Some(id));
        save_to(
            &connection,
            Preferences {
                restore_last_book: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(startup_book(&connection).unwrap(), None);
        save_to(&connection, Preferences::default()).unwrap();
        std::fs::remove_file(&source).unwrap();
        assert_eq!(startup_book(&connection).unwrap(), None);
        std::fs::write(&source, b"read-only fixture").unwrap();
        connection
            .execute("DELETE FROM books WHERE id = ?1", [id])
            .unwrap();
        assert_eq!(startup_book(&connection).unwrap(), None);
        assert_eq!(std::fs::read(source).unwrap(), b"read-only fixture");
    }
}
