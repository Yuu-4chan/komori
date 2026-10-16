//! Backups of Komori's own data: preferences, the Library's Komori-owned book state, and
//! reading sessions, written to a JSON file the reader chooses or to a snapshot in Komori's data
//! folder. EPUBs and dictionaries are never part of a backup, and no source is read or written.
//!
//! A backup names each book by its catalog ID with its source file's name and size and its
//! title and author, so a restore on another computer can find the same book in that Library.
//! Restoring is two steps: the file is read and validated into a preview held natively (the
//! frontend gets a token, never a path), then the reader confirms and the preview's state is
//! applied in one transaction, after a snapshot of the current state.

use crate::interface_text::{self, Text};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::{
    anki,
    appearance_preferences::AppearancePreferences,
    bookmarks::{text_valid, BookmarkLocator},
    library::{open_catalog, storage_error, BookProgress, CatalogState},
    reading_position::ReadingPosition,
    reading_sessions::{ReadingSession, SessionAdjustment},
};

const FORMAT: &str = "komori-backup";
const VERSION: i64 = 1;
const EXTENSION: &str = "komoribackup";
const SNAPSHOT_FOLDER: &str = "backups";
const SETTINGS_RECORD: &str = "backup";
/// Far above any real backup (a Library of thousands of books with years of sessions is a few
/// MiB), so a mistaken pick of a huge file is refused before it is read. Writes share the limit,
/// so every backup and snapshot Komori saves is one it can read back.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BOOKS: usize = 200_000;
const MAX_SESSIONS: usize = 2_000_000;
const MAX_TEXT: usize = 4096;
const MAX_DICTIONARIES: usize = 10_000;
/// Komori keeps this many snapshots from before a restore; automatic ones follow `keep`.
const KEEP_RESTORE_SNAPSHOTS: usize = 3;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const FREQUENCIES: [&str; 3] = ["daily", "weekly", "monthly"];
pub(crate) const KEEP_CHOICES: [i64; 4] = [3, 7, 14, 30];

/// Holds the backup the reader is about to restore, between its preview and confirmation.
#[derive(Default)]
pub struct BackupState {
    pending: Mutex<Option<(String, Backup)>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettings {
    automatic: bool,
    frequency: String,
    keep: i64,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            automatic: true,
            frequency: "daily".into(),
            keep: 7,
        }
    }
}

impl BackupSettings {
    fn is_valid(&self) -> bool {
        FREQUENCIES.contains(&self.frequency.as_str()) && KEEP_CHOICES.contains(&self.keep)
    }

    /// Keeps each valid stored field; the rest take their defaults.
    fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            automatic: value
                .get("automatic")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.automatic),
            frequency: value
                .get("frequency")
                .and_then(Value::as_str)
                .filter(|frequency| FREQUENCIES.contains(frequency))
                .map_or(defaults.frequency, str::to_owned),
            keep: value
                .get("keep")
                .and_then(Value::as_i64)
                .filter(|keep| KEEP_CHOICES.contains(keep))
                .unwrap_or(defaults.keep),
        }
    }

    fn interval_ms(&self) -> i64 {
        match self.frequency.as_str() {
            "weekly" => 7 * DAY_MS,
            "monthly" => 30 * DAY_MS,
            _ => DAY_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    format: String,
    version: i64,
    created_at: i64,
    komori_version: String,
    preferences: BackupPreferences,
    /// The installed dictionaries, so a restore elsewhere can point the preferences' dictionary
    /// IDs at the same dictionaries there. Backups from before it restore those IDs as they are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dictionaries: Option<Vec<BackupDictionary>>,
    books: Vec<BackupBook>,
    sessions: Vec<BackupSession>,
}

/// A dictionary's local ID with the title and revision that name it on any computer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupDictionary {
    id: i64,
    title: String,
    revision: String,
}

impl BackupDictionary {
    fn is_valid(&self) -> bool {
        (1..=9_007_199_254_740_991).contains(&self.id)
            && plain_text(&self.title)
            && plain_text(&self.revision)
    }
}

