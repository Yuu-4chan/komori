//! Syncing reading state between the phone and its paired Komori PC.
//!
//! The phone drives every sync (`pc_link::sync_pc`): it pulls the PC's state of the books it has
//! copies of and every reading session, merges them with its own against what both sides held
//! when they last synced (the phone's record of it), pushes what the PC lacks and then writes its
//! own side. The PC only answers `pull` and `push`. A PC book's copy keeps the PC's catalog ID
//! (copies made before syncing are matched through `pc_books`); bookmarks, notes and sessions
//! keep their own IDs on both sides.
//!
//! Each item merges three ways: what changed on one side goes to the other, what one side deleted
//! since the last sync is deleted on the other, and with nothing recorded (a first sync) both are
//! combined. When both sides changed, a book's place becomes a conflict the Reader asks about, a
//! bookmark takes the PC's name, a note keeps both versions (the phone's as a new note), and a
//! session keeps the version of the device that read it. One place bookmarked on both sides
//! becomes the PC's bookmark.
#![cfg_attr(not(mobile), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    backup::valid_timestamp,
    bookmarks::{text_valid, BookmarkLocator, MAX_BOOKMARKS},
    library::{storage_error, BookProgress},
    reader_notes::{self, MAX_NOTES},
    reading_position::{self, ReadingPosition},
    reading_sessions::{self, ReadingDevice, ReadingSession, SessionAdjustment},
};

/// The most books one pull asks about.
const MAX_BOOKS: usize = 10_000;
/// How far within a section two places without whole-book progress may be and still be one.
const SAME_PLACE: f64 = 0.001;
/// The longest session title kept, as backups keep it.
const MAX_TITLE: usize = 4096;

/// Where a book is: its place in the Reader and its whole-book progress. Neither means unread.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reading {
    pub(crate) position: Option<ReadingPosition>,
    pub(crate) progress: Option<BookProgress>,
}

impl Reading {
    fn is_valid(&self) -> bool {
        self.position.as_ref().is_none_or(ReadingPosition::is_valid)
            && self.progress.as_ref().is_none_or(BookProgress::is_valid)
    }

    fn is_empty(&self) -> bool {
        self.position.is_none() && self.progress.is_none()
    }

