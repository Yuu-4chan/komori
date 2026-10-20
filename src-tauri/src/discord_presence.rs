//! Discord Rich Presence. While it is on, Komori tells the Discord app on this computer what
//! the Reader shows, through Discord's local IPC pipe: the book's title, its progress, the
//! chapter's progress and the reading speed, each as the reader chooses, or Idle after five
//! minutes without reading or with no book open. Native code owns the choices, the pipe and the
//! idle timer; the Reader reports only display text and its position. Nothing goes over the
//! network from Komori: the Discord app shares the status.

use crate::interface_text::{self, Text};
use crate::library::{open_catalog, storage_error, CatalogState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

static CHANGING: Mutex<()> = Mutex::new(());
pub(crate) const RECORD: &str = "discord";
/// Komori's application in the Discord Developer Portal; Discord shows its name and icon.
const CLIENT_ID: &str = "1562070752675766322";
/// No reading for this long shows Idle.
const IDLE_AFTER: Duration = Duration::from_secs(5 * 60);
/// Discord accepts five activity updates in 20 s; a change sooner waits for the next slot.
const UPDATE_EVERY: Duration = Duration::from_secs(15);
/// While Discord is closed, how often Komori looks for it again.
const CONNECT_EVERY: Duration = Duration::from_secs(30);
/// How often the saved interface language is read again for the status words.
const LANGUAGE_EVERY: Duration = Duration::from_secs(60);
/// Discord's limit for each line of the status.
const LINE_CHARS: usize = 128;
/// A progress or speed text from the Reader is a few words.
const PART_CHARS: usize = 64;
/// The largest reading position the Reader saves (see book progress).
const MAX_POSITION: u64 = 1_000_000_000;

/// How book progress reads: `45%`, `9,099 / 20,000 characters` (or words), or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProgressFormat {
    #[default]
    Percentage,
    Position,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub enabled: bool,
    pub show_book_title: bool,
    pub show_book_progress: bool,
    #[serde(default)]
    pub book_progress_format: ProgressFormat,
    pub show_chapter_progress: bool,
    pub show_reading_speed: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            show_book_title: true,
            show_book_progress: true,
            book_progress_format: ProgressFormat::Percentage,
            show_chapter_progress: true,
            show_reading_speed: true,
        }
    }
}