/// Each record as Komori stores it; none means it was never saved, so a restore removes it and
/// Komori uses its defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupPreferences {
    appearance: Option<Value>,
    anki: Option<Value>,
    backup: Option<BackupSettings>,
    startup: Option<crate::startup::Preferences>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupBook {
    id: String,
    file_name: String,
    file_size: Option<u64>,
    title: Option<String>,
    author: Option<String>,
    /// The series set by hand (a null name is No series); none follows the book's metadata.
    manual_series: Option<ManualSeries>,
    position: Option<BackupPosition>,
    progress: Option<BackupProgress>,
    bookmarks: Vec<BackupBookmark>,
    /// Absent in older backups: leave the book's current notes unchanged.
    notes: Option<Vec<BackupNote>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManualSeries {
    name: Option<String>,
    index: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupPosition {
    spine_index: i64,
    section_key: Option<String>,
    progress: f64,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupProgress {
    unit: String,
    current: i64,
    total: i64,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupBookmark {
    locator: BookmarkLocator,
    label: String,
    excerpt: String,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupNote {
    locator: BookmarkLocator,
    passage: String,
    body: String,
    created_at: String,
    updated_at: String,
}

impl BackupNote {
    fn is_valid(&self) -> bool {
        self.locator.canonical().is_some()
            && crate::reader_notes::text_valid(&self.passage)
            && crate::reader_notes::body_valid(&self.body)
            && valid_timestamp(&self.created_at)
            && valid_timestamp(&self.updated_at)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupSession {
    book_id: String,
    book_title: Option<String>,
    finish_cleared: bool,
    session: ReadingSession,
    #[serde(default)]
    adjustment: Option<SessionAdjustment>,
}

/// SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ')`, the only timestamp form Komori stores.
fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    bytes.len() == 24
        && digits(0..4)
        && bytes[4] == b'-'
        && digits(5..7)
        && bytes[7] == b'-'
        && digits(8..10)
        && bytes[10] == b'T'
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19)
        && bytes[19] == b'.'
        && digits(20..23)
        && bytes[23] == b'Z'
}

fn plain_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TEXT && !value.chars().any(char::is_control)
}

impl BackupBook {
    fn position(&self) -> Option<ReadingPosition> {
        self.position.as_ref().map(|position| ReadingPosition {
            spine_index: position.spine_index,
            section_key: position.section_key.clone(),
            progress: position.progress,
        })
    }

    fn progress(&self) -> Option<BookProgress> {
        self.progress.as_ref().map(|progress| BookProgress {
            unit: progress.unit.clone(),
            current: progress.current,
            total: progress.total,
        })
    }

    fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.id).is_ok()
            && plain_text(&self.file_name)
            && self.title.as_deref().is_none_or(plain_text)
            && self.author.as_deref().is_none_or(plain_text)
            && self.manual_series.as_ref().is_none_or(|series| {
                series.name.as_deref().is_none_or(|name| {
                    name.chars().count() <= 200 && plain_text(name) && name.trim() == name
                }) && series
                    .index
                    .is_none_or(|index| index.is_finite() && index >= 0.0)
            })
            && self.position().is_none_or(|position| position.is_valid())
            && self
                .position
                .as_ref()
                .is_none_or(|position| valid_timestamp(&position.updated_at))
            && self.progress().is_none_or(|progress| progress.is_valid())
            && self
                .progress
                .as_ref()
                .is_none_or(|progress| valid_timestamp(&progress.updated_at))
            && self.bookmarks.len() <= 1000
            && self.notes.as_ref().is_none_or(|notes| {
                notes.len() <= crate::reader_notes::MAX_NOTES
                    && notes.iter().all(BackupNote::is_valid)
            })
            && self.bookmarks.iter().all(|bookmark| {
                bookmark.locator.canonical().is_some()
                    && text_valid(&bookmark.label, 80)
                    && text_valid(&bookmark.excerpt, 160)
                    && valid_timestamp(&bookmark.created_at)
            })
    }
}

impl Backup {
    /// Every value must be one Komori could have saved; one that is not makes the file damaged.
    fn is_valid(&self) -> bool {
        let mut book_ids = HashSet::new();
        let mut session_ids = HashSet::new();
        let mut dictionary_ids = HashSet::new();
        self.format == FORMAT
            && self.version == VERSION
            && self.created_at > 0
            && self.komori_version.len() <= 64
            && self
                .preferences
                .appearance
                .as_ref()
                .is_none_or(Value::is_object)
            && self.preferences.anki.as_ref().is_none_or(|value| {
                serde_json::from_value::<anki::Preferences>(value.clone())
                    .is_ok_and(|preferences| preferences.validate().is_ok())
            })
            && self
                .preferences
                .backup
                .as_ref()
                .is_none_or(BackupSettings::is_valid)
            && self.dictionaries.as_ref().is_none_or(|dictionaries| {
                dictionaries.len() <= MAX_DICTIONARIES
                    && dictionaries.iter().all(|dictionary| {
                        dictionary.is_valid() && dictionary_ids.insert(dictionary.id)
                    })
            })
            && self.books.len() <= MAX_BOOKS
            && self.sessions.len() <= MAX_SESSIONS
            && self
                .books
                .iter()
                .all(|book| book.is_valid() && book_ids.insert(book.id.as_str()))
            && self.sessions.iter().all(|stored| {
                Uuid::parse_str(&stored.book_id).is_ok()
                    && stored.session.is_valid()
                    && stored
                        .adjustment
                        .as_ref()
                        .is_none_or(SessionAdjustment::is_valid)
                    && stored.book_title.as_deref().is_none_or(plain_text)
                    && session_ids.insert(stored.session.id.as_str())
            })
    }
}

/// What a backup holds and how it would apply to this Library.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    status: &'static str,
    token: Option<String>,
    created_at: Option<i64>,
    komori_version: Option<String>,
    books: usize,
    matched: usize,
    /// Titles (or file names) of the backup's books this Library does not have, the first 20.
    unmatched: Vec<String>,
    unmatched_count: usize,
    positions: usize,
    bookmarks: usize,
    notes: usize,
    sessions: usize,
    appearance: bool,
    anki: bool,
    startup: bool,
}

impl BackupPreview {
    fn refused(status: &'static str) -> Self {
        Self {
            status,
            token: None,
            created_at: None,
            komori_version: None,
            books: 0,
            matched: 0,
            unmatched: Vec::new(),
            unmatched_count: 0,
            positions: 0,
            bookmarks: 0,
            notes: 0,
            sessions: 0,
            appearance: false,
            anki: false,
            startup: false,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    status: &'static str,
    books: usize,
    unmatched: Vec<String>,
    unmatched_count: usize,
    sessions: usize,
    /// The snapshot of the state from before the restore.
    snapshot: Option<String>,
}

impl RestoreResult {
    fn refused(status: &'static str) -> Self {
        Self {
            status,
            books: 0,
            unmatched: Vec::new(),
            unmatched_count: 0,
            sessions: 0,
            snapshot: None,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    status: &'static str,
    file_name: Option<String>,
    books: usize,
    sessions: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    id: String,
    /// `automatic`, `manual`, or `restore` (taken just before a restore).
    kind: &'static str,
    created_at: i64,
    size: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    status: &'static str,
    snapshot: Option<Snapshot>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn snapshot_folder(database: &Path) -> PathBuf {
    database
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(SNAPSHOT_FOLDER)
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn get_backup_settings(
    catalog: State<'_, CatalogState>,
) -> Result<BackupSettings, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || load_settings(&open_catalog(&database)?))
        .await
        .map_err(|error| format!("Backup task failed: {error}"))?
}

/// Saves the automatic backup settings, then takes an automatic snapshot if one is due and
/// removes automatic snapshots beyond the number kept.
#[tauri::command]
pub async fn save_backup_settings(
    catalog: State<'_, CatalogState>,
    settings: BackupSettings,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !settings.is_valid() {
            return Ok(false);
        }
        save_settings(&open_catalog(&database)?, &settings)?;
        run_automatic(&database, now_ms())?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))?
}

#[tauri::command]
pub async fn export_backup(catalog: State<'_, CatalogState>) -> Result<ExportResult, String> {
    let language = interface_text::language(&catalog.database);
    let name = format!(
        "{} {}.{EXTENSION}",
        interface_text::text(language, Text::BackupFileName),
        local_date()
    );
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::ExportBackup))
        .add_filter(
            interface_text::text(language, Text::KomoriBackup),
            &[EXTENSION],
        )
        .set_file_name(name)
        .save_file()
        .await
        .map(|file| file.path().to_path_buf());
    let Some(mut path) = selected else {
        return Ok(ExportResult {
            status: "canceled",
            file_name: None,
            books: 0,
            sessions: 0,
        });
    };
    if path.extension().is_none() {
        path.set_extension(EXTENSION);
    }
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let failed = ExportResult {
            status: "failed",
            file_name: None,
            books: 0,
            sessions: 0,
        };
        let Ok(backup) = collect_at(&database, now_ms()) else {
            return Ok(failed);
        };
        if write_backup(&path, &backup).is_err() {
            return Ok(failed);
        }
        Ok(ExportResult {
            status: "saved",
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            books: backup.books.len(),
            sessions: backup.sessions.len(),
        })
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))?
}

