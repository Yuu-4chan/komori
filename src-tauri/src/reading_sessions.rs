//! Komori-owned reading sessions and the Library's kanji, for Statistics.
//!
//! A session is one stretch of reading a book in the Reader: when it started and last saw
//! activity, how long it was actively read (idle time, a hidden window, and a closed Reader
//! excluded), and the units it read, with the book's position at its start and end. The Reader
//! saves the same session again as it goes, so a closed window loses at most its last moments.
//! `reading_sessions` is an additive table keyed by session ID, created without a schema bump
//! so an older Komori still opens the catalog. Sessions outlive their book's removal, keeping
//! the title it had, until the reader deletes them from Settings. Sources are never read here.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::library::{open_catalog, storage_error, CatalogState};

/// 2000-01-01T00:00:00Z: no genuine session starts earlier.
const MIN_TIME_MS: i64 = 946_684_800_000;
/// 9999-12-31: keeps stored times bounded.
const MAX_TIME_MS: i64 = 253_402_214_400_000;
/// A session may stay open for days, but not for longer than a month.
const MAX_SPAN_MS: i64 = 31 * 24 * 60 * 60 * 1000;
/// Nobody reads one session for more than a day.
const MAX_ACTIVE_MS: i64 = 24 * 60 * 60 * 1000;
/// As for book progress: generous for the longest real books, still bounded.
const MAX_UNITS: i64 = 1_000_000_000;

const SESSIONS_TABLE: &str = "(
               id TEXT PRIMARY KEY,
               book_id TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               ended_at INTEGER NOT NULL,
               active_ms INTEGER NOT NULL,
               unit TEXT NOT NULL,
               units_read INTEGER NOT NULL,
               start_units INTEGER NOT NULL,
               end_units INTEGER NOT NULL,
               total_units INTEGER NOT NULL,
               book_title TEXT,
               finish_cleared INTEGER NOT NULL DEFAULT 0,
               units_adjustment INTEGER NOT NULL DEFAULT 0,
               active_adjustment INTEGER NOT NULL DEFAULT 0
             )";

/// Creates the table, and moves the first version's rows, which cascaded with their book and
/// kept no title, to the current one.
pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS reading_sessions {SESSIONS_TABLE};"
        ))
        .map_err(storage_error)?;
    let titled: bool = connection
        .query_row(
            "SELECT count(*) FROM pragma_table_info('reading_sessions')
              WHERE name = 'book_title'",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !titled {
        connection
            .execute_batch(&format!(
                "BEGIN;
                 CREATE TABLE reading_sessions_next {SESSIONS_TABLE};
                 INSERT INTO reading_sessions_next
                   (id, book_id, started_at, ended_at, active_ms, unit, units_read,
                    start_units, end_units, total_units, book_title)
                 SELECT sessions.id, sessions.book_id, sessions.started_at, sessions.ended_at,
                        sessions.active_ms, sessions.unit, sessions.units_read,
                        sessions.start_units, sessions.end_units, sessions.total_units,
                        coalesce(books.title, books.file_name)
                   FROM reading_sessions AS sessions
                   LEFT JOIN books ON books.id = sessions.book_id;
                 DROP TABLE reading_sessions;
                 ALTER TABLE reading_sessions_next RENAME TO reading_sessions;
                 COMMIT;"
            ))
            .map_err(storage_error)?;
    }
    for column in ["units_adjustment", "active_adjustment"] {
        let exists: bool = connection
            .query_row(
                "SELECT count(*) FROM pragma_table_info('reading_sessions') WHERE name = ?1",
                [column],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE reading_sessions ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                ))
                .map_err(storage_error)?;
        }
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS reading_sessions_book
               ON reading_sessions (book_id, started_at);",
        )
        .map_err(storage_error)
}

/// One session as the Reader records it. Times are Unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingSession {
    pub(crate) id: String,
    pub(crate) started_at: i64,
    pub(crate) ended_at: i64,
    pub(crate) active_ms: i64,
    pub(crate) unit: String,
    pub(crate) units_read: i64,
    pub(crate) start_units: i64,
    pub(crate) end_units: i64,
    pub(crate) total_units: i64,
}

impl ReadingSession {
    pub(crate) fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.id).is_ok()
            && (MIN_TIME_MS..=MAX_TIME_MS).contains(&self.started_at)
            && (self.started_at..=MAX_TIME_MS).contains(&self.ended_at)
            && self.ended_at - self.started_at <= MAX_SPAN_MS
            && (0..=MAX_ACTIVE_MS.min(self.ended_at - self.started_at)).contains(&self.active_ms)
            && matches!(self.unit.as_str(), "characters" | "words")
            && (1..=MAX_UNITS).contains(&self.total_units)
            && (0..=MAX_UNITS).contains(&self.units_read)
            && (0..=self.total_units).contains(&self.start_units)
            && (0..=self.total_units).contains(&self.end_units)
    }
}