impl Preferences {
    pub(crate) fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        let field =
            |name: &str, fallback| value.get(name).and_then(Value::as_bool).unwrap_or(fallback);
        Self {
            enabled: field("enabled", defaults.enabled),
            show_book_title: field("showBookTitle", defaults.show_book_title),
            show_book_progress: field("showBookProgress", defaults.show_book_progress),
            book_progress_format: value
                .get("bookProgressFormat")
                .and_then(|format| serde_json::from_value(format.clone()).ok())
                .unwrap_or(defaults.book_progress_format),
            show_chapter_progress: field("showChapterProgress", defaults.show_chapter_progress),
            show_reading_speed: field("showReadingSpeed", defaults.show_reading_speed),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Changes {
    enabled: Option<bool>,
    show_book_title: Option<bool>,
    show_book_progress: Option<bool>,
    book_progress_format: Option<ProgressFormat>,
    show_chapter_progress: Option<bool>,
    show_reading_speed: Option<bool>,
}

impl Changes {
    fn apply(self, preferences: &mut Preferences) {
        if let Some(format) = self.book_progress_format {
            preferences.book_progress_format = format;
        }
        let pairs = [
            (self.enabled, &mut preferences.enabled),
            (self.show_book_title, &mut preferences.show_book_title),
            (self.show_book_progress, &mut preferences.show_book_progress),
            (
                self.show_chapter_progress,
                &mut preferences.show_chapter_progress,
            ),
            (self.show_reading_speed, &mut preferences.show_reading_speed),
        ];
        for (change, field) in pairs {
            if let Some(value) = change {
                *field = value;
            }
        }
    }
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

/// What the Reader shows of the open book, in the interface language. The texts are shown
/// as given, each only while its choice is on; `position` changing is reading.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reading {
    book: String,
    title: String,
    book_progress: Option<String>,
    book_position: Option<String>,
    chapter_progress: Option<String>,
    reading_speed: Option<String>,
    position: u64,
}

impl Reading {
    fn validated(self) -> Result<Self, String> {
        if Uuid::parse_str(&self.book).is_err() || self.position > MAX_POSITION {
            return Err("Invalid Discord status".into());
        }
        let part = |text: Option<String>| text.and_then(|text| clean(&text, PART_CHARS));
        Ok(Self {
            title: clean(&self.title, LINE_CHARS).unwrap_or_default(),
            book_progress: part(self.book_progress),
            book_position: part(self.book_position),
            chapter_progress: part(self.chapter_progress),
            reading_speed: part(self.reading_speed),
            ..self
        })
    }
}

/// One line of plain text: whitespace and control characters become single spaces, and text
/// longer than `limit` characters ends in an ellipsis. Empty text is none.
fn clean(text: &str, limit: usize) -> Option<String> {
    let words: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect();
    let line = words.join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= limit {
        return Some(line);
    }
    let mut short: String = line.chars().take(limit - 1).collect();
    short.truncate(short.trim_end().len());
    short.push('…');
    Some(short)
}

/// The status Discord shows: two lines and, while reading, when this stretch of reading began.
#[derive(Debug, Clone, PartialEq)]
struct Activity {
    details: String,
    state: Option<String>,
    /// Unix seconds; Discord counts the elapsed time from it.
    start: Option<u64>,
}

impl Activity {
    fn to_json(&self) -> Value {
        let mut activity = json!({ "details": self.details, "instance": false });
        if let Some(state) = &self.state {
            activity["state"] = json!(state);
        }
        if let Some(start) = self.start {
            activity["timestamps"] = json!({ "start": start });
        }
        activity
    }
}

/// The open book and when it was last read.
#[derive(Debug, Default)]
struct Presence {
    reading: Option<Reading>,
    /// When the book opened or its position last changed.
    progressed: Option<Instant>,
    /// When this stretch of reading began: the book opening, or reading again after Idle.
    since: u64,
}

impl Presence {
    fn report(&mut self, reading: Option<Reading>, now: Instant, unix: u64) {
        match (&self.reading, &reading) {
            (_, None) => self.progressed = None,
            (Some(old), Some(new)) if old.book == new.book => {
                if old.position != new.position {
                    if self.idle(now) {
                        self.since = unix;
                    }
                    self.progressed = Some(now);
                }
            }
            (_, Some(_)) => {
                self.progressed = Some(now);
                self.since = unix;
            }
        }
        self.reading = reading;
    }

    fn idle(&self, now: Instant) -> bool {
        self.progressed
            .is_none_or(|at| now.saturating_duration_since(at) >= IDLE_AFTER)
    }

    fn activity(&self, preferences: &Preferences, language: &str, now: Instant) -> Activity {
        let Some(reading) = self.reading.as_ref().filter(|_| !self.idle(now)) else {
            return Activity {
                details: interface_text::text(language, Text::DiscordIdle).into(),
                state: None,
                start: None,
            };
        };
        let details = match reading.title.chars().count() {
            0 => None,
            // Discord needs two characters a line; a one-character title is quoted.
            1 => Some(format!("“{}”", reading.title)),
            _ => Some(reading.title.clone()),
        }
        .filter(|_| preferences.show_book_title)
        .unwrap_or_else(|| interface_text::text(language, Text::DiscordReading).into());
        let format = preferences.book_progress_format;
        let parts: Vec<&str> = [
            (
                preferences.show_book_progress && format != ProgressFormat::Percentage,
                &reading.book_position,
            ),
            (
                preferences.show_book_progress && format != ProgressFormat::Position,
                &reading.book_progress,
            ),
            (preferences.show_chapter_progress, &reading.chapter_progress),
            (preferences.show_reading_speed, &reading.reading_speed),
        ]
        .into_iter()
        .filter_map(|(shown, text)| text.as_deref().filter(|_| shown))
        .collect();
        Activity {
            details,
            state: clean(&parts.join(" · "), LINE_CHARS).filter(|state| state.chars().count() >= 2),
            start: Some(self.since),
        }
    }
}

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;
/// Discord's answers are small; a longer frame is not Discord's.
const MAX_FRAME: usize = 64 * 1024;

fn write_frame(stream: &mut impl Write, opcode: u32, payload: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend(opcode.to_le_bytes());
    frame.extend(
        u32::try_from(body.len())
            .map_err(io::Error::other)?
            .to_le_bytes(),
    );
    frame.extend(body);
    stream.write_all(&frame)?;
    stream.flush()
}

fn read_frame(stream: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0; 8];
    stream.read_exact(&mut header)?;
    let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if length > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    let payload = serde_json::from_slice(&body).map_err(|_| io::ErrorKind::InvalidData)?;
    Ok((opcode, payload))
}

/// A connection to the Discord app.
struct Ipc<S> {
    stream: S,
}

impl<S: Read + Write> Ipc<S> {
    fn handshake(stream: S) -> io::Result<Self> {
        let mut ipc = Self { stream };
        write_frame(
            &mut ipc.stream,
            HANDSHAKE,
            &json!({ "v": 1, "client_id": CLIENT_ID }),
        )?;
        if ipc.reply()?["evt"] == "READY" {
            Ok(ipc)
        } else {
            Err(io::Error::other("Discord refused the connection"))
        }
    }