    /// Whether both are the same place to the reader. Opening a book saves its place again as
    /// that screen lays it out, a little off within the section; the same section with the same
    /// whole-book progress (or, without one, nearly the same place in the section) is unchanged.
    fn same_place(&self, other: &Self) -> bool {
        if self.progress != other.progress {
            return false;
        }
        match (&self.position, &other.position) {
            (None, None) => true,
            (Some(mine), Some(theirs)) => {
                mine.spine_index == theirs.spine_index
                    && mine.section_key == theirs.section_key
                    && (self.progress.is_some()
                        || (mine.progress - theirs.progress).abs() <= SAME_PLACE)
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncBookmark {
    pub(crate) id: String,
    pub(crate) book_id: String,
    pub(crate) locator: BookmarkLocator,
    pub(crate) label: String,
    pub(crate) excerpt: String,
    pub(crate) created_at: String,
}

impl SyncBookmark {
    fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.id).is_ok()
            && Uuid::parse_str(&self.book_id).is_ok()
            && self.locator.canonical().is_some()
            && text_valid(&self.label, 80)
            && text_valid(&self.excerpt, 160)
            && valid_timestamp(&self.created_at)
    }

    fn hash(&self) -> String {
        digest(&[
            "bookmark",
            &self.locator.canonical().unwrap_or_default(),
            &self.label,
            &self.excerpt,
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncNote {
    pub(crate) id: String,
    pub(crate) book_id: String,
    pub(crate) locator: BookmarkLocator,
    pub(crate) passage: String,
    pub(crate) body: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

impl SyncNote {
    fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.id).is_ok()
            && Uuid::parse_str(&self.book_id).is_ok()
            && self.locator.canonical().is_some()
            && reader_notes::text_valid(&self.passage)
            && reader_notes::body_valid(&self.body)
            && valid_timestamp(&self.created_at)
            && valid_timestamp(&self.updated_at)
    }

    fn hash(&self) -> String {
        digest(&[
            "note",
            &self.locator.canonical().unwrap_or_default(),
            &self.passage,
            &self.body,
        ])
    }
}

/// A reading session with its book and the device that read it (none: the one that keeps it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncSession {
    pub(crate) book_id: String,
    pub(crate) book_title: Option<String>,
    pub(crate) finish_cleared: bool,
    pub(crate) adjustment: SessionAdjustment,
    pub(crate) device: Option<String>,
    pub(crate) session: ReadingSession,
}

impl SyncSession {
    fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.book_id).is_ok()
            && self.session.is_valid()
            && self.adjustment.is_valid()
            && self.book_title.as_deref().is_none_or(|title| {
                !title.is_empty()
                    && title.chars().count() <= MAX_TITLE
                    && !title.chars().any(char::is_control)
            })
            && self
                .device
                .as_deref()
                .is_none_or(|device| Uuid::parse_str(device).is_ok())
    }

    /// Who read it is fixed when it is recorded, so it is not part of what changes.
    fn hash(&self) -> String {
        let content = serde_json::to_string(&(
            &self.book_id,
            &self.book_title,
            self.finish_cleared,
            &self.adjustment,
            &self.session,
        ))
        .unwrap_or_default();
        digest(&["session", &content])
    }
}

/// A PC book's state as the PC holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BookState {
    pub(crate) id: String,
    pub(crate) reading: Reading,
    /// When its place last changed.
    pub(crate) updated_at: Option<String>,
    pub(crate) bookmarks: Vec<SyncBookmark>,
    pub(crate) notes: Vec<SyncNote>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PullRequest {
    /// The PC books the phone has copies of.
    pub(crate) books: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PullResponse {
    /// The PC's own device ID, which its sessions carry.
    pub(crate) device: String,
    /// Every device the PC knows by name: itself, its phones, and those that read its sessions.
    pub(crate) devices: Vec<ReadingDevice>,
    /// The asked-for books the PC still has.
    pub(crate) books: Vec<BookState>,
    pub(crate) sessions: Vec<SyncSession>,
}

/// A book's new place, written only while the PC still holds the place the phone merged with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PositionChange {
    pub(crate) book: String,
    pub(crate) expected: Reading,
    pub(crate) next: Reading,
    pub(crate) updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Deleted {
    pub(crate) bookmarks: Vec<String>,
    pub(crate) notes: Vec<String>,
    pub(crate) sessions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PushRequest {
    pub(crate) positions: Vec<PositionChange>,
    pub(crate) bookmarks: Vec<SyncBookmark>,
    pub(crate) notes: Vec<SyncNote>,
    pub(crate) sessions: Vec<SyncSession>,
    pub(crate) deleted: Deleted,
}

#[cfg(test)]
impl PushRequest {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PushResponse {
    /// Books whose place moved on the PC since the pull; the next sync merges them again.
    pub(crate) refused: Vec<String>,
}

fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    crate::devices::protocol::encode(&hash.finalize())
}

fn book_exists(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

/// A book's place and progress, and when either last changed.
pub(crate) fn reading_of(
    connection: &Connection,
    book: &str,
) -> Result<(Reading, Option<String>), String> {
    let position = reading_position::load_from(connection, book)?;
    let position_at: Option<String> = connection
        .query_row(
            "SELECT updated_at FROM reading_positions WHERE book_id = ?1",
            [book],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let progress = connection
        .query_row(
            "SELECT unit, current_units, total_units, updated_at FROM book_progress
              WHERE book_id = ?1",
            [book],
            |row| {
                Ok((
                    BookProgress {
                        unit: row.get(0)?,
                        current: row.get(1)?,
                        total: row.get(2)?,
                    },
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
        .filter(|(progress, _)| progress.is_valid());
    let progress_at = progress.as_ref().and_then(|(_, at)| at.clone());
    let updated_at = [
        position.as_ref().and(position_at),
        progress_at.filter(|_| progress.is_some()),
    ]
    .into_iter()
    .flatten()
    .filter(|at| valid_timestamp(at))
    .max();
    Ok((
        Reading {
            position,
            progress: progress.map(|(progress, _)| progress),
        },
        updated_at,
    ))
}

/// Writes a book's place and progress (none removes it), dated `updated_at` or now.
fn write_reading(
    connection: &Connection,
    book: &str,
    reading: &Reading,
    updated_at: Option<&str>,
) -> Result<(), String> {
    let at = updated_at.filter(|at| valid_timestamp(at));
    match &reading.position {
        Some(position) => connection.execute(
            "INSERT INTO reading_positions (book_id, spine_index, section_key, progress, updated_at)
             SELECT id, ?2, ?3, ?4, coalesce(?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               FROM books WHERE id = ?1
             ON CONFLICT(book_id) DO UPDATE SET
               spine_index = excluded.spine_index, section_key = excluded.section_key,
               progress = excluded.progress, updated_at = excluded.updated_at",
            params![
                book,
                position.spine_index,
                position.section_key,
                position.progress,
                at
            ],
        ),
        None => connection.execute("DELETE FROM reading_positions WHERE book_id = ?1", [book]),
    }
    .map_err(storage_error)?;
    match &reading.progress {
        Some(progress) => connection.execute(
            "INSERT INTO book_progress (book_id, unit, current_units, total_units, updated_at)
             SELECT id, ?2, ?3, ?4, coalesce(?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               FROM books WHERE id = ?1
             ON CONFLICT(book_id) DO UPDATE SET
               unit = excluded.unit, current_units = excluded.current_units,
               total_units = excluded.total_units, updated_at = excluded.updated_at",
            params![book, progress.unit, progress.current, progress.total, at],
        ),
        None => connection.execute("DELETE FROM book_progress WHERE book_id = ?1", [book]),
    }
    .map(|_| ())
    .map_err(storage_error)
}

/// The book's bookmarks, under the ID the other side knows the book by.
fn bookmarks_of(
    connection: &Connection,
    book: &str,
    shared: &str,
) -> Result<Vec<SyncBookmark>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, locator, label, excerpt, created_at FROM bookmarks
              WHERE book_id = ?1 ORDER BY created_at, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([book], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(storage_error)?;
    Ok(rows
        .filter_map(Result::ok)
        .filter_map(|(id, locator, label, excerpt, created_at)| {
            Some(SyncBookmark {
                id,
                book_id: shared.to_owned(),
                locator: serde_json::from_str(&locator).ok()?,
                label,
                excerpt,
                created_at,
            })
        })
        .filter(SyncBookmark::is_valid)
        .collect())
}

fn notes_of(connection: &Connection, book: &str, shared: &str) -> Result<Vec<SyncNote>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, locator, passage, body, created_at, updated_at FROM reader_notes
              WHERE book_id = ?1 ORDER BY created_at, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([book], |row| {
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
    Ok(rows
        .filter_map(Result::ok)
        .filter_map(|(id, locator, passage, body, created_at, updated_at)| {
            Some(SyncNote {
                id,
                book_id: shared.to_owned(),
                locator: serde_json::from_str(&locator).ok()?,
                passage,
                body,
                created_at,
                updated_at,
            })
        })
        .filter(SyncNote::is_valid)
        .collect())
}

fn sessions_of(connection: &Connection) -> Result<Vec<SyncSession>, String> {
    Ok(reading_sessions::list_from(connection)?
        .into_iter()
        .map(|stored| SyncSession {
            book_id: stored.book_id,
            book_title: stored.book_title,
            finish_cleared: stored.finish_cleared,
            adjustment: stored.adjustment,
            device: stored.device,
            session: stored.session,
        })
        .filter(SyncSession::is_valid)
        .collect())
}

/// Adds or updates a bookmark of `book`, unless another one already marks its place or the
/// book is full.
fn upsert_bookmark(
    connection: &Connection,
    book: &str,
    bookmark: &SyncBookmark,
) -> Result<bool, String> {
    let Some(locator) = bookmark.locator.canonical() else {
        return Ok(false);
    };
    let (taken, exists, count): (bool, bool, i64) = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bookmarks WHERE book_id = ?1 AND locator = ?2 AND id <> ?3),
                    EXISTS(SELECT 1 FROM bookmarks WHERE id = ?3),
                    (SELECT count(*) FROM bookmarks WHERE book_id = ?1)",
            params![book, locator, bookmark.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(storage_error)?;
    if taken || (!exists && count >= MAX_BOOKMARKS) {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO bookmarks (id, book_id, locator, label, excerpt, created_at)
             SELECT ?1, id, ?3, ?4, ?5, ?6 FROM books WHERE id = ?2
             ON CONFLICT(id) DO UPDATE SET
               book_id = excluded.book_id, locator = excluded.locator,
               label = excluded.label, excerpt = excluded.excerpt",
            params![
                bookmark.id,
                book,
                locator,
                bookmark.label,
                bookmark.excerpt,
                bookmark.created_at
            ],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

fn upsert_note(connection: &Connection, book: &str, note: &SyncNote) -> Result<bool, String> {
    let Some(locator) = note.locator.canonical() else {
        return Ok(false);
    };
    let (exists, count): (bool, usize) = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM reader_notes WHERE id = ?2),
                    (SELECT count(*) FROM reader_notes WHERE book_id = ?1)",
            params![book, note.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if !exists && count >= MAX_NOTES {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO reader_notes (id, book_id, locator, passage, body, created_at, updated_at)
             SELECT ?1, id, ?3, ?4, ?5, ?6, ?7 FROM books WHERE id = ?2
             ON CONFLICT(id) DO UPDATE SET
               book_id = excluded.book_id, locator = excluded.locator,
               passage = excluded.passage, body = excluded.body,
               updated_at = excluded.updated_at",
            params![
                note.id,
                book,
                locator,
                note.passage,
                note.body,
                note.created_at,
                note.updated_at
            ],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

/// Records a session as it came, whether or not its book is here; who read it never changes.
fn upsert_session(connection: &Connection, session: &SyncSession) -> Result<(), String> {
    let SyncSession {
        book_id,
        book_title,
        finish_cleared,
        adjustment,
        device,
        session,
    } = session;
    connection
        .execute(
            "INSERT INTO reading_sessions
               (id, book_id, started_at, ended_at, active_ms, unit, units_read, start_units,
                end_units, total_units, book_title, finish_cleared, units_adjustment,
                active_adjustment, device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
                book_title,
                finish_cleared,
                adjustment.units_delta,
                adjustment.active_ms_delta,
                device
            ],
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn delete_items(connection: &Connection, deleted: &Deleted) -> Result<(), String> {
    for (table, ids) in [
        ("bookmarks", &deleted.bookmarks),
        ("reader_notes", &deleted.notes),
        ("reading_sessions", &deleted.sessions),
    ] {
        for id in ids {
            connection
                .execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
                .map_err(storage_error)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The PC's side.

/// What the PC answers a pull with. `own` is the PC itself; `phones` its paired devices.
pub(crate) fn pull(
    connection: &Connection,
    own: &ReadingDevice,
    phones: &[ReadingDevice],
    request: &PullRequest,
) -> Result<PullResponse, String> {
    let mut books = Vec::new();
    let mut seen = HashSet::new();
    for id in request.books.iter().take(MAX_BOOKS) {
        if Uuid::parse_str(id).is_err() || !seen.insert(id) || !book_exists(connection, id)? {
            continue;
        }
        let (reading, updated_at) = reading_of(connection, id)?;
        books.push(BookState {
            id: id.clone(),
            reading,
            updated_at,
            bookmarks: bookmarks_of(connection, id, id)?,
            notes: notes_of(connection, id, id)?,
        });
    }
    let sessions = sessions_of(connection)?
        .into_iter()
        .map(|mut session| {
            session.device.get_or_insert_with(|| own.id.clone());
            session
        })
        .collect();
    let mut devices: BTreeMap<String, String> = reading_sessions::devices_from(connection)?
        .into_iter()
        .map(|device| (device.id, device.name))
        .collect();
    for device in phones
        .iter()
        .chain([own])
        .filter(|device| device.is_valid())
    {
        devices.insert(device.id.clone(), device.name.clone());
    }
    Ok(PullResponse {
        device: own.id.clone(),
        devices: devices
            .into_iter()
            .map(|(id, name)| ReadingDevice { id, name })
            .collect(),
        books,
        sessions,
    })
}

/// Writes what a phone pushed, all or nothing. `own` is the PC's device ID, `phone` the phone.
pub(crate) fn push(
    connection: &mut Connection,
    own: &str,
    phone: &ReadingDevice,
    request: &PushRequest,
) -> Result<PushResponse, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let mut refused = Vec::new();
    for change in &request.positions {
        if Uuid::parse_str(&change.book).is_err()
            || !change.next.is_valid()
            || !book_exists(&transaction, &change.book)?
        {
            refused.push(change.book.clone());
            continue;
        }
        let (current, _) = reading_of(&transaction, &change.book)?;
        if current != change.expected {
            refused.push(change.book.clone());
            continue;
        }
        write_reading(
            &transaction,
            &change.book,
            &change.next,
            change.updated_at.as_deref(),
        )?;
    }
    delete_items(&transaction, &request.deleted)?;
    for bookmark in request.bookmarks.iter().filter(|each| each.is_valid()) {
        upsert_bookmark(&transaction, &bookmark.book_id, bookmark)?;
    }
    for note in request.notes.iter().filter(|each| each.is_valid()) {
        upsert_note(&transaction, &note.book_id, note)?;
    }
    for session in request.sessions.iter().filter(|each| each.is_valid()) {
        let mut session = session.clone();
        // The PC's own sessions carry no device here.
        if session.device.as_deref() == Some(own) {
            session.device = None;
        }
        upsert_session(&transaction, &session)?;
    }
    reading_sessions::save_device(&transaction, phone)?;
    transaction.commit().map_err(storage_error)?;
    Ok(PushResponse { refused })
}

// ---------------------------------------------------------------------------------------------
// The phone's side.

pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_books (
               book_id TEXT PRIMARY KEY,
               reading TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sync_items (
               kind TEXT NOT NULL,
               id TEXT NOT NULL,
               book_id TEXT,
               hash TEXT NOT NULL,
               PRIMARY KEY (kind, id)
             );
             CREATE TABLE IF NOT EXISTS sync_conflicts (
               book_id TEXT PRIMARY KEY,
               reading TEXT NOT NULL,
               updated_at TEXT
             );",
        )
        .map_err(storage_error)
}

/// Forgets what the last sync saw, as unpairing does: the next pairing combines both sides.
pub(crate) fn forget(connection: &Connection) -> Result<(), String> {
    create_tables(connection)?;
    connection
        .execute_batch(
            "DELETE FROM sync_books; DELETE FROM sync_items; DELETE FROM sync_conflicts;",
        )
        .map_err(storage_error)
}

/// The phone's copies of PC books: the PC's ID for each copy, and the copy for each PC ID.
#[derive(Debug, Default)]
pub(crate) struct Copies {
    to_local: HashMap<String, String>,
    to_pc: HashMap<String, String>,
}

impl Copies {
    pub(crate) fn read(connection: &Connection) -> Self {
        let pairs: Vec<(String, String)> = connection
            .prepare("SELECT book_id, pc_book FROM pc_books")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            })
            .unwrap_or_default();
        let mut copies = Self::default();
        for (local, pc) in pairs {
            copies.to_local.insert(pc.clone(), local.clone());
            copies.to_pc.insert(local, pc);
        }
        copies
    }

    fn local<'a>(&'a self, pc: &'a str) -> &'a str {
        self.to_local.get(pc).map_or(pc, String::as_str)
    }

    fn pc<'a>(&'a self, local: &'a str) -> &'a str {
        self.to_pc.get(local).map_or(local, String::as_str)
    }

    pub(crate) fn pc_books(&self) -> Vec<String> {
        let mut books: Vec<String> = self.to_local.keys().cloned().collect();
        books.sort();
        books
    }
}

/// What a sync asks the PC for.
pub(crate) fn pull_request(connection: &Connection) -> PullRequest {
    PullRequest {
        books: Copies::read(connection).pc_books(),
    }
}

/// A place the phone takes from the PC, while its own is still the one merged.
#[derive(Debug)]
struct TakenReading {
    book: String,
    expected: Reading,
    next: Reading,
    updated_at: Option<String>,
}

/// One sync's changes on both sides, written on the phone once the PC took its part.
#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub(crate) push: PushRequest,
    readings: Vec<TakenReading>,
    /// PC books whose place changed on both sides: the PC's place, and when.
    conflicts: Vec<(String, Reading, Option<String>)>,
    settled: Vec<String>,
    bookmarks: Vec<(String, SyncBookmark)>,
    notes: Vec<(String, SyncNote)>,
    sessions: Vec<SyncSession>,
    deleted: Deleted,
    /// What both sides hold after the sync; a pushed place is recorded once the PC took it.
    books: Vec<(String, Reading)>,
    pushed: Vec<(String, Reading)>,
    forget_books: Vec<String>,
    items: Vec<(&'static str, String, Option<String>, String)>,
    forget_items: Vec<(&'static str, String)>,
    devices: Vec<ReadingDevice>,
}

impl Plan {
    /// Whether the sync changes the phone's books, for the Library to show it.
    pub(crate) fn changes_phone(&self) -> bool {
        !self.readings.is_empty()
            || !self.bookmarks.is_empty()
            || !self.notes.is_empty()
            || !self.sessions.is_empty()
            || self.deleted != Deleted::default()
    }

    #[cfg(test)]
    pub(crate) fn pushes(&self) -> bool {
        !self.push.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Merge {
    Same,
    TakeTheirs,
    PushMine,
    DeleteMine,
    DeleteTheirs,
    Forget,
    Both,
}

/// The three-way decision for one item, from its hash at the last sync and on each side now.
fn merge(base: Option<&str>, mine: Option<&str>, theirs: Option<&str>) -> Merge {
    match (mine, theirs) {
        (None, None) => Merge::Forget,
        (Some(mine), Some(theirs)) if mine == theirs => Merge::Same,
        (Some(mine), Some(theirs)) => {
            if base == Some(mine) {
                Merge::TakeTheirs
            } else if base == Some(theirs) {
                Merge::PushMine
            } else {
                Merge::Both
            }
        }
        // Deleted on the PC, unless the phone changed it since: a change outlives a deletion.
        (Some(mine), None) if base == Some(mine) => Merge::DeleteMine,
        (Some(_), None) => Merge::PushMine,
        (None, Some(theirs)) if base == Some(theirs) => Merge::DeleteTheirs,
        (None, Some(_)) => Merge::TakeTheirs,
    }
}

/// How one item ends up after a sync.
#[derive(Debug, Clone)]
enum Outcome<T> {
    /// Both sides hold it already.
    Keep(T),
    /// The phone takes the PC's version.
    Take(T),
    /// The PC takes the phone's version.
    Push(T),
    /// New on both sides.
    New(T),
    Drop {
        mine: bool,
        theirs: bool,
    },
}

struct Baselines {
    books: HashMap<String, Reading>,
    items: HashMap<(String, String), String>,
}

fn baselines(connection: &Connection) -> Result<Baselines, String> {
    let mut statement = connection
        .prepare("SELECT book_id, reading FROM sync_books")
        .map_err(storage_error)?;
    let books = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage_error)?
        .filter_map(Result::ok)
        .filter_map(|(book, reading)| Some((book, serde_json::from_str(&reading).ok()?)))
        .collect();
    let mut statement = connection
        .prepare("SELECT kind, id, hash FROM sync_items")
        .map_err(storage_error)?;
    let items = statement
        .query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?
        .filter_map(Result::ok)
        .collect();
    Ok(Baselines { books, items })
}

/// Merges one kind of item; `both` settles one changed on both sides.
fn merge_items<T: Clone>(
    kind: &str,
    base: &Baselines,
    mine: &BTreeMap<String, T>,
    theirs: &BTreeMap<String, T>,
    hash: impl Fn(&T) -> String,
    mut both: impl FnMut(&T, &T) -> Vec<(String, Outcome<T>)>,
) -> Vec<(String, Outcome<T>)> {
    let ids: BTreeSet<&String> = mine.keys().chain(theirs.keys()).collect();
    let mut outcomes = Vec::new();
    for id in ids {
        let (my, their) = (mine.get(id), theirs.get(id));
        let recorded = base.items.get(&(kind.to_owned(), id.clone()));
        let decision = merge(
            recorded.map(String::as_str),
            my.map(&hash).as_deref(),
            their.map(&hash).as_deref(),
        );
        match decision {
            Merge::Same => outcomes.push((id.clone(), Outcome::Keep(my.unwrap().clone()))),
            Merge::TakeTheirs => outcomes.push((id.clone(), Outcome::Take(their.unwrap().clone()))),
            Merge::PushMine => outcomes.push((id.clone(), Outcome::Push(my.unwrap().clone()))),
            Merge::DeleteMine => outcomes.push((
                id.clone(),
                Outcome::Drop {
                    mine: true,
                    theirs: false,
                },
            )),
            Merge::DeleteTheirs => outcomes.push((
                id.clone(),
                Outcome::Drop {
                    mine: false,
                    theirs: true,
                },
            )),
            Merge::Forget => outcomes.push((
                id.clone(),
                Outcome::Drop {
                    mine: false,
                    theirs: false,
                },
            )),
            Merge::Both => outcomes.extend(both(my.unwrap(), their.unwrap())),
        }
    }
    outcomes
}

/// Merges the PC's state into a plan for both sides. `own` is the phone's device ID.
pub(crate) fn plan(
    connection: &Connection,
    own: &str,
    pulled: &PullResponse,
) -> Result<Plan, String> {
    create_tables(connection)?;
    let copies = Copies::read(connection);
    let base = baselines(connection)?;
    let mut plan = Plan::default();
    let answered: HashSet<&str> = pulled
        .books
        .iter()
        .filter(|book| copies.to_local.contains_key(&book.id))
        .map(|book| book.id.as_str())
        .collect();
    // A book the PC no longer has, or the phone no longer has a copy of, is not deleted on
    // either side: what the last sync saw of it is forgotten.
    for book in base.books.keys() {
        if !answered.contains(book.as_str()) {
            plan.forget_books.push(book.clone());
        }
    }
    let item_books: Vec<(String, String, Option<String>)> = connection
        .prepare("SELECT kind, id, book_id FROM sync_items WHERE kind <> 'session'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect()
        })
        .map_err(storage_error)?;
    for (kind, id, book) in item_books {
        if book.as_deref().is_none_or(|book| !answered.contains(book)) {
            plan.forget_items
                .push((if kind == "note" { "note" } else { "bookmark" }, id));
        }
    }

    for state in pulled
        .books
        .iter()
        .filter(|book| answered.contains(book.id.as_str()))
    {
        let local = copies.local(&state.id).to_owned();
        if !book_exists(connection, &local)? || !state.reading.is_valid() {
            continue;
        }
        plan_reading(connection, &base, &mut plan, &local, state)?;
        plan_bookmarks(connection, &base, &mut plan, &local, state)?;
        plan_notes(connection, &base, &mut plan, &local, state)?;
    }
    plan_sessions(connection, &base, &mut plan, &copies, own, pulled)?;
    plan.devices = pulled
        .devices
        .iter()
        .filter(|device| device.id != own && device.is_valid())
        .cloned()
        .collect();
    Ok(plan)
}

fn plan_reading(
    connection: &Connection,
    base: &Baselines,
    plan: &mut Plan,
    local: &str,
    state: &BookState,
) -> Result<(), String> {
    let (mine, mine_at) = reading_of(connection, local)?;
    let theirs = &state.reading;
    let recorded = base.books.get(&state.id);
    let unchanged = |reading: &Reading| match recorded {
        Some(recorded) => recorded.same_place(reading),
        None => reading.is_empty(),
    };
    if mine.same_place(theirs) {
        plan.books.push((state.id.clone(), mine));
        plan.settled.push(state.id.clone());
    } else if unchanged(&mine) {
        plan.readings.push(TakenReading {
            book: local.to_owned(),
            expected: mine,
            next: theirs.clone(),
            updated_at: state.updated_at.clone(),
        });
        plan.books.push((state.id.clone(), theirs.clone()));
        plan.settled.push(state.id.clone());
    } else if unchanged(theirs) {
        plan.push.positions.push(PositionChange {
            book: state.id.clone(),
            expected: theirs.clone(),
            next: mine.clone(),
            updated_at: mine_at,
        });
        plan.pushed.push((state.id.clone(), mine));
        plan.settled.push(state.id.clone());
    } else {
        plan.conflicts
            .push((state.id.clone(), theirs.clone(), state.updated_at.clone()));
    }
    Ok(())
}

fn plan_bookmarks(
    connection: &Connection,
    base: &Baselines,
    plan: &mut Plan,
    local: &str,
    state: &BookState,
) -> Result<(), String> {
    let mine: BTreeMap<String, SyncBookmark> = bookmarks_of(connection, local, &state.id)?
        .into_iter()
        .map(|bookmark| (bookmark.id.clone(), bookmark))
        .collect();
    let theirs: BTreeMap<String, SyncBookmark> = state
        .bookmarks
        .iter()
        .filter(|bookmark| bookmark.is_valid() && bookmark.book_id == state.id)
        .map(|bookmark| (bookmark.id.clone(), bookmark.clone()))
        .collect();
    // Renamed on both sides: the PC's name.
    let mut outcomes = merge_items(
        "bookmark",
        base,
        &mine,
        &theirs,
        SyncBookmark::hash,
        |_, pc| vec![(pc.id.clone(), Outcome::Take(pc.clone()))],
    );
    // One place bookmarked on both sides is one bookmark, the PC's.
    let mut places: HashMap<String, usize> = HashMap::new();
    let survivor = |outcome: &Outcome<SyncBookmark>| match outcome {
        Outcome::Keep(each) | Outcome::Take(each) | Outcome::Push(each) | Outcome::New(each) => {
            Some(each.locator.canonical().unwrap_or_default())
        }
        Outcome::Drop { .. } => None,
    };
    for index in 0..outcomes.len() {
        let Some(place) = survivor(&outcomes[index].1) else {
            continue;
        };
        match places.get(&place).copied() {
            None => {
                places.insert(place, index);
            }
            Some(kept) => {
                let pc_has = |index: usize| theirs.contains_key(&outcomes[index].0);
                let (winner, loser) = if pc_has(index) && !pc_has(kept) {
                    (index, kept)
                } else {
                    (kept, index)
                };
                let id = outcomes[loser].0.clone();
                outcomes[loser].1 = Outcome::Drop {
                    mine: mine.contains_key(&id),
                    theirs: theirs.contains_key(&id),
                };
                places.insert(place, winner);
            }
        }
    }
    for (id, outcome) in outcomes {
        record(
            plan,
            "bookmark",
            &state.id,
            id,
            outcome,
            SyncBookmark::hash,
            |plan, each, local_too, pc_too| {
                if local_too {
                    plan.bookmarks.push((local.to_owned(), each.clone()));
                }
                if pc_too {
                    plan.push.bookmarks.push(each);
                }
            },
            |deleted| &mut deleted.bookmarks,
        );
    }
    Ok(())
}

fn plan_notes(
    connection: &Connection,
    base: &Baselines,
    plan: &mut Plan,
    local: &str,
    state: &BookState,
) -> Result<(), String> {
    let mine: BTreeMap<String, SyncNote> = notes_of(connection, local, &state.id)?
        .into_iter()
        .map(|note| (note.id.clone(), note))
        .collect();
    let theirs: BTreeMap<String, SyncNote> = state
        .notes
        .iter()
        .filter(|note| note.is_valid() && note.book_id == state.id)
        .map(|note| (note.id.clone(), note.clone()))
        .collect();
    // Edited on both sides: the PC's keeps its ID, and the phone's is kept as a new note.
    let outcomes = merge_items("note", base, &mine, &theirs, SyncNote::hash, |phone, pc| {
        let copy = SyncNote {
            id: Uuid::new_v4().to_string(),
            ..phone.clone()
        };
        vec![
            (pc.id.clone(), Outcome::Take(pc.clone())),
            (copy.id.clone(), Outcome::New(copy)),
        ]
    });
    for (id, outcome) in outcomes {
        record(
            plan,
            "note",
            &state.id,
            id,
            outcome,
            SyncNote::hash,
            |plan, each, local_too, pc_too| {
                if local_too {
                    plan.notes.push((local.to_owned(), each.clone()));
                }
                if pc_too {
                    plan.push.notes.push(each);
                }
            },
            |deleted| &mut deleted.notes,
        );
    }
    Ok(())
}

fn plan_sessions(
    connection: &Connection,
    base: &Baselines,
    plan: &mut Plan,
    copies: &Copies,
    own: &str,
    pulled: &PullResponse,
) -> Result<(), String> {
    // Both sides' sessions as the PC names books and devices.
    let mine: BTreeMap<String, SyncSession> = sessions_of(connection)?
        .into_iter()
        .map(|mut session| {
            session.book_id = copies.pc(&session.book_id).to_owned();
            session.device.get_or_insert_with(|| own.to_owned());
            (session.session.id.clone(), session)
        })
        .collect();
    let theirs: BTreeMap<String, SyncSession> = pulled
        .sessions
        .iter()
        .filter(|session| session.is_valid() && session.device.is_some())
        .map(|session| (session.session.id.clone(), session.clone()))
        .collect();
    // Changed on both sides: the device that read it keeps its version.
    let outcomes = merge_items(
        "session",
        base,
        &mine,
        &theirs,
        SyncSession::hash,
        |phone, pc| {
            if phone.device.as_deref() == Some(own) {
                vec![(phone.session.id.clone(), Outcome::Push(phone.clone()))]
            } else {
                vec![(pc.session.id.clone(), Outcome::Take(pc.clone()))]
            }
        },
    );
    for (id, outcome) in outcomes {
        record(
            plan,
            "session",
            "",
            id,
            outcome,
            SyncSession::hash,
            |plan, each, local_too, pc_too| {
                if local_too {
                    let mut here = each.clone();
                    here.book_id = copies.local(&here.book_id).to_owned();
                    if here.device.as_deref() == Some(own) {
                        here.device = None;
                    }
                    plan.sessions.push(here);
                }
                if pc_too {
                    plan.push.sessions.push(each);
                }
            },
            |deleted| &mut deleted.sessions,
        );
    }
    Ok(())
}

/// Adds one item's outcome to the plan: `write` sends it to the phone, the PC, or both.
#[allow(clippy::too_many_arguments)]
fn record<T>(
    plan: &mut Plan,
    kind: &'static str,
    book: &str,
    id: String,
    outcome: Outcome<T>,
    hash: impl Fn(&T) -> String,
    write: impl FnOnce(&mut Plan, T, bool, bool),
    list: impl Fn(&mut Deleted) -> &mut Vec<String>,
) {
    let book = (!book.is_empty()).then(|| book.to_owned());
    match outcome {
        Outcome::Drop { mine, theirs } => {
            if mine {
                list(&mut plan.deleted).push(id.clone());
            }
            if theirs {
                list(&mut plan.push.deleted).push(id.clone());
            }
            plan.forget_items.push((kind, id));
        }
        Outcome::Keep(each) => plan.items.push((kind, id, book, hash(&each))),
        Outcome::Take(each) => {
            plan.items.push((kind, id, book, hash(&each)));
            write(plan, each, true, false);
        }
        Outcome::Push(each) => {
            plan.items.push((kind, id, book, hash(&each)));
            write(plan, each, false, true);
        }
        Outcome::New(each) => {
            plan.items.push((kind, id, book, hash(&each)));
            write(plan, each, true, true);
        }
    }
}

/// Writes the phone's side of a sync the PC accepted, and what both sides now hold.
/// Writes the phone's part of the sync; returns the phone's books whose place it moved.
pub(crate) fn finish(
    connection: &mut Connection,
    plan: &Plan,
    answer: &PushResponse,
) -> Result<Vec<String>, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    create_tables(&transaction)?;
    let mut moved = Vec::new();
    for taken in &plan.readings {
        // The Reader may have moved on since the merge; its place then goes to the PC next time.
        if reading_of(&transaction, &taken.book)?.0 == taken.expected {
            write_reading(
                &transaction,
                &taken.book,
                &taken.next,
                taken.updated_at.as_deref(),
            )?;
            if taken.next.position != taken.expected.position {
                moved.push(taken.book.clone());
            }
        }
    }
    delete_items(&transaction, &plan.deleted)?;
    for (book, bookmark) in &plan.bookmarks {
        upsert_bookmark(&transaction, book, bookmark)?;
    }
    for (book, note) in &plan.notes {
        upsert_note(&transaction, book, note)?;
    }
    for session in &plan.sessions {
        upsert_session(&transaction, session)?;
    }
    for (book, reading, updated_at) in &plan.conflicts {
        transaction
            .execute(
                "INSERT INTO sync_conflicts (book_id, reading, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(book_id) DO UPDATE SET
                   reading = excluded.reading, updated_at = excluded.updated_at",
                params![book, json(reading)?, updated_at],
            )
            .map_err(storage_error)?;
    }
    for book in plan.settled.iter().chain(&plan.forget_books) {
        transaction
            .execute("DELETE FROM sync_conflicts WHERE book_id = ?1", [book])
            .map_err(storage_error)?;
    }
    for book in &plan.forget_books {
        transaction
            .execute("DELETE FROM sync_books WHERE book_id = ?1", [book])
            .map_err(storage_error)?;
    }
    let pushed = plan
        .pushed
        .iter()
        .filter(|(book, _)| !answer.refused.contains(book));
    for (book, reading) in plan.books.iter().chain(pushed) {
        transaction
            .execute(
                "INSERT INTO sync_books (book_id, reading) VALUES (?1, ?2)
                 ON CONFLICT(book_id) DO UPDATE SET reading = excluded.reading",
                params![book, json(reading)?],
            )
            .map_err(storage_error)?;
    }
    for (kind, id) in &plan.forget_items {
        transaction
            .execute(
                "DELETE FROM sync_items WHERE kind = ?1 AND id = ?2",
                params![kind, id],
            )
            .map_err(storage_error)?;
    }
    for (kind, id, book, hash) in &plan.items {
        transaction
            .execute(
                "INSERT INTO sync_items (kind, id, book_id, hash) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(kind, id) DO UPDATE SET
                   book_id = excluded.book_id, hash = excluded.hash",
                params![kind, id, book, hash],
            )
            .map_err(storage_error)?;
    }
    for device in &plan.devices {
        reading_sessions::save_device(&transaction, device)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(moved)
}

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

/// A book's place on both sides, when they changed it apart, for the Reader to ask.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pc: Reading,
    pc_at: Option<String>,
    phone: Reading,
    phone_at: Option<String>,
}

/// The conflict of a book on the phone (its catalog ID), if its place changed on both sides.
pub(crate) fn conflict_of(connection: &Connection, book: &str) -> Result<Option<Conflict>, String> {
    create_tables(connection)?;
    let copies = Copies::read(connection);
    let stored: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT reading, updated_at FROM sync_conflicts WHERE book_id = ?1",
            [copies.pc(book)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((reading, pc_at)) = stored else {
        return Ok(None);
    };
    let Ok(pc) = serde_json::from_str::<Reading>(&reading) else {
        return Ok(None);
    };
    let (phone, phone_at) = reading_of(connection, book)?;
    Ok((pc != phone).then_some(Conflict {
        pc,
        pc_at,
        phone,
        phone_at,
    }))
}

/// Settles a book's conflict: the PC's place (`keep_pc`) is written here, or the phone's goes
/// to the PC with the next sync.
pub(crate) fn resolve(
    connection: &mut Connection,
    book: &str,
    keep_pc: bool,
) -> Result<bool, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    create_tables(&transaction)?;
    let copies = Copies::read(&transaction);
    let pc_book = copies.pc(book).to_owned();
    let stored: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT reading, updated_at FROM sync_conflicts WHERE book_id = ?1",
            [&pc_book],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(pc) = stored
        .as_ref()
        .and_then(|(reading, _)| serde_json::from_str::<Reading>(reading).ok())
    else {
        return Ok(false);
    };
    if keep_pc {
        write_reading(
            &transaction,
            book,
            &pc,
            stored.as_ref().and_then(|(_, at)| at.as_deref()),
        )?;
    }
    // Both sides last agreed on the PC's place: the phone's, if kept, is a change to push.
    transaction
        .execute(
            "INSERT INTO sync_books (book_id, reading) VALUES (?1, ?2)
             ON CONFLICT(book_id) DO UPDATE SET reading = excluded.reading",
            params![pc_book, json(&pc)?],
        )
        .map_err(storage_error)?;
    transaction
        .execute("DELETE FROM sync_conflicts WHERE book_id = ?1", [&pc_book])
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