/// Picks a backup file and reads it into a preview; nothing changes until it is restored.
#[tauri::command]
pub async fn open_backup_file(
    catalog: State<'_, CatalogState>,
    backups: State<'_, BackupState>,
) -> Result<BackupPreview, String> {
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::ImportBackup))
        .add_filter(
            interface_text::text(language, Text::KomoriBackup),
            &[EXTENSION],
        )
        .add_filter(interface_text::text(language, Text::AllFiles), &["*"])
        .pick_file()
        .await
        .map(|file| file.path().to_path_buf());
    let Some(path) = selected else {
        return Ok(BackupPreview::refused("canceled"));
    };
    let database = catalog.database.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || prepare(&database, &path))
        .await
        .map_err(|error| format!("Backup task failed: {error}"))??;
    Ok(hold(&backups, preview))
}

/// Reads one of Komori's snapshots into a preview.
#[tauri::command]
pub async fn open_snapshot(
    catalog: State<'_, CatalogState>,
    backups: State<'_, BackupState>,
    id: String,
) -> Result<BackupPreview, String> {
    if snapshot_kind(&id).is_none() {
        return Ok(BackupPreview::refused("missing"));
    }
    let database = catalog.database.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let path = snapshot_folder(&database).join(format!("{id}.{EXTENSION}"));
        if !path.is_file() {
            return Ok((BackupPreview::refused("missing"), None));
        }
        prepare(&database, &path)
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))??;
    Ok(hold(&backups, preview))
}

/// Applies the previewed backup in one transaction, after a snapshot of the current state.
#[tauri::command]
pub async fn restore_backup(
    app: tauri::AppHandle,
    catalog: State<'_, CatalogState>,
    backups: State<'_, BackupState>,
    token: String,
) -> Result<RestoreResult, String> {
    let pending = {
        let mut pending = backups.pending.lock().map_err(|_| "Backup state failed")?;
        match pending.take() {
            Some((held, backup)) if held == token => Some(backup),
            other => {
                *pending = other;
                None
            }
        }
    };
    let Some(backup) = pending else {
        return Ok(RestoreResult::refused("expired"));
    };
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let startup = backup.preferences.startup;
        if startup.is_some_and(|preferences| preferences.minimize_to_tray) {
            crate::window_lifecycle::ensure_tray(&app, true)?;
        }
        let _guard = crate::startup::CHANGING
            .lock()
            .map_err(|_| "Startup settings unavailable")?;
        let result =
            crate::startup::with_launch_update(startup.map(|p| p.launch_at_startup), || {
                let result = restore(&database, &backup, now_ms())?;
                if result.status != "restored" {
                    return Err(
                        "The safety snapshot could not be created. Nothing was restored.".into(),
                    );
                }
                Ok(result)
            });
        let actual = crate::startup::load(&database)?.minimize_to_tray;
        drop(_guard);
        crate::window_lifecycle::ensure_tray(&app, actual)?;
        // A restored interface language names the tray menu at once.
        crate::window_lifecycle::relabel_tray(&app, crate::interface_text::language(&database));
        crate::app_icon::apply(&app, crate::app_icon::saved(&database).as_deref());
        if !actual {
            crate::window_lifecycle::show(&app);
        }
        result
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))?
}

#[tauri::command]
pub async fn list_snapshots(catalog: State<'_, CatalogState>) -> Result<Vec<Snapshot>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(snapshots(&snapshot_folder(&database))))
        .await
        .map_err(|error| format!("Backup task failed: {error}"))?
}

#[tauri::command]
pub async fn create_snapshot(catalog: State<'_, CatalogState>) -> Result<SnapshotResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(match take_snapshot(&database, "manual", now_ms()) {
            Ok(snapshot) => SnapshotResult {
                status: "created",
                snapshot: Some(snapshot),
            },
            Err(_) => SnapshotResult {
                status: "failed",
                snapshot: None,
            },
        })
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))?
}

/// Deletes one snapshot file from Komori's backup folder, by its ID only.
#[tauri::command]
pub async fn delete_snapshot(catalog: State<'_, CatalogState>, id: String) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if snapshot_kind(&id).is_none() {
            return Ok(false);
        }
        let path = snapshot_folder(&database).join(format!("{id}.{EXTENSION}"));
        Ok(path.is_file() && std::fs::remove_file(path).is_ok())
    })
    .await
    .map_err(|error| format!("Backup task failed: {error}"))?
}