    /// Discord's next answer, answering its pings on the way.
    fn reply(&mut self) -> io::Result<Value> {
        loop {
            let (opcode, payload) = read_frame(&mut self.stream)?;
            match opcode {
                FRAME => return Ok(payload),
                PING => write_frame(&mut self.stream, PONG, &payload)?,
                CLOSE => return Err(io::ErrorKind::ConnectionAborted.into()),
                _ => {}
            }
        }
    }

    /// Shows `activity`, or clears the status. Discord refusing a status keeps the connection.
    fn set_activity(&mut self, activity: Option<&Activity>) -> io::Result<()> {
        write_frame(
            &mut self.stream,
            FRAME,
            &json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": activity.map(Activity::to_json) },
                "nonce": Uuid::new_v4().to_string(),
            }),
        )?;
        let reply = self.reply()?;
        if reply["evt"] == "ERROR" {
            eprintln!("Discord refused Komori's status: {}", reply["data"]);
        }
        Ok(())
    }
}

/// The Discord app's pipe, when it runs and accepts Komori.
fn connect() -> Option<Ipc<std::fs::File>> {
    (0..10).find_map(|index| {
        let pipe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\.\pipe\discord-ipc-{index}"))
            .ok()?;
        Ipc::handshake(pipe).ok()
    })
}

enum Message {
    Preferences(Preferences),
    Reading(Option<Reading>),
}

/// The Discord worker's inbox.
pub struct DiscordState {
    sender: Sender<Message>,
}

impl DiscordState {
    fn send(&self, message: Message) {
        // The worker only stops with the application.
        let _ = self.sender.send(message);
    }
}

/// Starts the worker that keeps Discord's status with the saved choices.
pub(crate) fn start(database: PathBuf) -> DiscordState {
    let (sender, receiver) = mpsc::channel();
    let preferences = load(&database).unwrap_or_default();
    let started = std::thread::Builder::new()
        .name("komori-discord".into())
        .spawn(move || {
            run(preferences, receiver, connect, || {
                interface_text::language(&database)
            })
        });
    if let Err(error) = started {
        eprintln!("Komori's Discord status could not start: {error}");
    }
    DiscordState { sender }
}