/// A recorded session with its book, as Statistics lists it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    book_id: String,
    /// The book's title when the session was last saved, for books since removed.
    book_title: Option<String>,
    /// Marked unread since: the session no longer counts as finishing the book.
    finish_cleared: bool,
    /// Corrections affect measured totals only; Reader checkpoints remain original.
    adjustment: SessionAdjustment,
    #[serde(flatten)]
    session: ReadingSession,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionAdjustment {
    pub(crate) units_delta: i64,
    pub(crate) active_ms_delta: i64,
}

impl SessionAdjustment {
    pub(crate) fn is_valid(&self) -> bool {
        (-MAX_UNITS..=MAX_UNITS).contains(&self.units_delta)
            && (-MAX_ACTIVE_MS..=MAX_ACTIVE_MS).contains(&self.active_ms_delta)
    }
}

/// Local midnight bounds identify the day; expected totals reject stale edits.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DailyActivityEdit {
    book_id: String,
    day_start: i64,
    day_end: i64,
    unit: String,
    units_read: i64,
    active_ms: i64,
    expected_units: i64,
    expected_active_ms: i64,
    expected_sessions: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivityResult {
    status: &'static str,
    sessions: Vec<StoredSession>,
}

#[tauri::command]
pub async fn edit_daily_activity(
    catalog: State<'_, CatalogState>,
    edit: DailyActivityEdit,
) -> Result<DailyActivityResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || edit_day(&mut open_catalog(&database)?, &edit))
        .await
        .map_err(|_| "Statistics edit task failed".to_owned())?
}

fn measured(stored: &StoredSession) -> (i64, i64) {
    (
        (stored.session.units_read + stored.adjustment.units_delta).clamp(0, MAX_UNITS),
        (stored.session.active_ms + stored.adjustment.active_ms_delta).clamp(0, MAX_ACTIVE_MS),
    )
}

fn edit_day(
    connection: &mut Connection,
    edit: &DailyActivityEdit,
) -> Result<DailyActivityResult, String> {
    let refused = |status| {
        Ok(DailyActivityResult {
            status,
            sessions: Vec::new(),
        })
    };
    if Uuid::parse_str(&edit.book_id).is_err()
        || !(MIN_TIME_MS..=MAX_TIME_MS).contains(&edit.day_start)
        || edit.day_end <= edit.day_start
        || edit.day_end > MAX_TIME_MS
        || !matches!(edit.unit.as_str(), "characters" | "words")
        || !(0..=MAX_UNITS).contains(&edit.units_read)
        || !(0..=MAX_ACTIVE_MS).contains(&edit.active_ms)
        || edit.expected_units < 0
        || edit.expected_active_ms < 0
    {
        return refused("invalid");
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // SQLite uses the system timezone, as the Statistics calendar does. This also validates
    // 23/25-hour DST days rather than trusting arbitrary caller timestamp ranges.
    let bounds: (i64, i64) = transaction.query_row(
        "SELECT strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', 'start of day', 'utc') * 1000,
                strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', 'start of day', '+1 day', 'utc') * 1000",
        [edit.day_start], |row| Ok((row.get(0)?, row.get(1)?))).map_err(storage_error)?;
    if bounds != (edit.day_start, edit.day_end) {
        return refused("invalid");
    }
    let sessions = list_from(&transaction)?;
    let selected: Vec<_> = sessions
        .iter()
        .filter(|stored| {
            stored.book_id == edit.book_id
                && stored.session.started_at >= edit.day_start
                && stored.session.started_at < edit.day_end
        })
        .collect();
    if selected.is_empty() {
        return refused("missing");
    }
    if selected
        .iter()
        .any(|stored| stored.session.unit != edit.unit)
    {
        return refused("conflict");
    }
    let (units, time) = selected
        .iter()
        .map(|stored| measured(stored))
        .fold((0i128, 0i128), |(u, t), (next_u, next_t)| {
            (u + i128::from(next_u), t + i128::from(next_t))
        });
    if units != i128::from(edit.expected_units)
        || time != i128::from(edit.expected_active_ms)
        || selected.len() != edit.expected_sessions
    {
        return refused("conflict");
    }
    // Preserve the relative contribution of existing sessions, with exact integer totals.
    let mut cumulative = (0i128, 0i128);
    let mut allocated = (0i64, 0i64);
    for (index, stored) in selected.iter().enumerate() {
        let (u, t) = measured(stored);
        cumulative.0 += i128::from(u);
        cumulative.1 += i128::from(t);
        let split = |target: i64, cumulative: i128, total: i128| {
            if total == 0 {
                target
            } else {
                (i128::from(target) * cumulative / total) as i64
            }
        };
        let next = (
            split(edit.units_read, cumulative.0, units),
            split(edit.active_ms, cumulative.1, time),
        );
        let share = if index == 0 {
            next
        } else {
            (next.0 - allocated.0, next.1 - allocated.1)
        };
        allocated = next;
        transaction.execute("UPDATE reading_sessions SET units_adjustment = ?1, active_adjustment = ?2 WHERE id = ?3",
            params![share.0 - stored.session.units_read, share.1 - stored.session.active_ms, stored.session.id]).map_err(storage_error)?;
    }
    let sessions = list_from(&transaction)?;
    transaction.commit().map_err(storage_error)?;
    Ok(DailyActivityResult {
        status: "saved",
        sessions,
    })
}

/// How much Statistics holds, for Settings.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsCounts {
    sessions: i64,
    /// Sessions of books no longer in the Library, and how many such books.
    orphan_sessions: i64,
    orphan_books: i64,
}