/// Takes automatic snapshots while Komori runs: shortly after it starts, then every hour.
pub fn start_automatic(database: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        loop {
            if let Err(error) = run_automatic(&database, now_ms()) {
                eprintln!("Komori automatic backup failed: {error}");
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Settings and snapshots

fn load_settings(connection: &Connection) -> Result<BackupSettings, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [SETTINGS_RECORD],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(stored
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| BackupSettings::from_stored(&value))
        .unwrap_or_default())
}

fn save_settings(connection: &Connection, settings: &BackupSettings) -> Result<(), String> {
    let value = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    write_record(connection, SETTINGS_RECORD, Some(&value))
}

fn write_record(connection: &Connection, name: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => connection.execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET
               value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![name, value],
        ),
        None => connection.execute("DELETE FROM preferences WHERE name = ?1", [name]),
    }
    .map(|_| ())
    .map_err(storage_error)
}

/// A snapshot ID is its kind and the Unix millisecond it was taken: `automatic-1759400000000`.
fn snapshot_kind(id: &str) -> Option<(&'static str, i64)> {
    let (kind, time) = id.split_once('-')?;
    let kind = ["automatic", "manual", "restore"]
        .into_iter()
        .find(|known| *known == kind)?;
    if time.is_empty() || time.len() > 15 || !time.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((kind, time.parse().ok()?))
}

/// Every snapshot in the folder, newest first; other files are ignored.
fn snapshots(folder: &Path) -> Vec<Snapshot> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<Snapshot> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()?.to_str()? != EXTENSION {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_owned();
            let (kind, created_at) = snapshot_kind(&id)?;
            let metadata = entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())?;
            Some(Snapshot {
                id,
                kind,
                created_at,
                size: metadata.len(),
            })
        })
        .collect();
    found.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    found
}

fn take_snapshot(database: &Path, kind: &'static str, now: i64) -> Result<Snapshot, String> {
    let folder = snapshot_folder(database);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    // Two snapshots in one millisecond take the next free one.
    let mut created_at = now;
    let path = loop {
        let path = folder.join(format!("{kind}-{created_at}.{EXTENSION}"));
        if !path.exists() {
            break path;
        }
        created_at += 1;
    };
    let backup = collect_at(database, created_at)?;
    write_backup(&path, &backup)?;
    let size = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
    Ok(Snapshot {
        id: format!("{kind}-{created_at}"),
        kind,
        created_at,
        size,
    })
}

/// Removes the oldest snapshots of a kind beyond the number kept.
fn prune(folder: &Path, kind: &str, keep: usize) {
    for snapshot in snapshots(folder)
        .into_iter()
        .filter(|snapshot| snapshot.kind == kind)
        .skip(keep)
    {
        let _ = std::fs::remove_file(folder.join(format!("{}.{EXTENSION}", snapshot.id)));
    }
}

/// Takes an automatic snapshot when automatic backups are on and the newest is older than the
/// chosen frequency (or from the future, as after a clock change), then prunes.
fn run_automatic(database: &Path, now: i64) -> Result<Option<Snapshot>, String> {
    let settings = load_settings(&open_catalog(database)?)?;
    let folder = snapshot_folder(database);
    if !settings.automatic {
        return Ok(None);
    }
    let newest = snapshots(&folder)
        .into_iter()
        .find(|snapshot| snapshot.kind == "automatic");
    let due = newest.is_none_or(|snapshot| {
        now - snapshot.created_at >= settings.interval_ms() || snapshot.created_at > now
    });
    let taken = if due {
        Some(take_snapshot(database, "automatic", now)?)
    } else {
        None
    };
    prune(&folder, "automatic", settings.keep as usize);
    Ok(taken)
}

fn local_date() -> String {
    Connection::open_in_memory()
        .and_then(|connection| {
            connection.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
        })
        .unwrap_or_else(|_| "backup".into())
}

// ---------------------------------------------------------------------------------------------
// Reading and writing backups

/// Reads Komori's state in one read transaction, so the backup is consistent.
pub(crate) const BACKUP_BOOKS_SQL: &str =
    "SELECT books.id, books.source_path, books.file_name, books.title, books.author,
            manual.book_id IS NOT NULL, manual.series, manual.series_index,
            position.spine_index, position.section_key, position.progress,
            position.updated_at, progress.unit, progress.current_units,
            progress.total_units, progress.updated_at
       FROM books
       LEFT JOIN book_series AS manual ON manual.book_id = books.id
       LEFT JOIN reading_positions AS position ON position.book_id = books.id
       LEFT JOIN book_progress AS progress ON progress.book_id = books.id
      ORDER BY books.imported_at, books.id";