/// Applies the saved choices again, after a restore.
pub(crate) fn reload(app: &AppHandle, database: &Path) {
    if let Some(state) = app.try_state::<DiscordState>() {
        state.send(Message::Preferences(load(database).unwrap_or_default()));
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}

/// Keeps Discord's status until the application ends: connects while the choice is on (again
/// every 30 s while Discord is closed), sends each changed status at most every 15 s, and closes
/// the connection, clearing the status, when the choice is turned off.
fn run<S: Read + Write>(
    mut preferences: Preferences,
    messages: Receiver<Message>,
    mut connect: impl FnMut() -> Option<Ipc<S>>,
    language: impl Fn() -> &'static str,
) {
    let mut presence = Presence::default();
    let mut ipc: Option<Ipc<S>> = None;
    let mut shown: Option<Activity> = None;
    let mut sent_at: Option<Instant> = None;
    let mut tried_at: Option<Instant> = None;
    let mut words: Option<(&'static str, Instant)> = None;
    loop {
        // Idle needs the clock while the choice is on; otherwise only a message matters.
        let first = if preferences.enabled {
            match messages.recv_timeout(Duration::from_secs(1)) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match messages.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            }
        };
        for message in first.into_iter().chain(messages.try_iter()) {
            match message {
                Message::Preferences(next) => {
                    preferences = next;
                    words = None;
                }
                Message::Reading(reading) => presence.report(reading, Instant::now(), unix_now()),
            }
        }
        let now = Instant::now();
        if !preferences.enabled {
            if let Some(mut connection) = ipc.take() {
                let _ = connection.set_activity(None);
            }
            shown = None;
            tried_at = None;
            continue;
        }
        if ipc.is_none() {
            if tried_at.is_some_and(|at| now.duration_since(at) < CONNECT_EVERY) {
                continue;
            }
            tried_at = Some(now);
            ipc = connect();
            shown = None;
            sent_at = None;
        }
        let Some(connection) = ipc.as_mut() else {
            continue;
        };
        if sent_at.is_some_and(|at| now.duration_since(at) < UPDATE_EVERY) {
            continue;
        }
        let words_language = match words {
            Some((saved, at)) if now.duration_since(at) < LANGUAGE_EVERY => saved,
            _ => {
                let saved = language();
                words = Some((saved, now));
                saved
            }
        };
        let activity = presence.activity(&preferences, words_language, now);
        if shown.as_ref() == Some(&activity) {
            continue;
        }
        match connection.set_activity(Some(&activity)) {
            Ok(()) => {
                shown = Some(activity);
                sent_at = Some(now);
            }
            // Discord closed; look for it again later.
            Err(_) => ipc = None,
        }
    }
}

#[tauri::command]
pub async fn get_discord_preferences(
    catalog: State<'_, CatalogState>,
) -> Result<Preferences, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || load(&database))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_discord_preferences(
    catalog: State<'_, CatalogState>,
    discord: State<'_, DiscordState>,
    changes: Changes,
) -> Result<Preferences, String> {
    let database = catalog.database.clone();
    let preferences = tauri::async_runtime::spawn_blocking(move || {
        let _guard = CHANGING
            .lock()
            .map_err(|_| "Discord settings unavailable")?;
        let connection = open_catalog(&database)?;
        let mut preferences = load_from(&connection)?;
        changes.apply(&mut preferences);
        save_to(&connection, preferences)?;
        Ok::<_, String>(preferences)
    })
    .await
    .map_err(|e| e.to_string())??;
    discord.send(Message::Preferences(preferences));
    Ok(preferences)
}

