//! Local-only AnkiConnect v6. No URLs or transport errors cross the IPC boundary.
use crate::library::{open_catalog, CatalogState};
use crate::word_audio;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::BTreeMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

static OPERATIONS: Mutex<()> = Mutex::new(());
// Checks share only this short schema migration lock, never the network/write queue.
static JOURNAL_SCHEMA: Mutex<()> = Mutex::new(());
thread_local! {
    static CHECK_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}
mod glossary;
mod presentation;
#[cfg(test)]
mod tests;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const FIELD_LIMIT: usize = 128 * 1024;
const TOTAL_LIMIT: usize = 512 * 1024;
const PLACEHOLDERS: [&str; 15] = [
    "expression",
    "reading",
    "definition",
    "source",
    "frequency",
    "frequencyHarmonic",
    "frequencyAverage",
    "pitch",
    "sentence",
    "bookTitle",
    "expressionFurigana",
    "glossary",
    "picture",
    "selectionText",
    "audio",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AnkiError {
    Invalid,
    ContentTooLarge,
    Storage,
    Unavailable,
    Protocol,
    Rejected,
    Changed,
    Incompatible,
    Busy,
    Duplicate,
    Pending,
}
type Result<T> = std::result::Result<T, AnkiError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mapping {
    #[serde(default)]
    pub model_id: Option<i64>,
    pub fields: Vec<String>,
    pub templates: BTreeMap<String, String>,
    #[serde(default = "default_tags")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tag_dictionaries: Vec<i64>,
}
fn default_tags() -> Vec<String> {
    vec!["komori".into()]
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DuplicatePolicy {
    #[default]
    Prevent,
    Overwrite,
    Allow,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DuplicateScope {
    Deck,
    #[default]
    Collection,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub port: u16,
    pub key: String,
    pub deck: String,
    #[serde(default)]
    pub deck_id: Option<i64>,
    pub model: String,
    pub mappings: BTreeMap<String, Mapping>,
    #[serde(default)]
    pub duplicate_policy: DuplicatePolicy,
    #[serde(default)]
    pub duplicate_scope: DuplicateScope,
    #[serde(default)]
    pub check_children: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            port: 8765,
            key: String::new(),
            deck: String::new(),
            deck_id: None,
            model: String::new(),
            mappings: BTreeMap::new(),
            duplicate_policy: DuplicatePolicy::default(),
            duplicate_scope: DuplicateScope::default(),
            check_children: false,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    deck_ids: BTreeMap<String, i64>,
    model_ids: BTreeMap<String, i64>,
    decks: Vec<String>,
    models: Vec<String>,
    fields: Vec<String>,
    lapis: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NoteOutcome {
    Created {
        id: i64,
    },
    Updated {
        id: i64,
    },
    Duplicate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<i64>,
    },
    Uncertain,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteRequest {
    request_id: String,
    preferences: Preferences,
    fields: BTreeMap<String, String>,
    #[serde(default)]
    field_parts: BTreeMap<String, Vec<FieldPart>>,
    #[serde(default)]
    book_id: Option<String>,
    #[serde(default)]
    dictionary_sources: Vec<DictionaryTagSource>,
    /// The headword's reading. A note with the same first field but another reading in its
    /// reading field is not a duplicate (誰が だれが vs 誰が たが).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reading: Option<String>,
}
/// Existence checks for several lookup results at once: only each note's first field and
/// reading cross IPC, and Anki is asked in a few batched requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusBatch {
    preferences: Preferences,
    notes: Vec<StatusNote>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusNote {
    first: Vec<FieldPart>,
    #[serde(default)]
    reading: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DictionaryTagSource {
    id: i64,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    values: Option<Vec<String>>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NoteStatus {
    Missing,
    Existing {
        id: i64,
        count: usize,
    },
    Pending {
        #[serde(rename = "requestId")]
        request_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum FieldPart {
    Text {
        text: String,
    },
    Frequencies {
        text: String,
    },
    Sentence {
        text: String,
        expression: String,
    },
    Definitions {
        entries: Vec<DefinitionContent>,
    },
    Cover,
    /// The headword's recording from the word audio sources, when one has it.
    Audio {
        term: String,
        reading: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefinitionContent {
    source: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    glossary: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presentation: Option<Vec<Vec<presentation::Node>>>,
}
#[derive(Debug, Serialize, Deserialize)]
struct WriteIntent {
    target: Option<i64>,
    fields: BTreeMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    request_id: String,
    model: String,
    expression: String,
}

fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
fn valid_id(id: i64) -> bool {
    (1..=9_007_199_254_740_991).contains(&id)
}
fn valid_text(s: &str, max: usize) -> bool {
    s.len() <= max
        && !s
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
}
fn valid_template(s: &str) -> bool {
    if !valid_text(s, 4096) {
        return false;
    }
    let mut tail = s;
    while let Some(start) = tail.find("{{") {
        if tail[..start].contains(['{', '}']) {
            return false;
        }
        let Some(end) = tail[start + 2..].find("}}") else {
            return false;
        };
        let key = &tail[start + 2..start + 2 + end];
        let dictionary = key
            .strip_prefix("dictionary:")
            .is_some_and(|id| !id.starts_with('0') && id.parse::<i64>().is_ok_and(valid_id));
        if !PLACEHOLDERS.contains(&key) && !dictionary {
            return false;
        }
        tail = &tail[start + end + 4..];
    }
    !tail.contains(['{', '}'])
}
/// The template with each `{{dictionary:N}}` naming `map(N)`, or removed when `map` has none.
fn remap_template(template: &str, map: impl Fn(i64) -> Option<i64>) -> String {
    const PREFIX: &str = "{{dictionary:";
    let mut remapped = String::with_capacity(template.len());
    let mut tail = template;
    while let Some(start) = tail.find(PREFIX) {
        remapped.push_str(&tail[..start]);
        let rest = &tail[start + PREFIX.len()..];
        let Some(end) = rest.find("}}") else {
            remapped.push_str(PREFIX);
            tail = rest;
            continue;
        };
        match rest[..end].parse::<i64>() {
            Ok(id) => {
                if let Some(id) = map(id) {
                    remapped.push_str(&format!("{PREFIX}{id}}}}}"));
                }
            }
            Err(_) => remapped.push_str(&tail[start..start + PREFIX.len() + end + 2]),
        }
        tail = &rest[end + 2..];
    }
    remapped.push_str(tail);
    remapped
}
impl Preferences {
    /// Points dictionary placeholders and tag sources at other dictionaries, removing those
    /// `map` cannot name.
    pub(crate) fn remap_dictionaries(&mut self, map: impl Fn(i64) -> Option<i64> + Copy) {
        for mapping in self.mappings.values_mut() {
            mapping.tag_dictionaries = mapping
                .tag_dictionaries
                .iter()
                .filter_map(|id| map(*id))
                .collect();
            for template in mapping.templates.values_mut() {
                *template = remap_template(template, map);
            }
        }
    }
    fn lowercase_tags(mut self) -> Self {
        for mapping in self.mappings.values_mut() {
            let mut tags = Vec::new();
            for tag in &mapping.tags {
                let tag = tag.to_lowercase();
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
            mapping.tags = tags;
        }
        self
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if self.deck_id.is_some_and(|id| !valid_id(id))
            || self
                .mappings
                .values()
                .any(|mapping| mapping.model_id.is_some_and(|id| !valid_id(id)))
        {
            return Err(AnkiError::Invalid);
        }
        if self.port == 0
            || self.key.len() > 256
            || self.key.chars().any(char::is_control)
            || (!self.deck.is_empty() && !valid_name(&self.deck))
            || (!self.model.is_empty() && !valid_name(&self.model))
            || self.mappings.len() > 32
        {
            return Err(AnkiError::Invalid);
        }
        for (model, mapping) in &self.mappings {
            if !valid_name(model)
                || mapping.fields.is_empty()
                || mapping.fields.len() > 128
                || mapping.templates.len() != mapping.fields.len()
                || mapping.tags.len() > 32
                || mapping.tag_dictionaries.len() > 32
                || mapping.tag_dictionaries.iter().any(|id| !valid_id(*id))
                || mapping
                    .tag_dictionaries
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != mapping.tag_dictionaries.len()
                || mapping.tags.iter().any(|tag| {
                    tag.is_empty()
                        || tag.len() > 128
                        || tag.chars().any(|c| c.is_whitespace() || c.is_control())
                        || tag.starts_with("komori_request_")
                })
                || mapping
                    .tags
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != mapping.tags.len()
            {
                return Err(AnkiError::Invalid);
            }
            let mut unique = std::collections::BTreeSet::new();
            for field in &mapping.fields {
                if !valid_name(field)
                    || !unique.insert(field)
                    || !mapping
                        .templates
                        .get(field)
                        .is_some_and(|s| valid_template(s))
                {
                    return Err(AnkiError::Invalid);
                }
            }
        }
        Ok(())
    }
}
fn connection(path: &Path) -> Result<Connection> {
    open_catalog(path).map_err(|_| AnkiError::Storage)
}
fn load(path: &Path) -> Result<Preferences> {
    let value: Option<String> = connection(path)?
        .query_row(
            "SELECT value FROM preferences WHERE name = 'anki'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| AnkiError::Storage)?;
    match value {
        None => Ok(Preferences::default()),
        Some(value) => {
            let prefs: Preferences =
                serde_json::from_str(&value).map_err(|_| AnkiError::Storage)?;
            prefs.validate()?;
            let prefs = prefs.lowercase_tags();
            prefs.validate()?;
            Ok(prefs)
        }
    }
}
fn save(path: &Path, prefs: &Preferences) -> Result<()> {
    prefs.validate()?;
    let prefs = prefs.clone().lowercase_tags();
    prefs.validate()?;
    connection(path)?.execute("INSERT INTO preferences (name, value) VALUES ('anki', ?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value", [serde_json::to_string(&prefs).map_err(|_| AnkiError::Invalid)?]).map_err(|_| AnkiError::Storage)?;
    Ok(())
}

/// Fixed IPv4 loopback; no DNS, proxy, redirect, alternate host/path or automatic retry.
fn request_body(prefs: &Preferences, action: &str, parameters: Value) -> Result<Vec<u8>> {
    let mut envelope = json!({"action": action, "version": 6, "params": parameters});
    // An empty key must be omitted: AnkiConnect distinguishes it from no key.
    if !prefs.key.is_empty() {
        envelope["key"] = json!(prefs.key);
    }
    let body = serde_json::to_vec(&envelope).map_err(|_| AnkiError::Invalid)?;
    let request_limit = if action == "storeMediaFile" {
        12 * 1024 * 1024
    } else {
        1024 * 1024
    };
    if body.len() > request_limit {
        return Err(AnkiError::ContentTooLarge);
    }
    Ok(body)
}
fn call(prefs: &Preferences, action: &str, parameters: Value) -> Result<Value> {
    prefs.validate()?;
    let body = request_body(prefs, action, parameters)?;
    let end = CHECK_DEADLINE
        .with(Cell::get)
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(5));
    let timeout = end
        .checked_duration_since(Instant::now())
        .ok_or(AnkiError::Unavailable)?;
    let address = SocketAddr::from(([127, 0, 0, 1], prefs.port));
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|_| AnkiError::Unavailable)?;
    let headers = format!("POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", prefs.port, body.len());
    for part in [headers.as_bytes(), body.as_slice()] {
        let mut sent = 0;
        while sent < part.len() {
            let remaining = end
                .checked_duration_since(Instant::now())
                .ok_or(AnkiError::Unavailable)?;
            stream
                .set_write_timeout(Some(remaining))
                .map_err(|_| AnkiError::Unavailable)?;
            let count = stream
                .write(&part[sent..])
                .map_err(|_| AnkiError::Unavailable)?;
            if count == 0 {
                return Err(AnkiError::Unavailable);
            }
            sent += count;
        }
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let remaining = end
            .checked_duration_since(Instant::now())
            .ok_or(AnkiError::Unavailable)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| AnkiError::Unavailable)?;
        let count = stream
            .read(&mut buffer)
            .map_err(|_| AnkiError::Unavailable)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_RESPONSE {
            return Err(AnkiError::Protocol);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if response_length(&bytes)?.is_some_and(|length| bytes.len() >= length) {
            break;
        }
    }
    parse_response(&bytes)
}
// Complete a length-delimited response without waiting for socket close.
fn response_length(bytes: &[u8]) -> Result<Option<usize>> {
    let Some(split) = bytes.windows(4).position(|s| s == b"\r\n\r\n") else {
        return if bytes.len() > 8192 {
            Err(AnkiError::Protocol)
        } else {
            Ok(None)
        };
    };
    if split > 8192 {
        return Err(AnkiError::Protocol);
    }
    let head = std::str::from_utf8(&bytes[..split]).map_err(|_| AnkiError::Protocol)?;
    let mut length = None;
    for line in head.lines().skip(1) {
        let (name, value) = line.split_once(':').ok_or(AnkiError::Protocol)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(AnkiError::Protocol);
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(AnkiError::Protocol);
            }
            let size = value
                .trim()
                .parse::<usize>()
                .map_err(|_| AnkiError::Protocol)?;
            length = Some(
                (split + 4)
                    .checked_add(size)
                    .filter(|v| *v <= MAX_RESPONSE)
                    .ok_or(AnkiError::Protocol)?,
            );
        }
    }
    Ok(length)
}
fn parse_response(bytes: &[u8]) -> Result<Value> {
    let split = bytes
        .windows(4)
        .position(|s| s == b"\r\n\r\n")
        .ok_or(AnkiError::Protocol)?;
    if split > 8192 {
        return Err(AnkiError::Protocol);
    }
    let head = std::str::from_utf8(&bytes[..split]).map_err(|_| AnkiError::Protocol)?;
    if !head
        .lines()
        .next()
        .is_some_and(|s| s.starts_with("HTTP/1.") && s.split_whitespace().nth(1) == Some("200"))
    {
        return Err(AnkiError::Protocol);
    }
    let body = &bytes[split + 4..];
    for line in head.lines().skip(1) {
        let (name, value) = line.split_once(':').ok_or(AnkiError::Protocol)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(AnkiError::Protocol);
        }
        if name.eq_ignore_ascii_case("content-length")
            && value.trim().parse::<usize>().ok() != Some(body.len())
        {
            return Err(AnkiError::Protocol);
        }
    }
    let envelope: Value = serde_json::from_slice(body).map_err(|_| AnkiError::Protocol)?;
    if envelope.get("error").and_then(Value::as_str)
        == Some("cannot create note because it is a duplicate")
    {
        return Err(AnkiError::Duplicate);
    }
    if !envelope.is_object() || !envelope.get("error").is_some_and(Value::is_null) {
        return Err(AnkiError::Rejected);
    }
    envelope.get("result").cloned().ok_or(AnkiError::Protocol)
}
fn names(value: Value) -> Result<Vec<String>> {
    let names: Vec<String> = serde_json::from_value(value).map_err(|_| AnkiError::Protocol)?;
    if names.len() > 4096 || names.iter().any(|s| !valid_name(s)) {
        return Err(AnkiError::Protocol);
    }
    Ok(names)
}
fn model_fields(prefs: &Preferences, model: &str) -> Result<Vec<String>> {
    let fields = names(call(prefs, "modelFieldNames", json!({"modelName":model}))?)?;
    if fields.is_empty()
        || fields.len() > 128
        || fields
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != fields.len()
    {
        return Err(AnkiError::Protocol);
    }
    Ok(fields)
}
fn lapis_fields() -> Vec<String> {
    include_str!("../vendor/lapis/anki_fields.yaml")
        .lines()
        .filter_map(|s| s.strip_prefix("- name: ").map(String::from))
        .collect()
}
fn identities(value: Value) -> Result<BTreeMap<String, i64>> {
    let ids: BTreeMap<String, i64> =
        serde_json::from_value(value).map_err(|_| AnkiError::Protocol)?;
    if ids.len() > 4096
        || ids
            .iter()
            .any(|(name, id)| !valid_name(name) || !valid_id(*id))
    {
        return Err(AnkiError::Protocol);
    }
    Ok(ids)
}
fn discover(prefs: &Preferences) -> Result<Discovery> {
    if call(prefs, "version", json!({}))?
        .as_i64()
        .is_none_or(|version| version < 6)
    {
        return Err(AnkiError::Protocol);
    }
    let deck_ids = identities(call(prefs, "deckNamesAndIds", json!({}))?)?;
    let model_ids = identities(call(prefs, "modelNamesAndIds", json!({}))?)?;
    let decks: Vec<String> = deck_ids.keys().cloned().collect();
    let models: Vec<String> = model_ids.keys().cloned().collect();
    let fields = if models.contains(&prefs.model) {
        model_fields(prefs, &prefs.model)?
    } else {
        vec![]
    };
    let lapis = if !models.iter().any(|s| s == "Lapis") {
        "missing"
    } else if model_fields(prefs, "Lapis")? == lapis_fields() {
        "compatible"
    } else {
        "incompatible"
    };
    Ok(Discovery {
        deck_ids,
        model_ids,
        decks,
        models,
        fields,
        lapis: lapis.into(),
    })
}
fn create_lapis(prefs: &Preferences) -> Result<String> {
    let discovery = discover(prefs)?;
    match discovery.lapis.as_str() {
        "compatible" => return Ok("existing".into()),
        "incompatible" => return Err(AnkiError::Incompatible),
        _ => {}
    }
    // Explicit operation creates a model only. Existing/customized models are never updated.
    let result = call(
        prefs,
        "createModel",
        json!({"modelName":"Lapis", "inOrderFields":lapis_fields(), "css":include_str!("../vendor/lapis/styling.css"), "isCloze":false, "cardTemplates":[{"Name":"Mining", "Front":include_str!("../vendor/lapis/front.html"), "Back":include_str!("../vendor/lapis/back.html")}]}),
    );
    if result.is_err() {
        return Ok("uncertain".into());
    }
    if discover(prefs)?.lapis != "compatible" {
        return Err(AnkiError::Incompatible);
    }
    Ok("created".into())
}
fn escaped(s: &str) -> String {
    // Lapis embeds some fields in JS template literals. Escape JS delimiters too,
    // as HTML entities that render as their original text on the finished card.
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('`', "&#96;")
        .replace('$', "&#36;")
        .replace('\\', "&#92;")
        .replace('\r', "")
        .replace('\n', "<br>")
}
fn validate_note(request: &NoteRequest, prefs: &Preferences, discovery: &Discovery) -> Result<()> {
    let id = uuid::Uuid::parse_str(&request.request_id).map_err(|_| AnkiError::Invalid)?;
    if id.to_string() != request.request_id {
        return Err(AnkiError::Invalid);
    }
    request.preferences.validate()?;
    if request.preferences.clone().lowercase_tags() != *prefs
        || !discovery.decks.contains(&prefs.deck)
        || !discovery.models.contains(&prefs.model)
    {
        return Err(AnkiError::Changed);
    }
    let mapping = prefs.mappings.get(&prefs.model).ok_or(AnkiError::Invalid)?;
    if prefs.deck_id.is_none()
        || prefs.deck_id.as_ref() != discovery.deck_ids.get(&prefs.deck)
        || mapping.model_id.is_none()
        || mapping.model_id.as_ref() != discovery.model_ids.get(&prefs.model)
    {
        return Err(AnkiError::Changed);
    }
    if mapping.fields != discovery.fields {
        return Err(AnkiError::Changed);
    }
    if request.fields.len() != discovery.fields.len() {
        return Err(AnkiError::Invalid);
    }
    if request.fields.values().map(String::len).sum::<usize>() > TOTAL_LIMIT
        || request.fields.values().any(|s| s.len() > FIELD_LIMIT)
    {
        return Err(AnkiError::ContentTooLarge);
    }
    for name in &discovery.fields {
        if !request
            .fields
            .get(name)
            .is_some_and(|s| valid_text(s, FIELD_LIMIT))
        {
            return Err(AnkiError::Invalid);
        }
    }
    if request.fields[&discovery.fields[0]].trim().is_empty()
        || request
            .reading
            .as_ref()
            .is_some_and(|reading| !valid_text(reading, 1024))
    {
        return Err(AnkiError::Invalid);
    }
    if request.dictionary_sources.len() > 128
        || request.dictionary_sources.iter().any(|s| {
            !valid_id(s.id)
                || !valid_name(&s.title)
                || s.values.as_ref().is_some_and(|values| {
                    values.len() > 128 || values.iter().any(|v| !valid_text(v, 1024))
                })
        })
        || request
            .dictionary_sources
            .iter()
            .map(|s| s.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != request.dictionary_sources.len()
    {
        return Err(AnkiError::Invalid);
    }
    if request.book_id.as_ref().is_some_and(|id| {
        uuid::Uuid::parse_str(id).is_err() || uuid::Uuid::parse_str(id).unwrap().to_string() != *id
    }) {
        return Err(AnkiError::Invalid);
    }
    if !request.field_parts.is_empty() {
        if request.field_parts.len() != request.fields.len() {
            return Err(AnkiError::Invalid);
        }
        for (field, text) in &request.fields {
            let parts = request.field_parts.get(field).ok_or(AnkiError::Invalid)?;
            if parts.len() > 256 {
                return Err(AnkiError::Invalid);
            }
            let mut plain = String::new();
            for part in parts {
                match part {
                    FieldPart::Text { text } | FieldPart::Frequencies { text } => {
                        if !valid_text(text, FIELD_LIMIT) {
                            return Err(AnkiError::Invalid);
                        }
                        plain.push_str(text);
                    }
                    FieldPart::Sentence { text, expression } => {
                        if !valid_text(text, FIELD_LIMIT)
                            || !valid_text(expression, 1024)
                            || expression.chars().count() > 256
                        {
                            return Err(AnkiError::Invalid);
                        }
                        plain.push_str(text);
                    }
                    FieldPart::Definitions { entries } => {
                        if entries.iter().any(|e| {
                            e.text.len() > FIELD_LIMIT
                                || e.presentation
                                    .as_ref()
                                    .is_some_and(|v| !presentation::valid(v))
                        }) {
                            return Err(AnkiError::ContentTooLarge);
                        }
                        if entries.len() > 128
                            || entries.iter().any(|e| {
                                !valid_name(&e.source)
                                    || !valid_text(&e.text, FIELD_LIMIT)
                                    || e.glossary.as_ref().is_some_and(|v| !glossary::valid(v))
                                    || (e.glossary.is_some() && e.presentation.is_some())
                            })
                        {
                            return Err(AnkiError::Invalid);
                        }
                        plain.push_str(
                            &entries
                                .iter()
                                .map(|e| e.text.as_str())
                                .collect::<Vec<_>>()
                                .join("\n\n"),
                        );
                    }
                    FieldPart::Cover => {}
                    FieldPart::Audio { term, reading } => {
                        if !valid_word(term) || !valid_word(reading) {
                            return Err(AnkiError::Invalid);
                        }
                    }
                }
            }
            if &plain != text {
                return Err(AnkiError::Invalid);
            }
        }
    }
    Ok(())
}

fn definition_html(entries: &[DefinitionContent]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    // Source groups match Lapis's glossary contract; only native-owned markup is emitted.
    let mut groups: Vec<(&str, Vec<&DefinitionContent>)> = vec![];
    for entry in entries {
        if let Some((_, texts)) = groups
            .iter_mut()
            .find(|(source, _)| *source == entry.source)
        {
            texts.push(entry);
        } else {
            groups.push((&entry.source, vec![entry]));
        }
    }
    let mut rows = String::new();
    for (source, texts) in groups {
        // Lapis puts the attribute in a quoted CSS selector and matches dictionary titles
        // exactly (`li[data-dictionary="Example Dictionary 3"]`). Encode only what could break it.
        let source_key: String = source
            .chars()
            .map(|c| {
                if c == '"' || c == '\\' || c.is_control() {
                    format!("_u{:x}_", c as u32)
                } else {
                    c.to_string()
                }
            })
            .collect();
        let content = texts
            .iter()
            .map(|entry| {
                if let Some(sections) = &entry.presentation {
                    return presentation::html(sections);
                }
                if let Some(value) = &entry.glossary {
                    return glossary::html(value);
                }
                // Flattened text keeps every nonblank line, without multiplying blank lines.
                entry
                    .text
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(escaped)
                    .collect::<Vec<_>>()
                    .join("<br>")
            })
            .collect::<String>();
        rows.push_str(&format!(
            "<li data-dictionary=\"{}\"><i>({})</i> <span>{content}</span></li>",
            escaped(&source_key),
            escaped(source)
        ));
    }
    // The class and list shape are the glossary markup Lapis's script and CSS select on.
    format!("<div style=\"text-align: left;\" class=\"yomitan-glossary\"><ol>{rows}</ol></div>")
}
fn sentence_html(text: &str, expression: &str) -> String {
    if expression.is_empty() {
        return escaped(text);
    }
    text.split(expression).map(escaped).collect::<Vec<_>>().join(&format!(
        "<span class=\"komori-sentence-expression\" style=\"color:var(--bold,#b76529);font-weight:600\">{}</span>", escaped(expression)))
}
fn dictionary_tag(title: &str) -> String {
    let normalized: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect();
    let mut tag = if normalized.starts_with("komori_request_") {
        "dict_".to_string()
    } else {
        String::new()
    };
    for c in normalized.chars() {
        if tag.len() + c.len_utf8() > 128 {
            break;
        }
        tag.push(c);
    }
    tag
}
fn card_tags(request: &NoteRequest, mapping: &Mapping) -> Vec<String> {
    let mut tags = Vec::new();
    for tag in &mapping.tags {
        let tag = tag.to_lowercase();
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    for source in &request.dictionary_sources {
        if mapping.tag_dictionaries.contains(&source.id) {
            let values = source
                .values
                .clone()
                .unwrap_or_else(|| vec![source.title.clone()]);
            for value in values {
                let tag = dictionary_tag(&value);
                if !tag.is_empty() && !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }
    }
    tags
}
fn valid_word(text: &str) -> bool {
    valid_text(text, 1024) && text.chars().count() <= 256
}
fn parts_html(parts: &[FieldPart], cover: &str, audio: &str) -> String {
    parts
        .iter()
        .map(|part| match part {
            FieldPart::Text { text } => escaped(text),
            FieldPart::Frequencies { text } => frequency_html(text),
            FieldPart::Sentence { text, expression } => sentence_html(text, expression),
            FieldPart::Cover => cover.to_string(),
            FieldPart::Audio { .. } => audio.to_string(),
            FieldPart::Definitions { entries } => definition_html(entries),
        })
        .collect()
}
/// The plain text of a field's parts, as the frontend's `fields` record holds it.
fn parts_text(parts: &[FieldPart]) -> String {
    parts
        .iter()
        .map(|part| match part {
            FieldPart::Text { text }
            | FieldPart::Frequencies { text }
            | FieldPart::Sentence { text, .. } => text.clone(),
            FieldPart::Definitions { entries } => entries
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
            FieldPart::Cover | FieldPart::Audio { .. } => String::new(),
        })
        .collect()
}
fn formatted_fields(
    request: &NoteRequest,
    cover: &str,
    audio: &str,
) -> Result<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    for (field, text) in &request.fields {
        let html = match request.field_parts.get(field) {
            None => escaped(text),
            Some(parts) => parts_html(parts, cover, audio),
        };
        if html.len() > 512 * 1024 {
            return Err(AnkiError::ContentTooLarge);
        }
        fields.insert(field.clone(), html);
    }
    if fields.values().map(String::len).sum::<usize>() > 1024 * 1024 {
        return Err(AnkiError::ContentTooLarge);
    }
    Ok(fields)
}
fn frequency_html(text: &str) -> String {
    let rows = text
        .lines()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("<li>{}</li>", escaped(s)))
        .collect::<String>();
    if rows.is_empty() {
        String::new()
    } else {
        format!("<ul class=\"komori-frequencies\" style=\"margin:0;padding-inline-start:1.5em;white-space:pre-wrap\">{rows}</ul>")
    }
}
fn cover_media(connection: &Connection, request: &NoteRequest) -> Result<Option<(String, String)>> {
    if !request
        .field_parts
        .values()
        .flatten()
        .any(|p| matches!(p, FieldPart::Cover))
    {
        return Ok(None);
    }
    let Some(id) = &request.book_id else {
        return Ok(None);
    };
    let cover: Option<(Option<String>, Option<Vec<u8>>)> = connection
        .query_row(
            "SELECT cover_mime,cover_bytes FROM books WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| AnkiError::Storage)?;
    let Some((mime, bytes)) = cover else {
        return Err(AnkiError::Changed);
    };
    let Some((mime, bytes)) = mime.zip(bytes) else {
        return Ok(None);
    };
    let extension = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/avif" => "avif",
        _ => return Err(AnkiError::Invalid),
    };
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(AnkiError::Invalid);
    }
    Ok(Some((
        format!("komori_cover_{:x}.{extension}", Sha256::digest(&bytes)),
        STANDARD.encode(bytes),
    )))
}
fn query_term(prefix: &str, text: &str) -> String {
    format!(
        "\"{}:{}\"",
        prefix.replace('\\', "\\\\").replace('"', "\\\""),
        text.replace('\\', "\\\\").replace('"', "\\\"")
    )
}
/// The search for notes whose first field is `text` (Anki's own duplicate search, with its
/// first-field checksum and HTML normalization): notes for the collection, cards for a deck.
fn duplicate_search(prefs: &Preferences, text: &str) -> Result<Value> {
    let model_id = prefs
        .mappings
        .get(&prefs.model)
        .and_then(|m| m.model_id)
        .ok_or(AnkiError::Changed)?;
    let mut query = query_term("dupe", &format!("{model_id},{text}"));
    if prefs.duplicate_scope == DuplicateScope::Collection {
        return Ok(json!({"action":"findNotes","params":{"query":query}}));
    }
    query.push(' ');
    query.push_str(&query_term("deck", &prefs.deck));
    // cardsInfo renders every card's question/answer and returns all note fields.
    // Existence needs only IDs and deck names, including for very large Lapis notes.
    Ok(json!({"action":"findCards","params":{"query":query}}))
}
/// Runs actions as one request: alone, or inside `multi` (each authenticated) when several.
fn call_all(prefs: &Preferences, actions: Vec<Value>) -> Result<Vec<Value>> {
    if let [action] = actions.as_slice() {
        return Ok(vec![call(
            prefs,
            action["action"].as_str().ok_or(AnkiError::Invalid)?,
            action.get("params").cloned().unwrap_or_else(|| json!({})),
        )?]);
    }
    if actions.is_empty() {
        return Ok(vec![]);
    }
    let actions = actions
        .into_iter()
        .map(|mut action| {
            action["version"] = json!(6);
            if !prefs.key.is_empty() {
                action["key"] = json!(prefs.key);
            }
            action
        })
        .collect::<Vec<_>>();
    let count = actions.len();
    let results = call(prefs, "multi", json!({"actions": actions}))?;
    let results = results
        .as_array()
        .filter(|r| r.len() == count)
        .ok_or(AnkiError::Protocol)?;
    results
        .iter()
        .map(|result| {
            if result.get("error").is_none_or(|e| !e.is_null()) {
                return Err(AnkiError::Protocol);
            }
            result.get("result").cloned().ok_or(AnkiError::Protocol)
        })
        .collect()
}
/// Each search's matching note IDs, keeping only cards in the chosen deck (or its children when
/// asked) for a deck search. Uses at most two more requests for every search together.
fn resolve_duplicates(prefs: &Preferences, found: Vec<Value>) -> Result<Vec<Vec<i64>>> {
    if prefs.duplicate_scope == DuplicateScope::Collection {
        return found.into_iter().map(|v| checked_ids(v, 128)).collect();
    }
    let cards = found
        .into_iter()
        .map(|v| checked_ids(v, 1024))
        .collect::<Result<Vec<_>>>()?;
    let all: std::collections::BTreeSet<i64> = cards.iter().flatten().copied().collect();
    if all.is_empty() {
        return Ok(vec![vec![]; cards.len()]);
    }
    let all: Vec<i64> = all.into_iter().collect();
    let decks: BTreeMap<String, Vec<i64>> =
        serde_json::from_value(call(prefs, "getDecks", json!({"cards":all}))?)
            .map_err(|_| AnkiError::Protocol)?;
    let mut in_scope = std::collections::BTreeSet::new();
    let mut seen = std::collections::BTreeSet::new();
    for (deck, ids) in decks {
        if !valid_name(&deck) {
            return Err(AnkiError::Protocol);
        }
        for id in ids {
            if !all.contains(&id) || !seen.insert(id) {
                return Err(AnkiError::Protocol);
            }
            if deck == prefs.deck
                || (prefs.check_children && deck.starts_with(&format!("{}::", prefs.deck)))
            {
                in_scope.insert(id);
            }
        }
    }
    // Missing/deleted cards make the check inconclusive; never report a false missing note.
    if seen.len() != all.len() {
        return Err(AnkiError::Protocol);
    }
    let selected: Vec<Vec<i64>> = cards
        .iter()
        .map(|ids| {
            ids.iter()
                .copied()
                .filter(|id| in_scope.contains(id))
                .collect()
        })
        .collect();
    let asked: Vec<usize> = (0..selected.len())
        .filter(|&index| !selected[index].is_empty())
        .collect();
    let notes = call_all(
        prefs,
        asked
            .iter()
            .map(|&index| json!({"action":"cardsToNotes","params":{"cards":selected[index]}}))
            .collect(),
    )?;
    let mut result = vec![vec![]; selected.len()];
    for (index, value) in asked.into_iter().zip(notes) {
        let ids = checked_ids(value, 128)?;
        if ids.is_empty() {
            return Err(AnkiError::Protocol);
        }
        result[index] = ids;
    }
    Ok(result)
}
fn duplicate_notes(prefs: &Preferences, text: &str) -> Result<Vec<i64>> {
    let search = duplicate_search(prefs, text)?;
    let found = call(
        prefs,
        search["action"].as_str().ok_or(AnkiError::Invalid)?,
        search["params"].clone(),
    )?;
    Ok(resolve_duplicates(prefs, vec![found])?.remove(0))
}
/// The fields after the first that hold the headword's reading in the saved mapping.
fn reading_fields(prefs: &Preferences) -> Vec<String> {
    prefs
        .mappings
        .get(&prefs.model)
        .map(|mapping| {
            mapping
                .fields
                .iter()
                .skip(1)
                .filter(|field| {
                    mapping.templates.get(*field).is_some_and(|template| {
                        template.contains("{{reading}}")
                            || template.contains("{{expressionFurigana}}")
                    })
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}
/// Kana text compared across hiragana and katakana, without spaces.
fn reading_key(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            'ァ'..='ヶ' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
            _ => c,
        })
        .collect()
}
/// The reading an Anki field shows: tags removed, and Anki furigana (`誰[だれ]が`, ` 漢字[かんじ]`)
/// read as its kana.
fn field_reading(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text.replace("&nbsp;", " ").replace("&amp;", "&");
    let is_kana =
        |c: char| matches!(c, 'ぁ'..='ゖ' | 'ァ'..='ヺ' | 'ー' | 'ゝ' | 'ゞ' | 'ヽ' | 'ヾ');
    let mut reading: Vec<char> = vec![];
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '[' {
            // The base is the run before the bracket back to a space or kana.
            while reading
                .last()
                .is_some_and(|c| !c.is_whitespace() && !is_kana(*c))
            {
                reading.pop();
            }
            for c in chars.by_ref() {
                if c == ']' {
                    break;
                }
                reading.push(c);
            }
        } else {
            reading.push(c);
        }
    }
    reading_key(&reading.into_iter().collect::<String>())
}
/// Keeps, for each list of candidate notes, those whose reading fields are empty (unknown) or
/// show `readings[i]`. One notesInfo request covers every candidate.
fn same_reading(
    prefs: &Preferences,
    candidates: Vec<Vec<i64>>,
    readings: &[Option<String>],
) -> Result<Vec<Vec<i64>>> {
    let fields = reading_fields(prefs);
    let asked: std::collections::BTreeSet<i64> = candidates
        .iter()
        .zip(readings)
        .filter(|(_, reading)| reading.as_deref().is_some_and(|r| !r.trim().is_empty()))
        .flat_map(|(ids, _)| ids.iter().copied())
        .collect();
    if fields.is_empty() || asked.is_empty() {
        return Ok(candidates);
    }
    let asked: Vec<i64> = asked.into_iter().collect();
    let info = call(prefs, "notesInfo", json!({"notes": asked}))?;
    let info = info.as_array().ok_or(AnkiError::Protocol)?;
    let mut shown: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for note in info {
        let id = note["noteId"].as_i64().ok_or(AnkiError::Protocol)?;
        let values = fields
            .iter()
            .filter_map(|field| note["fields"][field]["value"].as_str())
            .map(field_reading)
            .filter(|reading| !reading.is_empty())
            .collect();
        shown.insert(id, values);
    }
    Ok(candidates
        .into_iter()
        .zip(readings)
        .map(|(ids, reading)| match reading.as_deref().map(reading_key) {
            Some(reading) if !reading.is_empty() => ids
                .into_iter()
                .filter(|id| {
                    shown
                        .get(id)
                        .is_none_or(|values| values.is_empty() || values.contains(&reading))
                })
                .collect(),
            _ => ids,
        })
        .collect())
}
fn checked_ids(value: Value, limit: usize) -> Result<Vec<i64>> {
    let ids: Vec<i64> = serde_json::from_value(value).map_err(|_| AnkiError::Protocol)?;
    if ids.len() > limit
        || ids.iter().any(|id| !valid_id(*id))
        || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
    {
        return Err(AnkiError::Protocol);
    }
    Ok(ids)
}
fn journal(connection: &Connection) -> Result<()> {
    let _guard = JOURNAL_SCHEMA.lock().map_err(|_| AnkiError::Storage)?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS anki_requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, outcome TEXT NOT NULL, intent TEXT)").map_err(|_| AnkiError::Storage)?;
    let has_intent: bool = connection
        .query_row(
            "SELECT count(*) FROM pragma_table_info('anki_requests') WHERE name='intent'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|_| AnkiError::Storage)?
        != 0;
    if !has_intent {
        connection
            .execute_batch("ALTER TABLE anki_requests ADD COLUMN intent TEXT")
            .map_err(|_| AnkiError::Storage)?;
    }
    let has_cleaned: i64 = connection
        .query_row(
            "SELECT count(*) FROM pragma_table_info('anki_requests') WHERE name='tag_cleaned'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| AnkiError::Storage)?;
    if has_cleaned == 0 {
        connection
            .execute_batch(
                "ALTER TABLE anki_requests ADD COLUMN tag_cleaned INTEGER NOT NULL DEFAULT 0",
            )
            .map_err(|_| AnkiError::Storage)?;
    }
    Ok(())
}
fn pending_requests(path: &Path) -> Result<Vec<PendingRequest>> {
    let connection = connection(path)?;
    journal(&connection)?;
    let mut statement = connection
        .prepare("SELECT payload FROM anki_requests WHERE outcome=?1 LIMIT 128")
        .map_err(|_| AnkiError::Storage)?;
    let rows = statement
        .query_map(
            [serde_json::to_string(&NoteOutcome::Uncertain).unwrap()],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| AnkiError::Storage)?;
    let mut requests = vec![];
    for row in rows {
        let request: NoteRequest = serde_json::from_str(&row.map_err(|_| AnkiError::Storage)?)
            .map_err(|_| AnkiError::Storage)?;
        let first = request
            .preferences
            .mappings
            .get(&request.preferences.model)
            .and_then(|m| m.fields.first());
        let expression = first
            .and_then(|f| request.fields.get(f))
            .map(|s| s.chars().take(256).collect())
            .unwrap_or_default();
        requests.push(PendingRequest {
            request_id: request.request_id,
            model: request.preferences.model,
            expression,
        });
    }
    Ok(requests)
}
fn pending_for(connection: &Connection, request: &NoteRequest) -> Result<Option<String>> {
    let first = &request.preferences.mappings[&request.preferences.model].fields[0];
    pending_for_first(
        connection,
        &request.preferences,
        request.fields.get(first).map(String::as_str),
    )
}
/// An uncertain earlier request for the same port, note type, and first-field text.
fn pending_for_first(
    connection: &Connection,
    prefs: &Preferences,
    text: Option<&str>,
) -> Result<Option<String>> {
    let first = &prefs.mappings[&prefs.model].fields[0];
    let mut statement = connection
        .prepare("SELECT payload FROM anki_requests WHERE outcome=?1")
        .map_err(|_| AnkiError::Storage)?;
    let rows = statement
        .query_map(
            [serde_json::to_string(&NoteOutcome::Uncertain).unwrap()],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| AnkiError::Storage)?;
    for row in rows {
        let saved: NoteRequest = serde_json::from_str(&row.map_err(|_| AnkiError::Storage)?)
            .map_err(|_| AnkiError::Storage)?;
        if saved.preferences.port == prefs.port
            && saved.preferences.model == prefs.model
            && saved.fields.get(first).map(String::as_str) == text
        {
            return Ok(Some(saved.request_id));
        }
    }
    Ok(None)
}
// Only exact Komori-owned tags from confirmed journal records are removed. Failures
// retain the cleanup flag, never change a confirmed note into an uncertain write.
fn cleanup_note_tags(connection: &Connection, prefs: &Preferences, note_id: i64) -> Result<()> {
    let mut statement = connection.prepare("SELECT id,payload FROM anki_requests WHERE tag_cleaned=0 AND json_extract(outcome,'$.id')=?1 AND json_extract(outcome,'$.status') IN ('created','updated') LIMIT 128").map_err(|_| AnkiError::Storage)?;
    let rows = statement
        .query_map([note_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| AnkiError::Storage)?;
    let mut ids = vec![];
    for row in rows {
        let (id, payload) = row.map_err(|_| AnkiError::Storage)?;
        let request: NoteRequest =
            serde_json::from_str(&payload).map_err(|_| AnkiError::Storage)?;
        if request.preferences.port == prefs.port
            && request.preferences.key == prefs.key
            && request.request_id == id
            && uuid::Uuid::parse_str(&id).is_ok_and(|uuid| uuid.to_string() == id)
        {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    let tags = ids
        .iter()
        .map(|id| format!("komori_request_{id}"))
        .collect::<Vec<_>>()
        .join(" ");
    call(prefs, "removeTags", json!({"notes":[note_id], "tags":tags}))?;
    for id in ids {
        connection
            .execute("UPDATE anki_requests SET tag_cleaned=1 WHERE id=?1", [id])
            .map_err(|_| AnkiError::Storage)?;
    }
    Ok(())
}
/// One note's status, as a batch of one (the full request's first field and reading).
#[cfg(test)]
fn note_status(path: &Path, request: &NoteRequest) -> Result<NoteStatus> {
    let first = request
        .preferences
        .mappings
        .get(&request.preferences.model)
        .and_then(|m| m.fields.first())
        .ok_or(AnkiError::Changed)?;
    let parts = request.field_parts.get(first).cloned().unwrap_or_else(|| {
        vec![FieldPart::Text {
            text: request.fields.get(first).cloned().unwrap_or_default(),
        }]
    });
    let batch = StatusBatch {
        preferences: request.preferences.clone(),
        notes: vec![StatusNote {
            first: parts,
            reading: request.reading.clone(),
        }],
    };
    Ok(note_statuses(path, &batch)?.remove(0))
}
fn note_statuses(path: &Path, batch: &StatusBatch) -> Result<Vec<NoteStatus>> {
    struct Reset(Option<Instant>);
    impl Drop for Reset {
        fn drop(&mut self) {
            CHECK_DEADLINE.with(|d| d.set(self.0));
        }
    }
    let _reset =
        Reset(CHECK_DEADLINE.with(|d| d.replace(Some(Instant::now() + Duration::from_secs(5)))));
    note_statuses_inner(path, batch)
}
fn note_statuses_inner(path: &Path, batch: &StatusBatch) -> Result<Vec<NoteStatus>> {
    if serde_json::to_vec(batch)
        .map_err(|_| AnkiError::Invalid)?
        .len()
        > 1024 * 1024
        || batch.notes.len() > 64
    {
        return Err(AnkiError::ContentTooLarge);
    }
    let prefs = load(path)?;
    batch.preferences.validate()?;
    if batch.preferences.clone().lowercase_tags() != prefs
        || !prefs.mappings.contains_key(&prefs.model)
    {
        return Err(AnkiError::Changed);
    }
    if batch.notes.is_empty() {
        return Ok(vec![]);
    }
    // Each first field as its plain text (for interrupted requests) and card HTML (for Anki's
    // duplicate search), checked like a full note's.
    let mut firsts = vec![];
    for note in &batch.notes {
        if note.first.len() > 256
            || note.first.iter().any(|part| match part {
                FieldPart::Text { text } | FieldPart::Frequencies { text } => {
                    !valid_text(text, FIELD_LIMIT)
                }
                FieldPart::Sentence { text, expression } => {
                    !valid_text(text, FIELD_LIMIT) || !valid_text(expression, 1024)
                }
                FieldPart::Definitions { entries } => entries.iter().any(|e| {
                    !valid_name(&e.source)
                        || !valid_text(&e.text, FIELD_LIMIT)
                        || e.glossary.is_some()
                        || e.presentation
                            .as_ref()
                            .is_some_and(|v| !presentation::valid(v))
                }),
                FieldPart::Cover => false,
                FieldPart::Audio { term, reading } => !valid_word(term) || !valid_word(reading),
            })
            || note
                .reading
                .as_ref()
                .is_some_and(|reading| !valid_text(reading, 1024))
        {
            return Err(AnkiError::Invalid);
        }
        let text = parts_text(&note.first);
        if text.trim().is_empty() || !valid_text(&text, FIELD_LIMIT) {
            return Err(AnkiError::Invalid);
        }
        firsts.push((text, parts_html(&note.first, "", "")));
    }
    // Configuration and every duplicate search share one request.
    let mut actions = vec![
        json!({"action":"deckNamesAndIds"}),
        json!({"action":"modelNamesAndIds"}),
        json!({"action":"modelFieldNames","params":{"modelName":prefs.model}}),
    ];
    for (_, html) in &firsts {
        actions.push(duplicate_search(&prefs, html)?);
    }
    let mut results = call_all(&prefs, actions).map_err(|error| match error {
        // A failed configuration action means the deck, note type, or fields changed.
        AnkiError::Protocol => AnkiError::Changed,
        other => other,
    })?;
    let found = results.split_off(3);
    let fields = names(results.pop().ok_or(AnkiError::Protocol)?)?;
    let model_ids = identities(results.pop().ok_or(AnkiError::Protocol)?)?;
    let deck_ids = identities(results.pop().ok_or(AnkiError::Protocol)?)?;
    let mapping = &prefs.mappings[&prefs.model];
    if prefs.deck_id.is_none()
        || prefs.deck_id.as_ref() != deck_ids.get(&prefs.deck)
        || mapping.model_id.is_none()
        || mapping.model_id.as_ref() != model_ids.get(&prefs.model)
        || mapping.fields != fields
    {
        return Err(AnkiError::Changed);
    }
    let connection = connection(path)?;
    journal(&connection)?;
    let candidates = resolve_duplicates(&prefs, found)?;
    let readings: Vec<Option<String>> = batch.notes.iter().map(|n| n.reading.clone()).collect();
    let candidates = same_reading(&prefs, candidates, &readings)?;
    let mut statuses = vec![];
    for ((text, _), ids) in firsts.iter().zip(candidates) {
        if let Some(request_id) = pending_for_first(&connection, &prefs, Some(text))? {
            statuses.push(NoteStatus::Pending { request_id });
        } else if let Some(id) = ids.first() {
            if let Ok(_guard) = OPERATIONS.try_lock() {
                let _ = cleanup_note_tags(&connection, &prefs, *id);
            }
            statuses.push(NoteStatus::Existing {
                id: *id,
                count: ids.len(),
            });
        } else {
            statuses.push(NoteStatus::Missing);
        }
    }
    Ok(statuses)
}
#[cfg(test)]
fn create_note(path: &Path, request: &NoteRequest) -> Result<NoteOutcome> {
    create_note_with(path, request, &|_, _, _| None)
}
/// The recording an `Audio` part asks for, from the given sources.
type AudioFinder<'a> =
    &'a dyn Fn(&[word_audio::AudioSource], &str, &str) -> Option<Arc<word_audio::Audio>>;
fn create_note_with(
    path: &Path,
    request: &NoteRequest,
    find_audio: AudioFinder<'_>,
) -> Result<NoteOutcome> {
    let connection = connection(path)?;
    journal(&connection)?;
    let payload = serde_json::to_string(request).map_err(|_| AnkiError::Invalid)?;
    if payload.len() > 1024 * 1024 {
        return Err(AnkiError::ContentTooLarge);
    }
    let existing: Option<(String, String)> = connection
        .query_row(
            "SELECT payload, outcome FROM anki_requests WHERE id=?1",
            [&request.request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| AnkiError::Storage)?;
    if let Some((saved, outcome)) = existing {
        return if saved == payload {
            let outcome: NoteOutcome =
                serde_json::from_str(&outcome).map_err(|_| AnkiError::Storage)?;
            if let NoteOutcome::Created { id } | NoteOutcome::Updated { id } = &outcome {
                if let Ok(prefs) = load(path) {
                    let _ = cleanup_note_tags(&connection, &prefs, *id);
                }
            }
            Ok(outcome)
        } else {
            Err(AnkiError::Invalid)
        };
    }
    let prefs = load(path)?;
    let discovery = discover(&prefs)?;
    validate_note(request, &prefs, &discovery)?;
    if pending_requests(path)?.len() >= 128 {
        return Err(AnkiError::Pending);
    }
    // A previous interrupted attempt for the same first field must be resolved
    // before a new draft can send it, including after a restart.
    if pending_for(&connection, request)?.is_some() {
        return Err(AnkiError::Pending);
    }
    // A same-first-field note with another reading is not a duplicate; Anki itself would
    // refuse it as one, so it is added with duplicates allowed.
    let (matches, other_readings) = if prefs.duplicate_policy == DuplicatePolicy::Allow {
        (vec![], false)
    } else {
        let all = duplicate_notes(
            &prefs,
            &formatted_fields(request, "", "")?[&discovery.fields[0]],
        )?;
        let same = same_reading(
            &prefs,
            vec![all.clone()],
            std::slice::from_ref(&request.reading),
        )?
        .remove(0);
        let other_readings = same.is_empty() && !all.is_empty();
        (same, other_readings)
    };
    if !matches.is_empty()
        && (prefs.duplicate_policy == DuplicatePolicy::Prevent || matches.len() != 1)
    {
        let outcome = NoteOutcome::Duplicate {
            id: matches.first().copied(),
        };
        let _ = cleanup_note_tags(&connection, &prefs, matches[0]);
        connection
            .execute(
                "INSERT INTO anki_requests (id,payload,outcome) VALUES (?1,?2,?3)",
                params![
                    request.request_id,
                    payload,
                    serde_json::to_string(&outcome).unwrap()
                ],
            )
            .map_err(|_| AnkiError::Storage)?;
        return Ok(outcome);
    }
    let target = matches.first().copied();
    let media = cover_media(&connection, request)?;
    let cover = media
        .as_ref()
        .map(|(name, _)| format!("<img src=\"{name}\" alt=\"Book cover\">"))
        .unwrap_or_default();
    // Only a card that is written asks the word audio sources; none having it leaves the field empty.
    let audio = request
        .field_parts
        .values()
        .flatten()
        .find_map(|part| match part {
            FieldPart::Audio { term, reading } => Some((term, reading)),
            _ => None,
        })
        .and_then(|(term, reading)| find_audio(&word_audio::saved_sources(path), term, reading));
    let sound = audio
        .as_ref()
        .map(|audio| format!("[sound:{}]", audio.file_name()))
        .unwrap_or_default();
    let fields = formatted_fields(request, &cover, &sound)?;
    let intent = WriteIntent {
        target,
        fields: fields.clone(),
    };
    let tag = format!("komori_request_{}", request.request_id);
    let mut tags = card_tags(request, &prefs.mappings[&prefs.model]);
    tags.push(tag.clone());
    let note = json!({"deckName":prefs.deck, "modelName":prefs.model, "fields":fields, "options":{"allowDuplicate":prefs.duplicate_policy == DuplicatePolicy::Allow || other_readings, "duplicateScope":prefs.duplicate_scope, "duplicateScopeOptions":{"deckName":prefs.deck,"checkChildren":prefs.check_children,"checkAllModels":false}}, "tags":tags});
    // JSON escaping and envelope overhead also count toward the transport bound.
    // Refuse before media/tag writes or journaling a mutation that cannot be sent.
    if let Some(id) = target {
        request_body(
            &prefs,
            "updateNoteFields",
            json!({"note":{"id":id,"fields":fields}}),
        )?;
    } else {
        request_body(&prefs, "addNote", json!({"note":note}))?;
    }
    let audio = audio.map(|audio| (audio.file_name(), STANDARD.encode(&audio.bytes)));
    for (filename, data) in media.into_iter().chain(audio) {
        let saved = call(
            &prefs,
            "storeMediaFile",
            json!({"filename":filename,"data":data}),
        )?;
        if saved.as_str() != Some(filename.as_str()) {
            return Err(AnkiError::Protocol);
        }
    }
    // Commit before note mutation. Overwrites additionally keep exact expected HTML for recovery.
    connection
        .execute(
            "INSERT INTO anki_requests (id,payload,outcome,intent) VALUES (?1,?2,?3,?4)",
            params![
                request.request_id,
                payload,
                serde_json::to_string(&NoteOutcome::Uncertain).unwrap(),
                serde_json::to_string(&intent).map_err(|_| AnkiError::Invalid)?
            ],
        )
        .map_err(|_| AnkiError::Storage)?;
    let outcome = if let Some(id) = target {
        // Tag first so interrupted overwrites can be located. Never replace a user's tags.
        if call(
            &prefs,
            "addTags",
            json!({"notes":[id],"tags":tags.join(" ")}),
        )
        .is_ok()
        {
            let _ = call(
                &prefs,
                "updateNoteFields",
                json!({"note":{"id":id,"fields":fields}}),
            );
            if fields_match(&prefs, id, &fields).unwrap_or(false) {
                NoteOutcome::Updated { id }
            } else {
                NoteOutcome::Uncertain
            }
        } else {
            NoteOutcome::Uncertain
        }
    } else {
        match call(&prefs, "addNote", json!({"note":note})) {
            Ok(value) => match value.as_i64().filter(|id| valid_id(*id)) {
                Some(id) => NoteOutcome::Created { id },
                None => NoteOutcome::Uncertain,
            },
            Err(AnkiError::Duplicate) => NoteOutcome::Duplicate { id: None },
            Err(_) => NoteOutcome::Uncertain,
        }
    };
    connection
        .execute(
            "UPDATE anki_requests SET outcome=?2 WHERE id=?1",
            params![request.request_id, serde_json::to_string(&outcome).unwrap()],
        )
        .map_err(|_| AnkiError::Storage)?;
    if let NoteOutcome::Created { id } | NoteOutcome::Updated { id } = &outcome {
        let _ = cleanup_note_tags(&connection, &prefs, *id);
    }
    Ok(outcome)
}
fn fields_match(prefs: &Preferences, id: i64, fields: &BTreeMap<String, String>) -> Result<bool> {
    let info = call(prefs, "notesInfo", json!({"notes":[id]}))?;
    let info = info.as_array().ok_or(AnkiError::Protocol)?;
    Ok(info.len() == 1
        && info[0]["noteId"].as_i64() == Some(id)
        && fields
            .iter()
            .all(|(name, text)| info[0]["fields"][name]["value"].as_str() == Some(text)))
}
fn browse_note(path: &Path, id: i64) -> Result<()> {
    if !valid_id(id) {
        return Err(AnkiError::Invalid);
    }
    let prefs = load(path)?;
    let connection = connection(path)?;
    journal(&connection)?;
    let _ = cleanup_note_tags(&connection, &prefs, id);
    call(&prefs, "guiBrowse", json!({"query":format!("nid:{id}")}))?;
    Ok(())
}
fn check_note(path: &Path, request_id: &str) -> Result<NoteOutcome> {
    let connection = connection(path)?;
    journal(&connection)?;
    let (payload, outcome): (String, String) = connection
        .query_row(
            "SELECT payload,outcome FROM anki_requests WHERE id=?1",
            [request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AnkiError::Invalid)?;
    let outcome: NoteOutcome = serde_json::from_str(&outcome).map_err(|_| AnkiError::Storage)?;
    if outcome != NoteOutcome::Uncertain {
        if let NoteOutcome::Created { id } | NoteOutcome::Updated { id } = &outcome {
            if let Ok(prefs) = load(path) {
                let _ = cleanup_note_tags(&connection, &prefs, *id);
            }
        }
        return Ok(outcome);
    }
    let request: NoteRequest = serde_json::from_str(&payload).map_err(|_| AnkiError::Storage)?;
    let prefs = load(path)?;
    if prefs.port != request.preferences.port || prefs.key != request.preferences.key {
        return Err(AnkiError::Changed);
    }
    let found: Vec<i64> = serde_json::from_value(call(
        &prefs,
        "findNotes",
        json!({"query":format!("tag:komori_request_{}", request.request_id)}),
    )?)
    .map_err(|_| AnkiError::Protocol)?;
    if found.len() == 1 && valid_id(found[0]) {
        let intent: Option<String> = connection
            .query_row(
                "SELECT intent FROM anki_requests WHERE id=?1",
                [request_id],
                |r| r.get(0),
            )
            .map_err(|_| AnkiError::Storage)?;
        let intent: Option<WriteIntent> = intent
            .map(|value| serde_json::from_str(&value).map_err(|_| AnkiError::Storage))
            .transpose()?;
        let outcome = if let Some(intent) = intent.filter(|i| i.target.is_some()) {
            if intent.target != Some(found[0]) || !fields_match(&prefs, found[0], &intent.fields)? {
                return Ok(NoteOutcome::Uncertain);
            }
            NoteOutcome::Updated { id: found[0] }
        } else {
            NoteOutcome::Created { id: found[0] }
        };
        connection
            .execute(
                "UPDATE anki_requests SET outcome=?2 WHERE id=?1",
                params![request_id, serde_json::to_string(&outcome).unwrap()],
            )
            .map_err(|_| AnkiError::Storage)?;
        let _ = cleanup_note_tags(&connection, &prefs, found[0]);
        return Ok(outcome);
    }
    Ok(NoteOutcome::Uncertain)
}

#[tauri::command]
pub async fn get_anki_preferences(catalog: State<'_, CatalogState>) -> Result<Preferences> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|_| AnkiError::Storage)?
}
#[tauri::command]
pub async fn save_anki_preferences(
    catalog: State<'_, CatalogState>,
    preferences: Preferences,
) -> Result<()> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        save(&path, &preferences)
    })
    .await
    .map_err(|_| AnkiError::Storage)?
}
#[tauri::command]
pub async fn discover_anki(preferences: Preferences) -> Result<Discovery> {
    tauri::async_runtime::spawn_blocking(move || discover(&preferences))
        .await
        .map_err(|_| AnkiError::Unavailable)?
}
#[tauri::command]
pub async fn create_anki_lapis(preferences: Preferences) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        create_lapis(&preferences)
    })
    .await
    .map_err(|_| AnkiError::Unavailable)?
}
#[tauri::command]
pub async fn create_anki_note(
    catalog: State<'_, CatalogState>,
    request: NoteRequest,
) -> Result<NoteOutcome> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        create_note_with(&path, &request, &|sources, term, reading| {
            tauri::async_runtime::block_on(word_audio::find(sources, term, reading))
        })
    })
    .await
    .map_err(|_| AnkiError::Storage)?
}
#[tauri::command]
pub async fn check_anki_note(
    catalog: State<'_, CatalogState>,
    request_id: String,
) -> Result<NoteOutcome> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        check_note(&path, &request_id)
    })
    .await
    .map_err(|_| AnkiError::Storage)?
}
#[tauri::command]
pub async fn get_anki_pending_requests(
    catalog: State<'_, CatalogState>,
) -> Result<Vec<PendingRequest>> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        pending_requests(&path)
    })
    .await
    .map_err(|_| AnkiError::Storage)?
}

#[tauri::command]
pub async fn get_anki_note_statuses(
    catalog: State<'_, CatalogState>,
    batch: StatusBatch,
) -> Result<Vec<NoteStatus>> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || note_statuses(&path, &batch))
        .await
        .map_err(|_| AnkiError::Storage)?
}

#[tauri::command]
pub async fn browse_anki_note(catalog: State<'_, CatalogState>, id: i64) -> Result<()> {
    let path = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().map_err(|_| AnkiError::Busy)?;
        browse_note(&path, id)
    })
    .await
    .map_err(|_| AnkiError::Unavailable)?
}