/// Records (or updates) one session of a catalog book.
#[tauri::command]
pub async fn save_reading_session(
    catalog: State<'_, CatalogState>,
    id: String,
    session: ReadingSession,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Uuid::parse_str(&id).is_err() || !session.is_valid() {
            return Ok(false);
        }
        save_to(&open_catalog(&database)?, &id, &session)
    })
    .await
    .map_err(|error| format!("Reading session task failed: {error}"))?
}

#[tauri::command]
pub async fn list_reading_sessions(
    catalog: State<'_, CatalogState>,
) -> Result<Vec<StoredSession>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || list_from(&open_catalog(&database)?))
        .await
        .map_err(|error| format!("Reading session task failed: {error}"))?
}

/// How many sessions are recorded, and how many belong to books no longer in the Library.
#[tauri::command]
pub async fn get_statistics_counts(
    catalog: State<'_, CatalogState>,
) -> Result<StatisticsCounts, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || counts_from(&open_catalog(&database)?))
        .await
        .map_err(|error| format!("Reading session task failed: {error}"))?
}

/// Deletes every recorded session (`orphans` false) or only those of books no longer in the
/// Library, returning how many were deleted. Books, progress and positions are untouched.
#[tauri::command]
pub async fn delete_reading_sessions(
    catalog: State<'_, CatalogState>,
    orphans: bool,
) -> Result<i64, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || delete_from(&open_catalog(&database)?, orphans))
        .await
        .map_err(|error| format!("Reading session task failed: {error}"))?
}

/// Marks a catalog book unread: its saved position and progress are removed, so it is not
/// started, and its sessions no longer count as finishing it. Returns false for unknown IDs.
#[tauri::command]
pub async fn mark_book_unread(
    catalog: State<'_, CatalogState>,
    id: String,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Uuid::parse_str(&id).is_err() {
            return Ok(false);
        }
        mark_unread(&mut open_catalog(&database)?, &id)
    })
    .await
    .map_err(|error| format!("Reading session task failed: {error}"))?
}

pub(crate) fn counts_from(connection: &Connection) -> Result<StatisticsCounts, String> {
    connection
        .query_row(
            "SELECT count(*),
                    count(*) FILTER (WHERE books.id IS NULL),
                    count(DISTINCT CASE WHEN books.id IS NULL THEN sessions.book_id END)
               FROM reading_sessions AS sessions
               LEFT JOIN books ON books.id = sessions.book_id",
            [],
            |row| {
                Ok(StatisticsCounts {
                    sessions: row.get(0)?,
                    orphan_sessions: row.get(1)?,
                    orphan_books: row.get(2)?,
                })
            },
        )
        .map_err(storage_error)
}

pub(crate) fn delete_from(connection: &Connection, orphans: bool) -> Result<i64, String> {
    let sql = if orphans {
        "DELETE FROM reading_sessions WHERE book_id NOT IN (SELECT id FROM books)"
    } else {
        "DELETE FROM reading_sessions"
    };
    connection
        .execute(sql, [])
        .map(|deleted| deleted as i64)
        .map_err(storage_error)
}