fn collect(connection: &mut Connection, created_at: i64) -> Result<Backup, String> {
    let transaction = connection.transaction().map_err(storage_error)?;
    let record = |name: &str| -> Result<Option<Value>, String> {
        let stored: Option<String> = transaction
            .query_row(
                "SELECT value FROM preferences WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        Ok(stored.and_then(|text| serde_json::from_str(&text).ok()))
    };
    let appearance = record("appearance")?
        .map(|value| AppearancePreferences::from_stored(&value))
        .map(|preferences| serde_json::to_value(preferences).map_err(|error| error.to_string()))
        .transpose()?;
    let anki = record("anki")?.filter(|value| {
        serde_json::from_value::<anki::Preferences>(value.clone())
            .is_ok_and(|preferences| preferences.validate().is_ok())
    });
    let backup = record(SETTINGS_RECORD)?.map(|value| BackupSettings::from_stored(&value));
    let startup = record(crate::startup::RECORD)?
        .map(|value| crate::startup::Preferences::from_stored(&value));

    let mut books = Vec::new();
    {
        let mut statement = transaction
            .prepare(BACKUP_BOOKS_SQL)
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let source: String = row.get(1)?;
                let position = match row.get::<_, Option<i64>>(8)? {
                    Some(spine_index) => Some(BackupPosition {
                        spine_index,
                        section_key: row.get(9)?,
                        progress: row.get(10)?,
                        updated_at: row.get(11)?,
                    }),
                    None => None,
                };
                let progress = match row.get::<_, Option<String>>(12)? {
                    Some(unit) => Some(BackupProgress {
                        unit,
                        current: row.get(13)?,
                        total: row.get(14)?,
                        updated_at: row.get(15)?,
                    }),
                    None => None,
                };
                Ok(BackupBook {
                    id: row.get(0)?,
                    file_size: std::fs::metadata(&source)
                        .ok()
                        .map(|metadata| metadata.len()),
                    file_name: row.get(2)?,
                    title: row.get(3)?,
                    author: row.get(4)?,
                    manual_series: if row.get(5)? {
                        Some(ManualSeries {
                            name: row.get(6)?,
                            index: row.get(7)?,
                        })
                    } else {
                        None
                    },
                    position,
                    progress,
                    bookmarks: Vec::new(),
                    notes: Some(Vec::new()),
                })
            })
            .map_err(storage_error)?;
        for row in rows {
            let mut book = row.map_err(storage_error)?;
            // Text Komori itself did not write (or a broken row) is left out rather than
            // making the backup unrestorable.
            book.title = book.title.filter(|title| plain_text(title));
            book.author = book.author.filter(|author| plain_text(author));
            if book.position().is_some_and(|position| !position.is_valid())
                || book
                    .position
                    .as_ref()
                    .is_some_and(|position| !valid_timestamp(&position.updated_at))
            {
                book.position = None;
            }
            if book.progress().is_some_and(|progress| !progress.is_valid())
                || book
                    .progress
                    .as_ref()
                    .is_some_and(|progress| !valid_timestamp(&progress.updated_at))
            {
                book.progress = None;
            }
            if book.manual_series.as_ref().is_some_and(|series| {
                !series.name.as_deref().is_none_or(|name| {
                    name.chars().count() <= 200 && plain_text(name) && name.trim() == name
                }) || !series
                    .index
                    .is_none_or(|index| index.is_finite() && index >= 0.0)
            }) {
                book.manual_series = None;
            }
            books.push(book);
        }
    }
    {
        let index: HashMap<String, usize> = books
            .iter()
            .enumerate()
            .map(|(position, book)| (book.id.clone(), position))
            .collect();
        let mut statement = transaction
            .prepare(
                "SELECT book_id, locator, label, excerpt, created_at FROM bookmarks
                  ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(storage_error)?;
        for row in rows {
            let (book_id, locator, label, excerpt, created_at) = row.map_err(storage_error)?;
            let Some(&position) = index.get(&book_id) else {
                continue;
            };
            let Ok(locator) = serde_json::from_str::<BookmarkLocator>(&locator) else {
                continue;
            };
            let bookmark = BackupBookmark {
                locator,
                label,
                excerpt,
                created_at,
            };
            if bookmark.locator.canonical().is_some()
                && text_valid(&bookmark.label, 80)
                && text_valid(&bookmark.excerpt, 160)
                && valid_timestamp(&bookmark.created_at)
                && books[position].bookmarks.len() < 1000
            {
                books[position].bookmarks.push(bookmark);
            }
        }
    }
    {
        let index: HashMap<String, usize> = books
            .iter()
            .enumerate()
            .map(|(position, book)| (book.id.clone(), position))
            .collect();
        let mut statement = transaction.prepare("SELECT book_id, locator, passage, body, created_at, updated_at FROM reader_notes ORDER BY created_at, id").map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(storage_error)?;
        for row in rows {
            let (book_id, locator, passage, body, created_at, updated_at) =
                row.map_err(storage_error)?;
            let Some(&position) = index.get(&book_id) else {
                continue;
            };
            let Ok(locator) = serde_json::from_str::<BookmarkLocator>(&locator) else {
                continue;
            };
            let note = BackupNote {
                locator,
                passage,
                body,
                created_at,
                updated_at,
            };
            let notes = books[position]
                .notes
                .as_mut()
                .expect("Export includes notes");
            if notes.len() < crate::reader_notes::MAX_NOTES && note.is_valid() {
                notes.push(note);
            }
        }
    }
    let mut sessions = Vec::new();
    {
        let mut statement = transaction
            .prepare(
                "SELECT id, book_id, started_at, ended_at, active_ms, unit, units_read,
                        start_units, end_units, total_units, book_title, finish_cleared,
                        units_adjustment, active_adjustment
                   FROM reading_sessions ORDER BY started_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(BackupSession {
                    session: ReadingSession {
                        id: row.get(0)?,
                        started_at: row.get(2)?,
                        ended_at: row.get(3)?,
                        active_ms: row.get(4)?,
                        unit: row.get(5)?,
                        units_read: row.get(6)?,
                        start_units: row.get(7)?,
                        end_units: row.get(8)?,
                        total_units: row.get(9)?,
                    },
                    book_id: row.get(1)?,
                    book_title: row.get(10)?,
                    finish_cleared: row.get::<_, i64>(11)? != 0,
                    adjustment: Some(SessionAdjustment {
                        units_delta: row.get(12)?,
                        active_ms_delta: row.get(13)?,
                    }),
                })
            })
            .map_err(storage_error)?;
        for row in rows {
            let Ok(mut stored) = row else { continue };
            stored.book_title = stored.book_title.filter(|title| plain_text(title));
            if stored.session.is_valid()
                && Uuid::parse_str(&stored.book_id).is_ok()
                && stored
                    .adjustment
                    .as_ref()
                    .is_none_or(SessionAdjustment::is_valid)
            {
                sessions.push(stored);
            }
        }
    }
    transaction.commit().map_err(storage_error)?;
    Ok(Backup {
        format: FORMAT.into(),
        version: VERSION,
        created_at,
        komori_version: env!("CARGO_PKG_VERSION").into(),
        preferences: BackupPreferences {
            appearance,
            anki,
            backup,
            startup,
        },
        dictionaries: None,
        books,
        sessions,
    })
}