/// The Reader's open book, or none when no book is open.
#[tauri::command]
pub fn set_discord_activity(
    discord: State<'_, DiscordState>,
    reading: Option<Reading>,
) -> Result<(), String> {
    let reading = reading.map(Reading::validated).transpose()?;
    discord.send(Message::Reading(reading));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::Arc;

    const BOOK: &str = "11111111-1111-4111-8111-111111111111";

    fn reading(position: u64) -> Reading {
        Reading {
            book: BOOK.into(),
            title: "吾輩は猫である".into(),
            book_progress: Some("45%".into()),
            book_position: Some("9,099 / 20,000 characters".into()),
            chapter_progress: Some("Chapter 30%".into()),
            reading_speed: Some("31,200 chars/h".into()),
            position,
        }
    }

    #[test]
    fn defaults_invalid_fields_and_reopens_saved_choices() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(load(&database).unwrap(), Preferences::default());
        assert!(!Preferences::default().enabled);
        let preferences = Preferences {
            enabled: true,
            show_reading_speed: false,
            ..Preferences::default()
        };
        save_to(&open_catalog(&database).unwrap(), preferences).unwrap();
        assert_eq!(load(&database).unwrap(), preferences);
        assert_eq!(
            Preferences::from_stored(&json!({"enabled": "yes", "showBookTitle": false})),
            Preferences {
                show_book_title: false,
                ..Preferences::default()
            }
        );
        assert_eq!(
            Preferences::from_stored(&json!({"bookProgressFormat": "both"})).book_progress_format,
            ProgressFormat::Both
        );
        assert_eq!(
            Preferences::from_stored(&json!({"bookProgressFormat": "fraction"})),
            Preferences::default()
        );
        assert!(serde_json::from_value::<Preferences>(json!({"enabled": true})).is_err());
        assert!(
            serde_json::from_value::<Changes>(json!({"bookProgressFormat": "fraction"})).is_err()
        );
        assert!(serde_json::from_value::<Changes>(json!({"clientId": "1"})).is_err());
        let mut changed = preferences;
        serde_json::from_value::<Changes>(json!({"showBookTitle": false}))
            .unwrap()
            .apply(&mut changed);
        assert_eq!(
            changed,
            Preferences {
                show_book_title: false,
                ..preferences
            }
        );
    }

    #[test]
    fn reports_are_validated_and_cleaned() {
        assert!(Reading {
            book: "not-a-book".into(),
            ..reading(0)
        }
        .validated()
        .is_err());
        assert!(reading(MAX_POSITION + 1).validated().is_err());
        assert!(serde_json::from_value::<Reading>(json!({
            "book": BOOK, "title": "", "bookProgress": null, "bookPosition": null,
            "chapterProgress": null,
            "readingSpeed": null, "position": 0, "path": "C:\\book.epub"
        }))
        .is_err());
        let cleaned = Reading {
            title: format!("  A\ntitle\u{0}{}", "x".repeat(200)),
            book_progress: Some("  ".into()),
            ..reading(3)
        }
        .validated()
        .unwrap();
        assert!(cleaned.title.starts_with("A title "));
        assert_eq!(cleaned.title.chars().count(), LINE_CHARS);
        assert!(cleaned.title.ends_with('…'));
        assert_eq!(cleaned.book_progress, None);
    }

    #[test]
    fn shows_the_chosen_parts_and_idle_after_five_minutes_without_reading() {
        let start = Instant::now();
        let mut presence = Presence::default();
        let everything = Preferences {
            enabled: true,
            ..Preferences::default()
        };
        // No book open is Idle.
        assert_eq!(
            presence.activity(&everything, "en", start),
            Activity {
                details: "Idle".into(),
                state: None,
                start: None
            }
        );
        presence.report(Some(reading(10)), start, 1_000);
        assert_eq!(
            presence.activity(&everything, "en", start),
            Activity {
                details: "吾輩は猫である".into(),
                state: Some("45% · Chapter 30% · 31,200 chars/h".into()),
                start: Some(1_000)
            }
        );
        let hidden = Preferences {
            show_book_title: false,
            show_chapter_progress: false,
            show_reading_speed: false,
            ..everything
        };
        assert_eq!(
            presence.activity(&hidden, "ja", start),
            Activity {
                details: "読書中".into(),
                state: Some("45%".into()),
                start: Some(1_000)
            }
        );
        let position = Preferences {
            book_progress_format: ProgressFormat::Position,
            ..hidden
        };
        assert_eq!(
            presence.activity(&position, "en", start).state.as_deref(),
            Some("9,099 / 20,000 characters")
        );
        let both = Preferences {
            book_progress_format: ProgressFormat::Both,
            ..everything
        };
        assert_eq!(
            presence.activity(&both, "en", start).state.as_deref(),
            Some("9,099 / 20,000 characters · 45% · Chapter 30% · 31,200 chars/h")
        );
        let nothing = Preferences {
            show_book_progress: false,
            ..hidden
        };
        assert_eq!(presence.activity(&nothing, "en", start).state, None);

        // A report without a new position (a speed refresh) is not reading.
        let later = start + Duration::from_secs(4 * 60);
        presence.report(Some(reading(10)), later, 1_240);
        assert_eq!(
            presence
                .activity(&everything, "en", start + IDLE_AFTER)
                .details,
            "Idle"
        );
        assert_eq!(
            presence
                .activity(
                    &everything,
                    "en",
                    start + IDLE_AFTER - Duration::from_secs(1)
                )
                .start,
            Some(1_000)
        );
        // Reading again after Idle starts a new stretch.
        let back = start + Duration::from_secs(9 * 60);
        presence.report(Some(reading(11)), back, 1_540);
        assert_eq!(
            presence.activity(&everything, "en", back).start,
            Some(1_540)
        );
        // Reading before Idle keeps the stretch.
        presence.report(Some(reading(12)), back + Duration::from_secs(60), 1_600);
        assert_eq!(
            presence
                .activity(&everything, "en", back + Duration::from_secs(60))
                .start,
            Some(1_540)
        );
        // Another book starts its own stretch, and closing the book is Idle.
        let other = Reading {
            book: "22222222-2222-4222-8222-222222222222".into(),
            title: "猫".into(),
            ..reading(12)
        };
        presence.report(Some(other), back + Duration::from_secs(61), 1_601);
        let shown = presence.activity(&everything, "en", back + Duration::from_secs(61));
        assert_eq!(shown.details, "“猫”");
        assert_eq!(shown.start, Some(1_601));
        presence.report(None, back + Duration::from_secs(62), 1_602);
        assert_eq!(
            presence
                .activity(&everything, "pt-BR", back + Duration::from_secs(62))
                .details,
            "Ausente"
        );
    }

    /// Discord's side of a pipe: scripted answers in, Komori's frames out.
    struct Pipe {
        input: Cursor<Vec<u8>>,
        output: Arc<Mutex<Vec<u8>>>,
    }

    impl Read for Pipe {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl Write for Pipe {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output.lock().unwrap().write(buffer)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frames(answers: &[(u32, Value)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (opcode, payload) in answers {
            write_frame(&mut bytes, *opcode, payload).unwrap();
        }
        bytes
    }

    fn sent(output: &Arc<Mutex<Vec<u8>>>) -> Vec<(u32, Value)> {
        let bytes = output.lock().unwrap().clone();
        let mut cursor = Cursor::new(bytes);
        let mut frames = Vec::new();
        while (cursor.position() as usize) < cursor.get_ref().len() {
            frames.push(read_frame(&mut cursor).unwrap());
        }
        frames
    }

    #[test]
    fn handshakes_answers_pings_and_sets_the_activity() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let pipe = Pipe {
            input: Cursor::new(frames(&[
                (FRAME, json!({"cmd": "DISPATCH", "evt": "READY"})),
                (PING, json!({"n": 1})),
                (FRAME, json!({"cmd": "SET_ACTIVITY", "evt": null})),
                (
                    FRAME,
                    json!({"cmd": "SET_ACTIVITY", "evt": "ERROR", "data": {}}),
                ),
                (CLOSE, json!({"code": 1000})),
            ])),
            output: output.clone(),
        };
        let mut ipc = Ipc::handshake(pipe).unwrap();
        let activity = Activity {
            details: "Book".into(),
            state: Some("45%".into()),
            start: Some(7),
        };
        ipc.set_activity(Some(&activity)).unwrap();
        // A refused status keeps the connection; a closed pipe does not.
        ipc.set_activity(None).unwrap();
        assert!(ipc.set_activity(None).is_err());
        let frames = sent(&output);
        assert_eq!(
            frames[0],
            (HANDSHAKE, json!({"v": 1, "client_id": CLIENT_ID}))
        );
        assert_eq!(frames[1].0, FRAME);
        assert_eq!(
            frames[1].1["args"]["activity"],
            json!({"details": "Book", "state": "45%", "timestamps": {"start": 7}, "instance": false})
        );
        assert_eq!(frames[1].1["cmd"], "SET_ACTIVITY");
        assert_eq!(frames[2], (PONG, json!({"n": 1})));
        assert_eq!(frames[3].1["args"]["activity"], Value::Null);

        let refused = Pipe {
            input: Cursor::new(frames_of_error()),
            output: Arc::new(Mutex::new(Vec::new())),
        };
        assert!(Ipc::handshake(refused).is_err());
        let mut huge = Cursor::new([1u32.to_le_bytes(), 70_000u32.to_le_bytes()].concat());
        assert!(read_frame(&mut huge).is_err());
    }

    fn frames_of_error() -> Vec<u8> {
        frames(&[(CLOSE, json!({"code": 4000, "message": "Invalid Client ID"}))])
    }

    #[test]
    fn the_worker_shows_the_book_and_clears_it_when_turned_off() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let answers = frames(
            &[(FRAME, json!({"evt": "READY"}))]
                .into_iter()
                .chain(std::iter::repeat_n((FRAME, json!({"evt": null})), 4))
                .collect::<Vec<_>>(),
        );
        let pipe = Some(Pipe {
            input: Cursor::new(answers),
            output: output.clone(),
        });
        let pipe = Mutex::new(pipe);
        let (sender, receiver) = mpsc::channel();
        sender.send(Message::Reading(Some(reading(5)))).unwrap();
        let worker = std::thread::spawn(move || {
            run(
                Preferences {
                    enabled: true,
                    ..Preferences::default()
                },
                receiver,
                || {
                    pipe.lock()
                        .unwrap()
                        .take()
                        .and_then(|pipe| Ipc::handshake(pipe).ok())
                },
                || "en",
            )
        });
        let wait_for = |count: usize| {
            for _ in 0..100 {
                if sent(&output).len() >= count {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            panic!("Komori sent {} frames", sent(&output).len());
        };
        wait_for(2);
        sender
            .send(Message::Preferences(Preferences::default()))
            .unwrap();
        wait_for(3);
        drop(sender);
        worker.join().unwrap();
        let frames = sent(&output);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[1].1["args"]["activity"]["details"], "吾輩は猫である");
        assert_eq!(frames[2].1["args"]["activity"], Value::Null);
    }
}