pub(crate) fn mark_unread(connection: &mut Connection, id: &str) -> Result<bool, String> {
    let transaction = connection.transaction().map_err(storage_error)?;
    let exists: bool = transaction
        .query_row("SELECT count(*) FROM books WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(storage_error)?;
    if !exists {
        return Ok(false);
    }
    for sql in [
        "DELETE FROM reading_positions WHERE book_id = ?1",
        "DELETE FROM book_progress WHERE book_id = ?1",
        "UPDATE reading_sessions SET finish_cleared = 1 WHERE book_id = ?1",
    ] {
        transaction.execute(sql, [id]).map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(true)
}

/// Every kanji the Library's Japanese or Chinese books contain, for the character explorer.
#[tauri::command]
pub async fn list_library_kanji(
    catalog: State<'_, CatalogState>,
) -> Result<Vec<LibraryKanji>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || kanji_from(&open_catalog(&database)?))
        .await
        .map_err(|error| format!("Library kanji task failed: {error}"))?
}

/// Inserts the session only while the book exists; a later save of the same session updates
/// it, but never moves it to another book or start.
pub(crate) fn save_to(
    connection: &Connection,
    book_id: &str,
    session: &ReadingSession,
) -> Result<bool, String> {
    if !session.is_valid() {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO reading_sessions
               (id, book_id, started_at, ended_at, active_ms, unit, units_read,
                start_units, end_units, total_units, book_title)
             SELECT ?1, id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, coalesce(title, file_name)
               FROM books WHERE id = ?2
             ON CONFLICT(id) DO UPDATE SET
               book_title = excluded.book_title,
               ended_at = excluded.ended_at,
               active_ms = excluded.active_ms,
               units_adjustment = CASE WHEN reading_sessions.unit = excluded.unit THEN reading_sessions.units_adjustment ELSE 0 END,
               active_adjustment = CASE WHEN reading_sessions.unit = excluded.unit THEN reading_sessions.active_adjustment ELSE 0 END,
               unit = excluded.unit,
               units_read = excluded.units_read,
               start_units = excluded.start_units,
               end_units = excluded.end_units,
               total_units = excluded.total_units
             WHERE reading_sessions.book_id = excluded.book_id
               AND reading_sessions.started_at = excluded.started_at",
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
                session.total_units
            ],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

/// Every well-formed session, oldest first; a corrupt row is left out.
pub(crate) fn list_from(connection: &Connection) -> Result<Vec<StoredSession>, String> {
    let mut statement = connection
        .prepare(
            "SELECT book_id, id, started_at, ended_at, active_ms, unit, units_read,
                    start_units, end_units, total_units, book_title, finish_cleared,
                    units_adjustment, active_adjustment
               FROM reading_sessions ORDER BY started_at, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0),
                row.get::<_, Option<String>>(10).unwrap_or(None),
                row.get::<_, bool>(11).unwrap_or(false),
                SessionAdjustment {
                    units_delta: row.get(12).unwrap_or(0),
                    active_ms_delta: row.get(13).unwrap_or(0),
                },
                (|| {
                    Ok::<_, rusqlite::Error>(ReadingSession {
                        id: row.get(1)?,
                        started_at: row.get(2)?,
                        ended_at: row.get(3)?,
                        active_ms: row.get(4)?,
                        unit: row.get(5)?,
                        units_read: row.get(6)?,
                        start_units: row.get(7)?,
                        end_units: row.get(8)?,
                        total_units: row.get(9)?,
                    })
                })(),
            ))
        })
        .map_err(storage_error)?;
    let mut sessions = Vec::new();
    for row in rows {
        if let (Ok(book_id), book_title, finish_cleared, adjustment, Ok(session)) =
            row.map_err(storage_error)?
        {
            if session.is_valid() {
                sessions.push(StoredSession {
                    book_id,
                    book_title,
                    finish_cleared,
                    adjustment: if adjustment.is_valid() {
                        adjustment
                    } else {
                        SessionAdjustment::default()
                    },
                    session,
                });
            }
        }
    }
    Ok(sessions)
}

/// One script's kanji across the Library.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryKanji {
    /// `ja` or `zh`.
    language: &'static str,
    /// The books of this language with counted kanji.
    books: i64,
    /// Each kanji, the books containing it, and whether a completed book does.
    kanji: Vec<KanjiEntry>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiEntry {
    character: String,
    books: i64,
    completed: bool,
}