/// A backup of the catalog at `database` that names the dictionaries installed beside it.
fn collect_at(database: &Path, created_at: i64) -> Result<Backup, String> {
    let mut backup = collect(&mut open_catalog(database)?, created_at)?;
    backup.dictionaries = installed_dictionaries(database);
    Ok(backup)
}

/// The dictionaries in the store beside the catalog, or none when it cannot be read.
fn installed_dictionaries(database: &Path) -> Option<Vec<BackupDictionary>> {
    let store = database.with_file_name(crate::dictionary::store::DATABASE_FILE_NAME);
    if !store.is_file() {
        return None;
    }
    let connection = Connection::open(store).ok()?;
    let mut statement = connection
        .prepare("SELECT id, title, revision FROM dictionaries ORDER BY id")
        .ok()?;
    let dictionaries = statement
        .query_map([], |row| {
            Ok(BackupDictionary {
                id: row.get(0)?,
                title: row.get(1)?,
                revision: row.get(2)?,
            })
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    // One that could not be named is left out, so its selections do not restore elsewhere.
    let dictionaries: Vec<_> = dictionaries
        .into_iter()
        .filter(BackupDictionary::is_valid)
        .collect();
    (dictionaries.len() <= MAX_DICTIONARIES).then_some(dictionaries)
}

/// Each backup dictionary ID with this computer's dictionary of the same title and revision,
/// when exactly one dictionary on each side has them.
fn dictionary_ids(
    backup: &[BackupDictionary],
    installed: &[BackupDictionary],
) -> HashMap<i64, i64> {
    fn named(dictionaries: &[BackupDictionary]) -> HashMap<(&str, &str), Vec<i64>> {
        let mut named: HashMap<(&str, &str), Vec<i64>> = HashMap::new();
        for dictionary in dictionaries {
            named
                .entry((dictionary.title.as_str(), dictionary.revision.as_str()))
                .or_default()
                .push(dictionary.id);
        }
        named
    }
    let installed = named(installed);
    named(backup)
        .into_iter()
        .filter_map(
            |(name, ids)| match (ids.as_slice(), installed.get(&name)?.as_slice()) {
                ([from], [to]) => Some((*from, *to)),
                _ => None,
            },
        )
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum WriteError {
    /// The backup would be larger than Komori reads back, so it is not written.
    TooLarge,
    Failed(String),
}

impl From<WriteError> for String {
    fn from(error: WriteError) -> Self {
        match error {
            WriteError::TooLarge => "The backup is too large to restore.".into(),
            WriteError::Failed(error) => error,
        }
    }
}

/// Writes beside the destination first, so a failed write never leaves half a backup there.
fn write_backup(path: &Path, backup: &Backup) -> Result<(), WriteError> {
    write_backup_within(path, backup, MAX_FILE_BYTES)
}

fn write_backup_within(path: &Path, backup: &Backup, limit: u64) -> Result<(), WriteError> {
    let text = serde_json::to_vec(backup).map_err(|error| WriteError::Failed(error.to_string()))?;
    if text.len() as u64 > limit {
        return Err(WriteError::TooLarge);
    }
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let written = std::fs::write(&partial, text).and_then(|()| std::fs::rename(&partial, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written.map_err(|error| WriteError::Failed(error.to_string()))
}

/// Bounds actual bytes even when a source grows after its handle's metadata was inspected.
fn read_backup_bytes(reader: impl Read, limit: u64) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    if bytes.len() as u64 > limit {
        return Err("tooLarge");
    }
    Ok(bytes)
}

/// Reads and validates a backup file: `foreign` when it is not one, `newer` when a later Komori
/// wrote it, `damaged` when anything in it is not what Komori saves.
fn read_backup(path: &Path) -> Result<Backup, &'static str> {
    let source = File::open(path).map_err(|_| "unreadable")?;
    let metadata = source.metadata().map_err(|_| "unreadable")?;
    if !metadata.is_file() {
        return Err("unreadable");
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("tooLarge");
    }
    let bytes = read_backup_bytes(source, MAX_FILE_BYTES)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "foreign")?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err("foreign");
    }
    match value.get("version").and_then(Value::as_i64) {
        Some(version) if version > VERSION => return Err("newer"),
        Some(VERSION) => {}
        _ => return Err("damaged"),
    }
    let backup: Backup = serde_json::from_value(value).map_err(|_| "damaged")?;
    if !backup.is_valid() {
        return Err("damaged");
    }
    Ok(backup)
}

fn prepare(database: &Path, path: &Path) -> Result<(BackupPreview, Option<Backup>), String> {
    let backup = match read_backup(path) {
        Ok(backup) => backup,
        Err(status) => return Ok((BackupPreview::refused(status), None)),
    };
    let connection = open_catalog(database)?;
    let matches = match_books(&backup.books, &catalog_books(&connection)?);
    let (matched, unmatched) = split_matches(&backup.books, &matches);
    let preview = BackupPreview {
        status: "ready",
        token: Some(Uuid::new_v4().to_string()),
        created_at: Some(backup.created_at),
        komori_version: Some(backup.komori_version.clone()),
        books: backup.books.len(),
        matched,
        unmatched_count: unmatched.len(),
        unmatched: unmatched.into_iter().take(20).collect(),
        positions: backup
            .books
            .iter()
            .filter(|book| book.position.is_some())
            .count(),
        bookmarks: backup.books.iter().map(|book| book.bookmarks.len()).sum(),
        notes: backup
            .books
            .iter()
            .map(|book| book.notes.as_ref().map_or(0, Vec::len))
            .sum(),
        sessions: backup.sessions.len(),
        appearance: backup.preferences.appearance.is_some(),
        anki: backup.preferences.anki.is_some(),
        startup: backup.preferences.startup.is_some(),
    };
    Ok((preview, Some(backup)))
}

/// Keeps one previewed backup at a time; a newer preview replaces an older one.
fn hold(
    backups: &BackupState,
    (preview, backup): (BackupPreview, Option<Backup>),
) -> BackupPreview {
    if let (Some(token), Some(backup)) = (&preview.token, backup) {
        if let Ok(mut pending) = backups.pending.lock() {
            *pending = Some((token.clone(), backup));
        }
    }
    preview
}

/// Counts matched books and names the unmatched ones.
fn split_matches(books: &[BackupBook], matches: &[Option<String>]) -> (usize, Vec<String>) {
    let unmatched: Vec<String> = books
        .iter()
        .zip(matches)
        .filter(|(_, matched)| matched.is_none())
        .map(|(book, _)| book.title.clone().unwrap_or_else(|| book.file_name.clone()))
        .collect();
    (books.len() - unmatched.len(), unmatched)
}

type MatchPass<'a> = dyn Fn(&BackupBook, &CatalogBook) -> bool + 'a;

struct CatalogBook {
    id: String,
    file_name: String,
    file_size: Option<u64>,
    title: Option<String>,
    author: Option<String>,
}

pub(crate) const CATALOG_BOOKS_SQL: &str =
    "SELECT id, source_path, file_name, title, author FROM books ORDER BY imported_at, id";

fn catalog_books(connection: &Connection) -> Result<Vec<CatalogBook>, String> {
    let mut statement = connection
        .prepare(CATALOG_BOOKS_SQL)
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            let source: String = row.get(1)?;
            Ok(CatalogBook {
                id: row.get(0)?,
                file_size: std::fs::metadata(&source)
                    .ok()
                    .map(|metadata| metadata.len()),
                file_name: row.get(2)?,
                title: row.get(3)?,
                author: row.get(4)?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<_, _>>().map_err(storage_error)
}

fn same_text(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.trim().to_lowercase() == b.trim().to_lowercase(),
        (None, None) => true,
        _ => false,
    }
}

/// Finds each backup book's catalog book, strongest evidence first, each catalog book at most
/// once: the same catalog ID (this Library); the same source file name and size; the same file
/// name, title and author; and last the same title and author. Every pass after the ID needs
/// exactly one book on each side to fit; an ambiguous book stays unmatched.
fn match_books(books: &[BackupBook], catalog: &[CatalogBook]) -> Vec<Option<String>> {
    let mut matches: Vec<Option<String>> = vec![None; books.len()];
    let mut used: HashSet<&str> = HashSet::new();
    let ids: HashSet<&str> = catalog.iter().map(|book| book.id.as_str()).collect();
    for (index, book) in books.iter().enumerate() {
        if ids.contains(book.id.as_str()) {
            matches[index] = Some(book.id.clone());
            used.insert(book.id.as_str());
        }
    }
    let name = |value: &str| value.to_lowercase();
    let passes: [&MatchPass<'_>; 2] = [
        &|book, candidate| {
            name(&book.file_name) == name(&candidate.file_name)
                && book.file_size.is_some()
                && book.file_size == candidate.file_size
        },
        &|book, candidate| {
            name(&book.file_name) == name(&candidate.file_name)
                && book.title.is_some()
                && same_text(&book.title, &candidate.title)
                && same_text(&book.author, &candidate.author)
        },
    ];
    // A pass matches a book only to its one unused candidate, and only when no other unmatched
    // book also fits that candidate; anything ambiguous is left for the preview to name.
    for pass in passes {
        for (index, book) in books.iter().enumerate() {
            if matches[index].is_some() {
                continue;
            }
            let mut candidates = catalog
                .iter()
                .filter(|candidate| !used.contains(candidate.id.as_str()) && pass(book, candidate));
            let (Some(candidate), None) = (candidates.next(), candidates.next()) else {
                continue;
            };
            let rivals = books.iter().enumerate().any(|(other, rival)| {
                other != index && matches[other].is_none() && pass(rival, candidate)
            });
            if !rivals {
                used.insert(candidate.id.as_str());
                matches[index] = Some(candidate.id.clone());
            }
        }
    }
    let key = |title: &Option<String>, author: &Option<String>| {
        title.as_ref().map(|title| {
            (
                title.trim().to_lowercase(),
                author.as_deref().unwrap_or("").trim().to_lowercase(),
            )
        })
    };
    let mut wanted: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (index, book) in books.iter().enumerate() {
        if matches[index].is_none() {
            if let Some(key) = key(&book.title, &book.author) {
                wanted.entry(key).or_default().push(index);
            }
        }
    }
    let mut offered: HashMap<(String, String), Vec<&str>> = HashMap::new();
    for candidate in catalog {
        if !used.contains(candidate.id.as_str()) {
            if let Some(key) = key(&candidate.title, &candidate.author) {
                offered.entry(key).or_default().push(candidate.id.as_str());
            }
        }
    }
    for (key, indexes) in wanted {
        if let (Some([candidate]), [index]) = (offered.get(&key).map(Vec::as_slice), &indexes[..]) {
            matches[*index] = Some((*candidate).to_owned());
        }
    }
    matches
}

/// Applies a backup: preferences and the Anki configuration as they were, and for each book this
/// Library has, its hand-set series, position, progress and bookmarks exactly as in the backup
/// (removing what it did not have). Sessions are added, a backup's version replacing the same
/// session here; those of books this Library lacks keep their title and count as removed books.
fn restore(database: &Path, backup: &Backup, now: i64) -> Result<RestoreResult, String> {
    let Ok(snapshot) = take_snapshot(database, "restore", now) else {
        return Ok(RestoreResult::refused("snapshotFailed"));
    };
    prune(
        &snapshot_folder(database),
        "restore",
        KEEP_RESTORE_SNAPSHOTS,
    );
    let mut connection = open_catalog(database)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let matches = match_books(&backup.books, &catalog_books(&transaction)?);
    // Dictionary IDs are each computer's own: a backup that names its dictionaries has their
    // IDs pointed at the same dictionaries here, and those this computer lacks are cleared.
    let dictionaries = backup
        .dictionaries
        .as_deref()
        .map(|named| dictionary_ids(named, &installed_dictionaries(database).unwrap_or_default()));
    let dictionary = |id: i64| {
        dictionaries
            .as_ref()
            .map_or(Some(id), |ids| ids.get(&id).copied())
    };

    let appearance = backup
        .preferences
        .appearance
        .as_ref()
        .map(|value| {
            let mut preferences = AppearancePreferences::from_stored(value);
            preferences.remap_dictionaries(dictionary);
            serde_json::to_string(&preferences)
        })
        .transpose()
        .map_err(|error| error.to_string())?;
    write_record(&transaction, "appearance", appearance.as_deref())?;
    let anki = backup
        .preferences
        .anki
        .as_ref()
        .and_then(|value| serde_json::from_value::<anki::Preferences>(value.clone()).ok())
        .map(|mut preferences| {
            preferences.remap_dictionaries(dictionary);
            serde_json::to_string(&preferences)
        })
        .transpose()
        .map_err(|error| error.to_string())?;
    write_record(&transaction, "anki", anki.as_deref())?;
    if let Some(settings) = &backup.preferences.backup {
        save_settings(&transaction, settings)?;
    }
    // A backup from before Startup choices preserves today's choices.
    if let Some(preferences) = backup.preferences.startup {
        crate::startup::save_to(&transaction, preferences)?;
    }

    let mut moved: HashMap<&str, &str> = HashMap::new();
    for (book, matched) in backup.books.iter().zip(&matches) {
        let Some(id) = matched else { continue };
        moved.insert(book.id.as_str(), id.as_str());
        if let Some(notes) = &book.notes {
            transaction
                .execute("DELETE FROM reader_notes WHERE book_id = ?1", [id])
                .map_err(storage_error)?;
            for note in notes {
                let locator = note.locator.canonical().ok_or("Invalid note location")?;
                transaction.execute("INSERT INTO reader_notes (id, book_id, locator, passage, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![Uuid::new_v4().to_string(), id, locator, note.passage, note.body, note.created_at, note.updated_at]).map_err(storage_error)?;
            }
        }
        for table in [
            "book_series",
            "reading_positions",
            "book_progress",
            "bookmarks",
        ] {
            transaction
                .execute(&format!("DELETE FROM {table} WHERE book_id = ?1"), [id])
                .map_err(storage_error)?;
        }
        if let Some(series) = &book.manual_series {
            transaction
                .execute(
                    "INSERT INTO book_series (book_id, series, series_index) VALUES (?1, ?2, ?3)",
                    params![id, series.name, series.index],
                )
                .map_err(storage_error)?;
        }
        if let Some(position) = &book.position {
            transaction
                .execute(
                    "INSERT INTO reading_positions
                       (book_id, spine_index, section_key, progress, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        id,
                        position.spine_index,
                        position.section_key,
                        position.progress,
                        position.updated_at
                    ],
                )
                .map_err(storage_error)?;
        }
        if let Some(progress) = &book.progress {
            transaction
                .execute(
                    "INSERT INTO book_progress
                       (book_id, unit, current_units, total_units, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        id,
                        progress.unit,
                        progress.current,
                        progress.total,
                        progress.updated_at
                    ],
                )
                .map_err(storage_error)?;
        }
        for bookmark in &book.bookmarks {
            let Some(locator) = bookmark.locator.canonical() else {
                continue;
            };
            transaction
                .execute(
                    "INSERT OR IGNORE INTO bookmarks
                       (id, book_id, locator, label, excerpt, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        Uuid::new_v4().to_string(),
                        id,
                        locator,
                        bookmark.label,
                        bookmark.excerpt,
                        bookmark.created_at
                    ],
                )
                .map_err(storage_error)?;
        }
    }
    for stored in &backup.sessions {
        let session = &stored.session;
        let book_id = moved
            .get(stored.book_id.as_str())
            .copied()
            .unwrap_or(stored.book_id.as_str());
        transaction
            .execute(
                "INSERT INTO reading_sessions
                   (id, book_id, started_at, ended_at, active_ms, unit, units_read,
                    start_units, end_units, total_units, book_title, finish_cleared,
                    units_adjustment, active_adjustment)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                   book_id = excluded.book_id, started_at = excluded.started_at,
                   ended_at = excluded.ended_at, active_ms = excluded.active_ms,
                   unit = excluded.unit, units_read = excluded.units_read,
                   start_units = excluded.start_units, end_units = excluded.end_units,
                   total_units = excluded.total_units, book_title = excluded.book_title,
                   finish_cleared = excluded.finish_cleared,
                   units_adjustment = excluded.units_adjustment,
                   active_adjustment = excluded.active_adjustment",
                params![
                    session.id,
                    book_id,
                    session.started_at,
                    session.ended_at,
                    session.active_ms,
                    session.unit,
                    session.units_read,
                    session.start_units,
                    session.end_units,
                    session.total_units,
                    stored.book_title,
                    stored.finish_cleared,
                    stored.adjustment.as_ref().map_or(0, |a| a.units_delta),
                    stored.adjustment.as_ref().map_or(0, |a| a.active_ms_delta)
                ],
            )
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    let (matched, unmatched) = split_matches(&backup.books, &matches);
    Ok(RestoreResult {
        status: "restored",
        books: matched,
        unmatched_count: unmatched.len(),
        unmatched: unmatched.into_iter().take(20).collect(),
        sessions: backup.sessions.len(),
        snapshot: Some(snapshot.id),
    })
}

#[cfg(test)]
mod tests;