/// Groups the counted kanji of Japanese and Chinese books, most widespread first. A book is
/// completed when its saved progress reached its total.
pub(crate) fn kanji_from(connection: &Connection) -> Result<Vec<LibraryKanji>, String> {
    let mut statement = connection
        .prepare(
            "SELECT details.language, details.kanji,
                    coalesce(progress.current_units >= progress.total_units
                             AND progress.total_units > 0, 0)
               FROM book_details AS details
               LEFT JOIN book_progress AS progress ON progress.book_id = details.book_id
              WHERE details.kanji IS NOT NULL AND details.kanji <> ''",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(storage_error)?;
    // Per script: its books, and each kanji's books and whether a completed book has it.
    type Kanji = BTreeMap<char, (i64, bool)>;
    let mut groups: BTreeMap<&'static str, (i64, Kanji)> = BTreeMap::new();
    for row in rows {
        let (language, kanji, completed) = row.map_err(storage_error)?;
        let Some(script) = script_of(language.as_deref()) else {
            continue;
        };
        let (books, entries) = groups.entry(script).or_default();
        *books += 1;
        for character in kanji.chars() {
            let entry = entries.entry(character).or_default();
            entry.0 += 1;
            entry.1 |= completed;
        }
    }
    Ok(groups
        .into_iter()
        .map(|(language, (books, entries))| {
            let mut kanji: Vec<KanjiEntry> = entries
                .into_iter()
                .map(|(character, (books, completed))| KanjiEntry {
                    character: character.to_string(),
                    books,
                    completed,
                })
                .collect();
            // Stable over code point order, so ties stay in code point order.
            kanji.sort_by_key(|entry| std::cmp::Reverse(entry.books));
            LibraryKanji {
                language,
                books,
                kanji,
            }
        })
        .collect())
}

fn script_of(language: Option<&str>) -> Option<&'static str> {
    let primary = language?.split('-').next()?;
    match primary {
        "ja" => Some("ja"),
        "zh" => Some("zh"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::BookProgress;
    use crate::reading_position::save_progress_to;
    use std::path::Path;
    use tempfile::tempdir;

    const BOOK: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "22222222-2222-4222-8222-222222222222";
    const SESSION: &str = "33333333-3333-4333-8333-333333333333";
    const START: i64 = 1_790_000_000_000;

    fn catalog(directory: &Path) -> Connection {
        let connection = open_catalog(&directory.join("library.sqlite3")).unwrap();
        for (id, name) in [(BOOK, "a.epub"), (OTHER, "b.epub")] {
            connection
                .execute(
                    "INSERT INTO books (id, source_path, file_name) VALUES (?1, ?2, ?3)",
                    params![id, format!("C:/private/{name}"), name],
                )
                .unwrap();
        }
        connection
    }

    fn session(active_ms: i64, units_read: i64) -> ReadingSession {
        ReadingSession {
            id: SESSION.into(),
            started_at: START,
            ended_at: START + 600_000,
            active_ms,
            unit: "characters".into(),
            units_read,
            start_units: 100,
            end_units: 100 + units_read,
            total_units: 10_000,
        }
    }

    fn daily_edit(connection: &Connection, book_id: &str) -> DailyActivityEdit {
        let (day_start, day_end) = connection.query_row(
            "SELECT strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', 'start of day', 'utc') * 1000,
                    strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', 'start of day', '+1 day', 'utc') * 1000",
            [START], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).unwrap();
        let selected: Vec<_> = list_from(connection)
            .unwrap()
            .into_iter()
            .filter(|s| {
                s.book_id == book_id
                    && s.session.started_at >= day_start
                    && s.session.started_at < day_end
            })
            .collect();
        DailyActivityEdit {
            book_id: book_id.into(),
            day_start,
            day_end,
            unit: "characters".into(),
            units_read: 1500,
            active_ms: 3_600_000,
            expected_units: selected.iter().map(|s| measured(s).0).sum(),
            expected_active_ms: selected.iter().map(|s| measured(s).1).sum(),
            expected_sessions: selected.len(),
        }
    }

    #[test]
    fn corrects_daily_measurements_atomically_persists_and_keeps_reader_checkpoints() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut connection = catalog(directory.path());
        let first = session(60_000, 500);
        let later = ReadingSession {
            id: "44444444-4444-4444-8444-444444444444".into(),
            started_at: START + 1000,
            ended_at: START + 601000,
            ..session(120_000, 1000)
        };
        save_to(&connection, BOOK, &first).unwrap();
        save_to(&connection, BOOK, &later).unwrap();
        let edit = daily_edit(&connection, BOOK);
        let other_day = ReadingSession {
            id: "55555555-5555-4555-8555-555555555555".into(),
            started_at: edit.day_end,
            ended_at: edit.day_end + 600000,
            ..first.clone()
        };
        save_to(&connection, BOOK, &other_day).unwrap();
        let other_book = ReadingSession {
            id: "66666666-6666-4666-8666-666666666666".into(),
            unit: "words".into(),
            ..first.clone()
        };
        save_to(&connection, OTHER, &other_book).unwrap();
        save_progress_to(
            &connection,
            BOOK,
            &BookProgress {
                unit: "characters".into(),
                current: 900,
                total: 10000,
            },
        )
        .unwrap();
        connection.execute("INSERT INTO reading_positions (book_id, spine_index, progress, updated_at) VALUES (?1, 0, 0.09, '2026-10-01T00:00:00.000Z')", [BOOK]).unwrap();
        assert_eq!(edit_day(&mut connection, &edit).unwrap().status, "saved");
        let listed = list_from(&connection).unwrap();
        assert_eq!(listed[0].session, first);
        let later_stored = listed.iter().find(|s| s.session.id == later.id).unwrap();
        assert_eq!(later_stored.session, later);
        assert_eq!(measured(&listed[0]), (500, 1200000));
        assert_eq!(measured(later_stored), (1000, 2400000));
        assert!(listed
            .iter()
            .filter(|s| s.session.id == other_day.id || s.session.id == other_book.id)
            .all(|s| s.adjustment == SessionAdjustment::default()));
        let progress: i64 = connection
            .query_row(
                "SELECT current_units FROM book_progress WHERE book_id = ?1",
                [BOOK],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(progress, 900);
        let position: f64 = connection
            .query_row(
                "SELECT progress FROM reading_positions WHERE book_id = ?1",
                [BOOK],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(position, 0.09);
        assert_eq!(edit_day(&mut connection, &edit).unwrap().status, "conflict");
        // Subsequent saves add their new measurements to the correction, without overwriting it.
        save_to(&connection, BOOK, &session(120000, 600)).unwrap();
        assert_eq!(
            measured(&list_from(&connection).unwrap()[0]),
            (600, 1260000)
        );
        // Retained sessions remain editable after Library removal.
        connection
            .execute("DELETE FROM books WHERE id = ?1", [BOOK])
            .unwrap();
        let mut zero = daily_edit(&connection, BOOK);
        zero.units_read = 0;
        zero.active_ms = 0;
        assert_eq!(edit_day(&mut connection, &zero).unwrap().status, "saved");
        let mut maximum = daily_edit(&connection, BOOK);
        maximum.units_read = MAX_UNITS;
        maximum.active_ms = MAX_ACTIVE_MS;
        assert_eq!(edit_day(&mut connection, &maximum).unwrap().status, "saved");
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        let selected: Vec<_> = list_from(&connection)
            .unwrap()
            .into_iter()
            .filter(|s| s.book_id == BOOK && s.session.started_at < edit.day_end)
            .collect();
        assert_eq!(
            selected.iter().map(|s| measured(s).0).sum::<i64>(),
            MAX_UNITS
        );
        assert_eq!(
            selected.iter().map(|s| measured(s).1).sum::<i64>(),
            MAX_ACTIVE_MS
        );
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn refuses_invalid_missing_stale_and_failed_daily_edits_without_mutation() {
        let directory = tempdir().unwrap();
        let mut connection = catalog(directory.path());
        save_to(&connection, BOOK, &session(60000, 500)).unwrap();
        let edit = daily_edit(&connection, BOOK);
        let before = serde_json::to_value(list_from(&connection).unwrap()).unwrap();
        for invalid in [
            DailyActivityEdit {
                book_id: "C:/private/a.epub".into(),
                ..edit.clone()
            },
            DailyActivityEdit {
                units_read: -1,
                ..edit.clone()
            },
            DailyActivityEdit {
                units_read: MAX_UNITS + 1,
                ..edit.clone()
            },
            DailyActivityEdit {
                active_ms: -1,
                ..edit.clone()
            },
            DailyActivityEdit {
                active_ms: MAX_ACTIVE_MS + 1,
                ..edit.clone()
            },
            DailyActivityEdit {
                unit: "pages".into(),
                ..edit.clone()
            },
            DailyActivityEdit {
                day_start: edit.day_start + 1,
                ..edit.clone()
            },
            DailyActivityEdit {
                day_end: edit.day_end + 1,
                ..edit.clone()
            },
            DailyActivityEdit {
                day_start: i64::MIN,
                ..edit.clone()
            },
        ] {
            assert_eq!(
                edit_day(&mut connection, &invalid).unwrap().status,
                "invalid"
            );
        }
        assert_eq!(
            edit_day(
                &mut connection,
                &DailyActivityEdit {
                    book_id: OTHER.into(),
                    ..edit.clone()
                }
            )
            .unwrap()
            .status,
            "missing"
        );
        assert_eq!(
            edit_day(
                &mut connection,
                &DailyActivityEdit {
                    expected_units: 501,
                    ..edit.clone()
                }
            )
            .unwrap()
            .status,
            "conflict"
        );
        assert_eq!(
            edit_day(
                &mut connection,
                &DailyActivityEdit {
                    expected_sessions: 2,
                    ..edit.clone()
                }
            )
            .unwrap()
            .status,
            "conflict"
        );
        assert_eq!(
            serde_json::to_value(list_from(&connection).unwrap()).unwrap(),
            before
        );
        let later = ReadingSession {
            id: "44444444-4444-4444-8444-444444444444".into(),
            ..session(60000, 500)
        };
        save_to(&connection, BOOK, &later).unwrap();
        let edit = daily_edit(&connection, BOOK);
        let before = serde_json::to_value(list_from(&connection).unwrap()).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_second BEFORE UPDATE ON reading_sessions WHEN OLD.id = '44444444-4444-4444-8444-444444444444' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(edit_day(&mut connection, &edit).is_err());
        assert_eq!(
            serde_json::to_value(list_from(&connection).unwrap()).unwrap(),
            before
        );
        let mut value = serde_json::json!({"bookId":BOOK,"dayStart":edit.day_start,"dayEnd":edit.day_end,"unit":"characters","unitsRead":1,"activeMs":1,"expectedUnits":1000,"expectedActiveMs":120000,"expectedSessions":2});
        value["sourcePath"] = "C:/private/a.epub".into();
        assert!(serde_json::from_value::<DailyActivityEdit>(value).is_err());
    }

    #[test]
    fn saves_updates_and_lists_a_session_for_its_book_only() {
        let directory = tempdir().unwrap();
        let connection = catalog(directory.path());
        assert!(save_to(&connection, BOOK, &session(60_000, 500)).unwrap());
        assert!(save_to(&connection, BOOK, &session(120_000, 900)).unwrap());
        // The same session cannot move to another book or start.
        assert!(!save_to(&connection, OTHER, &session(180_000, 1_000)).unwrap());
        let moved = ReadingSession {
            started_at: START + 1,
            ..session(180_000, 1_000)
        };
        assert!(!save_to(&connection, BOOK, &moved).unwrap());
        // Unknown books get no session.
        let unknown = ReadingSession {
            id: "44444444-4444-4444-8444-444444444444".into(),
            ..session(1_000, 0)
        };
        assert!(!save_to(
            &connection,
            "55555555-5555-4555-8555-555555555555",
            &unknown
        )
        .unwrap());

        let listed = list_from(&connection).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].book_id, BOOK);
        assert_eq!(listed[0].session, session(120_000, 900));
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(json["bookId"], BOOK);
        assert_eq!(json["activeMs"], 120_000);
        assert_eq!(json["unitsRead"], 900);
        assert_eq!(json["startUnits"], 100);

        assert_eq!(json["bookTitle"], "a.epub");
        assert_eq!(json["finishCleared"], false);

        // A removed book's sessions stay, with its title, until deleted.
        connection
            .execute("DELETE FROM books WHERE id = ?1", [BOOK])
            .unwrap();
        assert_eq!(list_from(&connection).unwrap().len(), 1);
        assert_eq!(
            counts_from(&connection).unwrap(),
            StatisticsCounts {
                sessions: 1,
                orphan_sessions: 1,
                orphan_books: 1
            }
        );
    }

    #[test]
    fn deletes_orphan_or_all_sessions_and_marks_books_unread() {
        let directory = tempdir().unwrap();
        let mut connection = catalog(directory.path());
        let other = |id: &str| ReadingSession {
            id: id.into(),
            ..session(60_000, 500)
        };
        assert!(save_to(&connection, BOOK, &session(60_000, 500)).unwrap());
        for id in [
            "44444444-4444-4444-8444-444444444444",
            "66666666-6666-4666-8666-666666666666",
        ] {
            assert!(save_to(&connection, OTHER, &other(id)).unwrap());
        }
        connection
            .execute("DELETE FROM books WHERE id = ?1", [OTHER])
            .unwrap();
        assert_eq!(delete_from(&connection, true).unwrap(), 2);
        let listed = list_from(&connection).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].book_id, BOOK);

        save_progress_to(
            &connection,
            BOOK,
            &BookProgress {
                unit: "characters".into(),
                current: 10_000,
                total: 10_000,
            },
        )
        .unwrap();
        assert!(mark_unread(&mut connection, BOOK).unwrap());
        assert!(!mark_unread(&mut connection, OTHER).unwrap());
        let progress: i64 = connection
            .query_row("SELECT count(*) FROM book_progress", [], |row| row.get(0))
            .unwrap();
        assert_eq!(progress, 0);
        assert!(list_from(&connection).unwrap()[0].finish_cleared);
        // A later session of the same book counts again.
        let later = ReadingSession {
            started_at: START + 1_000_000,
            ended_at: START + 1_600_000,
            ..other("77777777-7777-4777-8777-777777777777")
        };
        assert!(save_to(&connection, BOOK, &later).unwrap());
        assert!(!list_from(&connection).unwrap()[1].finish_cleared);

        assert_eq!(delete_from(&connection, false).unwrap(), 2);
        assert!(list_from(&connection).unwrap().is_empty());
    }

    #[test]
    fn moves_first_version_sessions_to_the_current_table() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = catalog(directory.path());
        connection
            .execute_batch(&format!(
                "DROP TABLE reading_sessions;
                 CREATE TABLE reading_sessions (
                   id TEXT PRIMARY KEY,
                   book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                   started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
                   active_ms INTEGER NOT NULL, unit TEXT NOT NULL,
                   units_read INTEGER NOT NULL, start_units INTEGER NOT NULL,
                   end_units INTEGER NOT NULL, total_units INTEGER NOT NULL);
                 INSERT INTO reading_sessions VALUES
                   ('{SESSION}', '{BOOK}', {START}, {START} + 600000, 60000, 'characters',
                    500, 100, 600, 10000);"
            ))
            .unwrap();
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        let listed = list_from(&connection).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].book_title.as_deref(), Some("a.epub"));
        connection
            .execute("DELETE FROM books WHERE id = ?1", [BOOK])
            .unwrap();
        assert_eq!(list_from(&connection).unwrap().len(), 1);
    }

    #[test]
    fn rejects_invalid_sessions() {
        let directory = tempdir().unwrap();
        let connection = catalog(directory.path());
        let valid = session(60_000, 500);
        for invalid in [
            ReadingSession {
                id: "C:/private/a.epub".into(),
                ..valid.clone()
            },
            ReadingSession {
                started_at: 0,
                ..valid.clone()
            },
            ReadingSession {
                ended_at: START - 1,
                ..valid.clone()
            },
            ReadingSession {
                ended_at: START + MAX_SPAN_MS + 1,
                ..valid.clone()
            },
            // More active time than the session lasted.
            ReadingSession {
                active_ms: 600_001,
                ..valid.clone()
            },
            ReadingSession {
                active_ms: -1,
                ..valid.clone()
            },
            ReadingSession {
                unit: "pages".into(),
                ..valid.clone()
            },
            ReadingSession {
                units_read: -1,
                ..valid.clone()
            },
            ReadingSession {
                total_units: 0,
                ..valid.clone()
            },
            ReadingSession {
                end_units: 10_001,
                ..valid.clone()
            },
        ] {
            assert!(
                !save_to(&connection, BOOK, &invalid).unwrap(),
                "{invalid:?}"
            );
        }
        assert!(list_from(&connection).unwrap().is_empty());
        assert!(serde_json::from_value::<ReadingSession>(serde_json::json!({
            "id": SESSION, "startedAt": START, "endedAt": START, "activeMs": 0,
            "unit": "words", "unitsRead": 0, "startUnits": 0, "endUnits": 0,
            "totalUnits": 1, "sourcePath": "C:/private/a.epub"
        }))
        .is_err());
    }

    #[test]
    fn a_corrupt_stored_session_is_left_out() {
        let directory = tempdir().unwrap();
        let connection = catalog(directory.path());
        assert!(save_to(&connection, BOOK, &session(60_000, 500)).unwrap());
        connection
            .execute("UPDATE reading_sessions SET active_ms = 'text'", [])
            .unwrap();
        assert!(list_from(&connection).unwrap().is_empty());
        connection
            .execute("UPDATE reading_sessions SET active_ms = 99999999999", [])
            .unwrap();
        assert!(list_from(&connection).unwrap().is_empty());
    }

    #[test]
    fn groups_japanese_and_chinese_kanji_with_completion() {
        let directory = tempdir().unwrap();
        let connection = catalog(directory.path());
        let insert = |id: &str, language: &str, kanji: &str| {
            connection
                .execute(
                    "INSERT INTO book_details (book_id, details_version, language, kanji)
                     VALUES (?1, 1, ?2, ?3)",
                    params![id, language, kanji],
                )
                .unwrap();
        };
        insert(BOOK, "ja", "人日本");
        insert(OTHER, "ja-JP", "日月");
        save_progress_to(
            &connection,
            OTHER,
            &BookProgress {
                unit: "characters".into(),
                current: 10,
                total: 10,
            },
        )
        .unwrap();
        let groups = kanji_from(&connection).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].language, "ja");
        assert_eq!(groups[0].books, 2);
        let summary: Vec<(String, i64, bool)> = groups[0]
            .kanji
            .iter()
            .map(|entry| (entry.character.clone(), entry.books, entry.completed))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("日".into(), 2, true),
                ("人".into(), 1, false),
                ("月".into(), 1, true),
                ("本".into(), 1, false),
            ]
        );
    }
}
