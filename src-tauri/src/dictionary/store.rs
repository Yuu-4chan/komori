//! Komori's own dictionary database (`dictionaries.sqlite3`): imported
//! dictionaries, one table per row kind, indexed for exact lookup, with each glossary stored as a
//! deflate blob. Archives are only read, through `dictionary::archive`; each is written in one
//! transaction, so a failed import leaves nothing behind, and a dictionary is removed with all
//! its rows in one transaction. A turned-off dictionary keeps its rows but matches no lookup.
//! Dictionaries keep the reader's order, which lookups follow. Compaction gives the space that
//! removals freed back to the disk. Paths never reach the frontend.

use crate::interface_text::{self, Text};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};

use crate::bulk_progress::{
    compaction_needed, reclaim, BatchProgress, RemovalBatch, COMPACTION_MINIMUM_FREE,
};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::archive::{
    BankKind, DictionaryArchive, DictionaryArchiveError, TermEntry, TermMetaMode,
};
use super::deinflect::{deinflect, word_classes, DICTIONARY_FORMS, VS};
use super::sources::SourcePolicy;

const SCHEMA_VERSION: i64 = 8;
pub(crate) const DATABASE_FILE_NAME: &str = "dictionaries.sqlite3";
const MAX_QUERY_CHARS: usize = 256;
const MAX_QUERY_BYTES: usize = 1024;
/// The longest start of a query tried when the whole query matches nothing, in characters.
const MAX_SCANNED_START_CHARS: usize = 64;
/// The most starts a scanned query lists groups for, the longest matching start included.
const MAX_LISTED_STARTS: usize = 8;
/// The most groups a scanned query lists once shorter starts follow its longest matching start;
/// the longest start's own groups are never cut.
const MAX_LISTED_GROUPS: usize = 32;
/// The bounds of a caller's own result limit (the Reader popup's Maximum results), which cuts
/// every group past it, the longest start's included.
const MAX_RESULTS: std::ops::RangeInclusive<usize> = 1..=64;
/// Particles that follow a word: a longest start that is a shorter start plus one of them (誰が
/// after 誰) is a word-and-particle expression.
const TRAILING_PARTICLES: [char; 12] = [
    'が', 'を', 'は', 'に', 'へ', 'と', 'で', 'も', 'の', 'か', 'や', 'ね',
];
/// How many times rarer (by its best rank) a word-and-particle expression must be than the word
/// it starts with before the word's groups are listed first.
const PARTICLE_RARITY: f64 = 10.0;
/// The most text one stored glossary (or kanji row's meanings) may read back as in a lookup. The
/// largest real glossary is about 370 KiB.
const MAX_GLOSSARY_BYTES: usize = 2 * 1024 * 1024;
/// The most glossary text one lookup may return. An unlimited lookup of a common reading returns
/// about 7.5 MiB.
const MAX_LOOKUP_GLOSSARY_BYTES: usize = 32 * 1024 * 1024;
const GLOSSARY_TOO_LARGE: &str = "A dictionary definition is too large to show.";
const LOOKUP_TOO_LARGE: &str = "These dictionary results are too large to show.";

/// How much glossary text a lookup reads: per glossary, and in all for the returned groups.
#[derive(Clone, Copy)]
struct GlossaryLimits {
    glossary: usize,
    lookup: usize,
}

const GLOSSARY_LIMITS: GlossaryLimits = GlossaryLimits {
    glossary: MAX_GLOSSARY_BYTES,
    lookup: MAX_LOOKUP_GLOSSARY_BYTES,
};

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermMatch {
    dictionary_id: i64,
    dictionary_title: String,
    definition_tags: String,
    rules: String,
    score: f64,
    sequence: i64,
    term_tags: String,
    /// Each name in the definition tags, then the term tags, once, resolved against the tags of
    /// this term's own dictionary.
    tags: Vec<TermTag>,
    /// Null until the lookup has chosen its groups; then the glossary read from `stored`.
    glossary: Value,
    /// The deflated glossary, emptied once it is read.
    #[serde(skip)]
    stored: Vec<u8>,
    /// Whether the glossary carries the `uk` sense marker, once ranking has looked.
    #[serde(skip)]
    kana_marker: Option<bool>,
}

/// A tag name with the first definition its dictionary imported for it, if any.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermTag {
    name: String,
    #[serde(flatten)]
    definition: Option<TagDefinition>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDefinition {
    category: String,
    order: f64,
    notes: String,
    score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyMatch {
    dictionary_id: i64,
    dictionary_title: String,
    data: Value,
    /// The source's declared `frequencyMode`, so cards can average only ranks.
    #[serde(skip_serializing_if = "Option::is_none")]
    frequency_mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchMatch {
    dictionary_id: i64,
    dictionary_title: String,
    data: Value,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermGroup {
    expression: String,
    reading: String,
    /// The start of the query the group matched, exactly or as an inflection. Empty from an
    /// exact lookup of one text.
    text: String,
    /// When the group was reached as an inflection of the matched text, its dictionary form.
    deinflection: Option<Deinflection>,
    terms: Vec<TermMatch>,
    frequencies: Vec<FrequencyMatch>,
    pitches: Vec<PitchMatch>,
}

/// The groups for a query, or for its longest start that an enabled dictionary matches, exactly
/// or as an inflection of a dictionary form: the exact groups first, then each matching
/// dictionary form's groups. Unless the whole query matched exactly, each shorter matching
/// start's groups follow, longest start first, in the same order.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermLookup {
    /// The text the first groups match: the trimmed query, or its longest matching start. With no
    /// groups, the trimmed query.
    text: String,
    groups: Vec<TermGroup>,
}

/// The dictionary form an inflected text was looked up as.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deinflection {
    form: String,
    /// The inflections applied, from the dictionary form outward (読みました: polite, past).
    inflections: Vec<String>,
}

/// One imported kanji row, with its dictionary.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiMatch {
    dictionary_id: i64,
    dictionary_title: String,
    character: String,
    onyomi: String,
    kunyomi: String,
    /// The original space-separated tag names.
    tags: String,
    meanings: Vec<String>,
    stats: Value,
    /// Each name in `tags` once, resolved against the tags of this row's own dictionary.
    resolved_tags: Vec<TermTag>,
    /// Each stat name in `stats`, resolved against the tags of this row's own dictionary.
    stat_tags: Vec<TermTag>,
}

/// The kanji rows and kanji frequency rows for one kanji, in the reader's dictionary order.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiLookup {
    entries: Vec<KanjiMatch>,
    frequencies: Vec<FrequencyMatch>,
}

pub struct DictionaryStoreState {
    pub(super) database: PathBuf,
    /// Imports, removals, moves, and compaction run one at a time: an import holds
    /// the write transaction for its whole archive, so the others wait for it instead of timing out.
    pub(super) write_lock: Arc<Mutex<()>>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySummary {
    id: i64,
    title: String,
    revision: String,
    /// Legacy storage flag, restored to true by v7. Source policies govern choices now.
    enabled: bool,
    term_count: i64,
    term_meta_count: i64,
    kanji_count: i64,
    kanji_meta_count: i64,
    has_definitions: bool,
    has_frequency: bool,
    has_pitch: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryImportResult {
    /// The archive's file name only, never its path.
    file_name: String,
    status: ImportStatus,
    /// The dictionary's title once its index has been read.
    title: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportStatus {
    Imported,
    /// A dictionary with the same title and revision is already imported.
    AlreadyImported,
    /// Not a dictionary archive Komori reads: not a ZIP, no or a bad index, format 1, or a
    /// malformed or oversized bank.
    Invalid,
    /// The file or one of its entries could not be read.
    Unreadable,
    /// The dictionary database could not be written.
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryImportBatch {
    canceled: bool,
    results: Vec<DictionaryImportResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalStatus {
    /// The dictionary and every row keyed by it are gone.
    Removed,
    /// No dictionary has this ID (already removed, or never imported).
    NotFound,
    /// The dictionary database could not be written; nothing was removed.
    Failed,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EnabledStatus {
    /// The dictionary now has the requested state (including when it already had it).
    Updated,
    /// No dictionary has this ID (removed, or never imported).
    NotFound,
    /// The dictionary database could not be written; nothing changed.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveStatus {
    /// The dictionary is now at the requested place in the order (including when it already was).
    Moved,
    /// No dictionary has this ID (removed, or never imported).
    NotFound,
    /// The dictionary database could not be written; the order is unchanged.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompactionResult {
    /// The free pages are gone. Sizes are the database file and its log, in bytes.
    Compacted { size_before: u64, size_after: u64 },
    /// Too little space is free for a rewrite to be worth it; later additions reuse it.
    NotNeeded,
    /// The store could not be compacted; every dictionary and row is unchanged.
    Failed,
}

pub fn initialize_store(app: &AppHandle) -> Result<DictionaryStoreState, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate Komori application data: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create Komori application data: {error}"))?;
    let database = directory.join(DATABASE_FILE_NAME);
    open_store(&database)?;
    Ok(DictionaryStoreState {
        database,
        write_lock: Arc::default(),
    })
}

#[tauri::command]
pub async fn list_dictionaries(
    store: State<'_, DictionaryStoreState>,
) -> Result<Vec<DictionarySummary>, String> {
    let database = store.database.clone();
    tauri::async_runtime::spawn_blocking(move || list_from_store(&open_store(&database)?))
        .await
        .map_err(|error| format!("Dictionary task failed: {error}"))?
}

#[tauri::command]
pub async fn lookup_terms(
    query: String,
    sources: Option<SourcePolicy>,
    max_results: Option<usize>,
    store: State<'_, DictionaryStoreState>,
) -> Result<TermLookup, String> {
    let sources = sources.unwrap_or_default();
    if !sources.is_valid() {
        return Err("Invalid dictionary sources.".into());
    }
    if max_results.is_some_and(|limit| !MAX_RESULTS.contains(&limit)) {
        return Err("Invalid result limit.".into());
    }
    let query = checked_query(&query)?;
    if query.is_empty() {
        return Ok(TermLookup {
            text: query,
            groups: Vec::new(),
        });
    }
    let database = store.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lookup_longest_start_limited(&open_store(&database)?, &query, &sources, max_results)
    })
    .await
    .map_err(|error| format!("Dictionary lookup task failed: {error}"))?
}

/// Looks up one kanji in the enabled kanji dictionaries. Any other query (empty, several
/// characters, or a character that is not a kanji) matches nothing.
#[tauri::command]
pub async fn lookup_kanji(
    query: String,
    sources: Option<SourcePolicy>,
    store: State<'_, DictionaryStoreState>,
) -> Result<KanjiLookup, String> {
    let sources = sources.unwrap_or_default();
    if !sources.is_valid() {
        return Err("Invalid dictionary sources.".into());
    }
    let query = checked_query(&query)?;
    if kanji_query(&query).is_none() {
        return Ok(KanjiLookup::default());
    }
    let database = store.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lookup_kanji_with_sources(&open_store(&database)?, &query, &sources)
    })
    .await
    .map_err(|error| format!("Dictionary lookup task failed: {error}"))?
}

fn checked_query(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS || query.len() > MAX_QUERY_BYTES {
        return Err("Search is too long (maximum 256 characters).".into());
    }
    Ok(query.to_owned())
}

#[cfg(test)]
fn lookup_from_store(connection: &Connection, query: &str) -> Result<Vec<TermGroup>, String> {
    lookup_classes_from_store(connection, query, None)
}

/// Which of the terms an exact lookup finds it keeps.
#[derive(Clone, Copy)]
enum TermFilter {
    All,
    /// Terms whose rules name one of these word classes.
    Classes(u32),
    /// Nouns that take する: terms whose rules or definition tags name `vs`, since JMdict gives
    /// such a noun (勉強) no rules and names `vs` among its part-of-speech tags.
    SuruNoun,
}

impl TermFilter {
    fn keeps(self, rules: &str, definition_tags: &str) -> bool {
        match self {
            Self::All => true,
            Self::Classes(classes) => word_classes(rules) & classes != 0,
            Self::SuruNoun => (word_classes(rules) | word_classes(definition_tags)) & VS != 0,
        }
    }
}

/// The exact lookup, keeping only terms whose rules name one of `classes` when it is given.
#[cfg(test)]
fn lookup_classes_from_store(
    connection: &Connection,
    query: &str,
    classes: Option<u32>,
) -> Result<Vec<TermGroup>, String> {
    lookup_filtered_with_sources(
        connection,
        query,
        classes.map_or(TermFilter::All, TermFilter::Classes),
        &SourcePolicy::default(),
    )
}

/// The exact lookup with its glossaries read, keeping only the terms `filter` keeps.
#[cfg(test)]
fn lookup_filtered_with_sources(
    connection: &Connection,
    query: &str,
    filter: TermFilter,
    sources: &SourcePolicy,
) -> Result<Vec<TermGroup>, String> {
    let mut groups = exact_groups(connection, query, filter, sources, GLOSSARY_LIMITS)?;
    read_glossaries(&mut groups, GLOSSARY_LIMITS)?;
    Ok(groups)
}

/// Inflates one stored glossary, or `None` when it reads back as more than `limit` bytes.
fn inflate_glossary(compressed: &[u8], limit: usize) -> Result<Option<String>, String> {
    let mut glossary = String::new();
    DeflateDecoder::new(compressed)
        .take(limit as u64 + 1)
        .read_to_string(&mut glossary)
        .map_err(|_| "Dictionary glossary could not be read.".to_string())?;
    Ok((glossary.len() <= limit).then_some(glossary))
}

fn parse_glossary(compressed: &[u8], limit: usize) -> Result<Value, String> {
    let glossary = inflate_glossary(compressed, limit)?.ok_or(GLOSSARY_TOO_LARGE)?;
    serde_json::from_str(&glossary).map_err(|_| "Dictionary glossary could not be read.".into())
}

/// Reads the glossaries of the groups a lookup returns, in order, refusing the lookup when one
/// glossary or all of them together read back as more than `limits` allow.
fn read_glossaries(groups: &mut [TermGroup], limits: GlossaryLimits) -> Result<(), String> {
    let mut total = 0usize;
    for term in groups.iter_mut().flat_map(|group| &mut group.terms) {
        let glossary =
            inflate_glossary(&term.stored, limits.glossary)?.ok_or(GLOSSARY_TOO_LARGE)?;
        total += glossary.len();
        if total > limits.lookup {
            return Err(LOOKUP_TOO_LARGE.into());
        }
        term.glossary = serde_json::from_str(&glossary)
            .map_err(|_| "Dictionary glossary could not be read.".to_string())?;
        term.stored = Vec::new();
    }
    Ok(())
}

/// The exact lookup, keeping only the terms `filter` keeps. Glossaries stay stored until the
/// caller has chosen the groups it returns (see `read_glossaries`).
fn exact_groups(
    connection: &Connection,
    query: &str,
    filter: TermFilter,
    sources: &SourcePolicy,
    limits: GlossaryLimits,
) -> Result<Vec<TermGroup>, String> {
    let query = checked_query(query)?;
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.title, t.expression, t.reading, t.definition_tags, t.rules,
                    t.score, t.glossary, t.sequence, t.term_tags
               FROM terms t JOIN dictionaries d ON d.id = t.dictionary
              WHERE (t.expression = ?1 OR t.reading = ?1 OR
                     (t.reading = t.expression AND t.expression IN
                       (SELECT expression FROM terms WHERE reading = ?1)))
                AND d.enabled AND d.has_definitions AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              ORDER BY d.position, d.id, t.score DESC, t.rowid",
        )
        .map_err(storage_error)?;
    let mut rows = statement
        .query(params![&query, sources.definitions.sql_ids()])
        .map_err(storage_error)?;
    let mut tag_resolver = TagResolver::new(connection)?;
    let mut matches = Vec::new();
    let mut explicit_readings = HashMap::new();
    while let Some(row) = rows.next().map_err(storage_error)? {
        let rules: String = row.get(5).map_err(storage_error)?;
        let definition_tags: String = row.get(4).map_err(storage_error)?;
        if !filter.keeps(&rules, &definition_tags) {
            continue;
        }
        let expression: String = row.get(2).map_err(storage_error)?;
        let reading: String = row.get(3).map_err(storage_error)?;
        if reading != expression {
            explicit_readings
                .entry(expression.clone())
                .or_insert_with(|| reading.clone());
        }
        let dictionary_id: i64 = row.get(0).map_err(storage_error)?;
        let term_tags: String = row.get(9).map_err(storage_error)?;
        let tags = tag_resolver.resolve(dictionary_id, [&definition_tags, &term_tags])?;
        let term = TermMatch {
            dictionary_id,
            dictionary_title: row.get(1).map_err(storage_error)?,
            definition_tags,
            rules,
            score: row.get(6).map_err(storage_error)?,
            glossary: Value::Null,
            stored: row.get(7).map_err(storage_error)?,
            kana_marker: None,
            sequence: row.get(8).map_err(storage_error)?,
            term_tags,
            tags,
        };
        matches.push((expression, reading, term));
    }
    let mut groups: Vec<TermGroup> = Vec::new();
    let mut positions: HashMap<(String, String), usize> = HashMap::new();
    for (expression, mut reading, term) in matches {
        // The archive reader uses the expression for an omitted reading. Such definitions
        // belong once under the first matching supplied reading, not in a duplicate card.
        // Kana-only headwords already have a reading; genuine supplied variants stay separate.
        if reading == expression && !is_kana(&expression) {
            if let Some(explicit) = explicit_readings.get(&expression) {
                reading.clone_from(explicit);
            }
        }
        // A reading query's extra expression-only rows require an eligible supplied match.
        // Disabled/unselected sources or a rejected word class must not supply that match.
        if expression != query && reading != query {
            continue;
        }
        let key = (expression.clone(), reading.clone());
        let position = *positions.entry(key).or_insert_with(|| {
            groups.push(TermGroup {
                expression,
                reading,
                text: String::new(),
                deinflection: None,
                terms: Vec::new(),
                frequencies: Vec::new(),
                pitches: Vec::new(),
            });
            groups.len() - 1
        });
        groups[position].terms.push(term);
    }
    let mut frequency_statement = connection
        .prepare(
            "SELECT d.id, d.title, m.data, d.frequency_mode FROM term_meta m
               JOIN dictionaries d ON d.id = m.dictionary
              WHERE m.expression = ?1 AND m.mode = 'freq' AND d.enabled AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              ORDER BY d.position, d.id, m.rowid",
        )
        .map_err(storage_error)?;
    let mut frequency_cache: HashMap<String, Vec<FrequencyMatch>> = HashMap::new();
    for group in &mut groups {
        if !frequency_cache.contains_key(&group.expression) {
            let matches = frequency_statement
                .query_map(
                    params![&group.expression, sources.frequency.sql_ids()],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .map_err(storage_error)?
                .map(|result| {
                    let (dictionary_id, dictionary_title, data, frequency_mode) =
                        result.map_err(storage_error)?;
                    Ok(FrequencyMatch {
                        dictionary_id,
                        dictionary_title,
                        data: serde_json::from_str(&data)
                            .map_err(|_| "Dictionary frequency could not be read.".to_string())?,
                        frequency_mode,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            frequency_cache.insert(group.expression.clone(), matches);
        }
        group.frequencies = frequency_cache[&group.expression]
            .iter()
            .filter(|item| {
                item.data
                    .get("reading")
                    .and_then(Value::as_str)
                    .is_none_or(|reading| reading == group.reading)
            })
            .cloned()
            .collect();
    }
    let mut pitch_statement = connection
        .prepare(
            "SELECT d.id, d.title, m.data FROM term_meta m
               JOIN dictionaries d ON d.id = m.dictionary
              WHERE m.expression = ?1 AND m.mode = 'pitch' AND d.enabled AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              ORDER BY d.position, d.id, m.rowid",
        )
        .map_err(storage_error)?;
    let mut pitch_cache: HashMap<String, Vec<PitchMatch>> = HashMap::new();
    for group in &mut groups {
        if !pitch_cache.contains_key(&group.expression) {
            let rows = pitch_statement
                .query_map(params![&group.expression, sources.pitch.sql_ids()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(storage_error)?;
            let mut matches = Vec::new();
            for row in rows {
                let (dictionary_id, dictionary_title, data) = row.map_err(storage_error)?;
                if let Ok(data) = serde_json::from_str::<Value>(&data) {
                    if valid_pitch_data(&data) {
                        matches.push(PitchMatch {
                            dictionary_id,
                            dictionary_title,
                            data,
                        });
                    }
                }
            }
            pitch_cache.insert(group.expression.clone(), matches);
        }
        group.pitches = pitch_cache[&group.expression]
            .iter()
            .filter(|item| item.data["reading"].as_str() == Some(group.reading.as_str()))
            .cloned()
            .collect();
    }
    rank_kana_groups(&query, &mut groups, 0, limits)?;
    Ok(groups)
}

fn is_kana(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|c| {
            matches!(
                c,
                '\u{3041}'..='\u{3096}'
                    | '\u{309d}'..='\u{309f}'
                    | '\u{30a1}'..='\u{30fa}'
                    | '\u{30fc}'..='\u{30ff}'
                    | '\u{ff66}'..='\u{ff9f}'
            )
        })
}

/// Jitendex carries JMdict's `uk` sense marker in inert structured content, rather than
/// in the headword tags. Inspect that marker, never arbitrary prose mentioning kana.
fn kana_marker(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(kana_marker),
        Value::Object(node) => {
            let data = node.get("data");
            (data.is_some_and(|data| data["code"] == "uk" && data["content"] == "misc-info"))
                || node.get("content").is_some_and(kana_marker)
        }
        _ => false,
    }
}

/// Whether a term marks its headword as usually written in kana. The glossary is read only when
/// no tag says so, at most once per term, and is not kept: the lookup reads the glossaries it
/// returns later.
fn usually_kana(group: &mut TermGroup, limits: GlossaryLimits) -> Result<bool, String> {
    for term in &mut group.terms {
        if [&term.definition_tags, &term.term_tags]
            .iter()
            .any(|tags| tags.split(' ').any(|tag| tag == "uk"))
            || term.tags.iter().any(|tag| tag.name == "uk")
        {
            return Ok(true);
        }
        let marked = match term.kana_marker {
            Some(marked) => marked,
            None if term.stored.is_empty() => kana_marker(&term.glossary),
            None => kana_marker(&parse_glossary(&term.stored, limits.glossary)?),
        };
        term.kana_marker = Some(marked);
        if marked {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Stable tiers retain native source/score/row and candidate order within each tier, for the
/// groups from `first` on. A kanji query keeps its original ranking. For inflections compare the
/// dictionary form.
fn rank_kana_groups(
    query: &str,
    groups: &mut Vec<TermGroup>,
    first: usize,
    limits: GlossaryLimits,
) -> Result<(), String> {
    if !is_kana(query) {
        return Ok(());
    }
    let mut ranked = groups
        .split_off(first)
        .into_iter()
        .map(|mut group| {
            let form = group
                .deinflection
                .as_ref()
                .map_or(query, |form| form.form.as_str());
            let tier = if group.expression == form && is_kana(&group.expression) {
                0
            } else if group.reading == form && usually_kana(&mut group, limits)? {
                1
            } else {
                2
            };
            Ok((tier, group))
        })
        .collect::<Result<Vec<_>, String>>()?;
    ranked.sort_by_key(|(tier, _)| *tier);
    groups.extend(ranked.into_iter().map(|(_, group)| group));
    Ok(())
}

/// Looks up the trimmed query exactly, or, when no enabled dictionary has a term whose
/// expression or reading equals it, its starts (by Unicode character, at most
/// `MAX_SCANNED_START_CHARS` long) that one has. Each start, longest
/// first, is tried exactly and as an inflection of each dictionary form it may be (see
/// `dictionary::deinflect`), whose terms must have rules naming that form's word class. The
/// first start with any match wins and names the lookup's text; within the kana tiers its exact groups come first,
/// then each matching form's groups in candidate order. Each shorter start that matches then
/// lists its groups in the same order, within `MAX_LISTED_STARTS` and `MAX_LISTED_GROUPS`. A
/// group reached more than one way is listed once, the first way (so with its longest start).
/// A `vs` candidate ending in する is followed by its nonempty stem as a form of its own,
/// matching only terms whose rules or definition tags name `vs` (JMdict's する-nouns, stored
/// without する and with `vs` only among their part-of-speech tags).
///
/// A longest start that is a shorter matching start plus one trailing particle (誰が, then 誰)
/// lists after that start when its best rank in the rank-based frequency dictionaries is more
/// than `PARTICLE_RARITY` times rarer, or it has none and the shorter start has one; the
/// shorter start then names the lookup's text. `limit`, when given, cuts every group past it.
#[cfg(test)]
fn lookup_longest_start_with_sources(
    connection: &Connection,
    query: &str,
    sources: &SourcePolicy,
) -> Result<TermLookup, String> {
    lookup_longest_start_limited(connection, query, sources, None)
}

fn lookup_longest_start_limited(
    connection: &Connection,
    query: &str,
    sources: &SourcePolicy,
    limit: Option<usize>,
) -> Result<TermLookup, String> {
    lookup_longest_start_bounded(connection, query, sources, limit, GLOSSARY_LIMITS)
}

/// `lookup_longest_start_limited`, reading only the returned groups' glossaries, within `limits`.
fn lookup_longest_start_bounded(
    connection: &Connection,
    query: &str,
    sources: &SourcePolicy,
    limit: Option<usize>,
    limits: GlossaryLimits,
) -> Result<TermLookup, String> {
    let query = checked_query(query)?;
    let mut probe = connection
        .prepare(
            "SELECT 1 FROM terms t JOIN dictionaries d ON d.id = t.dictionary
              WHERE (t.expression = ?1 OR t.reading = ?1) AND d.enabled AND d.has_definitions AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              LIMIT 1",
        )
        .map_err(storage_error)?;
    let mut rules_probe = connection
        .prepare(
            "SELECT t.rules, t.definition_tags FROM terms t JOIN dictionaries d ON d.id = t.dictionary
              WHERE (t.expression = ?1 OR t.reading = ?1) AND d.enabled AND d.has_definitions AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))",
        )
        .map_err(storage_error)?;
    // Byte ends of the starts shorter than the query, longest first.
    let ends = query
        .char_indices()
        .skip(1)
        .take(MAX_SCANNED_START_CHARS)
        .map(|(end, _)| end)
        .collect::<Vec<_>>();
    let starts =
        std::iter::once(query.as_str()).chain(ends.into_iter().rev().map(|end| &query[..end]));
    let mut text: Option<&str> = None;
    let mut groups: Vec<TermGroup> = Vec::new();
    let mut listed_starts = 0;
    for start in starts.filter(|start| !start.is_empty()) {
        let exact = probe
            .exists(params![start, sources.definitions.sql_ids()])
            .map_err(storage_error)?;
        let listed = groups.len();
        add_start_groups(
            connection,
            &mut rules_probe,
            start,
            exact,
            &mut groups,
            sources,
            limits,
        )?;
        if groups.len() == listed {
            continue;
        }
        listed_starts += 1;
        match text {
            None => {
                text = Some(start);
                // A query matched exactly as a whole lists only its own groups.
                if exact && start == query {
                    break;
                }
            }
            Some(_) => groups.truncate(MAX_LISTED_GROUPS),
        }
        if listed_starts == MAX_LISTED_STARTS
            || groups.len() >= MAX_LISTED_GROUPS
            || limit.is_some_and(|limit| groups.len() >= limit)
        {
            break;
        }
    }
    let mut text = text.unwrap_or(&query).to_owned();
    if let Some(word) = rare_particle_expression(connection, &text, &groups)? {
        let (mut first, rest): (Vec<_>, Vec<_>) =
            groups.into_iter().partition(|group| group.text == word);
        let (expression, rest): (Vec<_>, Vec<_>) =
            rest.into_iter().partition(|group| group.text == text);
        first.extend(expression);
        first.extend(rest);
        groups = first;
        text = word;
    }
    if let Some(limit) = limit {
        groups.truncate(limit);
    }
    read_glossaries(&mut groups, limits)?;
    Ok(TermLookup { text, groups })
}

/// The shorter start to list first when `text`, the longest matching start, is that start plus a
/// trailing particle and is much rarer than it (see `lookup_longest_start_with_sources`).
fn rare_particle_expression(
    connection: &Connection,
    text: &str,
    groups: &[TermGroup],
) -> Result<Option<String>, String> {
    let Some(particle) = text.chars().last() else {
        return Ok(None);
    };
    let word = &text[..text.len() - particle.len_utf8()];
    if word.is_empty()
        || !TRAILING_PARTICLES.contains(&particle)
        || groups
            .iter()
            .any(|group| group.text == text && group.deinflection.is_some())
        || !groups.iter().any(|group| group.text == word)
    {
        return Ok(None);
    }
    let ranked = connection
        .prepare("SELECT id FROM dictionaries WHERE frequency_mode = 'rank-based'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<HashSet<_>, _>>()
        })
        .map_err(storage_error)?;
    let best = |start: &str| {
        groups
            .iter()
            .filter(|group| group.text == start)
            .flat_map(|group| &group.frequencies)
            .filter(|frequency| ranked.contains(&frequency.dictionary_id))
            .filter_map(|frequency| frequency_number(&frequency.data))
            .filter(|rank| *rank > 0.0)
            .min_by(f64::total_cmp)
    };
    Ok(match (best(text), best(word)) {
        (_, None) => None,
        (Some(expression), Some(word_rank)) if expression <= word_rank * PARTICLE_RARITY => None,
        _ => Some(word.to_owned()),
    })
}

/// A frequency row's number: the value itself, its `value`, or its `frequency`'s (with or without
/// a reading).
fn frequency_number(data: &Value) -> Option<f64> {
    match data {
        Value::Number(number) => number.as_f64(),
        Value::Object(fields) => fields
            .get("frequency")
            .and_then(frequency_number)
            .or_else(|| fields.get("value").and_then(Value::as_f64)),
        _ => None,
    }
}

/// Appends `start`'s unseen exact and inflected groups in candidate order, each naming `start`,
/// then applies the stable kana tiers to that start before the caller enforces its limit.
fn add_start_groups(
    connection: &Connection,
    rules_probe: &mut rusqlite::Statement,
    start: &str,
    exact: bool,
    groups: &mut Vec<TermGroup>,
    sources: &SourcePolicy,
    limits: GlossaryLimits,
) -> Result<(), String> {
    let first = groups.len();
    let mut add = |found: Vec<TermGroup>, deinflection: Option<&Deinflection>| {
        for mut group in found {
            if groups
                .iter()
                .any(|seen| seen.expression == group.expression && seen.reading == group.reading)
            {
                continue;
            }
            start.clone_into(&mut group.text);
            group.deinflection = deinflection.cloned();
            groups.push(group);
        }
    };
    if exact {
        add(
            exact_groups(connection, start, TermFilter::All, sources, limits)?,
            None,
        );
    }
    for form in deinflect(start) {
        let classes = form.classes & DICTIONARY_FORMS;
        if classes == 0 {
            continue;
        }
        // A する verb's candidate is also its noun stored without する (勉強して: 勉強する,
        // then 勉強), as JMdict stores する-nouns.
        let noun = (classes & VS != 0)
            .then(|| form.text.strip_suffix("する"))
            .flatten()
            .filter(|stem| !stem.is_empty());
        for (text, filter) in std::iter::once((form.text.as_str(), TermFilter::Classes(classes)))
            .chain(noun.map(|stem| (stem, TermFilter::SuruNoun)))
        {
            let mut rows = rules_probe
                .query(params![text, sources.definitions.sql_ids()])
                .map_err(storage_error)?;
            let mut matched = false;
            while let Some(row) = rows.next().map_err(storage_error)? {
                let rules: String = row.get(0).map_err(storage_error)?;
                let definition_tags: String = row.get(1).map_err(storage_error)?;
                if filter.keeps(&rules, &definition_tags) {
                    matched = true;
                    break;
                }
            }
            drop(rows);
            if !matched {
                continue;
            }
            let deinflection = Deinflection {
                form: text.to_owned(),
                inflections: form.inflections.iter().map(|&name| name.into()).collect(),
            };
            add(
                exact_groups(connection, text, filter, sources, limits)?,
                Some(&deinflection),
            );
        }
    }
    rank_kana_groups(start, groups, first, limits)
}

/// The format's kanji ranges (the unified ideographs and their extensions, and the
/// compatibility ideographs, as in Yomitan's `isCodePointKanji`) as inclusive hex code point
/// pairs, in a file the frontend reads too, so the Dictionary page offers only kanji this lookup
/// accepts.
static KANJI_RANGES: LazyLock<Vec<(u32, u32)>> = LazyLock::new(|| {
    let ranges: Vec<(String, String)> = serde_json::from_str(include_str!(
        "../../../src/features/dictionary/kanjiRanges.json"
    ))
    .expect("the kanji ranges file is a JSON array of hex pairs");
    let code = |hex: &str| u32::from_str_radix(hex, 16).expect("a hex code point");
    ranges
        .iter()
        .map(|(first, last)| (code(first), code(last)))
        .collect()
});

/// The query's one character when it is a kanji: a CJK ideograph in `KANJI_RANGES`.
fn kanji_query(query: &str) -> Option<char> {
    let mut characters = query.chars();
    let character = characters.next()?;
    let code = u32::from(character);
    (characters.next().is_none()
        && KANJI_RANGES
            .iter()
            .any(|&(first, last)| (first..=last).contains(&code)))
    .then_some(character)
}

fn lookup_kanji_with_sources(
    connection: &Connection,
    query: &str,
    sources: &SourcePolicy,
) -> Result<KanjiLookup, String> {
    lookup_kanji_bounded(connection, query, sources, GLOSSARY_LIMITS)
}

/// `lookup_kanji_with_sources`, refusing a row whose meanings are longer than one glossary may be.
fn lookup_kanji_bounded(
    connection: &Connection,
    query: &str,
    sources: &SourcePolicy,
    limits: GlossaryLimits,
) -> Result<KanjiLookup, String> {
    let query = checked_query(query)?;
    let Some(character) = kanji_query(&query) else {
        return Ok(KanjiLookup::default());
    };
    let character = character.to_string();
    let unreadable = |_: serde_json::Error| "Dictionary kanji could not be read.".to_string();
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.title, k.character, k.onyomi, k.kunyomi, k.tags,
                    length(CAST(k.meanings AS BLOB)), k.stats, k.meanings
               FROM kanji k JOIN dictionaries d ON d.id = k.dictionary
              WHERE k.character = ?1 AND d.enabled AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              ORDER BY d.position, d.id, k.rowid",
        )
        .map_err(storage_error)?;
    let mut rows = statement
        .query(params![&character, sources.definitions.sql_ids()])
        .map_err(storage_error)?;
    let mut tag_resolver = TagResolver::new(connection)?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next().map_err(storage_error)? {
        let dictionary_id: i64 = row.get(0).map_err(storage_error)?;
        let tags: String = row.get(5).map_err(storage_error)?;
        if row.get::<_, usize>(6).map_err(storage_error)? > limits.glossary {
            return Err(GLOSSARY_TOO_LARGE.into());
        }
        let meanings: String = row.get(8).map_err(storage_error)?;
        let stats: Value = serde_json::from_str(&row.get::<_, String>(7).map_err(storage_error)?)
            .map_err(unreadable)?;
        let resolved_tags = tag_resolver.resolve(dictionary_id, [&tags])?;
        // Stat names are whole object keys, never split.
        let stat_tags = tag_resolver.resolve_names(
            dictionary_id,
            stats
                .as_object()
                .into_iter()
                .flat_map(|stats| stats.keys())
                .map(String::as_str),
        )?;
        entries.push(KanjiMatch {
            dictionary_id,
            dictionary_title: row.get(1).map_err(storage_error)?,
            character: row.get(2).map_err(storage_error)?,
            onyomi: row.get(3).map_err(storage_error)?,
            kunyomi: row.get(4).map_err(storage_error)?,
            tags,
            meanings: serde_json::from_str(&meanings).map_err(unreadable)?,
            stats,
            resolved_tags,
            stat_tags,
        });
    }
    // Kanji meta rows only carry frequencies (the archive reader refuses other modes).
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.title, m.data, d.frequency_mode FROM kanji_meta m
               JOIN dictionaries d ON d.id = m.dictionary
              WHERE m.character = ?1 AND d.enabled AND (?2 IS NULL OR d.id IN (SELECT value FROM json_each(?2)))
              ORDER BY d.position, d.id, m.rowid",
        )
        .map_err(storage_error)?;
    let frequencies = statement
        .query_map(params![&character, sources.frequency.sql_ids()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(storage_error)?
        .map(|result| {
            let (dictionary_id, dictionary_title, data, frequency_mode) =
                result.map_err(storage_error)?;
            Ok(FrequencyMatch {
                dictionary_id,
                dictionary_title,
                data: serde_json::from_str(&data)
                    .map_err(|_| "Dictionary frequency could not be read.".to_string())?,
                frequency_mode,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(KanjiLookup {
        entries,
        frequencies,
    })
}

/// Looks up tag names in one dictionary's imported tags, taking the first definition in bank order
/// for each name and remembering it for the rest of the lookup.
struct TagResolver<'a> {
    statement: rusqlite::Statement<'a>,
    cache: HashMap<(i64, String), Option<TagDefinition>>,
}

impl<'a> TagResolver<'a> {
    fn new(connection: &'a Connection) -> Result<Self, String> {
        let statement = connection
            .prepare(
                "SELECT category, sort_order, notes, score FROM tags
                  WHERE dictionary = ?1 AND name = ?2
                  ORDER BY rowid LIMIT 1",
            )
            .map_err(storage_error)?;
        Ok(Self {
            statement,
            cache: HashMap::new(),
        })
    }

    /// The space-separated names in `fields`, in order and once each. only U+0020
    /// separates names: Jitendex's names contain no-break spaces (`priority\u{a0}form`).
    fn resolve<'f>(
        &mut self,
        dictionary: i64,
        fields: impl IntoIterator<Item = &'f String>,
    ) -> Result<Vec<TermTag>, String> {
        self.resolve_names(
            dictionary,
            fields.into_iter().flat_map(|field| field.split(' ')),
        )
    }

    /// Each nonempty name in `names`, in order and once each.
    fn resolve_names<'n>(
        &mut self,
        dictionary: i64,
        names: impl IntoIterator<Item = &'n str>,
    ) -> Result<Vec<TermTag>, String> {
        let mut tags: Vec<TermTag> = Vec::new();
        for name in names.into_iter().filter(|name| !name.is_empty()) {
            if tags.iter().any(|tag| tag.name == name) {
                continue;
            }
            let key = (dictionary, name.to_owned());
            let definition = match self.cache.get(&key) {
                Some(definition) => definition.clone(),
                None => {
                    let definition = self
                        .statement
                        .query_row(params![dictionary, name], |row| {
                            Ok(TagDefinition {
                                category: row.get(0)?,
                                order: row.get(1)?,
                                notes: row.get(2)?,
                                score: row.get(3)?,
                            })
                        })
                        .optional()
                        .map_err(storage_error)?;
                    self.cache.insert(key, definition.clone());
                    definition
                }
            };
            tags.push(TermTag {
                name: name.to_owned(),
                definition,
            });
        }
        Ok(tags)
    }
}

fn valid_pitch_data(data: &Value) -> bool {
    data.get("reading")
        .and_then(Value::as_str)
        .is_some_and(|reading| !reading.is_empty())
        && data
            .get("pitches")
            .and_then(Value::as_array)
            .is_some_and(|pitches| {
                !pitches.is_empty()
                    && pitches
                        .iter()
                        .all(|pitch| pitch.get("position").and_then(Value::as_u64).is_some())
            })
}

#[tauri::command]
pub async fn import_dictionaries(
    app: AppHandle,
    store: State<'_, DictionaryStoreState>,
    catalog: State<'_, crate::library::CatalogState>,
    operation_id: Option<String>,
) -> Result<DictionaryImportBatch, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    progress.phase("picking");
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::AddDictionaries))
        .add_filter(
            interface_text::text(language, Text::DictionaryArchives),
            &["zip"],
        )
        .pick_files()
        .await;
    let Some(selected) = selected else {
        return Ok(DictionaryImportBatch {
            canceled: true,
            results: Vec::new(),
        });
    };
    let paths: Vec<PathBuf> = selected
        .iter()
        .map(|file| file.path().to_path_buf())
        .collect();
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _importing = write_lock
            .lock()
            .map_err(|_| "A previous dictionary import failed.".to_string())?;
        let mut connection = open_store(&database)?;
        Ok(DictionaryImportBatch {
            canceled: false,
            results: import_paths_with_progress(&mut connection, &paths, &mut progress),
        })
    })
    .await
    .map_err(|error| format!("Dictionary import task failed: {error}"))?
}

/// Removes one imported dictionary by its ID. The archive it came from is not involved: Komori
/// keeps no reference to it.
#[tauri::command]
pub async fn remove_dictionary(
    app: AppHandle,
    id: i64,
    store: State<'_, DictionaryStoreState>,
    operation_id: Option<String>,
) -> Result<RemovalBatch<RemovalStatus>, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _removing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let batch = remove_at_path(&database, &[id], &mut progress, COMPACTION_MINIMUM_FREE);
        Ok(RemovalBatch {
            results: batch.results[0].status,
            maintenance: batch.maintenance,
        })
    })
    .await
    .map_err(|error| format!("Dictionary removal task failed: {error}"))?
}

/// One requested ID's outcome in a bulk removal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryRemovalResult {
    id: i64,
    status: RemovalStatus,
}

/// Removes several imported dictionaries by their IDs under one lock, each in its own
/// transaction, so a failure keeps the other removals. Returns one result per requested ID, in
/// request order; a repeated ID is reported as not found once it has been removed.
#[tauri::command]
pub async fn remove_dictionaries(
    app: AppHandle,
    ids: Vec<i64>,
    store: State<'_, DictionaryStoreState>,
    operation_id: Option<String>,
) -> Result<RemovalBatch<Vec<DictionaryRemovalResult>>, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _removing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(remove_at_path(
            &database,
            &ids,
            &mut progress,
            COMPACTION_MINIMUM_FREE,
        ))
    })
    .await
    .map_err(|error| format!("Dictionary removal task failed: {error}"))?
}

#[cfg(test)]
fn remove_many_from_store(
    connection: &mut Connection,
    ids: &[i64],
) -> Vec<DictionaryRemovalResult> {
    remove_many_with_progress(connection, ids, &mut BatchProgress::silent())
}

fn remove_many_with_progress(
    connection: &mut Connection,
    ids: &[i64],
    progress: &mut BatchProgress,
) -> Vec<DictionaryRemovalResult> {
    progress.start(ids.len());
    ids.iter()
        .map(|&id| {
            let result = DictionaryRemovalResult {
                id,
                status: remove_from_store(connection, id).unwrap_or_else(|error| {
                    if cfg!(debug_assertions) {
                        eprintln!("Komori dictionary removal failed for {id}: {error}");
                    }
                    RemovalStatus::Failed
                }),
            };
            progress.completed_one();
            result
        })
        .collect()
}

fn remove_and_reclaim(
    connection: &mut Connection,
    database: &Path,
    ids: &[i64],
    progress: &mut BatchProgress,
    minimum_free: u64,
) -> RemovalBatch<Vec<DictionaryRemovalResult>> {
    let results = remove_many_with_progress(connection, ids, progress);
    let maintenance = reclaim(
        progress,
        results
            .iter()
            .any(|result| result.status == RemovalStatus::Removed),
        || store_compaction_needed(connection, database, minimum_free),
        || compact_store(connection, database),
    );
    RemovalBatch {
        results,
        maintenance,
    }
}

fn remove_at_path(
    database: &Path,
    ids: &[i64],
    progress: &mut BatchProgress,
    minimum_free: u64,
) -> RemovalBatch<Vec<DictionaryRemovalResult>> {
    match open_store(database) {
        Ok(mut connection) => {
            remove_and_reclaim(&mut connection, database, ids, progress, minimum_free)
        }
        Err(_) => {
            progress.start(ids.len());
            let results = ids
                .iter()
                .map(|&id| {
                    progress.completed_one();
                    DictionaryRemovalResult {
                        id,
                        status: RemovalStatus::Failed,
                    }
                })
                .collect();
            RemovalBatch {
                results,
                maintenance: None,
            }
        }
    }
}

/// Deletes the dictionary and its terms, term meta, kanji, kanji meta, and tags in one
/// transaction, so a failure leaves every row in place. Its title and revision can then be
/// imported again. The owning command reclaims freed pages after the batch finishes.
fn remove_from_store(
    connection: &mut Connection,
    id: i64,
) -> Result<RemovalStatus, rusqlite::Error> {
    let transaction = connection.transaction()?;
    if transaction.execute("DELETE FROM dictionaries WHERE id = ?1", [id])? == 0 {
        return Ok(RemovalStatus::NotFound);
    }
    for table in ["terms", "term_meta", "kanji", "kanji_meta", "tags"] {
        transaction.execute(&format!("DELETE FROM {table} WHERE dictionary = ?1"), [id])?;
    }
    transaction.commit()?;
    Ok(RemovalStatus::Removed)
}

// Test-only legacy setup for migration and filtering regressions.
#[cfg(test)]
fn set_enabled_in_store(
    connection: &Connection,
    id: i64,
    enabled: bool,
) -> Result<EnabledStatus, rusqlite::Error> {
    let changed = connection.execute(
        "UPDATE dictionaries SET enabled = ?2 WHERE id = ?1",
        params![id, enabled],
    )?;
    Ok(if changed == 0 {
        EnabledStatus::NotFound
    } else {
        EnabledStatus::Updated
    })
}

/// Moves one imported dictionary to `position` (zero-based; past the end means last) in the order
/// that the list and lookups follow. Its rows are untouched.
#[tauri::command]
pub async fn move_dictionary(
    id: i64,
    position: u32,
    store: State<'_, DictionaryStoreState>,
) -> Result<MoveStatus, String> {
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_moving) = write_lock.lock() else {
            return MoveStatus::Failed;
        };
        open_store(&database)
            .and_then(|mut connection| {
                move_in_store(&mut connection, id, position as usize).map_err(storage_error)
            })
            .unwrap_or_else(|error| {
                if cfg!(debug_assertions) {
                    eprintln!("Komori dictionary move failed for {id}: {error}");
                }
                MoveStatus::Failed
            })
    })
    .await
    .map_err(|error| format!("Dictionary move task failed: {error}"))
}

/// Renumbers every dictionary's position from 1 in the new order, in one transaction, so a
/// failure keeps the old order.
fn move_in_store(
    connection: &mut Connection,
    id: i64,
    position: usize,
) -> Result<MoveStatus, rusqlite::Error> {
    let transaction = connection.transaction()?;
    let mut order: Vec<i64> = transaction
        .prepare("SELECT id FROM dictionaries ORDER BY position, id")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let Some(current) = order.iter().position(|&candidate| candidate == id) else {
        return Ok(MoveStatus::NotFound);
    };
    order.remove(current);
    order.insert(position.min(order.len()), id);
    let mut statement =
        transaction.prepare("UPDATE dictionaries SET position = ?2 WHERE id = ?1")?;
    for (index, id) in order.iter().enumerate() {
        statement.execute(params![id, index + 1])?;
    }
    drop(statement);
    transaction.commit()?;
    Ok(MoveStatus::Moved)
}

/// The store's size on disk in bytes: the database file and its write-ahead log.
#[tauri::command]
pub async fn get_dictionary_store_size(
    store: State<'_, DictionaryStoreState>,
) -> Result<u64, String> {
    let database = store.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store_size(&database).map_err(|_| "The dictionary store size could not be read.".into())
    })
    .await
    .map_err(|error| format!("Dictionary size task failed: {error}"))?
}

fn store_size(database: &Path) -> std::io::Result<u64> {
    let mut wal = database.as_os_str().to_owned();
    wal.push("-wal");
    let wal = match std::fs::metadata(PathBuf::from(wal)) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    Ok(std::fs::metadata(database)?.len() + wal)
}

/// Removals leave free pages that later imports reuse; only a large share is worth a rewrite.
fn store_compaction_needed(connection: &Connection, database: &Path, minimum: u64) -> bool {
    let size = std::fs::metadata(database).map_or(0, |metadata| metadata.len());
    compaction_needed(connection, size, minimum)
}

/// `VACUUM` builds a copy of the database without free pages (in the temporary directory) and, in
/// WAL mode, writes it back through the log, so it needs free disk space of up to about twice the
/// store while it runs. A truncating checkpoint then copies the log into the database file, which
/// shrinks, and empties the log. `VACUUM` keeps every row and, for rows without an integer primary
/// key, their relative order, which lookups follow. A failure leaves the store as it was.
fn compact_store(connection: &Connection, database: &Path) -> Result<CompactionResult, String> {
    let size = |database| store_size(database).map_err(|error| error.to_string());
    let size_before = size(database)?;
    crate::bulk_progress::interruptible(connection, || connection.execute_batch("VACUUM"))
        .map_err(storage_error)?;
    let busy: i64 = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(storage_error)?;
    if busy != 0 {
        // A reader kept the log from being copied back; a later checkpoint will do it.
        return Err("The compacted dictionary store could not be checkpointed yet.".into());
    }
    Ok(CompactionResult::Compacted {
        size_before,
        size_after: size(database)?,
    })
}

pub(crate) fn open_store(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(storage_error)?;
    // WAL keeps the store readable (the list now, lookups later) while an import writes.
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA journal_size_limit = 67108864;",
        )
        .map_err(storage_error)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_error)?;
    if version > SCHEMA_VERSION {
        return Err(crate::failure::DICTIONARY_NEWER.into());
    }
    if version < 1 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS dictionaries (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   title TEXT NOT NULL,
                   revision TEXT NOT NULL,
                   format INTEGER NOT NULL,
                   sequenced INTEGER NOT NULL,
                   author TEXT,
                   url TEXT,
                   description TEXT,
                   attribution TEXT,
                   source_language TEXT,
                   target_language TEXT,
                   frequency_mode TEXT,
                   term_count INTEGER NOT NULL DEFAULT 0,
                   term_meta_count INTEGER NOT NULL DEFAULT 0,
                   kanji_count INTEGER NOT NULL DEFAULT 0,
                   kanji_meta_count INTEGER NOT NULL DEFAULT 0,
                   imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                   UNIQUE (title, revision)
                 );
                 CREATE TABLE IF NOT EXISTS terms (
                   dictionary INTEGER NOT NULL,
                   expression TEXT NOT NULL,
                   reading TEXT NOT NULL,
                   definition_tags TEXT NOT NULL,
                   rules TEXT NOT NULL,
                   score REAL NOT NULL,
                   glossary BLOB NOT NULL,
                   sequence INTEGER NOT NULL,
                   term_tags TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS term_meta (
                   dictionary INTEGER NOT NULL,
                   expression TEXT NOT NULL,
                   mode TEXT NOT NULL,
                   data TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS kanji (
                   dictionary INTEGER NOT NULL,
                   character TEXT NOT NULL,
                   onyomi TEXT NOT NULL,
                   kunyomi TEXT NOT NULL,
                   tags TEXT NOT NULL,
                   meanings TEXT NOT NULL,
                   stats TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS kanji_meta (
                   dictionary INTEGER NOT NULL,
                   character TEXT NOT NULL,
                   data TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS terms_expression ON terms (expression);
                 CREATE INDEX IF NOT EXISTS terms_reading ON terms (reading);
                 CREATE INDEX IF NOT EXISTS term_meta_expression ON term_meta (expression);
                 CREATE INDEX IF NOT EXISTS kanji_character ON kanji (character);
                 CREATE INDEX IF NOT EXISTS kanji_meta_character ON kanji_meta (character);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 2 {
        // Dictionaries imported before version 2 keep no tag rows: their archives are not kept.
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS tags (
                   dictionary INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   category TEXT NOT NULL,
                   sort_order REAL NOT NULL,
                   notes TEXT NOT NULL,
                   score REAL NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS tags_dictionary_name ON tags (dictionary, name);
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 3 {
        // Removal deletes by dictionary; without these it scans every row of every table.
        // Building them reads an existing store once.
        connection
            .execute_batch(
                "BEGIN;
                 CREATE INDEX IF NOT EXISTS terms_dictionary ON terms (dictionary);
                 CREATE INDEX IF NOT EXISTS term_meta_dictionary ON term_meta (dictionary);
                 CREATE INDEX IF NOT EXISTS kanji_dictionary ON kanji (dictionary);
                 CREATE INDEX IF NOT EXISTS kanji_meta_dictionary ON kanji_meta (dictionary);
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 4 {
        // Every dictionary already imported stays on.
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE dictionaries ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 5 {
        // Dictionaries already imported keep import order.
        connection
            .execute_batch(
                "BEGIN;
                 ALTER TABLE dictionaries ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                 UPDATE dictionaries SET position = id;
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(storage_error)?;
    }
    if version < 6 {
        // Empty term-bank placeholders (e.g. TMW) do not supply definitions. Derive
        // eligibility once from stored content; no archive or re-import is required.
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction
            .execute_batch(
                "ALTER TABLE dictionaries ADD COLUMN has_definitions INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(storage_error)?;
        let ids = transaction
            .prepare("SELECT id FROM dictionaries")
            .map_err(storage_error)?
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        for id in ids {
            let has_definitions = stored_has_definitions(&transaction, id)?;
            transaction
                .execute(
                    "UPDATE dictionaries SET has_definitions = ?2 WHERE id = ?1",
                    params![id, has_definitions],
                )
                .map_err(storage_error)?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 6;")
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    if version < 7 {
        // Retire the global switch without stranding imported sources. Only this
        // legacy flag changes: rows, eligibility, IDs, order and role policies stay.
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction
            .execute_batch(
                "UPDATE dictionaries SET enabled = 1 WHERE enabled <> 1; PRAGMA user_version = 7;",
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    if version < 8 {
        // Listing walked every metadata row of a dictionary without pitch on each call. Derive the
        // frequency and pitch roles once from stored rows; imports record them from then on.
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        transaction
            .execute_batch(
                "ALTER TABLE dictionaries ADD COLUMN has_frequency INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE dictionaries ADD COLUMN has_pitch INTEGER NOT NULL DEFAULT 0;
                 UPDATE dictionaries SET
                   has_frequency = EXISTS(SELECT 1 FROM term_meta WHERE dictionary = dictionaries.id AND mode = 'freq')
                     OR EXISTS(SELECT 1 FROM kanji_meta WHERE dictionary = dictionaries.id),
                   has_pitch = EXISTS(SELECT 1 FROM term_meta WHERE dictionary = dictionaries.id AND mode = 'pitch');
                 PRAGMA user_version = 8;",
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    Ok(connection)
}

/// Whether a term row has anything to show. A glossary longer than `MAX_GLOSSARY_BYTES` is not
/// an empty list and is not parsed.
fn has_term_content(glossary: &str, rules: &str, definition_tags: &str, term_tags: &str) -> bool {
    !rules.trim().is_empty()
        || !definition_tags.trim().is_empty()
        || !term_tags.trim().is_empty()
        || glossary.len() > MAX_GLOSSARY_BYTES
        || !serde_json::from_str::<Vec<Value>>(glossary).is_ok_and(|items| items.is_empty())
}

fn stored_has_definitions(connection: &Connection, id: i64) -> Result<bool, String> {
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kanji WHERE dictionary = ?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(storage_error)?
    {
        return Ok(true);
    }
    let mut statement = connection
        .prepare(
            "SELECT glossary, rules, definition_tags, term_tags FROM terms WHERE dictionary = ?1",
        )
        .map_err(storage_error)?;
    let mut rows = statement.query([id]).map_err(storage_error)?;
    while let Some(row) = rows.next().map_err(storage_error)? {
        let compressed: Vec<u8> = row.get(0).map_err(storage_error)?;
        let Some(glossary) = inflate_glossary(&compressed, MAX_GLOSSARY_BYTES)? else {
            return Ok(true);
        };
        if has_term_content(
            &glossary,
            &row.get::<_, String>(1).map_err(storage_error)?,
            &row.get::<_, String>(2).map_err(storage_error)?,
            &row.get::<_, String>(3).map_err(storage_error)?,
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn list_from_store(connection: &Connection) -> Result<Vec<DictionarySummary>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, revision, enabled, term_count, term_meta_count, kanji_count,
                    kanji_meta_count, has_frequency, has_pitch, has_definitions
               FROM dictionaries ORDER BY position, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(DictionarySummary {
                id: row.get(0)?,
                title: row.get(1)?,
                revision: row.get(2)?,
                enabled: row.get(3)?,
                term_count: row.get(4)?,
                term_meta_count: row.get(5)?,
                kanji_count: row.get(6)?,
                kanji_meta_count: row.get(7)?,
                has_frequency: row.get(8)?,
                has_pitch: row.get(9)?,
                has_definitions: row.get(10)?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<_, _>>().map_err(storage_error)
}

#[cfg(test)]
fn import_paths(connection: &mut Connection, paths: &[PathBuf]) -> Vec<DictionaryImportResult> {
    import_paths_with_progress(connection, paths, &mut BatchProgress::silent())
}

fn import_paths_with_progress(
    connection: &mut Connection,
    paths: &[PathBuf],
    progress: &mut BatchProgress,
) -> Vec<DictionaryImportResult> {
    progress.start(paths.len());
    paths
        .iter()
        .map(|path| {
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Selected file".into());
            let (status, title) = import_one(connection, path);
            let result = DictionaryImportResult {
                file_name,
                status,
                title,
            };
            progress.completed_one();
            result
        })
        .collect()
}

enum ImportError {
    Archive(DictionaryArchiveError),
    Storage(rusqlite::Error),
}

impl From<DictionaryArchiveError> for ImportError {
    fn from(error: DictionaryArchiveError) -> Self {
        Self::Archive(error)
    }
}

impl From<rusqlite::Error> for ImportError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}

pub(super) fn import_one(
    connection: &mut Connection,
    path: &Path,
) -> (ImportStatus, Option<String>) {
    let mut archive = match DictionaryArchive::open(path) {
        Ok(archive) => archive,
        Err(error) => return (archive_status(&error), None),
    };
    let title = archive.index().title.clone();
    let result = connection
        .transaction()
        .map_err(ImportError::from)
        .and_then(|transaction| {
            let status = write_dictionary(&transaction, &mut archive)?;
            transaction.commit()?;
            Ok(status)
        });
    // Dropping an uncommitted transaction rolls it back, so a failure leaves no rows.
    let status = match result {
        Ok(status) => status,
        Err(ImportError::Archive(error)) => {
            // cfg! keeps the error used in release builds without logging there.
            if cfg!(debug_assertions) {
                eprintln!("Komori dictionary import refused {title:?}: {error}");
            }
            archive_status(&error)
        }
        Err(ImportError::Storage(error)) => {
            if cfg!(debug_assertions) {
                eprintln!("Komori dictionary import failed for {title:?}: {error}");
            }
            ImportStatus::Failed
        }
    };
    (status, Some(title))
}

fn archive_status(error: &DictionaryArchiveError) -> ImportStatus {
    match error {
        DictionaryArchiveError::Unreadable | DictionaryArchiveError::UnreadableEntry { .. } => {
            ImportStatus::Unreadable
        }
        DictionaryArchiveError::NotArchive
        | DictionaryArchiveError::MissingIndex
        | DictionaryArchiveError::InvalidIndex
        | DictionaryArchiveError::UnsupportedFormat(_)
        | DictionaryArchiveError::EntryTooLarge { .. }
        | DictionaryArchiveError::InvalidBank { .. } => ImportStatus::Invalid,
    }
}

/// Writes the whole archive inside `transaction`, reading and checking one bank before writing
/// it, so at most one bank is in memory.
fn write_dictionary(
    transaction: &Transaction<'_>,
    archive: &mut DictionaryArchive,
) -> Result<ImportStatus, ImportError> {
    let index = archive.index();
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM dictionaries WHERE title = ?1 AND revision = ?2)",
        params![index.title, index.revision],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(ImportStatus::AlreadyImported);
    }
    // A new dictionary goes last in the reader's order.
    transaction.execute(
        "INSERT INTO dictionaries (title, revision, format, sequenced, author, url, description,
             attribution, source_language, target_language, frequency_mode, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM dictionaries))",
        params![
            index.title,
            index.revision,
            index.format,
            index.sequenced,
            index.author,
            index.url,
            index.description,
            index.attribution,
            index.source_language,
            index.target_language,
            index.frequency_mode.map(|mode| mode.as_str()),
        ],
    )?;
    let dictionary = transaction.last_insert_rowid();
    let mut counts = [0usize; 4];
    let mut has_definitions = false;

    let mut statement = transaction.prepare(
        "INSERT INTO terms (dictionary, expression, reading, definition_tags, rules, score,
             glossary, sequence, term_tags) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;
    for bank in 0..archive.bank_count(BankKind::Term) {
        let terms = archive.read_term_bank(bank)?;
        let glossaries = deflate_glossaries(&terms);
        for (term, glossary) in terms.iter().zip(&glossaries) {
            if !has_definitions {
                has_definitions = has_term_content(
                    term.glossary.get(),
                    &term.rules,
                    &term.definition_tags,
                    &term.term_tags,
                );
            }
            statement.execute(params![
                dictionary,
                term.expression,
                term.reading,
                term.definition_tags,
                term.rules,
                term.score,
                glossary,
                term.sequence,
                term.term_tags,
            ])?;
        }
        counts[0] += terms.len();
    }

    let (mut has_frequency, mut has_pitch) = (false, false);
    let mut statement = transaction.prepare(
        "INSERT INTO term_meta (dictionary, expression, mode, data) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for bank in 0..archive.bank_count(BankKind::TermMeta) {
        let meta = archive.read_term_meta_bank(bank)?;
        for entry in &meta {
            has_frequency |= entry.mode == TermMetaMode::Frequency;
            has_pitch |= entry.mode == TermMetaMode::Pitch;
            statement.execute(params![
                dictionary,
                entry.expression,
                entry.mode.as_str(),
                entry.data.get()
            ])?;
        }
        counts[1] += meta.len();
    }

    let mut statement = transaction.prepare(
        "INSERT INTO kanji (dictionary, character, onyomi, kunyomi, tags, meanings, stats)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for bank in 0..archive.bank_count(BankKind::Kanji) {
        let kanji = archive.read_kanji_bank(bank)?;
        for entry in &kanji {
            let meanings = serde_json::to_string(&entry.meanings)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            statement.execute(params![
                dictionary,
                entry.character,
                entry.onyomi,
                entry.kunyomi,
                entry.tags,
                meanings,
                entry.stats.get(),
            ])?;
        }
        counts[2] += kanji.len();
    }

    let mut statement = transaction
        .prepare("INSERT INTO kanji_meta (dictionary, character, data) VALUES (?1, ?2, ?3)")?;
    for bank in 0..archive.bank_count(BankKind::KanjiMeta) {
        let meta = archive.read_kanji_meta_bank(bank)?;
        for entry in &meta {
            statement.execute(params![dictionary, entry.character, entry.data.get()])?;
        }
        counts[3] += meta.len();
    }

    let mut statement = transaction.prepare(
        "INSERT INTO tags (dictionary, name, category, sort_order, notes, score)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for bank in 0..archive.bank_count(BankKind::Tag) {
        for tag in archive.read_tag_bank(bank)? {
            statement.execute(params![
                dictionary,
                tag.name,
                tag.category,
                tag.order,
                tag.notes,
                tag.score,
            ])?;
        }
    }
    for tag in &archive.index().tag_meta {
        statement.execute(params![
            dictionary,
            tag.name,
            tag.category,
            tag.order,
            tag.notes,
            tag.score,
        ])?;
    }

    transaction.execute(
        "UPDATE dictionaries
            SET term_count = ?2, term_meta_count = ?3, kanji_count = ?4, kanji_meta_count = ?5, has_definitions = ?6,
                has_frequency = ?7, has_pitch = ?8
          WHERE id = ?1",
        params![
            dictionary,
            counts[0],
            counts[1],
            counts[2],
            counts[3],
            has_definitions || counts[2] > 0,
            has_frequency || counts[3] > 0,
            has_pitch
        ],
    )?;
    Ok(ImportStatus::Imported)
}

/// Deflates a bank's glossaries at the default level, spread over the available cores:
/// compression dominates import time, and each glossary is compressed on its own.
fn deflate_glossaries(terms: &[TermEntry]) -> Vec<Vec<u8>> {
    let threads = std::thread::available_parallelism().map_or(1, |count| count.get());
    let chunk_size = terms.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = terms
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|term| deflate(term.glossary.get().as_bytes()))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}

fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    // Writing into a Vec cannot fail.
    let _ = encoder.write_all(bytes);
    encoder.finish().unwrap_or_default()
}

fn storage_error(error: rusqlite::Error) -> String {
    format!("Dictionary storage error: {error}")
}

#[cfg(test)]
fn lookup_longest_start_from_store(
    connection: &Connection,
    query: &str,
) -> Result<TermLookup, String> {
    lookup_longest_start_with_sources(connection, query, &SourcePolicy::default())
}
#[cfg(test)]
fn lookup_kanji_from_store(connection: &Connection, query: &str) -> Result<KanjiLookup, String> {
    lookup_kanji_with_sources(connection, query, &SourcePolicy::default())
}

#[cfg(test)]
fn lookup_filtered_from_store(
    connection: &Connection,
    query: &str,
    filter: TermFilter,
) -> Result<Vec<TermGroup>, String> {
    lookup_filtered_with_sources(connection, query, filter, &SourcePolicy::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::archive::tests::{fixture_entries, write_archive, INDEX};
    use flate2::read::DeflateDecoder;
    use sha2::{Digest, Sha256};
    use std::{io::Read, time::Instant};
    use tempfile::tempdir;

    #[test]
    fn bulk_progress_counts_refused_imports_and_automatically_reclaims_partial_removals() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let mut connection = open_store(&database).unwrap();
        let large = large_dictionary(directory.path());
        let kept = second_dictionary(directory.path());
        let invalid = directory.path().join("invalid.zip");
        std::fs::write(&invalid, "invalid").unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let results = import_paths_with_progress(
            &mut connection,
            &[large.clone(), invalid, large, kept],
            &mut progress,
        );
        assert_eq!(
            results.iter().map(|item| item.status).collect::<Vec<_>>(),
            [
                ImportStatus::Imported,
                ImportStatus::Invalid,
                ImportStatus::AlreadyImported,
                ImportStatus::Imported
            ]
        );
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| (event.completed, event.total))
                .collect::<Vec<_>>(),
            [
                (0, Some(4)),
                (1, Some(4)),
                (2, Some(4)),
                (3, Some(4)),
                (4, Some(4))
            ]
        );
        move_in_store(&mut connection, 2, 0).unwrap();
        let lookup = lookup_from_store(&connection, "読む").unwrap();
        let states = stored_states(&connection);
        connection.execute_batch("CREATE TRIGGER refuse BEFORE DELETE ON tags WHEN OLD.dictionary = 2 BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let batch =
            remove_and_reclaim(&mut connection, &database, &[1, 2, 99, 1], &mut progress, 0);
        assert_eq!(
            batch.results,
            [
                removal(1, RemovalStatus::Removed),
                removal(2, RemovalStatus::Failed),
                removal(99, RemovalStatus::NotFound),
                removal(1, RemovalStatus::NotFound)
            ]
        );
        let Some(CompactionResult::Compacted {
            size_before,
            size_after,
        }) = batch.maintenance
        else {
            panic!("automatic reclamation failed")
        };
        assert!(size_after < size_before);
        assert_eq!(pragma(&connection, "freelist_count"), 0);
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), lookup);
        assert_eq!(
            stored_states(&connection),
            states
                .into_iter()
                .filter(|row| row.0 != 1)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| event.completed)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4, 4]
        );
        drop(connection);
        assert_eq!(
            lookup_from_store(&open_store(&database).unwrap(), "読む").unwrap(),
            lookup
        );
    }

    #[test]
    fn automatic_reclamation_failure_keeps_deletions_and_surviving_lookups() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let mut connection = open_store(&database).unwrap();
        let large = large_dictionary(directory.path());
        let second = second_dictionary(directory.path());
        import_paths(&mut connection, &[large, second]);
        let survivor = only_from(&lookup_from_store(&connection, "読む").unwrap(), 2);
        let reader = open_store(&database).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM dictionaries;")
            .unwrap();
        connection
            .busy_timeout(std::time::Duration::from_millis(10))
            .unwrap();
        let batch = remove_and_reclaim(
            &mut connection,
            &database,
            &[1],
            &mut BatchProgress::silent(),
            0,
        );
        assert_eq!(batch.results, [removal(1, RemovalStatus::Removed)]);
        assert_eq!(batch.maintenance, Some(CompactionResult::Failed));
        assert_eq!(listed_ids(&connection), [2]);
        assert_eq!(
            only_from(&lookup_from_store(&connection, "読む").unwrap(), 2),
            survivor
        );
        drop(reader);
        assert!(matches!(
            compact_store(&connection, &database).unwrap(),
            CompactionResult::Compacted { .. }
        ));
    }

    #[test]
    fn unavailable_store_reports_every_requested_removal_without_maintenance() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        std::fs::write(&database, b"not a database").unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let batch = remove_at_path(&database, &[10, 30], &mut progress, 0);
        assert_eq!(
            batch.results,
            [
                removal(10, RemovalStatus::Failed),
                removal(30, RemovalStatus::Failed)
            ]
        );
        assert_eq!(batch.maintenance, None);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| event.completed)
                .collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(std::fs::read(database).unwrap(), b"not a database");
    }

    fn inflate(bytes: &[u8]) -> String {
        let mut text = String::new();
        DeflateDecoder::new(bytes)
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    fn fixture_with(directory: &Path, name: &str, entries: &[(&str, &str)]) -> PathBuf {
        let path = directory.join(name);
        write_archive(&path, entries);
        path
    }

    fn replaced(name: &'static str, contents: &'static str) -> Vec<(&'static str, &'static str)> {
        let mut entries: Vec<_> = fixture_entries()
            .into_iter()
            .filter(|(entry, _)| *entry != name)
            .collect();
        entries.push((name, contents));
        entries
    }

    fn row_counts(connection: &Connection) -> [i64; 6] {
        [
            "dictionaries",
            "terms",
            "term_meta",
            "kanji",
            "kanji_meta",
            "tags",
        ]
        .map(|table| {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
    }

    fn summary(id: i64, revision: &str) -> DictionarySummary {
        DictionarySummary {
            id,
            title: "Fixture".into(),
            revision: revision.into(),
            enabled: true,
            term_count: 5,
            term_meta_count: 4,
            kanji_count: 1,
            kanji_meta_count: 1,
            has_frequency: true,
            has_pitch: true,
            has_definitions: true,
        }
    }

    #[test]
    fn version_six_restores_disabled_sources_without_changing_data_or_role_choices() {
        use super::super::sources::SourceSelection::{All, None, Selected};
        let directory = tempdir().unwrap();
        let archive = fixture_with(directory.path(), "legacy.zip", &fixture_entries());
        let other = second_dictionary(directory.path());
        let database = directory.path().join(DATABASE_FILE_NAME);
        let hash = Sha256::digest(std::fs::read(&archive).unwrap());
        let mut connection = open_store(&database).unwrap();
        import_paths(&mut connection, &[archive.clone(), other]);
        move_in_store(&mut connection, 2, 0).unwrap();
        let expected = store_contents(&connection);
        // Capture every stored cell, including compressed glossaries and metadata.
        let data = |connection: &Connection| {
            ["terms", "term_meta", "kanji", "kanji_meta", "tags"].map(|table| {
                let mut statement = connection
                    .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                    .unwrap();
                let columns = statement.column_count();
                statement
                    .query_map([], |row| {
                        Ok((0..columns)
                            .map(|index| format!("{:?}", row.get_ref(index).unwrap()))
                            .collect::<Vec<_>>())
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
            })
        };
        let rows = data(&connection);
        set_enabled_in_store(&connection, 1, false).unwrap();
        set_enabled_in_store(&connection, 2, false).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 6;",
            )
            .unwrap();
        drop(connection);
        let connection = open_store(&database).unwrap();
        assert_eq!(pragma(&connection, "user_version"), SCHEMA_VERSION);
        assert_eq!(store_contents(&connection), expected);
        assert_eq!(data(&connection), rows);
        assert!(list_from_store(&connection)
            .unwrap()
            .iter()
            .all(|source| source.enabled));
        let policy = SourcePolicy {
            definitions: Selected { ids: vec![1, 99] },
            frequency: None,
            pitch: All,
        };
        let lookup = lookup_longest_start_with_sources(&connection, "読む", &policy).unwrap();
        assert!(lookup.groups[0]
            .terms
            .iter()
            .all(|term| term.dictionary_id == 1));
        assert!(lookup.groups[0].frequencies.is_empty());
        assert!(!lookup.groups[0].pitches.is_empty());
        for selection in [None, Selected { ids: vec![] }, Selected { ids: vec![99] }] {
            let policy = SourcePolicy {
                definitions: selection,
                frequency: All,
                pitch: All,
            };
            assert!(
                lookup_longest_start_with_sources(&connection, "読む", &policy)
                    .unwrap()
                    .groups
                    .is_empty()
            );
            assert!(lookup_kanji_with_sources(&connection, "本", &policy)
                .unwrap()
                .entries
                .is_empty());
        }
        drop(connection);
        let connection = open_store(&database).unwrap();
        assert_eq!(store_contents(&connection), expected);
        assert_eq!(data(&connection), rows);
        assert_eq!(Sha256::digest(std::fs::read(archive).unwrap()), hash);
    }

    #[test]
    fn source_roles_filter_before_matching_and_survive_dictionary_lifecycle() {
        use super::super::sources::SourceSelection::{All, None, Selected};
        let directory = tempdir().unwrap();
        let first = fixture_with(
            directory.path(),
            "first.zip",
            &replaced(
                "term_bank_10.json",
                r#"[["本語","ほんご","excluded","",0,["excluded long match"],4,""],["読んだ","よんだ","excluded","",0,["excluded exact match"],5,""]]"#,
            ),
        );
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &replaced(
                "index.json",
                r#"{"title":"Second","revision":"1","format":3}"#,
            ),
        );
        let database = directory.path().join("sources.sqlite3");
        let mut connection = open_store(&database).unwrap();
        import_paths(&mut connection, &[first, second.clone()]);
        let selected = |ids: Vec<i64>| Selected { ids };
        let mut policy = SourcePolicy {
            definitions: selected(vec![2]),
            frequency: selected(vec![1]),
            pitch: selected(vec![2]),
        };
        let lookup = lookup_longest_start_with_sources(&connection, "本語", &policy).unwrap();
        assert_eq!(lookup.text, "本");
        assert!(lookup
            .groups
            .iter()
            .flat_map(|g| &g.terms)
            .all(|t| t.dictionary_id == 2 && !t.definition_tags.contains("excluded")));
        let lookup = lookup_longest_start_with_sources(&connection, "読んだ", &policy).unwrap();
        assert_eq!(lookup.groups[0].expression, "読む");
        assert!(lookup.groups[0].deinflection.is_some());
        assert!(lookup.groups[0]
            .frequencies
            .iter()
            .all(|f| f.dictionary_id == 1));
        assert_eq!(lookup.groups[0].pitches[0].dictionary_id, 2);
        let kanji = lookup_kanji_with_sources(&connection, "本", &policy).unwrap();
        assert_eq!(kanji.entries[0].dictionary_id, 2);
        assert_eq!(kanji.frequencies[0].dictionary_id, 1);
        for empty in [None, selected(vec![]), selected(vec![999])] {
            policy.definitions = empty;
            assert!(
                lookup_longest_start_with_sources(&connection, "読んだ", &policy)
                    .unwrap()
                    .groups
                    .is_empty()
            );
            let kanji = lookup_kanji_with_sources(&connection, "本", &policy).unwrap();
            assert!(kanji.entries.is_empty());
            assert_eq!(kanji.frequencies.len(), 1);
        }
        policy.definitions = selected(vec![2]);
        for empty in [None, selected(vec![]), selected(vec![999])] {
            policy.frequency = empty.clone();
            policy.pitch = empty;
            let word = lookup_longest_start_with_sources(&connection, "読む", &policy).unwrap();
            assert!(!word.groups.is_empty());
            assert!(word
                .groups
                .iter()
                .all(|g| g.frequencies.is_empty() && g.pitches.is_empty()));
            assert!(lookup_kanji_with_sources(&connection, "本", &policy)
                .unwrap()
                .frequencies
                .is_empty());
        }
        policy = SourcePolicy::default();
        move_in_store(&mut connection, 2, 0).unwrap();
        let ids = |c: &Connection, p: &SourcePolicy| {
            lookup_longest_start_with_sources(c, "読む", p)
                .unwrap()
                .groups[0]
                .terms
                .iter()
                .map(|t| t.dictionary_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&connection, &policy), [2, 1]);
        policy.definitions = selected(vec![1, 2]);
        assert_eq!(ids(&connection, &policy), [2, 1]);
        set_enabled_in_store(&connection, 2, false).unwrap();
        assert_eq!(ids(&connection, &policy), [1]);
        set_enabled_in_store(&connection, 2, true).unwrap();
        assert_eq!(ids(&connection, &policy), [2, 1]);
        drop(connection);
        let mut connection = open_store(&database).unwrap();
        assert_eq!(ids(&connection, &policy), [2, 1]);
        remove_from_store(&mut connection, 2).unwrap();
        import_paths(&mut connection, &[second]);
        assert_eq!(ids(&connection, &policy), [1]);
        policy.definitions = All;
        assert_eq!(ids(&connection, &policy), [1, 3]);
    }

    #[test]
    fn kana_ranking_prefers_surface_and_usually_kana_for_plain_and_inflected_text() {
        let directory = tempdir().unwrap();
        let archive = fixture_with(
            directory.path(),
            "kana.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kana","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[
                ["歯","は","","",100,["tooth"],1,""],
                ["葉","は","","",90,["leaf"],2,""],
                ["は","は","","",0,["particle"],3,""],
                ["等","など","uk","",100,["etc"],4,""],
                ["抔","など","","",200,["rare"],5,""],
                ["など","など","","",0,["etc kana"],6,""],
                ["琴","こと","","",200,["koto"],7,""],
                ["事","こと","","",100,[{"type":"structured-content","content":{"tag":"span","data":{"code":"uk","content":"misc-info"},"content":"kana"}}],8,""],
                ["板","いた","","",200,["board"],9,""],
                ["射る","いる","","v1",100,["shoot"],10,""],
                ["居る","いる","uk","v1",90,["exist"],11,""],
                ["いる","いる","","v1",0,["exist kana"],12,""],
                ["為る","する","uk","vs",0,["do"],13,""],
                ["下","した","","",200,["below"],14,""],
                ["する","する","","vs",0,["do kana"],15,""]
            ]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        import_paths(&mut connection, &[archive]);
        let expressions = |query: &str, limit| {
            lookup_longest_start_limited(&connection, query, &SourcePolicy::default(), limit)
                .unwrap()
                .groups
                .into_iter()
                .map(|g| g.expression)
                .collect::<Vec<_>>()
        };
        assert_eq!(expressions("は", None), ["は", "歯", "葉"]);
        assert_eq!(expressions("など", None), ["など", "等", "抔"]);
        assert_eq!(expressions("こと", None), ["事", "琴"]);
        assert_eq!(expressions("いる", None), ["いる", "居る", "射る"]);
        assert_eq!(expressions("いた", None), ["いる", "居る", "板", "射る"]);
        assert_eq!(expressions("した", None), ["する", "為る", "下"]);
        assert_eq!(expressions("は", Some(1)), ["は"]);
        assert_eq!(expressions("いたよ", Some(1)), ["いる"]);
        assert_eq!(expressions("歯", None), ["歯"]);
        assert_eq!(expressions("射た", None), ["射る"]);
        assert_eq!(expressions("居た", None), ["居る"]);
        assert!(lookup_longest_start_limited(
            &connection,
            "いた",
            &SourcePolicy::default(),
            Some(1)
        )
        .unwrap()
        .groups[0]
            .deinflection
            .is_some());
        // A mention of uk/kana in prose is not a sense marker.
        assert!(!kana_marker(&serde_json::json!([
            "uk: word usually written using kana alone"
        ])));
    }

    /// Small budgets stand in for the real ones. A group of 1,000 rows is refused whole, never
    /// cut or reordered, and a group the result limit drops costs nothing.
    #[test]
    fn lookups_read_only_the_returned_glossaries_within_their_budgets() {
        let directory = tempdir().unwrap();
        let rows = std::iter::once(r#"["語","ご","","",100,["word"],1,""]"#.to_string())
            .chain(
                (0..1000)
                    .map(|n| format!(r#"["五","ご","","",{},["sense {n:04}"],{},""]"#, -n, n + 2)),
            )
            .collect::<Vec<_>>()
            .join(",");
        let bank = format!("[{rows}]");
        let archive = fixture_with(
            directory.path(),
            "many.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Many","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", &bank),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        import_paths(&mut connection, &[archive]);
        let lookup = |limit, lookup| {
            lookup_longest_start_bounded(
                &connection,
                "ご",
                &SourcePolicy::default(),
                limit,
                GlossaryLimits {
                    glossary: 64,
                    lookup,
                },
            )
        };
        // Each of the 1,000 glossaries reads back as 14 bytes.
        assert_eq!(lookup(None, 10_000).unwrap_err(), LOOKUP_TOO_LARGE);
        let first = lookup(Some(1), 10_000).unwrap();
        assert_eq!(first.groups.len(), 1);
        assert_eq!(
            first.groups[0].terms[0].glossary,
            serde_json::json!(["word"])
        );
        let all = lookup(None, 20_000).unwrap();
        assert_eq!(all.groups[1].expression, "五");
        let senses = all.groups[1]
            .terms
            .iter()
            .map(|term| term.glossary[0].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            senses,
            (0..1000)
                .map(|n| format!("sense {n:04}"))
                .collect::<Vec<_>>()
        );
        assert!(all
            .groups
            .iter()
            .flat_map(|group| &group.terms)
            .all(|term| term.stored.is_empty()));
    }

    #[test]
    fn an_oversized_glossary_or_kanji_row_is_refused_rather_than_read() {
        let directory = tempdir().unwrap();
        let long = "x".repeat(5_000);
        let terms = format!(
            r#"[["長","ちょう","","",0,["{long}"],1,""],["短","たん","","",0,["short"],2,""]]"#
        );
        let kanji = format!(
            r#"[["長","チョウ","なが","",["{long}"],{{}}],["短","タン","みじか","",["short"],{{}}]]"#
        );
        let archive = fixture_with(
            directory.path(),
            "large.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Large","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", &terms),
                ("kanji_bank_1.json", &kanji),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        import_paths(&mut connection, &[archive]);
        let limits = GlossaryLimits {
            glossary: 4_096,
            lookup: 1 << 20,
        };
        let sources = SourcePolicy::default();
        assert_eq!(
            lookup_longest_start_bounded(&connection, "長", &sources, Some(1), limits).unwrap_err(),
            GLOSSARY_TOO_LARGE
        );
        assert_eq!(
            lookup_kanji_bounded(&connection, "長", &sources, limits).unwrap_err(),
            GLOSSARY_TOO_LARGE
        );
        assert_eq!(
            lookup_longest_start_bounded(&connection, "短", &sources, None, limits)
                .unwrap()
                .groups[0]
                .terms[0]
                .glossary,
            serde_json::json!(["short"])
        );
        assert_eq!(
            lookup_kanji_bounded(&connection, "短", &sources, limits)
                .unwrap()
                .entries[0]
                .meanings,
            ["short"]
        );
        // Reading stops one byte past the limit; such a glossary is content, never an empty list.
        let stored = deflate(format!(r#"["{long}"]"#).as_bytes());
        assert_eq!(inflate_glossary(&stored, 4_096).unwrap(), None);
        assert!(inflate_glossary(&stored, 8_192).unwrap().is_some());
        assert!(has_term_content(
            &format!(r#"["{}"]"#, "x".repeat(MAX_GLOSSARY_BYTES)),
            "",
            "",
            ""
        ));
        assert!(!has_term_content("[]", "", "", ""));
    }

    #[test]
    fn empty_term_placeholders_have_only_their_metadata_roles_after_import_and_v5_migration() {
        let directory = tempdir().unwrap();
        let archive = fixture_with(
            directory.path(),
            "empty.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Frequency placeholders","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","","",0,[],1,""],["phantom","phantom","","",0,[],2,""]]"#,
                ),
                ("term_meta_bank_1.json", r#"[["読む","freq",3]]"#),
            ],
        );
        let forms = fixture_with(
            directory.path(),
            "forms.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Forms","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", r#"[["読む","よむ","","v5",0,[],1,""]]"#),
            ],
        );
        let database = directory.path().join(DATABASE_FILE_NAME);
        let mut connection = open_store(&database).unwrap();
        import_paths(&mut connection, &[archive, forms]);
        let expected = list_from_store(&connection).unwrap();
        assert!(
            !expected[0].has_definitions && expected[0].has_frequency && !expected[0].has_pitch
        );
        assert!(expected[1].has_definitions && !expected[1].has_frequency);
        assert_eq!(expected[0].term_count, 2);
        let lookup =
            lookup_longest_start_with_sources(&connection, "読む", &SourcePolicy::default())
                .unwrap();
        assert_eq!(lookup.groups[0].terms.len(), 1);
        assert_eq!(lookup.groups[0].terms[0].dictionary_id, 2);
        assert_eq!(lookup.groups[0].frequencies[0].dictionary_id, 1);
        assert!(lookup_longest_start_with_sources(
            &connection,
            "phantom",
            &SourcePolicy::default()
        )
        .unwrap()
        .groups
        .is_empty());
        let counts = row_counts(&connection);
        connection
            .execute_batch(
                "ALTER TABLE dictionaries DROP COLUMN has_definitions;
                 ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 5;",
            )
            .unwrap();
        drop(connection);
        let connection = open_store(&database).unwrap();
        assert_eq!(list_from_store(&connection).unwrap(), expected);
        assert_eq!(row_counts(&connection), counts);
        assert_eq!(
            lookup_longest_start_with_sources(&connection, "読む", &SourcePolicy::default())
                .unwrap(),
            lookup
        );
        drop(connection);
        assert_eq!(
            list_from_store(&open_store(&database).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn source_availability_distinguishes_metadata_modes_and_kanji_roles() {
        let directory = tempdir().unwrap();
        let archive = fixture_with(
            directory.path(),
            "freq.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Frequency only","revision":"1","format":3}"#,
                ),
                ("term_meta_bank_1.json", r#"[["読む","freq",1]]"#),
            ],
        );
        let pitch = fixture_with(
            directory.path(),
            "pitch.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Pitch only","revision":"1","format":3}"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","pitch",{"reading":"よむ","pitches":[{"position":0}]}]]"#,
                ),
            ],
        );
        let kanji = fixture_with(
            directory.path(),
            "kanji.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kanji only","revision":"1","format":3}"#,
                ),
                ("kanji_meta_bank_1.json", r#"[["本","freq",2]]"#),
            ],
        );
        let database = directory.path().join("sources.sqlite3");
        let mut connection = open_store(&database).unwrap();
        import_paths(&mut connection, &[archive, pitch, kanji]);
        let sources = list_from_store(&connection).unwrap();
        assert!(sources[0].has_frequency && !sources[0].has_pitch);
        assert!(!sources[1].has_frequency && sources[1].has_pitch);
        assert!(sources[2].has_frequency && !sources[2].has_pitch);
        assert!(sources
            .iter()
            .all(|s| s.term_count == 0 && s.kanji_count == 0));
        // The roles are stored at import, so listing reads them without walking metadata rows.
        let stored = |connection: &Connection| -> Vec<(bool, bool)> {
            connection
                .prepare("SELECT has_frequency, has_pitch FROM dictionaries ORDER BY id")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            stored(&connection),
            [(true, false), (false, true), (true, false)]
        );
        // A v7 store derives them once from its stored rows.
        let counts = row_counts(&connection);
        connection
            .execute_batch(
                "ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 7;",
            )
            .unwrap();
        drop(connection);
        let connection = open_store(&database).unwrap();
        assert_eq!(pragma(&connection, "user_version"), SCHEMA_VERSION);
        assert_eq!(list_from_store(&connection).unwrap(), sources);
        assert_eq!(row_counts(&connection), counts);
    }

    #[test]
    fn omitted_readings_join_the_first_supplied_reading_without_merging_variants() {
        use super::super::sources::SourceSelection::Selected;
        let directory = tempdir().unwrap();
        let plain = fixture_with(
            directory.path(),
            "plain.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Plain","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[
                ["状態","","n","",10,["condition"],1,""],
                ["状態","","n","",1,["state"],2,""],
                ["生","","n","",0,["life or raw"],3,""],
                ["よむ","","","",0,["read"],4,""],
                ["孤独","","n","",0,["alone"],5,""]
            ]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[
                ["状態","freq",{"reading":"じょうたい","frequency":7}],
                ["状態","freq",{"reading":"じゃうたい","frequency":9}],
                ["状態","pitch",{"reading":"じょうたい","pitches":[{"position":0}]}]
            ]"#,
                ),
            ],
        );
        let supplied = fixture_with(
            directory.path(),
            "supplied.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Supplied","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[
                ["状態","じょうたい","n","",10,["situation"],1,""],
                ["状態","じゃうたい","n","",0,["historical reading"],2,""],
                ["生","せい","n","",10,["life"],3,""],
                ["生","なま","n","",0,["raw"],4,""],
                ["よむ","ヨム","","",0,["read with supplied katakana"],5,""]
            ]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        import_paths(&mut connection, &[plain.clone(), supplied.clone()]);
        let before = store_contents(&connection);
        let archive_hashes =
            [&plain, &supplied].map(|path| Sha256::digest(std::fs::read(path).unwrap()));
        for query in ["状態", "じょうたい"] {
            let groups = lookup_from_store(&connection, query).unwrap();
            assert_eq!(groups.len(), if query == "状態" { 2 } else { 1 });
            assert_eq!(groups[0].reading, "じょうたい");
            assert_eq!(
                groups[0]
                    .terms
                    .iter()
                    .map(|term| (term.dictionary_id, term.score))
                    .collect::<Vec<_>>(),
                vec![(1, 10.0), (1, 1.0), (2, 10.0)]
            );
            assert_eq!(groups[0].frequencies.len(), 1);
            assert_eq!(groups[0].frequencies[0].data["frequency"], 7);
            assert_eq!(groups[0].pitches.len(), 1);
        }
        let historical = lookup_from_store(&connection, "じゃうたい").unwrap();
        assert_eq!(historical.len(), 1);
        assert_eq!(historical[0].terms.len(), 3);
        assert_eq!(historical[0].frequencies[0].data["frequency"], 9);
        assert!(historical[0].pitches.is_empty());
        let homographs = lookup_from_store(&connection, "生").unwrap();
        assert_eq!(
            homographs
                .iter()
                .map(|group| group.reading.as_str())
                .collect::<Vec<_>>(),
            vec!["せい", "なま"]
        );
        assert_eq!(homographs[0].terms.len(), 2);
        assert_eq!(homographs[1].terms.len(), 1);
        assert_eq!(lookup_from_store(&connection, "よむ").unwrap().len(), 2);
        assert_eq!(
            lookup_from_store(&connection, "孤独").unwrap()[0].reading,
            "孤独"
        );
        let plain_only = SourcePolicy {
            definitions: Selected { ids: vec![1] },
            ..Default::default()
        };
        assert_eq!(
            lookup_filtered_with_sources(&connection, "状態", TermFilter::All, &plain_only)
                .unwrap()[0]
                .reading,
            "状態"
        );
        assert!(lookup_filtered_with_sources(
            &connection,
            "じょうたい",
            TermFilter::All,
            &plain_only
        )
        .unwrap()
        .is_empty());
        assert!(
            lookup_classes_from_store(&connection, "じょうたい", Some(VS))
                .unwrap()
                .is_empty()
        );
        set_enabled_in_store(&connection, 2, false).unwrap();
        assert!(lookup_from_store(&connection, "じょうたい")
            .unwrap()
            .is_empty());
        set_enabled_in_store(&connection, 2, true).unwrap();
        assert_eq!(store_contents(&connection), before);
        assert_eq!(
            [&plain, &supplied].map(|path| Sha256::digest(std::fs::read(path).unwrap())),
            archive_hashes
        );
        assert_eq!(
            lookup_longest_start_from_store(&connection, "状態です")
                .unwrap()
                .groups[0]
                .terms
                .len(),
            3
        );
    }

    #[test]
    fn exact_lookup_groups_imported_terms_and_metadata_in_order() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Second","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","rule",99,["second high"],5,"tag"],["読む","よむ","v5","rule",2,["second low"],6,"tag"]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",{"reading":"よむ","frequency":3}],["読む","freq",{"reading":"other","frequency":4}],["読む","pitch",{"reading":"other","pitches":[{"position":2}]}],["読む","pitch",{"reading":"よむ","pitches":[{"position":0}]}]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        assert_eq!(
            import_one(&mut connection, &first).0,
            ImportStatus::Imported
        );
        assert_eq!(
            import_one(&mut connection, &second).0,
            ImportStatus::Imported
        );

        let by_expression = lookup_from_store(&connection, "読む").unwrap();
        assert_eq!(by_expression.len(), 1);
        let group = &by_expression[0];
        assert_eq!(
            (&group.expression[..], &group.reading[..]),
            ("読む", "よむ")
        );
        assert_eq!(
            group
                .terms
                .iter()
                .map(|term| (term.dictionary_id, term.score))
                .collect::<Vec<_>>(),
            vec![(1, 10.0), (2, 99.0), (2, 2.0)]
        );
        assert_eq!(group.terms[0].glossary, serde_json::json!(["to read"]));
        assert_eq!(group.terms[1].rules, "rule");
        assert_eq!(group.terms[1].term_tags, "tag");
        assert_eq!(
            group
                .frequencies
                .iter()
                .map(|item| item.dictionary_id)
                .collect::<Vec<_>>(),
            vec![1, 1, 2]
        );
        assert_eq!(
            group.frequencies[2].data,
            serde_json::json!({"reading":"よむ","frequency":3})
        );
        assert_eq!(group.pitches.len(), 2);
        assert_eq!(group.pitches[0].dictionary_id, 1);
        assert_eq!(group.pitches[0].dictionary_title, "Fixture");
        assert_eq!(group.pitches[1].dictionary_id, 2);
        assert_eq!(group.pitches[1].dictionary_title, "Second");
        assert_eq!(
            group.pitches[0].data,
            serde_json::json!({"reading":"よむ","pitches":[{"position":1}]})
        );
        assert_eq!(
            serde_json::to_value(group).unwrap()["pitches"],
            serde_json::json!([
                {
                    "dictionaryId": 1,
                    "dictionaryTitle": "Fixture",
                    "data": {"reading":"よむ","pitches":[{"position":1}]}
                },
                {
                    "dictionaryId": 2,
                    "dictionaryTitle": "Second",
                    "data": {"reading":"よむ","pitches":[{"position":0}]}
                }
            ])
        );

        let by_reading = lookup_from_store(&connection, "よむ").unwrap();
        assert_eq!(by_reading.len(), 3);
        assert_eq!(by_reading[0].expression, "よむ");
        assert_eq!(by_reading[1].expression, "読む");
        assert_eq!(by_reading[2].expression, "詠む");
        assert!(by_reading[0].pitches.is_empty());
        assert!(by_reading[2].pitches.is_empty());
        assert_eq!(
            lookup_from_store(&connection, "missing").unwrap(),
            Vec::<TermGroup>::new()
        );
        assert!(lookup_from_store(&connection, &"あ".repeat(MAX_QUERY_CHARS + 1)).is_err());
    }

    #[test]
    fn a_query_without_an_exact_match_looks_up_its_longest_matching_start() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let long_start = "か".repeat(MAX_SCANNED_START_CHARS);
        let too_long_start = "き".repeat(MAX_SCANNED_START_CHARS + 1);
        let scan_terms = format!(
            r#"[["読書","どくしょ","n","",0,["reading"],1,""],
                ["読","よみ","n","",0,["reading (short)"],2,""],
                ["𠮟","しつ","n","",0,["scolding"],3,""],
                ["𠮟る","しかる","v5","v5",0,["to scold"],4,""],
                ["{long_start}","","n","",0,["long"],5,""],
                ["{too_long_start}","","n","",0,["too long"],6,""]]"#
        );
        let scan = fixture_with(
            directory.path(),
            "scan.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Scan","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", &scan_terms),
                ("term_meta_bank_1.json", r#"[["読書","freq",42]]"#),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["本棚","ほんだな","n","",0,["bookshelf"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&first, &scan, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 3, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let matched = |text: &str| TermLookup {
            text: text.into(),
            groups: lookup_from_store(&connection, text).unwrap(),
        };

        // An exact match returns exactly the exact lookup, by expression or by reading.
        for query in ["読む", "よむ", "本", " 読書 "] {
            let expected = matched(query.trim());
            assert!(!expected.groups.is_empty());
            assert_eq!(lookup(query), expected);
        }
        // A longer query returns its longest matching start, with its metadata.
        let longer = lookup("読書する");
        assert_eq!(longer, matched("読書"));
        assert_eq!(longer.groups.len(), 1);
        assert_eq!(longer.groups[0].frequencies[0].data, serde_json::json!(42));
        assert_eq!(lookup("読むのが好き"), matched("読む"));
        assert_eq!(lookup("よむよむ"), matched("よむ"));
        assert_eq!(lookup("読の"), matched("読"));
        // A start matched only by a turned-off dictionary is skipped.
        assert_eq!(lookup("本棚です"), matched("本"));
        // Starts end on character boundaries, supplementary-plane characters included.
        assert_eq!(lookup("𠮟の"), matched("𠮟"));
        assert_eq!(lookup("𠮟るの"), matched("𠮟る"));
        // No start matching returns the query with no groups.
        let none = TermLookup {
            text: "xyz 読".into(),
            groups: Vec::new(),
        };
        assert_eq!(lookup("xyz 読"), none);
        // Starts longer than the bound are not tried; an exact match of any length still is.
        let beyond = format!("{long_start}x");
        assert_eq!(lookup(&beyond), matched(&long_start));
        let beyond_too_long = format!("{too_long_start}x");
        assert_eq!(
            lookup(&beyond_too_long),
            TermLookup {
                text: beyond_too_long.clone(),
                groups: Vec::new(),
            }
        );
        assert_eq!(lookup(&too_long_start), matched(&too_long_start));
        // Existing query bounds apply; an empty query matches nothing.
        assert_eq!(
            lookup("  "),
            TermLookup {
                text: String::new(),
                groups: Vec::new(),
            }
        );
        assert!(
            lookup_longest_start_from_store(&connection, &"あ".repeat(MAX_QUERY_CHARS + 1))
                .is_err()
        );
        assert_eq!(
            serde_json::to_value(lookup("読書する")).unwrap(),
            serde_json::json!({
                "text": "読書",
                "groups": serde_json::to_value(lookup_from_store(&connection, "読書").unwrap()).unwrap(),
            })
        );
        // Turning the dictionary back on makes its longer start the longest match.
        assert_eq!(
            set_enabled_in_store(&connection, 3, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            winning_start(lookup_longest_start_from_store(&connection, "本棚です").unwrap()).text,
            "本棚"
        );
    }

    /// `lookup` with only its longest matching start's groups, without the start each names, as
    /// the lookups before shorter starts were listed returned it.
    fn winning_start(mut lookup: TermLookup) -> TermLookup {
        lookup.groups.retain(|group| group.text == lookup.text);
        for group in &mut lookup.groups {
            group.text.clear();
        }
        lookup
    }

    /// `groups` as reached by deinflecting to `form` with `inflections`.
    fn as_form(mut groups: Vec<TermGroup>, form: &str, inflections: &[&str]) -> Vec<TermGroup> {
        for group in &mut groups {
            group.deinflection = Some(Deinflection {
                form: form.into(),
                inflections: inflections.iter().map(|&name| name.into()).collect(),
            });
        }
        groups
    }

    #[test]
    fn an_inflected_query_looks_up_its_dictionary_form() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let inflect = fixture_with(
            directory.path(),
            "inflect.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Inflect","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["高い","たかい","adj-i","adj-i",0,["high"],1,""],
                        ["食べる","たべる","v1","v1 vt",0,["to eat"],2,""],
                        ["来る","くる","vk","vk",0,["to come"],3,""],
                        ["勉強","べんきょう","n","vs",0,["study"],4,""],
                        ["勉強する","べんきょうする","vs","vs",0,["to study"],5,""],
                        ["書く","かく","v1","v1",0,["wrong class"],6,""],
                        ["余務","よむ","n","n",0,["spare duty"],7,""],
                        ["読","よみ","n","",0,["reading (short)"],8,""],
                        ["北","きた","n","",0,["north"],9,""],
                        ["書いた本","","n","",0,["a written book"],10,""],
                        ["𠮟る","しかる","v5","v5",0,["to scold"],11,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["高い","freq",5],["高い","pitch",{"reading":"たかい","pitches":[{"position":2}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["泳ぐ","およぐ","v5","v5",0,["to swim"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&first, &inflect, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 3, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let deinflected = |text: &str, form: &str, classes: u32, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_classes_from_store(&connection, form, Some(classes)).unwrap(),
                form,
                inflections,
            ),
        };
        let nothing = |text: &str| TermLookup {
            text: text.into(),
            groups: Vec::new(),
        };
        use super::super::deinflect::{ADJ_I, V1, V5, VK};

        // Each supported ending reaches its dictionary form, with its metadata.
        let past = lookup("読んだ");
        assert_eq!(past, deinflected("読んだ", "読む", V5, &["past"]));
        assert_eq!(
            past.groups,
            as_form(
                lookup_from_store(&connection, "読む").unwrap(),
                "読む",
                &["past"]
            )
        );
        assert_eq!(past.groups[0].frequencies.len(), 2);
        assert_eq!(past.groups[0].pitches.len(), 1);
        for (query, form, classes, inflections) in [
            ("読みます", "読む", V5, &["polite"][..]),
            ("読みました", "読む", V5, &["polite", "past"]),
            (
                "読みませんでした",
                "読む",
                V5,
                &["polite", "negative", "past"],
            ),
            ("読まない", "読む", V5, &["negative"]),
            ("読まなかった", "読む", V5, &["negative", "past"]),
            ("読んで", "読む", V5, &["-te"]),
            ("食べた", "食べる", V1, &["past"]),
            ("食べない", "食べる", V1, &["negative"]),
            ("食べて", "食べる", V1, &["-te"]),
            ("来ました", "来る", VK, &["polite", "past"]),
            ("こない", "くる", VK, &["negative"]),
            ("高かった", "高い", ADJ_I, &["past"]),
            ("高くない", "高い", ADJ_I, &["negative"]),
            ("高くて", "高い", ADJ_I, &["-te"]),
            ("高くなかった", "高い", ADJ_I, &["negative", "past"]),
            ("𠮟った", "𠮟る", V5, &["past"]),
        ] {
            let result = lookup(query);
            assert_eq!(
                result,
                deinflected(query, form, classes, inflections),
                "{query}"
            );
            assert!(!result.groups.is_empty(), "{query}");
        }
        assert_eq!(
            lookup("高かった").groups[0].frequencies[0].data,
            serde_json::json!(5)
        );
        assert_eq!(lookup("高かった").groups[0].pitches.len(), 1);
        // Only terms whose rules name the form's class match: 余務 (a noun read よむ) is left
        // out, and 書く, stored as v1, is refused for the godan 書いた.
        let reading = lookup("よんだ");
        assert_eq!(reading, deinflected("よんだ", "よむ", V5, &["past"]));
        assert!(reading
            .groups
            .iter()
            .all(|group| group.expression != "余務"));
        assert_eq!(reading.groups.len(), 3);
        assert!(lookup_from_store(&connection, "よむ")
            .unwrap()
            .iter()
            .any(|group| group.expression == "余務"));
        assert_eq!(lookup("書いた"), nothing("書いた"));
        // An exact match is unchanged and comes before a deinflected one of the same length.
        let exact = lookup("読む");
        assert_eq!(
            exact.groups,
            lookup_from_store(&connection, "読む").unwrap()
        );
        assert!(exact
            .groups
            .iter()
            .all(|group| group.deinflection.is_none()));
        let kita = lookup("きた");
        assert_eq!(kita.text, "きた");
        assert_eq!(kita.groups[0].expression, "北");
        assert_eq!(kita.groups[0].deinflection, None);
        assert_eq!(kita.groups[1].expression, "来る");
        assert!(kita.groups[1].deinflection.is_some());
        // The longest start wins, exact or deinflected.
        assert_eq!(
            lookup("読んでみる"),
            deinflected("読んで", "読む", V5, &["-te"])
        );
        assert_eq!(
            lookup("高かったです"),
            deinflected("高かった", "高い", ADJ_I, &["past"])
        );
        let longer_exact = lookup("書いた本です");
        assert_eq!(longer_exact.text, "書いた本");
        assert_eq!(
            longer_exact.groups,
            lookup_from_store(&connection, "書いた本").unwrap()
        );
        // A form matched only by a turned-off dictionary is skipped until it is turned back on.
        assert_eq!(lookup("泳いだ"), nothing("泳いだ"));
        // Chains are bounded: six steps are followed, seven are not, so the longest start
        // within six steps matches (here as the adverbial く).
        assert_eq!(
            lookup("高くなくなくなくなくなくない"),
            deinflected(
                "高くなくなくなくなくなくない",
                "高い",
                ADJ_I,
                &["negative"; 6]
            )
        );
        assert_eq!(
            lookup("高くなくなくなくなくなくなくない"),
            deinflected(
                "高くなくなくなくなくなく",
                "高い",
                ADJ_I,
                &[
                    "negative",
                    "negative",
                    "negative",
                    "negative",
                    "negative",
                    "adverbial"
                ]
            )
        );
        assert_eq!(
            serde_json::to_value(lookup("読んだ")).unwrap(),
            serde_json::json!({
                "text": "読んだ",
                "groups": serde_json::to_value(as_form(
                    lookup_from_store(&connection, "読む").unwrap(),
                    "読む",
                    &["past"],
                ))
                .unwrap(),
            })
        );
        assert_eq!(
            set_enabled_in_store(&connection, 3, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            winning_start(lookup_longest_start_from_store(&connection, "泳いだ").unwrap()),
            deinflected("泳いだ", "泳ぐ", V5, &["past"])
        );
    }

    #[test]
    fn a_suru_verb_candidate_also_looks_up_its_noun() {
        let directory = tempdir().unwrap();
        let nouns = fixture_with(
            directory.path(),
            "nouns.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Nouns","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["勉強","べんきょう","n vs vt","",0,["study"],1,""],
                        ["研究","けんきゅう","n","vs",0,["research"],2,""],
                        ["研究する","けんきゅうする","vs","vs",0,["to research"],3,""],
                        ["散歩","さんぽ","n vs-s","",0,["walk (no vs)"],4,""],
                        ["する","","vs","vs",0,["to do"],5,""],
                        ["勉強","べんきょう","n","",0,["study (no vs)"],6,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["勉強","freq",11],["勉強","pitch",{"reading":"べんきょう","pitches":[{"position":0}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["勉強","べんきょう","n vs","",0,["study (off)"],1,""],
                        ["料理","りょうり","n vs vt","",0,["cooking"],2,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&nouns, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let as_noun = |text: &str, noun: &str, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_filtered_from_store(&connection, noun, TermFilter::SuruNoun).unwrap(),
                noun,
                inflections,
            ),
        };

        // Each supported ending of a する verb reaches the noun stored without する, as that
        // noun, with its metadata: 勉強 as JMdict stores it, with no rules and vs among its
        // part-of-speech tags.
        for (query, inflections) in [
            ("勉強して", &["-te"][..]),
            ("勉強した", &["past"]),
            ("勉強します", &["polite"]),
            ("勉強しました", &["polite", "past"]),
            ("勉強しません", &["polite", "negative"]),
            ("勉強しませんでした", &["polite", "negative", "past"]),
            ("勉強しましょう", &["polite", "volitional"]),
            ("勉強しまして", &["polite", "-te"]),
            ("勉強しない", &["negative"]),
            ("勉強しなかった", &["negative", "past"]),
            ("べんきょうして", &["-te"]),
        ] {
            let form = if query.starts_with('べ') {
                "べんきょう"
            } else {
                "勉強"
            };
            let result = lookup(query);
            assert_eq!(result, as_noun(query, form, inflections), "{query}");
            assert_eq!(result.groups.len(), 1, "{query}");
        }
        let shite = lookup("勉強して");
        assert_eq!(shite.groups[0].expression, "勉強");
        // Only its terms that name vs are kept.
        assert_eq!(shite.groups[0].terms.len(), 1);
        assert_eq!(shite.groups[0].terms[0].definition_tags, "n vs vt");
        assert_eq!(shite.groups[0].frequencies[0].data, serde_json::json!(11));
        assert_eq!(shite.groups[0].pitches.len(), 1);
        // Within the step bound: six steps are followed, seven are not (the longest start
        // within six steps matches, here as the adverbial く).
        assert_eq!(
            lookup("勉強しなくなくなくなくなくない"),
            as_noun("勉強しなくなくなくなくなくない", "勉強", &["negative"; 6])
        );
        assert_eq!(
            lookup("勉強しなくなくなくなくなくなくない"),
            as_noun(
                "勉強しなくなくなくなくなく",
                "勉強",
                &[
                    "negative",
                    "negative",
                    "negative",
                    "negative",
                    "negative",
                    "adverbial"
                ]
            )
        );
        // A term stored with する keeps matching, then the bare noun (here naming vs in its
        // rules), each listed once.
        let research = lookup("研究して");
        assert_eq!(
            research
                .groups
                .iter()
                .map(|group| (
                    group.expression.as_str(),
                    group.deinflection.as_ref().unwrap().form.as_str()
                ))
                .collect::<Vec<_>>(),
            [("研究する", "研究する"), ("研究", "研究")]
        );
        let mut expected = as_noun("研究して", "研究する", &["-te"]);
        expected
            .groups
            .extend(as_noun("研究して", "研究", &["-te"]).groups);
        assert_eq!(research, expected);
        // An exact match of the whole start is unchanged: 研究する stays its stored term alone,
        // and 勉強する, stored without する, still matches its start 勉強 exactly.
        assert_eq!(
            lookup("研究する").groups,
            lookup_from_store(&connection, "研究する").unwrap()
        );
        let dictionary_form = lookup("勉強する");
        assert_eq!(dictionary_form.text, "勉強");
        assert_eq!(
            dictionary_form.groups,
            lookup_from_store(&connection, "勉強").unwrap()
        );
        // A noun naming vs in neither its rules nor its definition tags (vs-s is another name)
        // is refused; only its start matches, exactly.
        let walk = lookup("散歩して");
        assert_eq!(walk.text, "散歩");
        assert!(walk.groups.iter().all(|group| group.deinflection.is_none()));
        // する itself has no stem to look up.
        assert_eq!(lookup("して"), as_noun("して", "する", &["-te"]));
        // A turned-off dictionary is skipped: its 勉強 term is left out, and 料理 is not found.
        assert!(shite.groups[0]
            .terms
            .iter()
            .all(|term| term.dictionary_id == 1));
        assert!(lookup("料理して").groups.is_empty());
        assert_eq!(
            serde_json::to_value(&shite).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({"form": "勉強", "inflections": ["-te"]})
        );
        // Turned back on, its terms join the same group, which is still listed once.
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        let both = lookup("勉強して");
        assert_eq!(both, as_noun("勉強して", "勉強", &["-te"]));
        assert_eq!(both.groups.len(), 1);
        assert_eq!(
            both.groups[0]
                .terms
                .iter()
                .map(|term| term.dictionary_id)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(lookup("料理して"), as_noun("料理して", "料理", &["-te"]));
    }

    #[test]
    fn a_progressive_form_looks_up_its_dictionary_form() {
        let directory = tempdir().unwrap();
        let verbs = fixture_with(
            directory.path(),
            "verbs.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Verbs","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",0,["to read"],1,""],
                        ["食べる","たべる","v1","v1",0,["to eat"],2,""],
                        ["来る","くる","vk","vk",0,["to come"],3,""],
                        ["する","","vs","vs",0,["to do"],4,""],
                        ["勉強","べんきょう","n vs vt","",0,["study"],5,""],
                        ["着る","きる","v1","v1",0,["to wear"],6,""],
                        ["捨てる","すてる","v1","v1",0,["to throw away"],7,""],
                        ["居る","いる","v1","v1",0,["to be"],8,""],
                        ["出る","でる","v1","v1",0,["to leave"],9,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",3],["読む","pitch",{"reading":"よむ","pitches":[{"position":1}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["泳ぐ","およぐ","v5","v5",0,["to swim"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&verbs, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let deinflected = |text: &str, form: &str, classes: u32, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_classes_from_store(&connection, form, Some(classes)).unwrap(),
                form,
                inflections,
            ),
        };
        let as_noun = |text: &str, noun: &str, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_filtered_from_store(&connection, noun, TermFilter::SuruNoun).unwrap(),
                noun,
                inflections,
            ),
        };
        use super::super::deinflect::{V1, V5, VK, VS};

        // Each ending, and its chains through the polite, past, and negative rules, reaches a
        // godan, ichidan, 来る, or する verb's dictionary form through its て form.
        for (query, form, classes, inflections) in [
            ("読んでいる", "読む", V5, &["-te", "progressive"][..]),
            ("読んでる", "読む", V5, &["-te", "progressive"]),
            ("読んでいた", "読む", V5, &["-te", "progressive", "past"]),
            ("読んでた", "読む", V5, &["-te", "progressive", "past"]),
            (
                "読んでいます",
                "読む",
                V5,
                &["-te", "progressive", "polite"],
            ),
            (
                "読んでいない",
                "読む",
                V5,
                &["-te", "progressive", "negative"],
            ),
            (
                "読んでいました",
                "読む",
                V5,
                &["-te", "progressive", "polite", "past"],
            ),
            ("食べている", "食べる", V1, &["-te", "progressive"]),
            ("食べてる", "食べる", V1, &["-te", "progressive"]),
            (
                "食べています",
                "食べる",
                V1,
                &["-te", "progressive", "polite"],
            ),
            ("捨てている", "捨てる", V1, &["-te", "progressive"]),
            ("来ている", "来る", VK, &["-te", "progressive"]),
            ("来てた", "来る", VK, &["-te", "progressive", "past"]),
            ("している", "する", VS, &["-te", "progressive"]),
            ("よんでいる", "よむ", V5, &["-te", "progressive"]),
        ] {
            let result = lookup(query);
            assert_eq!(
                result,
                deinflected(query, form, classes, inflections),
                "{query}"
            );
            assert_eq!(result.groups.len(), 1, "{query}");
        }
        let reading = lookup("読んでいる");
        assert_eq!(reading.groups[0].frequencies[0].data, serde_json::json!(3));
        assert_eq!(reading.groups[0].pitches.len(), 1);
        assert_eq!(
            serde_json::to_value(&reading).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({"form": "読む", "inflections": ["-te", "progressive"]})
        );
        // A する-noun is reached through its する verb, as in Task 0104.
        for (query, inflections) in [
            ("勉強している", &["-te", "progressive"][..]),
            ("勉強してる", &["-te", "progressive"]),
            ("勉強しています", &["-te", "progressive", "polite"]),
            (
                "勉強していました",
                &["-te", "progressive", "polite", "past"],
            ),
        ] {
            assert_eq!(
                lookup(query),
                as_noun(query, "勉強", inflections),
                "{query}"
            );
        }
        // Every form, in candidate order: きている is 来る's and the ichidan 着る's.
        let kiteiru = lookup("きている");
        assert_eq!(
            kiteiru
                .groups
                .iter()
                .map(|group| (
                    group.expression.as_str(),
                    group.deinflection.as_ref().unwrap().form.as_str()
                ))
                .collect::<Vec<_>>(),
            [("来る", "くる"), ("着る", "きる")]
        );
        let mut expected = deinflected("きている", "くる", VK, &["-te", "progressive"]);
        expected
            .groups
            .extend(deinflected("きている", "きる", V1, &["-te", "progressive"]).groups);
        assert_eq!(kiteiru, expected);
        // A longer query keeps its longest start; five and six steps are followed, seven are
        // not, so the longest start of 読んでいていませんでした is 読んでいていません.
        assert_eq!(
            lookup("読んでいるよ"),
            deinflected("読んでいる", "読む", V5, &["-te", "progressive"])
        );
        assert_eq!(
            lookup("読んでいませんでした"),
            deinflected(
                "読んでいませんでした",
                "読む",
                V5,
                &["-te", "progressive", "polite", "negative", "past"]
            )
        );
        assert_eq!(
            lookup("読んでいていませんでした"),
            deinflected(
                "読んでいていません",
                "読む",
                V5,
                &[
                    "-te",
                    "progressive",
                    "-te",
                    "progressive",
                    "polite",
                    "negative"
                ]
            )
        );
        // Exact matches are unchanged: an ichidan verb ending in てる or でる, and いる itself.
        for query in ["捨てる", "出る", "でる", "居る", "いる"] {
            let exact = lookup(query);
            assert_eq!(exact.text, query);
            assert_eq!(
                exact.groups,
                lookup_from_store(&connection, query).unwrap(),
                "{query}"
            );
        }
        // A form matched only by a turned-off dictionary is skipped until it is turned back on.
        assert_eq!(
            lookup("泳いでいる"),
            TermLookup {
                text: "泳いでいる".into(),
                groups: Vec::new(),
            }
        );
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            winning_start(lookup_longest_start_from_store(&connection, "泳いでいる").unwrap()),
            deinflected("泳いでいる", "泳ぐ", V5, &["-te", "progressive"])
        );
    }

    #[test]
    fn a_completive_form_looks_up_its_dictionary_form() {
        let directory = tempdir().unwrap();
        let verbs = fixture_with(
            directory.path(),
            "verbs.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Verbs","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",0,["to read"],1,""],
                        ["食べる","たべる","v1","v1",0,["to eat"],2,""],
                        ["来る","くる","vk","vk",0,["to come"],3,""],
                        ["する","","vs","vs",0,["to do"],4,""],
                        ["勉強","べんきょう","n vs vt","",0,["study"],5,""],
                        ["着る","きる","v1","v1",0,["to wear"],6,""],
                        ["行く","いく","v5","v5",0,["to go"],7,""],
                        ["忘れる","わすれる","v1","v1",0,["to forget"],8,""],
                        ["仕舞う","しまう","v5","v5",0,["to finish"],9,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",3],["読む","pitch",{"reading":"よむ","pitches":[{"position":1}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["泳ぐ","およぐ","v5","v5",0,["to swim"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&verbs, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let deinflected = |text: &str, form: &str, classes: u32, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_classes_from_store(&connection, form, Some(classes)).unwrap(),
                form,
                inflections,
            ),
        };
        let as_noun = |text: &str, noun: &str, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_filtered_from_store(&connection, noun, TermFilter::SuruNoun).unwrap(),
                noun,
                inflections,
            ),
        };
        use super::super::deinflect::{V1, V5, VK, VS};

        // Each ending, and its chains through the past, polite, and negative rules, reaches a
        // godan, ichidan, 来る, or する verb's dictionary form: てしまう through its て form, the
        // contracted ちゃう/じゃう directly.
        for (query, form, classes, inflections) in [
            ("読んでしまう", "読む", V5, &["-te", "completive"][..]),
            ("読んでしまった", "読む", V5, &["-te", "completive", "past"]),
            (
                "読んでしまいます",
                "読む",
                V5,
                &["-te", "completive", "polite"],
            ),
            (
                "読んでしまわない",
                "読む",
                V5,
                &["-te", "completive", "negative"],
            ),
            (
                "読んでしまいました",
                "読む",
                V5,
                &["-te", "completive", "polite", "past"],
            ),
            ("読んじゃう", "読む", V5, &["completive"]),
            ("読んじゃった", "読む", V5, &["completive", "past"]),
            ("食べてしまう", "食べる", V1, &["-te", "completive"]),
            ("食べちゃう", "食べる", V1, &["completive"]),
            ("食べちゃった", "食べる", V1, &["completive", "past"]),
            ("忘れちゃった", "忘れる", V1, &["completive", "past"]),
            ("行っちゃう", "行く", V5, &["completive"]),
            ("行ってしまった", "行く", V5, &["-te", "completive", "past"]),
            ("来てしまった", "来る", VK, &["-te", "completive", "past"]),
            ("来ちゃった", "来る", VK, &["completive", "past"]),
            ("してしまう", "する", VS, &["-te", "completive"]),
            ("しちゃった", "する", VS, &["completive", "past"]),
            ("よんでしまった", "よむ", V5, &["-te", "completive", "past"]),
        ] {
            let result = lookup(query);
            assert_eq!(
                result,
                deinflected(query, form, classes, inflections),
                "{query}"
            );
            assert_eq!(result.groups.len(), 1, "{query}");
        }
        let reading = lookup("読んでしまった");
        assert_eq!(reading.groups[0].frequencies[0].data, serde_json::json!(3));
        assert_eq!(reading.groups[0].pitches.len(), 1);
        assert_eq!(
            serde_json::to_value(&reading).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({"form": "読む", "inflections": ["-te", "completive", "past"]})
        );
        // A する-noun is reached through its する verb, as in Task 0104.
        for (query, inflections) in [
            ("勉強してしまう", &["-te", "completive"][..]),
            ("勉強してしまった", &["-te", "completive", "past"]),
            (
                "勉強してしまいました",
                &["-te", "completive", "polite", "past"],
            ),
            ("勉強しちゃう", &["completive"]),
            ("勉強しちゃった", &["completive", "past"]),
        ] {
            assert_eq!(
                lookup(query),
                as_noun(query, "勉強", inflections),
                "{query}"
            );
        }
        // Every form, in candidate order: きちゃう is 来る's and the ichidan 着る's.
        let kichau = lookup("きちゃう");
        let mut expected = deinflected("きちゃう", "くる", VK, &["completive"]);
        expected
            .groups
            .extend(deinflected("きちゃう", "きる", V1, &["completive"]).groups);
        assert_eq!(
            kichau
                .groups
                .iter()
                .map(|group| group.expression.as_str())
                .collect::<Vec<_>>(),
            ["来る", "着る"]
        );
        assert_eq!(kichau, expected);
        // A longer query keeps its longest start; five steps are followed, seven are not, so
        // the longest start of 読んでしまっていませんでした is 読んでしまっていません.
        assert_eq!(
            lookup("読んでしまったよ"),
            deinflected("読んでしまった", "読む", V5, &["-te", "completive", "past"])
        );
        assert_eq!(
            lookup("読んでしまいませんでした"),
            deinflected(
                "読んでしまいませんでした",
                "読む",
                V5,
                &["-te", "completive", "polite", "negative", "past"]
            )
        );
        assert_eq!(
            lookup("読んでしまっていませんでした"),
            deinflected(
                "読んでしまっていません",
                "読む",
                V5,
                &[
                    "-te",
                    "completive",
                    "-te",
                    "progressive",
                    "polite",
                    "negative"
                ]
            )
        );
        // Exact matches are unchanged, the progressive too.
        for query in ["しまう", "仕舞う", "読む"] {
            let exact = lookup(query);
            assert_eq!(exact.text, query);
            assert_eq!(
                exact.groups,
                lookup_from_store(&connection, query).unwrap(),
                "{query}"
            );
        }
        assert_eq!(
            lookup("読んでいる"),
            deinflected("読んでいる", "読む", V5, &["-te", "progressive"])
        );
        // A form matched only by a turned-off dictionary is skipped until it is turned back on.
        for query in ["泳いでしまった", "泳いじゃった"] {
            assert_eq!(
                lookup(query),
                TermLookup {
                    text: query.into(),
                    groups: Vec::new(),
                }
            );
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            winning_start(lookup_longest_start_from_store(&connection, "泳いでしまった").unwrap()),
            deinflected("泳いでしまった", "泳ぐ", V5, &["-te", "completive", "past"])
        );
        assert_eq!(
            winning_start(lookup_longest_start_from_store(&connection, "泳いじゃった").unwrap()),
            deinflected("泳いじゃった", "泳ぐ", V5, &["completive", "past"])
        );
    }

    #[test]
    fn the_rest_of_the_japanese_transforms_look_up_their_dictionary_forms() {
        let directory = tempdir().unwrap();
        let words = fixture_with(
            directory.path(),
            "words.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Words","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",0,["to read"],1,""],
                        ["食べる","たべる","v1","v1",0,["to eat"],2,""],
                        ["来る","くる","vk","vk",0,["to come"],3,""],
                        ["する","","vs","vs",0,["to do"],4,""],
                        ["信ずる","しんずる","vz","vz",0,["to believe"],5,""],
                        ["高い","たかい","adj-i","adj-i",0,["high"],6,""],
                        ["寒い","さむい","adj-i","adj-i",0,["cold"],7,""],
                        ["勉強","べんきょう","n vs vt","",0,["study"],8,""],
                        ["問う","とう","v5","v5",0,["to ask"],9,""],
                        ["いらっしゃる","","v5","v5",0,["to come (honorific)"],10,""],
                        ["置く","おく","v5","v5",0,["to put"],11,""],
                        ["解く","とく","v5","v5",0,["to solve"],12,""],
                        ["しまう","","v5","v5",0,["to finish"],13,""],
                        ["いる","","v1","v1",0,["to be"],14,""],
                        ["捨てる","すてる","v1","v1",0,["to throw away"],15,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",3],["読む","pitch",{"reading":"よむ","pitches":[{"position":1}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["泳ぐ","およぐ","v5","v5",0,["to swim"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&words, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let deinflected = |text: &str, form: &str, classes: u32, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_classes_from_store(&connection, form, Some(classes)).unwrap(),
                form,
                inflections,
            ),
        };
        let as_noun = |text: &str, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_filtered_from_store(&connection, "勉強", TermFilter::SuruNoun).unwrap(),
                "勉強",
                inflections,
            ),
        };
        use super::super::deinflect::{ADJ_I, V1, V5, VK, VS, VZ};

        // Each group reaches a godan, ichidan, 来る, する, or ずる verb's or an i-adjective's
        // dictionary form, with its metadata, by expression or by reading.
        for (query, form, classes, inflections) in [
            // Auxiliaries and contractions.
            ("読んじまう", "読む", V5, &["completive"][..]),
            ("食べちまった", "食べる", V1, &["completive", "past"]),
            ("来ちまう", "来る", VK, &["completive"]),
            ("しちまう", "する", VS, &["completive"]),
            ("信じちまう", "信ずる", VZ, &["completive"]),
            ("読んじゃ", "読む", V5, &["-cha"]),
            ("読まないでおく", "読む", V5, &["negative", "preparatory"]),
            ("食べないでいる", "食べる", V1, &["negative", "progressive"]),
            ("食べておる", "食べる", V1, &["-te", "progressive"]),
            // Conditionals and connectives.
            ("読めば", "読む", V5, &["conditional"]),
            ("食べれば", "食べる", V1, &["conditional"]),
            ("来れば", "来る", VK, &["conditional"]),
            ("すれば", "する", VS, &["conditional"]),
            ("高ければ", "高い", ADJ_I, &["conditional"]),
            ("読みゃ", "読む", V5, &["conditional", "contracted"]),
            ("読んだら", "読む", V5, &["-tara"]),
            ("食べたり", "食べる", V1, &["-tari"]),
            ("高かったら", "高い", ADJ_I, &["-tara"]),
            ("読まず", "読む", V5, &["-zu"]),
            ("信ぜず", "信ずる", VZ, &["-zu"]),
            ("読まん", "読む", V5, &["-n"]),
            ("食べねば", "食べる", V1, &["-neba"]),
            ("せねば", "する", VS, &["-neba"]),
            ("読むまい", "読む", V5, &["negative volitional"]),
            // Desire, appearance, degree, and requests.
            ("食べたかった", "食べる", V1, &["desiderative", "past"]),
            ("信じたい", "信ずる", VZ, &["desiderative"]),
            ("読みそう", "読む", V5, &["-sou"]),
            ("高そう", "高い", ADJ_I, &["-sou"]),
            ("食べすぎた", "食べる", V1, &["-sugiru", "past"]),
            ("読みなさい", "読む", V5, &["-nasai"]),
            ("寒がる", "寒い", ADJ_I, &["-garu"]),
            ("しやがる", "する", VS, &["-yagaru"]),
            ("高さ", "高い", ADJ_I, &["-sa"]),
            ("高く", "高い", ADJ_I, &["adverbial"]),
            // Voice and mood.
            ("食べさせる", "食べる", V1, &["causative"]),
            ("読ませる", "読む", V5, &["causative"]),
            ("読まれる", "読む", V5, &["passive"]),
            ("される", "する", VS, &["passive"]),
            ("読める", "読む", V5, &["potential"]),
            ("食べられる", "食べる", V1, &["potential or passive"]),
            ("来られる", "来る", VK, &["potential or passive"]),
            ("読め", "読む", V5, &["imperative"]),
            ("食べろ", "食べる", V1, &["imperative"]),
            ("読むな", "読む", V5, &["negative imperative"]),
            ("読もう", "読む", V5, &["volitional"]),
            ("食べよう", "食べる", V1, &["volitional"]),
            ("来よう", "来る", VK, &["volitional"]),
            ("しよう", "する", VS, &["volitional"]),
            ("読み", "読む", V5, &["continuative"]),
            ("食べ", "食べる", V1, &["continuative"]),
            // Archaic, slang, and Kansai-ben.
            ("読まむ", "読む", V5, &["-mu"]),
            ("高き", "高い", ADJ_I, &["attributive"]),
            ("たけえ", "たかい", ADJ_I, &["-e"]),
            ("食べんな", "食べる", V1, &["negative imperative slang"]),
            ("読まへん", "読む", V5, &["negative", "kansai-ben"]),
            ("高うて", "高い", ADJ_I, &["-te", "kansai-ben"]),
            // Special cases.
            ("信じた", "信ずる", VZ, &["past"]),
            ("問うた", "問う", V5, &["past"]),
            ("いらっしゃいます", "いらっしゃる", V5, &["polite"]),
            // Kana readings.
            ("よめば", "よむ", V5, &["conditional"]),
            ("しんじた", "しんずる", VZ, &["past"]),
        ] {
            let result = lookup(query);
            assert_eq!(
                result,
                deinflected(query, form, classes, inflections),
                "{query}"
            );
            assert_eq!(result.groups.len(), 1, "{query}");
        }
        let reading = lookup("読まされていました");
        assert_eq!(reading.text, "読まされていました");
        assert_eq!(reading.groups[0].frequencies[0].data, serde_json::json!(3));
        assert_eq!(reading.groups[0].pitches.len(), 1);
        assert_eq!(
            serde_json::to_value(&reading).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({
                "form": "読む",
                "inflections": ["short causative", "passive", "-te", "progressive", "polite", "past"]
            })
        );
        // A する-noun is reached through its する verb.
        for (query, inflections) in [
            ("勉強させる", &["causative"][..]),
            ("勉強すれば", &["conditional"]),
            ("勉強したい", &["desiderative"]),
            ("勉強しなさい", &["-nasai"]),
            ("勉強しよう", &["volitional"]),
        ] {
            assert_eq!(lookup(query), as_noun(query, inflections), "{query}");
        }
        // Six steps are followed, seven are not: the longest start within six steps matches.
        assert_eq!(
            lookup("読まされていませんでした"),
            deinflected(
                "読まされていません",
                "読む",
                V5,
                &[
                    "short causative",
                    "passive",
                    "-te",
                    "progressive",
                    "polite",
                    "negative"
                ]
            )
        );
        // Exact matches are unchanged, with no other forms after them.
        for query in [
            "置く",
            "解く",
            "しまう",
            "いる",
            "捨てる",
            "読む",
            "高い",
            "食べる",
        ] {
            let exact = lookup(query);
            assert_eq!(exact.text, query);
            assert!(!exact.groups.is_empty(), "{query}");
            assert_eq!(
                exact.groups,
                lookup_from_store(&connection, query).unwrap(),
                "{query}"
            );
        }
        // A form matched only by a turned-off dictionary is skipped until it is turned back on.
        assert_eq!(lookup("泳げば").groups, Vec::new());
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        let swim = lookup("泳げば");
        assert_eq!(swim, deinflected("泳げば", "泳ぐ", V5, &["conditional"]));
        assert_eq!(swim.groups[0].terms[0].dictionary_title, "Off");
    }

    #[test]
    fn a_preparatory_form_looks_up_its_dictionary_form() {
        let directory = tempdir().unwrap();
        let verbs = fixture_with(
            directory.path(),
            "verbs.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Verbs","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",0,["to read"],1,""],
                        ["食べる","たべる","v1","v1",0,["to eat"],2,""],
                        ["来る","くる","vk","vk",0,["to come"],3,""],
                        ["する","","vs","vs",0,["to do"],4,""],
                        ["勉強","べんきょう","n vs vt","",0,["study"],5,""],
                        ["着る","きる","v1","v1",0,["to wear"],6,""],
                        ["書く","かく","v5","v5",0,["to write"],7,""],
                        ["買う","かう","v5","v5",0,["to buy"],8,""],
                        ["置く","おく","v5","v5",0,["to put"],9,""],
                        ["解く","とく","v5","v5",0,["to solve"],10,""],
                        ["説く","とく","v5","v5",0,["to explain"],11,""],
                        ["退く","どく","v5","v5",0,["to step aside"],12,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",3],["読む","pitch",{"reading":"よむ","pitches":[{"position":1}]}]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["泳ぐ","およぐ","v5","v5",0,["to swim"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&verbs, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        let deinflected = |text: &str, form: &str, classes: u32, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_classes_from_store(&connection, form, Some(classes)).unwrap(),
                form,
                inflections,
            ),
        };
        let as_noun = |text: &str, noun: &str, inflections: &[&str]| TermLookup {
            text: text.into(),
            groups: as_form(
                lookup_filtered_from_store(&connection, noun, TermFilter::SuruNoun).unwrap(),
                noun,
                inflections,
            ),
        };
        use super::super::deinflect::{V1, V5, VK, VS};

        // Each ending, and its chains through the past, polite, and negative rules, reaches a
        // godan, ichidan, 来る, or する verb's dictionary form through its て form, contracted or
        // not.
        for (query, form, classes, inflections) in [
            ("読んでおく", "読む", V5, &["-te", "preparatory"][..]),
            ("読んでおいた", "読む", V5, &["-te", "preparatory", "past"]),
            (
                "読んでおきます",
                "読む",
                V5,
                &["-te", "preparatory", "polite"],
            ),
            (
                "読んでおかない",
                "読む",
                V5,
                &["-te", "preparatory", "negative"],
            ),
            (
                "読んでおきました",
                "読む",
                V5,
                &["-te", "preparatory", "polite", "past"],
            ),
            ("読んどく", "読む", V5, &["-te", "preparatory"]),
            ("読んどいた", "読む", V5, &["-te", "preparatory", "past"]),
            ("買っておいた", "買う", V5, &["-te", "preparatory", "past"]),
            ("書いとく", "書く", V5, &["-te", "preparatory"]),
            ("書いといた", "書く", V5, &["-te", "preparatory", "past"]),
            ("置いておく", "置く", V5, &["-te", "preparatory"]),
            ("置いとく", "置く", V5, &["-te", "preparatory"]),
            ("食べておく", "食べる", V1, &["-te", "preparatory"]),
            ("食べとく", "食べる", V1, &["-te", "preparatory"]),
            ("来ておいた", "来る", VK, &["-te", "preparatory", "past"]),
            ("来とく", "来る", VK, &["-te", "preparatory"]),
            ("しておく", "する", VS, &["-te", "preparatory"]),
            ("しといた", "する", VS, &["-te", "preparatory", "past"]),
            ("よんでおいた", "よむ", V5, &["-te", "preparatory", "past"]),
        ] {
            let result = lookup(query);
            assert_eq!(
                result,
                deinflected(query, form, classes, inflections),
                "{query}"
            );
            assert_eq!(result.groups.len(), 1, "{query}");
        }
        let reading = lookup("読んでおいた");
        assert_eq!(reading.groups[0].frequencies[0].data, serde_json::json!(3));
        assert_eq!(reading.groups[0].pitches.len(), 1);
        assert_eq!(
            serde_json::to_value(&reading).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({"form": "読む", "inflections": ["-te", "preparatory", "past"]})
        );
        // A する-noun is reached through its する verb, as in Task 0104.
        for (query, inflections) in [
            ("勉強しておく", &["-te", "preparatory"][..]),
            ("勉強しておきます", &["-te", "preparatory", "polite"]),
            ("勉強しておいた", &["-te", "preparatory", "past"]),
            ("勉強しとく", &["-te", "preparatory"]),
            ("勉強しといた", &["-te", "preparatory", "past"]),
        ] {
            assert_eq!(
                lookup(query),
                as_noun(query, "勉強", inflections),
                "{query}"
            );
        }
        // Every form, in candidate order: きとく is 来る's and the ichidan 着る's.
        let kitoku = lookup("きとく");
        let mut expected = deinflected("きとく", "くる", VK, &["-te", "preparatory"]);
        expected
            .groups
            .extend(deinflected("きとく", "きる", V1, &["-te", "preparatory"]).groups);
        assert_eq!(
            kitoku
                .groups
                .iter()
                .map(|group| group.expression.as_str())
                .collect::<Vec<_>>(),
            ["来る", "着る"]
        );
        assert_eq!(kitoku, expected);
        // A longer query keeps its longest start; five steps are followed, seven are not, so
        // the longest start of 読んでおいていませんでした is 読んでおいていません.
        assert_eq!(
            lookup("読んでおいたよ"),
            deinflected("読んでおいた", "読む", V5, &["-te", "preparatory", "past"])
        );
        assert_eq!(
            lookup("読んでおきませんでした"),
            deinflected(
                "読んでおきませんでした",
                "読む",
                V5,
                &["-te", "preparatory", "polite", "negative", "past"]
            )
        );
        assert_eq!(
            lookup("読んでおいていませんでした"),
            deinflected(
                "読んでおいていません",
                "読む",
                V5,
                &[
                    "-te",
                    "preparatory",
                    "-te",
                    "progressive",
                    "polite",
                    "negative"
                ]
            )
        );
        // Exact matches are unchanged, the progressive and the completive too.
        for query in [
            "置く", "おく", "解く", "説く", "とく", "退く", "どく", "読む",
        ] {
            let exact = lookup(query);
            assert_eq!(exact.text, query);
            assert!(!exact.groups.is_empty(), "{query}");
            assert_eq!(
                exact.groups,
                lookup_from_store(&connection, query).unwrap(),
                "{query}"
            );
        }
        assert_eq!(
            lookup("読んでいる"),
            deinflected("読んでいる", "読む", V5, &["-te", "progressive"])
        );
        assert_eq!(
            lookup("読んでしまった"),
            deinflected("読んでしまった", "読む", V5, &["-te", "completive", "past"])
        );
        // A form matched only by a turned-off dictionary is skipped until it is turned back on.
        for query in ["泳いでおいた", "泳いどいた"] {
            assert_eq!(
                lookup(query),
                TermLookup {
                    text: query.into(),
                    groups: Vec::new(),
                }
            );
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        for query in ["泳いでおいた", "泳いどいた"] {
            assert_eq!(
                winning_start(lookup_longest_start_from_store(&connection, query).unwrap()),
                deinflected(query, "泳ぐ", V5, &["-te", "preparatory", "past"]),
                "{query}"
            );
        }
    }

    #[test]
    fn a_start_lists_every_dictionary_form_it_matches() {
        let directory = tempdir().unwrap();
        let forms = fixture_with(
            directory.path(),
            "forms.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Forms","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["下","した","n","",0,["below"],1,""],
                        ["する","","vs","vs",0,["to do"],2,""],
                        ["北","きた","n","",0,["north"],3,""],
                        ["来る","くる","vk","vk",0,["to come"],4,""],
                        ["着る","きる","v1","v1",0,["to wear"],5,""],
                        ["切る","きる","v5","v5",0,["to cut"],6,""],
                        ["行く","いく","v5","v5",0,["to go"],7,""],
                        ["言う","いう","v5","v5",0,["to say"],8,""],
                        ["要る","いる","v5","v5",0,["to need"],9,""],
                        ["居る","いる","v1","v1",0,["to be"],10,""]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["言う","freq",7],["言う","pitch",{"reading":"いう","pitches":[{"position":0}]}]]"#,
                ),
            ],
        );
        // A second way to reach 来る: stored as v1, which 来て's て ending also reaches.
        let twice = fixture_with(
            directory.path(),
            "twice.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Twice","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["来る","くる","v1","v1",0,["to come (as v1)"],1,""]]"#,
                ),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["逝く","いく","v5","v5",0,["to pass away"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&forms, &twice, &off] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 3, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| {
            winning_start(lookup_longest_start_from_store(&connection, query).unwrap())
        };
        // Each group as (expression, dictionary form, inflections), in order.
        let listed = |lookup: &TermLookup| {
            lookup
                .groups
                .iter()
                .map(|group| {
                    let (form, inflections) = group.deinflection.as_ref().map_or(
                        (String::new(), String::new()),
                        |deinflection| {
                            (
                                deinflection.form.clone(),
                                deinflection.inflections.join(", "),
                            )
                        },
                    );
                    (group.expression.clone(), form, inflections)
                })
                .collect::<Vec<_>>()
        };
        let row = |expression: &str, form: &str, inflections: &str| {
            (
                expression.to_owned(),
                form.to_owned(),
                inflections.to_owned(),
            )
        };
        use super::super::deinflect::{V1, V5, VK, VS};

        // Kana dictionary forms precede kanji-only exact reading matches.
        let shita = lookup("した");
        assert_eq!(shita.text, "した");
        assert_eq!(
            listed(&shita),
            [row("する", "する", "past"), row("下", "", "")]
        );
        let mut expected = as_form(
            lookup_classes_from_store(&connection, "する", Some(VS)).unwrap(),
            "する",
            &["past"],
        );
        expected.extend(lookup_from_store(&connection, "した").unwrap());
        assert_eq!(shita.groups, expected);
        // Only terms whose rules name a form's class are listed: 切る (v5) is not the ichidan
        // きる that た leaves.
        assert_eq!(
            listed(&lookup("きた")),
            [
                row("北", "", ""),
                row("来る", "くる", "past"),
                row("着る", "きる", "past"),
            ]
        );
        // Several dictionary forms, without an exact match, each with its own metadata; 居る
        // (v1) is not the godan いる, and 逝く is in a turned-off dictionary.
        let itta = lookup("いった");
        assert_eq!(
            listed(&itta),
            [
                row("行く", "いく", "past"),
                row("言う", "いう", "past"),
                row("要る", "いる", "past"),
            ]
        );
        assert_eq!(
            itta.groups,
            [
                as_form(
                    lookup_classes_from_store(&connection, "いく", Some(V5)).unwrap(),
                    "いく",
                    &["past"]
                ),
                as_form(
                    lookup_classes_from_store(&connection, "いう", Some(V5)).unwrap(),
                    "いう",
                    &["past"]
                ),
                as_form(
                    lookup_classes_from_store(&connection, "いる", Some(V5)).unwrap(),
                    "いる",
                    &["past"]
                ),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
        );
        assert_eq!(itta.groups[1].frequencies[0].data, serde_json::json!(7));
        assert_eq!(itta.groups[1].pitches.len(), 1);
        // The longest matching start still wins, with all of its forms.
        let longer = lookup("いったよ");
        assert_eq!(longer.text, "いった");
        assert_eq!(longer.groups, itta.groups);
        // A group reached more than one way is listed once, the first way: 来て reaches 来る
        // as 来る (vk) and then as an ichidan verb (v1), which the second dictionary stores.
        let kite = lookup("来て");
        assert_eq!(listed(&kite), [row("来る", "来る", "-te")]);
        assert_eq!(
            kite.groups,
            as_form(
                lookup_classes_from_store(&connection, "来る", Some(VK)).unwrap(),
                "来る",
                &["-te"]
            )
        );
        assert_eq!(
            lookup_classes_from_store(&connection, "来る", Some(V1)).unwrap()[0].terms[0]
                .dictionary_id,
            2
        );
        assert_eq!(
            listed(&lookup("きて")),
            [row("来る", "くる", "-te"), row("着る", "きる", "-te")]
        );
        assert!(lookup("きて").groups[0]
            .terms
            .iter()
            .all(|term| term.dictionary_id == 1));
        assert_eq!(
            serde_json::to_value(&shita).unwrap()["groups"][0]["deinflection"],
            serde_json::json!({"form": "する", "inflections": ["past"]})
        );
        assert_eq!(
            serde_json::to_value(&shita).unwrap()["groups"][1]["deinflection"],
            serde_json::Value::Null
        );
        // Turning the dictionary back on lists its form's terms with the others of that form.
        assert_eq!(
            set_enabled_in_store(&connection, 3, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            listed(&winning_start(
                lookup_longest_start_from_store(&connection, "いった").unwrap()
            )),
            [
                row("行く", "いく", "past"),
                row("逝く", "いく", "past"),
                row("言う", "いう", "past"),
                row("要る", "いる", "past"),
            ]
        );
    }

    #[test]
    fn a_rare_word_and_particle_lists_after_its_word() {
        let directory = tempdir().unwrap();
        let words = fixture_with(
            directory.path(),
            "words.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Words","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["誰が","たが","exp","",0,["whose (poetical)"],1,""],
                        ["誰","だれ","pn","",0,["who"],2,""],
                        ["特に","とくに","adv","",0,["especially"],3,""],
                        ["特","とく","n","",0,["special"],4,""],
                        ["今日","きょう","n","",0,["today"],5,""],
                        ["今日は","こんにちは","int","",0,["hello"],6,""]]"#,
                ),
            ],
        );
        let ranks = fixture_with(
            directory.path(),
            "ranks.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Ranks","revision":"1","format":3,"frequencyMode":"rank-based"}"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["誰","freq",{"reading":"だれ","frequency":{"value":60,"displayValue":"60"}}],
                        ["誰が","freq",{"reading":"たが","frequency":48528}],
                        ["特","freq",550],
                        ["特に","freq",{"value":390}],
                        ["今日","freq",94]]"#,
                ),
            ],
        );
        let counts = fixture_with(
            directory.path(),
            "counts.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Counts","revision":"1","format":3}"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["誰が","freq",1],["誰","freq",900000]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&words, &ranks, &counts] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let order = |query: &str| {
            let lookup = lookup_longest_start_from_store(&connection, query).unwrap();
            (
                lookup.text,
                lookup
                    .groups
                    .iter()
                    .map(|group| (group.text.clone(), group.reading.clone()))
                    .collect::<Vec<_>>(),
            )
        };
        let pairs = |items: &[(&str, &str)]| {
            items
                .iter()
                .map(|(text, reading)| (text.to_string(), reading.to_string()))
                .collect::<Vec<_>>()
        };
        // 誰が is 800 times rarer than 誰: the word comes first and names the lookup.
        assert_eq!(
            order("誰がやった"),
            ("誰".into(), pairs(&[("誰", "だれ"), ("誰が", "たが")]))
        );
        // 特に is more common than 特, and 今日は has no rank: the longest start stays first
        // for the first, the word moves up for the second.
        assert_eq!(
            order("特にない"),
            ("特に".into(), pairs(&[("特に", "とくに"), ("特", "とく")]))
        );
        assert_eq!(
            order("今日は晴れ"),
            (
                "今日".into(),
                pairs(&[("今日", "きょう"), ("今日は", "こんにちは")])
            )
        );
        // An exact whole query keeps only its own groups.
        assert_eq!(order("誰が"), ("誰が".into(), pairs(&[("誰が", "たが")])));
        // Each frequency row carries its source's declared mode, or none.
        let modes = serde_json::to_value(
            &lookup_longest_start_from_store(&connection, "誰が")
                .unwrap()
                .groups[0]
                .frequencies,
        )
        .unwrap();
        assert_eq!(modes[0]["frequencyMode"], "rank-based");
        assert!(modes[1].get("frequencyMode").is_none());
        // Without a rank-based dictionary (occurrence counts only) the longest start leads.
        connection
            .execute(
                "UPDATE dictionaries SET enabled = 0 WHERE title = 'Ranks'",
                [],
            )
            .unwrap();
        assert_eq!(
            order("誰がやった"),
            ("誰が".into(), pairs(&[("誰が", "たが"), ("誰", "だれ")]))
        );
        // A result limit cuts every group past it.
        let limited = lookup_longest_start_limited(
            &connection,
            "誰がやった",
            &SourcePolicy::default(),
            Some(1),
        )
        .unwrap();
        assert_eq!(limited.groups.len(), 1);
    }

    #[test]
    fn a_scanned_query_lists_each_shorter_starts_groups_after_the_longest() {
        let directory = tempdir().unwrap();
        let starts = fixture_with(
            directory.path(),
            "starts.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Starts","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読書","どくしょ","n vs","",0,["reading"],1,""],
                        ["読","よみ","n","",0,["reading (short)"],2,""],
                        ["読","とく","n","",0,["reading (on)"],3,""],
                        ["読む","よむ","v5","v5",0,["to read"],4,""],
                        ["読み","よみ","n","",0,["a reading"],5,""],
                        ["読み方","よみかた","n","",0,["way of reading"],6,""]]"#,
                ),
                ("term_meta_bank_1.json", r#"[["読","freq",9]]"#),
            ],
        );
        let off = fixture_with(
            directory.path(),
            "off.zip",
            &[
                ("index.json", r#"{"title":"Off","revision":"1","format":3}"#),
                (
                    "term_bank_1.json",
                    r#"[["読","どく","n","",0,["reading (off)"],1,""]]"#,
                ),
            ],
        );
        // Every start of あ×10 matches, one group each; うう and う have 20 groups each, and いい
        // has more than the group bound on its own.
        let mut many = (1..=10)
            .map(|length| {
                format!(
                    r#"["{}","","n","",0,["a"],{length},""]"#,
                    "あ".repeat(length)
                )
            })
            .collect::<Vec<_>>();
        for (reading, count) in [("うう", 20), ("う", 20), ("いい", 40)] {
            many.extend((0..count).map(|index| {
                format!(r#"["{reading}{index}","{reading}","n","",0,["x"],{index},""]"#)
            }));
        }
        let many = fixture_with(
            directory.path(),
            "many.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Many","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", &format!("[{}]", many.join(","))),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&starts, &off, &many] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let lookup = |query: &str| lookup_longest_start_from_store(&connection, query).unwrap();
        // Each group as (start, expression, reading, inflections), in order.
        let listed = |lookup: &TermLookup| {
            lookup
                .groups
                .iter()
                .map(|group| {
                    (
                        group.text.clone(),
                        group.expression.clone(),
                        group.reading.clone(),
                        group
                            .deinflection
                            .as_ref()
                            .map_or(String::new(), |found| found.inflections.join(", ")),
                    )
                })
                .collect::<Vec<_>>()
        };
        let row = |start: &str, expression: &str, reading: &str, inflections: &str| {
            (
                start.to_owned(),
                expression.to_owned(),
                reading.to_owned(),
                inflections.to_owned(),
            )
        };
        // `groups` as `start` lists them.
        let from = |start: &str, mut groups: Vec<TermGroup>| {
            for group in &mut groups {
                group.text = start.into();
            }
            groups
        };

        // The longest start's groups come first, then each shorter start's, with its metadata.
        let reading = lookup("読書する");
        assert_eq!(reading.text, "読書");
        assert_eq!(
            listed(&reading),
            [
                row("読書", "読書", "どくしょ", ""),
                row("読", "読", "よみ", ""),
                row("読", "読", "とく", ""),
            ]
        );
        assert_eq!(
            reading.groups,
            [
                from("読書", lookup_from_store(&connection, "読書").unwrap()),
                from("読", lookup_from_store(&connection, "読").unwrap()),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
        );
        assert_eq!(reading.groups[1].frequencies[0].data, serde_json::json!(9));
        // A shorter start's forms follow its exact groups: 読み lists its own 読み, then 読む
        // (continuative).
        assert_eq!(
            listed(&lookup("読み方を")),
            [
                row("読み方", "読み方", "よみかた", ""),
                row("読み", "読み", "よみ", ""),
                row("読み", "読む", "よむ", "continuative"),
                row("読", "読", "よみ", ""),
                row("読", "読", "とく", ""),
            ]
        );
        // A group reached by two starts is listed once, with the longer start and its way:
        // 読みます reaches 読む as polite, and its start 読み reaches it again as continuative.
        let polite = lookup("読みますよ");
        assert_eq!(polite.text, "読みます");
        assert_eq!(
            listed(&polite),
            [
                row("読みます", "読む", "よむ", "polite"),
                row("読み", "読み", "よみ", ""),
                row("読", "読", "よみ", ""),
                row("読", "読", "とく", ""),
            ]
        );
        // A deinflected whole query also lists its shorter starts.
        assert_eq!(listed(&lookup("読みます"))[1..], listed(&polite)[1..]);
        // A query matched exactly as a whole is unchanged: its own groups and forms only.
        for query in ["読む", "読書", " 読み方 ", "読"] {
            let text = query.trim();
            assert_eq!(
                lookup(query),
                TermLookup {
                    text: text.into(),
                    groups: from(text, lookup_from_store(&connection, text).unwrap()),
                }
            );
        }
        assert_eq!(
            listed(&lookup("読み")),
            [
                row("読み", "読み", "よみ", ""),
                row("読み", "読む", "よむ", "continuative"),
            ]
        );
        // A start matched only by a turned-off dictionary is skipped until it is turned on,
        // then listed after that start's other groups.
        assert!(!listed(&lookup("読書する")).contains(&row("読", "読", "どく", "")));
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            listed(&lookup("読書する"))[1..],
            [
                row("読", "読", "よみ", ""),
                row("読", "読", "とく", ""),
                row("読", "読", "どく", ""),
            ]
        );
        // At most `MAX_LISTED_STARTS` starts are listed, longest first.
        let a = lookup(&format!("{}x", "あ".repeat(10)));
        assert_eq!(a.text, "あ".repeat(10));
        assert_eq!(
            a.groups
                .iter()
                .map(|group| group.text.chars().count())
                .collect::<Vec<_>>(),
            (10 - MAX_LISTED_STARTS + 1..=10).rev().collect::<Vec<_>>()
        );
        // Shorter starts fill the list up to `MAX_LISTED_GROUPS` groups...
        let u = lookup("ううx");
        assert_eq!(u.groups.len(), MAX_LISTED_GROUPS);
        assert_eq!(
            u.groups.iter().filter(|group| group.text == "うう").count(),
            20
        );
        assert_eq!(
            u.groups[20..],
            from("う", lookup_from_store(&connection, "う").unwrap())[..MAX_LISTED_GROUPS - 20]
        );
        // ...but never cut the longest start's own groups.
        let i = lookup("いいx");
        assert_eq!(i.groups.len(), 40);
        assert!(i.groups.iter().all(|group| group.text == "いい"));
        // No start matching returns the query with no groups.
        assert_eq!(
            lookup("xyz 読"),
            TermLookup {
                text: "xyz 読".into(),
                groups: Vec::new(),
            }
        );
        // Each group names its start in the JSON.
        let json = serde_json::to_value(lookup("読書する")).unwrap();
        assert_eq!(json["text"], "読書");
        assert_eq!(
            json["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|group| (group["text"].clone(), group["expression"].clone()))
                .collect::<Vec<_>>(),
            [
                (serde_json::json!("読書"), serde_json::json!("読書")),
                (serde_json::json!("読"), serde_json::json!("読")),
                (serde_json::json!("読"), serde_json::json!("読")),
                (serde_json::json!("読"), serde_json::json!("読")),
            ]
        );
        assert_eq!(json["groups"][1]["deinflection"], serde_json::Value::Null);
    }

    fn kanji_sources(lookup: &KanjiLookup) -> (Vec<(i64, &str)>, Vec<i64>) {
        (
            lookup
                .entries
                .iter()
                .map(|entry| (entry.dictionary_id, entry.onyomi.as_str()))
                .collect(),
            lookup
                .frequencies
                .iter()
                .map(|frequency| frequency.dictionary_id)
                .collect(),
        )
    }

    #[test]
    fn kanji_lookup_returns_enabled_rows_in_the_readers_order() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kanji Second","revision":"1","format":3}"#,
                ),
                (
                    "kanji_bank_1.json",
                    r#"[
                        ["本","ホン2","もと2","common grade1",["book (2)"],{"grade":"1","freq":10}],
                        ["日","ニチ","ひ","",["day"],{}],
                        ["本","ホン3","","",[],{}],
                        ["よ","ヨ","","",["kana"],{}],
                        ["𠮟","シツ","しか.る","",["scold"],{}]
                    ]"#,
                ),
                (
                    "kanji_meta_bank_1.json",
                    r#"[["日","freq",1],["本","freq",{"value":3,"displayValue":"3rd"}]]"#,
                ),
            ],
        );
        let frequency_only = fixture_with(
            directory.path(),
            "third.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kanji Frequency","revision":"1","format":3}"#,
                ),
                ("kanji_meta_bank_1.json", r#"[["本","freq","30"]]"#),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for archive in [&first, &second, &frequency_only] {
            assert_eq!(
                import_one(&mut connection, archive).0,
                ImportStatus::Imported
            );
        }

        let book = lookup_kanji_from_store(&connection, "本").unwrap();
        assert_eq!(
            kanji_sources(&book),
            (vec![(1, "ホン"), (2, "ホン2"), (2, "ホン3")], vec![1, 2, 3])
        );
        assert_eq!(
            serde_json::to_value(&book).unwrap(),
            serde_json::json!({
                "entries": [
                    {
                        "dictionaryId": 1,
                        "dictionaryTitle": "Fixture",
                        "character": "本",
                        "onyomi": "ホン",
                        "kunyomi": "もと",
                        "tags": "jouyou",
                        "meanings": ["book", "origin"],
                        "stats": {"strokes": "5"},
                        "resolvedTags": [{
                            "name": "jouyou",
                            "category": "frequent",
                            "order": 0.0,
                            "notes": "Jōyō kanji",
                            "score": -1.0
                        }],
                        "statTags": [{"name": "strokes"}]
                    },
                    {
                        "dictionaryId": 2,
                        "dictionaryTitle": "Kanji Second",
                        "character": "本",
                        "onyomi": "ホン2",
                        "kunyomi": "もと2",
                        "tags": "common grade1",
                        "meanings": ["book (2)"],
                        "stats": {"grade": "1", "freq": 10},
                        "resolvedTags": [{"name": "common"}, {"name": "grade1"}],
                        "statTags": [{"name": "freq"}, {"name": "grade"}]
                    },
                    {
                        "dictionaryId": 2,
                        "dictionaryTitle": "Kanji Second",
                        "character": "本",
                        "onyomi": "ホン3",
                        "kunyomi": "",
                        "tags": "",
                        "meanings": [],
                        "stats": {},
                        "resolvedTags": [],
                        "statTags": []
                    }
                ],
                "frequencies": [
                    {"dictionaryId": 1, "dictionaryTitle": "Fixture", "data": 10},
                    {
                        "dictionaryId": 2,
                        "dictionaryTitle": "Kanji Second",
                        "data": {"value": 3, "displayValue": "3rd"}
                    },
                    {"dictionaryId": 3, "dictionaryTitle": "Kanji Frequency", "data": "30"}
                ]
            })
        );
        // Surrounding whitespace is trimmed, as for term lookups.
        assert_eq!(lookup_kanji_from_store(&connection, " 本\t").unwrap(), book);

        // Another kanji returns only its own rows; one outside the Basic Multilingual Plane reads.
        assert_eq!(
            kanji_sources(&lookup_kanji_from_store(&connection, "日").unwrap()),
            (vec![(2, "ニチ")], vec![2])
        );
        assert_eq!(
            kanji_sources(&lookup_kanji_from_store(&connection, "𠮟").unwrap()),
            (vec![(2, "シツ")], vec![])
        );
        assert_eq!(
            lookup_kanji_from_store(&connection, "木").unwrap(),
            KanjiLookup::default()
        );

        // A character that is not a kanji matches nothing, even with a stored row, and so do
        // several characters, an empty query, and words.
        for query in ["よ", "本本", "本日", "読む", "", " ", "A"] {
            assert_eq!(
                lookup_kanji_from_store(&connection, query).unwrap(),
                KanjiLookup::default(),
                "{query:?}"
            );
        }
        assert!(lookup_kanji_from_store(&connection, &"本".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert_eq!(kanji_query("々"), None);
        assert_eq!(kanji_query("\u{f900}"), Some('\u{f900}'));
        // The ranges shared with the frontend are the format's kanji ranges.
        assert_eq!(
            *KANJI_RANGES,
            [
                (0x4e00, 0x9fff),
                (0x3400, 0x4dbf),
                (0x20000, 0x2a6df),
                (0x2a700, 0x2b73f),
                (0x2b740, 0x2b81f),
                (0x2b820, 0x2ceaf),
                (0x2ceb0, 0x2ebef),
                (0x2ebf0, 0x2ee5f),
                (0x30000, 0x3134f),
                (0x31350, 0x323af),
                (0xf900, 0xfaff),
                (0x2f800, 0x2fa1f),
            ]
        );

        // A turned-off dictionary contributes nothing until it is turned back on.
        set_enabled_in_store(&connection, 1, false).unwrap();
        assert_eq!(
            kanji_sources(&lookup_kanji_from_store(&connection, "本").unwrap()),
            (vec![(2, "ホン2"), (2, "ホン3")], vec![2, 3])
        );
        set_enabled_in_store(&connection, 2, false).unwrap();
        set_enabled_in_store(&connection, 3, false).unwrap();
        assert_eq!(
            lookup_kanji_from_store(&connection, "本").unwrap(),
            KanjiLookup::default()
        );
        for id in [1, 2, 3] {
            set_enabled_in_store(&connection, id, true).unwrap();
        }
        assert_eq!(lookup_kanji_from_store(&connection, "本").unwrap(), book);

        // Rows follow the reader's order, each dictionary's own rows in stored order.
        assert_eq!(
            move_in_store(&mut connection, 3, 0).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(
            move_in_store(&mut connection, 2, 1).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(
            kanji_sources(&lookup_kanji_from_store(&connection, "本").unwrap()),
            (vec![(2, "ホン2"), (2, "ホン3"), (1, "ホン")], vec![3, 2, 1])
        );
    }

    #[test]
    fn kanji_lookup_resolves_tags_and_stats_against_their_own_dictionary() {
        let directory = tempdir().unwrap();
        // Defines `strokes` twice, and none of `ucs`, `unknown`, or `Stroke count`.
        let first = fixture_with(
            directory.path(),
            "first.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kanji First","revision":"1","format":3}"#,
                ),
                (
                    "kanji_bank_1.json",
                    r#"[["本","ホン","もと","jouyou  jouyou unknown",["book"],
                        {"strokes":"5","skip":"4-1-4","ucs":"672c","Stroke count":"5"}]]"#,
                ),
                (
                    "tag_bank_1.json",
                    r#"[
                        ["jouyou","frequent",-5,"included in the jouyou list",0],
                        ["strokes","misc",1,"Stroke count",0],
                        ["skip","class",2,"SKIP code",0]
                    ]"#,
                ),
                ("tag_bank_2.json", r#"[["strokes","other",9,"later",0]]"#),
            ],
        );
        // Defines `ucs` and `unknown`, which the first dictionary's row uses, and has no row of its
        // own that they would resolve.
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Kanji Second","revision":"1","format":3}"#,
                ),
                (
                    "kanji_bank_1.json",
                    r#"[["本","ホン","","jouyou",[],{"strokes":"5"}]]"#,
                ),
                (
                    "tag_bank_1.json",
                    r#"[["ucs","code",0,"Unicode",0],["unknown","misc",0,"defined here",0]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for archive in [&first, &second] {
            assert_eq!(
                import_one(&mut connection, archive).0,
                ImportStatus::Imported
            );
        }

        let lookup =
            serde_json::to_value(lookup_kanji_from_store(&connection, "本").unwrap()).unwrap();
        let entries = lookup["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        // Tag names once each in source order; the original strings are unchanged.
        assert_eq!(entries[0]["tags"], "jouyou  jouyou unknown");
        assert_eq!(
            entries[0]["resolvedTags"],
            serde_json::json!([
                {
                    "name": "jouyou",
                    "category": "frequent",
                    "order": -5.0,
                    "notes": "included in the jouyou list",
                    "score": 0.0
                },
                {"name": "unknown"}
            ])
        );
        // Stat names are whole keys, in the returned stats object's order; the first definition
        // in bank order wins.
        assert_eq!(
            entries[0]["stats"],
            serde_json::json!({"strokes":"5","skip":"4-1-4","ucs":"672c","Stroke count":"5"})
        );
        assert_eq!(
            entries[0]["statTags"],
            serde_json::json!([
                {"name": "Stroke count"},
                {
                    "name": "skip",
                    "category": "class",
                    "order": 2.0,
                    "notes": "SKIP code",
                    "score": 0.0
                },
                {
                    "name": "strokes",
                    "category": "misc",
                    "order": 1.0,
                    "notes": "Stroke count",
                    "score": 0.0
                },
                {"name": "ucs"}
            ])
        );
        // The second dictionary never borrows the first one's definitions.
        assert_eq!(
            entries[1]["resolvedTags"],
            serde_json::json!([{"name": "jouyou"}])
        );
        assert_eq!(
            entries[1]["statTags"],
            serde_json::json!([{"name": "strokes"}])
        );
    }

    #[test]
    fn lookup_resolves_term_tags_against_their_own_dictionary() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        // Repeats names, uses a name only the first dictionary defines, and defines `v5` twice.
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Second","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5  v5 rare","v5",1,["second"],5,"common v5"]]"#,
                ),
                (
                    "tag_bank_1.json",
                    r#"[["v5","verb",2,"five-row verb",1],["v5","other",3,"later",4]]"#,
                ),
            ],
        );
        let untagged = fixture_with(
            directory.path(),
            "untagged.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Untagged","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",1,["untagged"],6,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&first, &second, &untagged] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }

        let groups = lookup_from_store(&connection, "読む").unwrap();
        let terms = &groups[0].terms;
        assert_eq!(terms.len(), 3);
        let defined = |name: &str, category: &str, order: f64, notes: &str, score: f64| TermTag {
            name: name.into(),
            definition: Some(TagDefinition {
                category: category.into(),
                order,
                notes: notes.into(),
                score,
            }),
        };
        let bare = |name: &str| TermTag {
            name: name.into(),
            definition: None,
        };
        assert_eq!(
            terms[0].tags,
            [
                defined("v5", "partOfSpeech", -3.0, "Godan verb", 0.0),
                defined("common", "popular", -10.5, "", 5.0),
            ]
        );
        // The first `v5` definition in bank order, each name once, and `common` not borrowed from
        // the first dictionary.
        assert_eq!(
            terms[1].tags,
            [
                defined("v5", "verb", 2.0, "five-row verb", 1.0),
                bare("rare"),
                bare("common"),
            ]
        );
        assert_eq!(
            (&terms[1].definition_tags[..], &terms[1].term_tags[..]),
            ("v5  v5 rare", "common v5")
        );
        // A dictionary without tags still returns its names.
        assert_eq!(terms[2].tags, [bare("v5")]);
        assert_eq!(
            serde_json::to_value(&terms[1]).unwrap()["tags"],
            serde_json::json!([
                {"name":"v5","category":"verb","order":2.0,"notes":"five-row verb","score":1.0},
                {"name":"rare"},
                {"name":"common"}
            ])
        );

        // Terms without tags return none.
        let by_reading = lookup_from_store(&connection, "よむ").unwrap();
        let composed = by_reading
            .iter()
            .find(|group| group.expression == "詠む")
            .unwrap();
        assert!(composed.terms[0].tags.is_empty());
    }

    #[test]
    fn pitch_lookup_keeps_matching_readings_and_skips_malformed_rows() {
        let directory = tempdir().unwrap();
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );

        for (expression, mode, data) in [
            (
                "本",
                "pitch",
                r#"{"reading":"ほん","pitches":[{"position":0}]}"#,
            ),
            (
                "本",
                "pitch",
                r#"{"reading":"もと","pitches":[{"position":2,"tags":["x"]}]}"#,
            ),
            (
                "本",
                "pitch",
                r#"{"reading":"ほん","pitches":[{"position":1}]}"#,
            ),
            (
                "本",
                "pitch",
                r#"{"reading":"other","pitches":[{"position":1}]}"#,
            ),
            (
                "本",
                "ipa",
                r#"{"reading":"ほん","pitches":[{"position":1}]}"#,
            ),
            ("本", "pitch", r#"{"reading":"ほん","pitches":[]}"#),
            (
                "本",
                "pitch",
                r#"{"reading":"ほん","pitches":[{"position":-1}]}"#,
            ),
            ("本", "pitch", r#"{"reading":4,"pitches":[{"position":1}]}"#),
            ("本", "pitch", r#"{"reading":"ほん","pitches":[{}]}"#),
            ("本", "pitch", "not json"),
        ] {
            connection
                .execute(
                    "INSERT INTO term_meta (dictionary, expression, mode, data) VALUES (1, ?1, ?2, ?3)",
                    params![expression, mode, data],
                )
                .unwrap();
        }

        let groups = lookup_from_store(&connection, "本").unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].reading, "ほん");
        assert_eq!(groups[1].reading, "もと");
        assert_eq!(
            groups[0]
                .pitches
                .iter()
                .map(|pitch| pitch.data["pitches"][0]["position"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(groups[1].pitches.len(), 1);
        assert_eq!(groups[1].pitches[0].data["pitches"][0]["position"], 2);
    }

    #[test]
    #[ignore = "requires an imported dictionary database; read-only real-data check"]
    fn real_dictionary_kanji_lookup() {
        let path = std::env::var_os("KOMORI_DICTIONARY_DATABASE")
            .expect("set KOMORI_DICTIONARY_DATABASE to an imported dictionary database");
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let query = std::env::var("KOMORI_KANJI_QUERY").unwrap_or_else(|_| "本".into());
        let result = lookup_kanji_from_store(&connection, &query).unwrap();
        let described = |tag: &TermTag| match &tag.definition {
            Some(definition) => format!(
                "{} ({}, {}: {:?})",
                tag.name, definition.category, definition.order, definition.notes
            ),
            None => format!("{} (undefined)", tag.name),
        };
        for entry in &result.entries {
            println!(
                "{} {}: on {:?}, kun {:?}, tags {:?}, {} meanings, {} stats",
                entry.dictionary_title,
                entry.character,
                entry.onyomi,
                entry.kunyomi,
                entry.tags,
                entry.meanings.len(),
                entry.stats.as_object().map_or(0, |stats| stats.len()),
            );
            for tag in &entry.resolved_tags {
                println!("  tag {}", described(tag));
            }
            for tag in &entry.stat_tags {
                println!("  stat {} = {}", described(tag), entry.stats[&tag.name]);
            }
        }
        for frequency in &result.frequencies {
            println!(
                "{} frequency: {}",
                frequency.dictionary_title, frequency.data
            );
        }
        assert!(
            !result.entries.is_empty() || !result.frequencies.is_empty(),
            "no enabled kanji rows matched {query:?}"
        );
    }

    /// Looks up each `|`-separated query in `KOMORI_TERM_QUERY` (読書する by default), printing
    /// the matched text, the median time of five lookups after a first one, and each group with
    /// the start it matched and the form and inflections it was reached as.
    #[test]
    #[ignore = "requires an imported dictionary database; read-only real-data check"]
    fn real_dictionary_longest_start_lookup() {
        let path = std::env::var_os("KOMORI_DICTIONARY_DATABASE")
            .expect("set KOMORI_DICTIONARY_DATABASE to an imported dictionary database");
        // URI input permits immutable=1 for evidence reads without creating WAL sidecars.
        let connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let queries = std::env::var("KOMORI_TERM_QUERY").unwrap_or_else(|_| "読書する".into());
        let mut evidence = std::collections::BTreeMap::new();
        for query in queries.split('|') {
            let result = lookup_longest_start_from_store(&connection, query).unwrap();
            let mut times: Vec<_> = (0..5)
                .map(|_| {
                    let started = Instant::now();
                    lookup_longest_start_from_store(&connection, query).unwrap();
                    started.elapsed()
                })
                .collect();
            times.sort();
            println!(
                "{query:?} ({} characters) matched {:?} in {:?}",
                query.chars().count(),
                result.text,
                times[2]
            );
            for group in &result.groups {
                let form = group
                    .deinflection
                    .as_ref()
                    .map_or(String::new(), |deinflection| {
                        format!(
                            " as {:?} ({})",
                            deinflection.form,
                            deinflection.inflections.join(", ")
                        )
                    });
                println!(
                    "  {}: {} [{}]{form}: {} terms from {:?}",
                    group.text,
                    group.expression,
                    group.reading,
                    group.terms.len(),
                    group
                        .terms
                        .iter()
                        .map(|term| term.dictionary_title.as_str())
                        .collect::<Vec<_>>()
                );
            }
            evidence.insert(query, result);
        }
        if let Some(output) = std::env::var_os("KOMORI_TERM_LOOKUP_OUTPUT") {
            std::fs::write(output, serde_json::to_vec(&evidence).unwrap()).unwrap();
        }
    }

    #[test]
    #[ignore = "Requires a read-only imported dictionary database; emits popup card fixtures"]
    fn real_popup_anki_lookup_evidence() {
        let path =
            std::env::var_os("KOMORI_DICTIONARY_DATABASE").expect("set KOMORI_DICTIONARY_DATABASE");
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let lookups: std::collections::BTreeMap<_, _> = ["記憶", "白髪の", "読む"]
            .into_iter()
            .map(|query| {
                (
                    query,
                    lookup_longest_start_from_store(&connection, query).unwrap(),
                )
            })
            .collect();
        std::fs::write(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../artifacts/validation/0132-real-lookups.json"),
            serde_json::to_vec(&lookups).unwrap(),
        )
        .unwrap();
        for (term, result) in lookups {
            println!("{term}: {} result groups", result.groups.len());
        }
    }

    #[test]
    #[ignore = "requires an imported dictionary database; read-only real-data check"]
    fn real_dictionary_pitch_lookup() {
        let path = std::env::var_os("KOMORI_DICTIONARY_DATABASE")
            .expect("set KOMORI_DICTIONARY_DATABASE to an imported dictionary database");
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut expressions: Vec<String> = connection
            .prepare("SELECT DISTINCT expression FROM term_meta WHERE mode = 'pitch' LIMIT 100")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let has_pitch_rows = !expressions.is_empty();
        if !has_pitch_rows {
            expressions = connection
                .prepare("SELECT DISTINCT expression FROM terms LIMIT 10")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
        }
        assert!(!expressions.is_empty(), "no imported terms to look up");
        let mut matched = 0;
        let mut groups = 0;
        let (mut tag_names, mut defined_tags) = (0, 0);
        for expression in &expressions {
            if expression.chars().count() > MAX_QUERY_CHARS || expression.len() > MAX_QUERY_BYTES {
                continue;
            }
            let result = lookup_from_store(&connection, expression).unwrap();
            groups += result.len();
            for tag in result
                .iter()
                .flat_map(|group| &group.terms)
                .flat_map(|term| &term.tags)
            {
                tag_names += 1;
                defined_tags += usize::from(tag.definition.is_some());
            }
            matched += result.into_iter().flat_map(|group| group.pitches).count();
        }
        assert!(groups > 0, "no imported term groups matched");
        if has_pitch_rows {
            assert!(matched > 0, "no pitch rows matched imported term groups");
        }
        println!(
            "Looked up {} real expressions and {groups} groups; matched {matched} pitch rows (pitch data present: {has_pitch_rows}); resolved {defined_tags} of {tag_names} term tag names",
            expressions.len(),
        );
    }

    #[test]
    fn import_stores_every_row_kind_and_reads_it_back() {
        let directory = tempdir().unwrap();
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();

        assert_eq!(
            import_one(&mut connection, &archive),
            (ImportStatus::Imported, Some("Fixture".into()))
        );
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1")]
        );
        let (format, sequenced, author): (i64, bool, Option<String>) = connection
            .query_row(
                "SELECT format, sequenced, author FROM dictionaries",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((format, sequenced, author), (3, true, None));

        // Rows keep bank-number order, and each glossary inflates to its original JSON text.
        type TermRow = (
            i64,
            String,
            String,
            String,
            String,
            f64,
            String,
            i64,
            String,
        );
        let terms: Vec<TermRow> = connection
            .prepare(
                "SELECT dictionary, expression, reading, definition_tags, rules, score, glossary,
                        sequence, term_tags FROM terms ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    inflate(&row.get::<_, Vec<u8>>(6)?),
                    row.get(7)?,
                    row.get(8)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let term = |expression: &str, reading: &str, tags: &str, score: f64, glossary: &str| {
            (
                expression.to_string(),
                reading.to_string(),
                tags.to_string(),
                score,
                glossary.to_string(),
            )
        };
        assert_eq!(
            terms
                .iter()
                .map(|row| (
                    row.1.clone(),
                    row.2.clone(),
                    row.3.clone(),
                    row.5,
                    row.6.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                term("読む", "よむ", "v5", 10.0, r#"["to read"]"#),
                term(
                    "詠む",
                    "よむ",
                    "",
                    -1.0,
                    r#"[{"type":"structured-content","content":"to compose"}]"#
                ),
                term("よむ", "よむ", "", 0.0, r#"["to read (kana)"]"#),
                term("本", "ほん", "n", 0.0, r#"["book"]"#),
                term("本", "もと", "n", 0.0, r#"["origin"]"#),
            ]
        );
        assert_eq!(
            (
                terms[0].0,
                terms[0].4.as_str(),
                terms[0].7,
                terms[0].8.as_str()
            ),
            (1, "v5", 1, "common")
        );

        let meta: Vec<(String, String, String)> = connection
            .prepare("SELECT expression, mode, data FROM term_meta ORDER BY rowid")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(meta.len(), 4);
        assert_eq!(meta[0], ("読む".into(), "freq".into(), "120".into()));
        assert_eq!(
            meta[3],
            (
                "本".into(),
                "ipa".into(),
                r#"{"reading":"ほん","transcriptions":[{"ipa":"hoɴ","tags":[]}]}"#.into()
            )
        );

        let kanji: (String, String, String, String, String, String) = connection
            .query_row(
                "SELECT character, onyomi, kunyomi, tags, meanings, stats FROM kanji",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            kanji,
            (
                "本".into(),
                "ホン".into(),
                "もと".into(),
                "jouyou".into(),
                r#"["book","origin"]"#.into(),
                r#"{"strokes":"5"}"#.into()
            )
        );
        let kanji_meta: (String, String) = connection
            .query_row("SELECT character, data FROM kanji_meta", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(kanji_meta, ("本".into(), "10".into()));

        assert_eq!(
            stored_tags(&connection),
            vec![
                tag(1, "v5", "partOfSpeech", -3.0, "Godan verb", 0.0),
                tag(1, "common", "popular", -10.5, "", 5.0),
                tag(1, "jouyou", "frequent", 0.0, "Jōyō kanji", -1.0),
            ]
        );
    }

    type TagRow = (i64, String, String, f64, String, f64);

    fn tag(
        dictionary: i64,
        name: &str,
        category: &str,
        order: f64,
        notes: &str,
        score: f64,
    ) -> TagRow {
        (
            dictionary,
            name.into(),
            category.into(),
            order,
            notes.into(),
            score,
        )
    }

    fn stored_tags(connection: &Connection) -> Vec<TagRow> {
        connection
            .prepare(
                "SELECT dictionary, name, category, sort_order, notes, score FROM tags
                  ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn lookup_splits_tag_names_on_spaces_only() {
        let directory = tempdir().unwrap();
        // Jitendex names its tags with no-break spaces; fields split on U+0020 only.
        let archive = fixture_with(
            directory.path(),
            "spaced.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Spaced","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ"," ★  priority form ","",1,["read"],1,"a\tb"]]"#,
                ),
                (
                    "tag_bank_1.json",
                    r#"[["priority form","frequent",1,"high priority spelling",1],["★","popular",2,"high priority entry",2]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );

        let groups = lookup_from_store(&connection, "読む").unwrap();
        let tags = &groups[0].terms[0].tags;
        let names: Vec<&str> = tags.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(names, ["★", "priority\u{a0}form", "a\tb"]);
        assert_eq!(
            tags[1].definition.as_ref().unwrap().notes,
            "high priority spelling"
        );
        assert!(tags[2].definition.is_none());
    }

    #[test]
    fn index_tag_meta_is_appended_after_banks_and_resolves_in_lookup() {
        let directory = tempdir().unwrap();
        let tagged = fixture_with(
            directory.path(),
            "index-tags.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Index tags","revision":"1","format":3,"tagMeta":{"index":{"category":"popular","order":-2,"notes":"From index","score":4},"bank":{"category":"frequent","order":2,"notes":"Index duplicate","score":1}}}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","bank index","",1,["read"],1,""]]"#,
                ),
                (
                    "tag_bank_1.json",
                    r#"[["bank","partOfSpeech",-3,"From bank",0]]"#,
                ),
            ],
        );
        let untagged = fixture_with(
            directory.path(),
            "no-tags.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"No tags","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","index","",1,["read"],1,""]]"#,
                ),
            ],
        );
        let index_only = fixture_with(
            directory.path(),
            "index-only.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Index only","revision":"1","format":3,"tagMeta":{"only":{"notes":"Only in index"}}}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["行く","いく","only","",1,["go"],1,""]]"#,
                ),
            ],
        );
        let invalid = fixture_with(
            directory.path(),
            "bad-index-tags.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Bad index tags","revision":"1","format":3,"tagMeta":{"bad":{"score":"high"}}}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","bad","",1,["read"],1,""]]"#,
                ),
            ],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        assert_eq!(
            import_one(&mut connection, &tagged).0,
            ImportStatus::Imported
        );
        assert_eq!(
            import_one(&mut connection, &untagged).0,
            ImportStatus::Imported
        );
        assert_eq!(
            import_one(&mut connection, &index_only).0,
            ImportStatus::Imported
        );
        assert_eq!(
            import_one(&mut connection, &invalid).0,
            ImportStatus::Invalid
        );
        assert_eq!(row_counts(&connection), [3, 3, 0, 0, 0, 4]);
        assert_eq!(
            stored_tags(&connection),
            [
                tag(1, "bank", "partOfSpeech", -3.0, "From bank", 0.0),
                tag(1, "index", "popular", -2.0, "From index", 4.0),
                tag(1, "bank", "frequent", 2.0, "Index duplicate", 1.0),
                tag(3, "only", "", 0.0, "Only in index", 0.0),
            ]
        );
        let groups = lookup_from_store(&connection, "読む").unwrap();
        let terms = &groups[0].terms;
        assert_eq!(
            terms[0].tags[0].definition.as_ref().unwrap().notes,
            "From bank"
        );
        assert_eq!(
            terms[0].tags[1].definition.as_ref().unwrap().notes,
            "From index"
        );
        assert!(terms[1].tags[0].definition.is_none());
        let index_only = lookup_from_store(&connection, "行く").unwrap();
        assert_eq!(
            index_only[0].terms[0].tags[0]
                .definition
                .as_ref()
                .unwrap()
                .notes,
            "Only in index"
        );
    }

    #[test]
    fn tags_are_kept_per_dictionary() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = fixture_with(
            directory.path(),
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Second","revision":"1","format":3}"#,
                ),
                // The same name as a first-dictionary tag, with other details, and a duplicate.
                (
                    "tag_bank_1.json",
                    r#"[["v5","verb",1,"five-row verb",2],["v5","verb",1,"five-row verb",2]]"#,
                ),
            ],
        );
        let untagged = fixture_with(
            directory.path(),
            "untagged.zip",
            &[(
                "index.json",
                r#"{"title":"Untagged","revision":"1","format":3}"#,
            )],
        );
        for path in [&first, &second, &untagged] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }

        let tags = stored_tags(&connection);
        assert_eq!(tags.len(), 5);
        assert_eq!(
            tags[3..],
            [
                tag(2, "v5", "verb", 1.0, "five-row verb", 2.0),
                tag(2, "v5", "verb", 1.0, "five-row verb", 2.0),
            ]
        );
        let first_v5: Vec<String> = connection
            .prepare("SELECT notes FROM tags WHERE dictionary = 1 AND name = 'v5'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(first_v5, ["Godan verb"]);
        // Existing row kinds and their counts are unchanged by tags.
        assert_eq!(
            list_from_store(&connection).unwrap()[0],
            summary(1, "fixture-1")
        );
    }

    #[test]
    fn version_one_stores_gain_an_empty_tag_table() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let mut connection = open_store(&database).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        // What a version 1 store holds: the same rows without the tag table.
        connection
            .execute_batch(
                "DROP TABLE tags;
                 ALTER TABLE dictionaries DROP COLUMN enabled;
                 ALTER TABLE dictionaries DROP COLUMN position;
                 ALTER TABLE dictionaries DROP COLUMN has_definitions;
                 ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        drop(connection);

        let connection = open_store(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(row_counts(&connection), [1, 5, 4, 1, 1, 0]);
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1")]
        );
        assert_eq!(
            lookup_from_store(&connection, "本").unwrap()[0].terms[0].glossary,
            serde_json::json!(["book"])
        );
    }

    /// Each of `id`'s term, term meta, kanji, kanji meta, and tag row counts.
    fn rows_of(connection: &Connection, id: i64) -> [i64; 5] {
        ["terms", "term_meta", "kanji", "kanji_meta", "tags"].map(|table| {
            connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE dictionary = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        })
    }

    /// A second dictionary with a row of every kind that the fixture also has.
    fn second_dictionary(directory: &Path) -> PathBuf {
        fixture_with(
            directory,
            "second.zip",
            &[
                (
                    "index.json",
                    r#"{"title":"Second","revision":"1","format":3}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["読む","よむ","v5","v5",1,["second"],5,"common"]]"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["読む","freq",3],["読む","pitch",{"reading":"よむ","pitches":[{"position":0}]}]]"#,
                ),
                ("kanji_bank_1.json", r#"[["本","ホン","","",["book"],{}]]"#),
                ("kanji_meta_bank_1.json", r#"[["本","freq",2]]"#),
                ("tag_bank_1.json", r#"[["v5","verb",2,"five-row verb",1]]"#),
            ],
        )
    }

    #[test]
    fn removal_deletes_only_that_dictionary_and_allows_importing_it_again() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let hash = || Sha256::digest(std::fs::read(&first).unwrap());
        let hash_before = hash();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&first, &second] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(rows_of(&connection, 1), [5, 4, 1, 1, 3]);
        assert_eq!(rows_of(&connection, 2), [1, 2, 1, 1, 1]);
        let second_tags: Vec<TagRow> = stored_tags(&connection)
            .into_iter()
            .filter(|tag| tag.0 == 2)
            .collect();
        // What the second dictionary contributes to a lookup that both dictionaries match.
        let mut expected = lookup_from_store(&connection, "読む").unwrap();
        for group in &mut expected {
            group.terms.retain(|term| term.dictionary_id == 2);
            group.frequencies.retain(|item| item.dictionary_id == 2);
            group.pitches.retain(|item| item.dictionary_id == 2);
        }
        assert_eq!(expected[0].terms.len(), 1);

        assert_eq!(
            remove_from_store(&mut connection, 1).unwrap(),
            RemovalStatus::Removed
        );
        assert_eq!(rows_of(&connection, 1), [0; 5]);
        assert_eq!(row_counts(&connection), [1, 1, 2, 1, 1, 1]);
        assert_eq!(stored_tags(&connection), second_tags);
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), expected);
        assert_eq!(
            expected[0].terms[0].tags[0].definition,
            Some(TagDefinition {
                category: "verb".into(),
                order: 2.0,
                notes: "five-row verb".into(),
                score: 1.0,
            })
        );
        // Terms only the removed dictionary had no longer match.
        assert!(lookup_from_store(&connection, "詠む").unwrap().is_empty());
        assert_eq!(list_from_store(&connection).unwrap().len(), 1);

        // An ID that is gone, or never existed, changes nothing.
        for id in [1, 3, 0, -1, i64::MAX] {
            assert_eq!(
                remove_from_store(&mut connection, id).unwrap(),
                RemovalStatus::NotFound
            );
        }
        assert_eq!(row_counts(&connection), [1, 1, 2, 1, 1, 1]);
        assert_eq!(
            serde_json::to_string(&[
                RemovalStatus::Removed,
                RemovalStatus::NotFound,
                RemovalStatus::Failed
            ])
            .unwrap(),
            r#"["removed","notFound","failed"]"#
        );

        // The same title and revision imports again, after the remaining dictionary.
        assert_eq!(
            import_one(&mut connection, &first).0,
            ImportStatus::Imported
        );
        let listed: Vec<(i64, String)> = list_from_store(&connection)
            .unwrap()
            .into_iter()
            .map(|dictionary| (dictionary.id, dictionary.title))
            .collect();
        assert_eq!(listed, [(2, "Second".into()), (3, "Fixture".into())]);
        assert_eq!(rows_of(&connection, 3), [5, 4, 1, 1, 3]);
        let terms = &lookup_from_store(&connection, "読む").unwrap()[0].terms;
        assert_eq!(
            terms
                .iter()
                .map(|term| term.dictionary_id)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            terms[1].tags[0].definition.as_ref().unwrap().notes,
            "Godan verb"
        );
        assert_eq!(hash(), hash_before);
    }

    #[test]
    fn a_failing_removal_leaves_every_row() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        for path in [&first, &second_dictionary(directory.path())] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let listed = list_from_store(&connection).unwrap();
        // Tags are deleted last, after the dictionary row and every other row kind.
        connection
            .execute_batch(
                "CREATE TRIGGER refuse BEFORE DELETE ON tags BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        assert!(remove_from_store(&mut connection, 1).is_err());
        assert_eq!(row_counts(&connection), [2, 6, 6, 2, 2, 4]);
        assert_eq!(list_from_store(&connection).unwrap(), listed);
        assert_eq!(lookup_from_store(&connection, "詠む").unwrap().len(), 1);
    }

    /// Each dictionary's ID, stored position, and enabled state, by ID.
    fn stored_states(connection: &Connection) -> Vec<(i64, i64, bool)> {
        connection
            .prepare("SELECT id, position, enabled FROM dictionaries ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn removal(id: i64, status: RemovalStatus) -> DictionaryRemovalResult {
        DictionaryRemovalResult { id, status }
    }

    #[test]
    fn bulk_removal_reports_each_id_and_keeps_the_other_dictionaries() {
        let directory = tempdir().unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let third = third_dictionary(directory.path());
        let hash = |path: &Path| Sha256::digest(std::fs::read(path).unwrap());
        let hashes_before = [hash(&first), hash(&third)];
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        for path in [&first, &second, &third] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        // The dictionary that stays is moved first and turned off.
        assert_eq!(
            move_in_store(&mut connection, 2, 0).unwrap(),
            MoveStatus::Moved
        );
        let kept = only_from(&lookup_from_store(&connection, "読む").unwrap(), 2);
        assert_eq!(
            set_enabled_in_store(&connection, 2, false).unwrap(),
            EnabledStatus::Updated
        );
        let kept_tags: Vec<TagRow> = stored_tags(&connection)
            .into_iter()
            .filter(|tag| tag.0 == 2)
            .collect();
        assert_eq!(
            stored_states(&connection),
            [(1, 2, true), (2, 1, false), (3, 3, true)]
        );

        // Found, unknown, and repeated IDs each get a result, in request order.
        let results = remove_many_from_store(&mut connection, &[1, 99, 1, 3, 0, -1]);
        assert_eq!(
            results,
            [
                removal(1, RemovalStatus::Removed),
                removal(99, RemovalStatus::NotFound),
                removal(1, RemovalStatus::NotFound),
                removal(3, RemovalStatus::Removed),
                removal(0, RemovalStatus::NotFound),
                removal(-1, RemovalStatus::NotFound),
            ]
        );
        assert_eq!(
            serde_json::to_string(&results[..2]).unwrap(),
            r#"[{"id":1,"status":"removed"},{"id":99,"status":"notFound"}]"#
        );
        for id in [1, 3] {
            assert_eq!(rows_of(&connection, id), [0; 5]);
        }
        // The remaining dictionary keeps its rows, tags, position, and enabled state.
        assert_eq!(rows_of(&connection, 2), [1, 2, 1, 1, 1]);
        assert_eq!(row_counts(&connection), [1, 1, 2, 1, 1, 1]);
        assert_eq!(stored_tags(&connection), kept_tags);
        assert_eq!(stored_states(&connection), [(2, 1, false)]);
        assert!(lookup_from_store(&connection, "読む").unwrap().is_empty());
        assert_eq!(
            set_enabled_in_store(&connection, 2, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(
            only_from(&lookup_from_store(&connection, "読む").unwrap(), 2),
            kept
        );
        assert!(remove_many_from_store(&mut connection, &[]).is_empty());

        // Both archives are unchanged and import again, after the remaining dictionary.
        assert_eq!([hash(&first), hash(&third)], hashes_before);
        for path in [&first, &third] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(listed_ids(&connection), [2, 4, 5]);
        assert_eq!(rows_of(&connection, 4), [5, 4, 1, 1, 3]);
    }

    #[test]
    fn a_failing_bulk_removal_keeps_the_other_removals() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let third = third_dictionary(directory.path());
        for path in [&first, &second, &third] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let second_rows = rows_of(&connection, 2);
        // Only the second dictionary's tags, deleted last, refuse to go.
        connection
            .execute_batch(
                "CREATE TRIGGER refuse BEFORE DELETE ON tags WHEN OLD.dictionary = 2 \
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        assert_eq!(
            remove_many_from_store(&mut connection, &[1, 2, 3]),
            [
                removal(1, RemovalStatus::Removed),
                removal(2, RemovalStatus::Failed),
                removal(3, RemovalStatus::Removed),
            ]
        );
        assert_eq!(listed_ids(&connection), [2]);
        assert_eq!(rows_of(&connection, 1), [0; 5]);
        assert_eq!(rows_of(&connection, 2), second_rows);
        assert_eq!(stored_states(&connection), [(2, 2, true)]);
    }

    #[test]
    fn version_two_stores_gain_dictionary_indexes() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let mut connection = open_store(&database).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        // What a version 2 store holds: the same rows without the dictionary indexes.
        connection
            .execute_batch(
                "DROP INDEX terms_dictionary;
                 DROP INDEX term_meta_dictionary;
                 DROP INDEX kanji_dictionary;
                 DROP INDEX kanji_meta_dictionary;
                 ALTER TABLE dictionaries DROP COLUMN enabled;
                 ALTER TABLE dictionaries DROP COLUMN position;
                 ALTER TABLE dictionaries DROP COLUMN has_definitions;
                 ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        drop(connection);

        let mut connection = open_store(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let indexes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE '%_dictionary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, indexes), (SCHEMA_VERSION, 4));
        assert_eq!(row_counts(&connection), [1, 5, 4, 1, 1, 3]);
        assert_eq!(
            remove_from_store(&mut connection, 1).unwrap(),
            RemovalStatus::Removed
        );
        assert_eq!(row_counts(&connection), [0; 6]);
    }

    #[test]
    fn version_three_stores_keep_every_dictionary_on() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let mut connection = open_store(&database).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        let expected = lookup_from_store(&connection, "読む").unwrap();
        // What a version 3 store holds: the same rows without the enabled and position columns.
        connection
            .execute_batch(
                "ALTER TABLE dictionaries DROP COLUMN enabled;
                 ALTER TABLE dictionaries DROP COLUMN position;
                 ALTER TABLE dictionaries DROP COLUMN has_definitions;
                 ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        drop(connection);

        let connection = open_store(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1")]
        );
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), expected);
    }

    #[test]
    fn version_four_stores_keep_import_order() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let mut connection = open_store(&database).unwrap();
        for path in [&first, &second] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let expected = lookup_from_store(&connection, "読む").unwrap();
        // What a version 4 store holds: the same rows without the position column.
        connection
            .execute_batch(
                "ALTER TABLE dictionaries DROP COLUMN position;
                 ALTER TABLE dictionaries DROP COLUMN has_definitions;
                 ALTER TABLE dictionaries DROP COLUMN has_frequency;
                 ALTER TABLE dictionaries DROP COLUMN has_pitch;
                 PRAGMA user_version = 4;",
            )
            .unwrap();
        drop(connection);

        let mut connection = open_store(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(listed_ids(&connection), [1, 2]);
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), expected);
        // A later import still goes last, and moving works on the migrated order.
        let third = third_dictionary(directory.path());
        assert_eq!(
            import_one(&mut connection, &third).0,
            ImportStatus::Imported
        );
        assert_eq!(listed_ids(&connection), [1, 2, 3]);
        assert_eq!(
            move_in_store(&mut connection, 1, 2).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(listed_ids(&connection), [2, 3, 1]);
    }

    fn listed_ids(connection: &Connection) -> Vec<i64> {
        list_from_store(connection)
            .unwrap()
            .into_iter()
            .map(|dictionary| dictionary.id)
            .collect()
    }

    fn third_dictionary(directory: &Path) -> PathBuf {
        fixture_with(
            directory,
            "third.zip",
            &[(
                "index.json",
                r#"{"title":"Third","revision":"1","format":3}"#,
            )],
        )
    }

    /// The dictionary IDs of a lookup's terms, frequency rows, and pitch rows, in returned order.
    fn lookup_sources(groups: &[TermGroup]) -> [Vec<i64>; 3] {
        [
            groups
                .iter()
                .flat_map(|group| group.terms.iter().map(|term| term.dictionary_id))
                .collect(),
            groups
                .iter()
                .flat_map(|group| group.frequencies.iter().map(|item| item.dictionary_id))
                .collect(),
            groups
                .iter()
                .flat_map(|group| group.pitches.iter().map(|item| item.dictionary_id))
                .collect(),
        ]
    }

    /// A group's expression with one dictionary's term scores, frequency data, and pitch data.
    type Contribution = (String, Vec<f64>, Vec<Value>, Vec<Value>);

    /// `groups` with only `id`'s terms, frequency rows, and pitch rows.
    fn only_from(groups: &[TermGroup], id: i64) -> Vec<Contribution> {
        groups
            .iter()
            .map(|group| {
                (
                    group.expression.clone(),
                    group
                        .terms
                        .iter()
                        .filter(|term| term.dictionary_id == id)
                        .map(|term| term.score)
                        .collect(),
                    group
                        .frequencies
                        .iter()
                        .filter(|item| item.dictionary_id == id)
                        .map(|item| item.data.clone())
                        .collect(),
                    group
                        .pitches
                        .iter()
                        .filter(|item| item.dictionary_id == id)
                        .map(|item| item.data.clone())
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn moving_a_dictionary_reorders_the_list_and_lookups() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let mut connection = open_store(&database).unwrap();
        for path in [&first, &second] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let before = lookup_from_store(&connection, "読む").unwrap();
        assert_eq!(
            lookup_sources(&before),
            [vec![1, 2], vec![1, 1, 2], vec![1, 2]]
        );
        let counts = row_counts(&connection);

        // Moving the second dictionary above the first puts its rows first in every lookup;
        // each dictionary's own rows keep their order.
        assert_eq!(
            move_in_store(&mut connection, 2, 0).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(listed_ids(&connection), [2, 1]);
        let after = lookup_from_store(&connection, "読む").unwrap();
        assert_eq!(
            lookup_sources(&after),
            [vec![2, 1], vec![2, 1, 1], vec![2, 1]]
        );
        for id in [1, 2] {
            assert_eq!(only_from(&after, id), only_from(&before, id));
        }
        assert_eq!(after[0].terms[0].tags, before[0].terms[1].tags);
        assert_eq!(row_counts(&connection), counts);
        // Moving it to where it already is changes nothing.
        assert_eq!(
            move_in_store(&mut connection, 2, 0).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), after);

        // The order survives a restart; a new import goes last.
        drop(connection);
        let mut connection = open_store(&database).unwrap();
        assert_eq!(listed_ids(&connection), [2, 1]);
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), after);
        let third = third_dictionary(directory.path());
        assert_eq!(
            import_one(&mut connection, &third).0,
            ImportStatus::Imported
        );
        assert_eq!(listed_ids(&connection), [2, 1, 3]);
        assert_eq!(
            move_in_store(&mut connection, 3, 1).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(listed_ids(&connection), [2, 3, 1]);
        // A position past the end means last.
        assert_eq!(
            move_in_store(&mut connection, 2, u32::MAX as usize).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(listed_ids(&connection), [3, 1, 2]);

        // Removing one keeps the others' order; importing it again puts it last.
        assert_eq!(
            remove_from_store(&mut connection, 1).unwrap(),
            RemovalStatus::Removed
        );
        assert_eq!(listed_ids(&connection), [3, 2]);
        assert_eq!(
            import_one(&mut connection, &first).0,
            ImportStatus::Imported
        );
        assert_eq!(listed_ids(&connection), [3, 2, 4]);
        assert_eq!(
            lookup_sources(&lookup_from_store(&connection, "読む").unwrap()),
            [vec![2, 4], vec![2, 4, 4], vec![2, 4]]
        );

        // Turning one off and on keeps its place.
        set_enabled_in_store(&connection, 2, false).unwrap();
        assert_eq!(listed_ids(&connection), [3, 2, 4]);
        assert_eq!(
            lookup_sources(&lookup_from_store(&connection, "読む").unwrap()),
            [vec![4], vec![4, 4], vec![4]]
        );
        set_enabled_in_store(&connection, 2, true).unwrap();
        assert_eq!(listed_ids(&connection), [3, 2, 4]);
        assert_eq!(
            lookup_sources(&lookup_from_store(&connection, "読む").unwrap()),
            [vec![2, 4], vec![2, 4, 4], vec![2, 4]]
        );

        // An ID that is gone, or never existed, changes nothing.
        for id in [1, 0, -1, i64::MAX] {
            assert_eq!(
                move_in_store(&mut connection, id, 0).unwrap(),
                MoveStatus::NotFound
            );
        }
        assert_eq!(listed_ids(&connection), [3, 2, 4]);
        assert_eq!(
            serde_json::to_string(&[MoveStatus::Moved, MoveStatus::NotFound, MoveStatus::Failed])
                .unwrap(),
            r#"["moved","notFound","failed"]"#
        );
    }

    #[test]
    fn a_failing_move_keeps_the_order() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        for path in [&first, &second] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let expected = lookup_from_store(&connection, "読む").unwrap();
        // The first renumbered row is written, then the second is refused.
        connection
            .execute_batch(
                "CREATE TRIGGER refuse BEFORE UPDATE ON dictionaries WHEN NEW.id = 1
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        assert!(move_in_store(&mut connection, 2, 0).is_err());
        assert_eq!(listed_ids(&connection), [1, 2]);
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), expected);
    }

    /// A dictionary large enough that removing it frees whole pages.
    fn large_dictionary(directory: &Path) -> PathBuf {
        let terms: Vec<String> = (0..2000)
            .map(|row| format!(r#"["大{row}","だい{row}","","",{row},["gloss {row}"],{row},""]"#))
            .collect();
        let meta: Vec<String> = (0..2000)
            .map(|row| format!(r#"["大{row}","freq",{row}]"#))
            .collect();
        let (terms, meta) = (
            format!("[{}]", terms.join(",")),
            format!("[{}]", meta.join(",")),
        );
        let path = directory.join("large.zip");
        write_archive(
            &path,
            &[
                (
                    "index.json",
                    r#"{"title":"Large","revision":"1","format":3}"#,
                ),
                ("term_bank_1.json", &terms),
                ("term_meta_bank_1.json", &meta),
            ],
        );
        path
    }

    /// Everything compaction must keep: the list, the stored order and states, every row count,
    /// each table's rows in stored order, and lookups.
    fn store_contents(connection: &Connection) -> String {
        let dictionaries: Vec<(i64, i64, bool)> = connection
            .prepare("SELECT id, position, enabled FROM dictionaries ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let rows = |sql: &str| -> Vec<(i64, String)> {
            connection
                .prepare(sql)
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        format!(
            "{:?}\n{dictionaries:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
            list_from_store(connection).unwrap(),
            row_counts(connection),
            rows("SELECT dictionary, expression || reading FROM terms ORDER BY rowid"),
            rows("SELECT dictionary, expression || data FROM term_meta ORDER BY rowid"),
            rows("SELECT dictionary, character FROM kanji ORDER BY rowid"),
            stored_tags(connection),
            lookup_from_store(connection, "読む").unwrap(),
            lookup_from_store(connection, "詠む").unwrap(),
        )
    }

    fn pragma(connection: &Connection, name: &str) -> i64 {
        connection
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn compaction_reclaims_removed_rows_and_keeps_every_dictionary() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let large = large_dictionary(directory.path());
        let hash = || Sha256::digest(std::fs::read(&large).unwrap());
        let hash_before = hash();
        let mut connection = open_store(&database).unwrap();
        for path in [
            &large,
            &fixture_with(directory.path(), "first.zip", &fixture_entries()),
            &second_dictionary(directory.path()),
            &third_dictionary(directory.path()),
        ] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        // Reordered, one turned off, and the first-imported (lowest rows) removed.
        move_in_store(&mut connection, 3, 0).unwrap();
        set_enabled_in_store(&connection, 4, false).unwrap();
        assert_eq!(
            remove_from_store(&mut connection, 1).unwrap(),
            RemovalStatus::Removed
        );
        assert!(pragma(&connection, "freelist_count") > 10);
        let contents = store_contents(&connection);
        assert_eq!(
            lookup_sources(&lookup_from_store(&connection, "読む").unwrap()),
            [vec![3, 2], vec![3, 2, 2], vec![3, 2]]
        );
        let size_before = store_size(&database).unwrap();

        let CompactionResult::Compacted {
            size_before: reported_before,
            size_after,
        } = compact_store(&connection, &database).unwrap()
        else {
            panic!("the store was not compacted");
        };
        assert_eq!(reported_before, size_before);
        assert!(size_after < size_before, "{size_after} < {size_before}");
        // The log is emptied into a database file that has no free pages left.
        assert_eq!(size_after, store_size(&database).unwrap());
        assert_eq!(size_after, std::fs::metadata(&database).unwrap().len());
        assert_eq!(pragma(&connection, "freelist_count"), 0);
        assert_eq!(
            size_after as i64,
            pragma(&connection, "page_count") * pragma(&connection, "page_size")
        );
        assert_eq!(store_contents(&connection), contents);

        // Compacting again, and restarting, change nothing.
        assert!(matches!(
            compact_store(&connection, &database).unwrap(),
            CompactionResult::Compacted { size_after: again, .. } if again == size_after
        ));
        drop(connection);
        let mut connection = open_store(&database).unwrap();
        assert_eq!(store_contents(&connection), contents);
        // The removed dictionary imports again, last, under a new ID.
        assert_eq!(
            import_one(&mut connection, &large).0,
            ImportStatus::Imported
        );
        assert_eq!(listed_ids(&connection), [3, 2, 4, 5]);
        assert_eq!(lookup_from_store(&connection, "大7").unwrap().len(), 1);
        assert_eq!(hash(), hash_before);

        assert_eq!(
            serde_json::to_string(&[
                CompactionResult::Compacted {
                    size_before: 3,
                    size_after: 2
                },
                CompactionResult::Failed
            ])
            .unwrap(),
            r#"[{"status":"compacted","sizeBefore":3,"sizeAfter":2},{"status":"failed"}]"#
        );
    }

    #[test]
    fn a_small_removal_keeps_every_lookup_and_skips_compaction() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let large = large_dictionary(directory.path());
        let mut connection = open_store(&database).unwrap();
        for path in [
            &large,
            &fixture_with(directory.path(), "first.zip", &fixture_entries()),
            &second_dictionary(directory.path()),
        ] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let survivor = only_from(&lookup_from_store(&connection, "読む").unwrap(), 3);
        let batch = remove_and_reclaim(
            &mut connection,
            &database,
            &[1],
            &mut BatchProgress::silent(),
            COMPACTION_MINIMUM_FREE,
        );
        assert_eq!(batch.results, [removal(1, RemovalStatus::Removed)]);
        assert_eq!(batch.maintenance, Some(CompactionResult::NotNeeded));
        let free = pragma(&connection, "freelist_count");
        assert!(free > 0);
        assert_eq!(listed_ids(&connection), [2, 3]);
        assert!(lookup_from_store(&connection, "大7").unwrap().is_empty());
        assert_eq!(
            only_from(&lookup_from_store(&connection, "読む").unwrap(), 3),
            survivor
        );
        let contents = store_contents(&connection);
        drop(connection);
        let mut connection = open_store(&database).unwrap();
        assert_eq!(store_contents(&connection), contents);
        // The next import reuses the free pages and the removed dictionary comes back.
        assert_eq!(
            import_one(&mut connection, &large).0,
            ImportStatus::Imported
        );
        assert!(pragma(&connection, "freelist_count") < free);
        assert_eq!(listed_ids(&connection), [2, 3, 4]);
        assert_eq!(lookup_from_store(&connection, "大7").unwrap().len(), 1);
    }

    #[test]
    fn a_failing_compaction_keeps_the_store_usable() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let mut connection = open_store(&database).unwrap();
        for path in [
            &large_dictionary(directory.path()),
            &fixture_with(directory.path(), "first.zip", &fixture_entries()),
        ] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        remove_from_store(&mut connection, 1).unwrap();
        let contents = store_contents(&connection);
        connection.busy_timeout(std::time::Duration::ZERO).unwrap();
        let other = Connection::open(&database).unwrap();

        // Another writer keeps VACUUM from starting; a reader keeps the log from being copied
        // back. Either way the store is unchanged and stays usable.
        for hold in ["BEGIN IMMEDIATE", "BEGIN; SELECT COUNT(*) FROM terms;"] {
            other.execute_batch(hold).unwrap();
            assert!(compact_store(&connection, &database).is_err(), "{hold}");
            assert_eq!(store_contents(&connection), contents);
            other.execute_batch("ROLLBACK").unwrap();
            assert_eq!(store_contents(&other), contents);
        }
        let second = second_dictionary(directory.path());
        assert_eq!(
            import_one(&mut connection, &second).0,
            ImportStatus::Imported
        );
        assert_eq!(listed_ids(&connection), [2, 3]);
        remove_from_store(&mut connection, 3).unwrap();
        assert!(matches!(
            compact_store(&connection, &database).unwrap(),
            CompactionResult::Compacted { .. }
        ));
        assert_eq!(store_contents(&connection), contents);
        assert_eq!(pragma(&connection, "freelist_count"), 0);
    }

    #[test]
    fn a_turned_off_dictionary_matches_nothing_until_turned_back_on() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let first = fixture_with(directory.path(), "first.zip", &fixture_entries());
        let second = second_dictionary(directory.path());
        let mut connection = open_store(&database).unwrap();
        for path in [&first, &second] {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let both = lookup_from_store(&connection, "読む").unwrap();
        let only_first = lookup_from_store(&connection, "詠む").unwrap();
        // What the second dictionary alone contributes to a lookup that both match.
        let mut second_only = lookup_from_store(&connection, "読む").unwrap();
        for group in &mut second_only {
            group.terms.retain(|term| term.dictionary_id == 2);
            group.frequencies.retain(|item| item.dictionary_id == 2);
            group.pitches.retain(|item| item.dictionary_id == 2);
        }
        assert_eq!(second_only[0].terms.len(), 1);
        assert_eq!(second_only[0].frequencies.len(), 1);
        assert_eq!(second_only[0].pitches.len(), 1);
        second_only.retain(|group| !group.terms.is_empty());
        let counts = row_counts(&connection);

        assert_eq!(
            set_enabled_in_store(&connection, 1, false).unwrap(),
            EnabledStatus::Updated
        );
        let enabled = |connection: &Connection| -> Vec<(i64, bool)> {
            list_from_store(connection)
                .unwrap()
                .into_iter()
                .map(|dictionary| (dictionary.id, dictionary.enabled))
                .collect()
        };
        assert_eq!(enabled(&connection), [(1, false), (2, true)]);
        // Its terms, frequencies, pitches, and tags leave the lookup; its rows stay.
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), second_only);
        assert!(lookup_from_store(&connection, "詠む").unwrap().is_empty());
        assert_eq!(row_counts(&connection), counts);
        // Turning it off again is not an error.
        assert_eq!(
            set_enabled_in_store(&connection, 1, false).unwrap(),
            EnabledStatus::Updated
        );

        // The state survives a restart, another import, and another removal.
        drop(connection);
        let mut connection = open_store(&database).unwrap();
        assert_eq!(enabled(&connection), [(1, false), (2, true)]);
        let third = fixture_with(
            directory.path(),
            "third.zip",
            &[(
                "index.json",
                r#"{"title":"Third","revision":"1","format":3}"#,
            )],
        );
        assert_eq!(
            import_one(&mut connection, &third).0,
            ImportStatus::Imported
        );
        assert_eq!(enabled(&connection), [(1, false), (2, true), (3, true)]);
        assert_eq!(
            remove_from_store(&mut connection, 3).unwrap(),
            RemovalStatus::Removed
        );
        assert_eq!(enabled(&connection), [(1, false), (2, true)]);
        assert!(lookup_from_store(&connection, "詠む").unwrap().is_empty());

        // Turning it back on restores the same lookup.
        assert_eq!(
            set_enabled_in_store(&connection, 1, true).unwrap(),
            EnabledStatus::Updated
        );
        assert_eq!(lookup_from_store(&connection, "読む").unwrap(), both);
        assert_eq!(lookup_from_store(&connection, "詠む").unwrap(), only_first);

        // Turning both off leaves no match at all.
        for id in [1, 2] {
            set_enabled_in_store(&connection, id, false).unwrap();
        }
        assert!(lookup_from_store(&connection, "読む").unwrap().is_empty());

        // An ID that is gone, or never existed, changes nothing.
        for id in [3, 0, -1, i64::MAX] {
            assert_eq!(
                set_enabled_in_store(&connection, id, true).unwrap(),
                EnabledStatus::NotFound
            );
        }
        assert_eq!(enabled(&connection), [(1, false), (2, false)]);
        assert_eq!(
            serde_json::to_string(&[
                EnabledStatus::Updated,
                EnabledStatus::NotFound,
                EnabledStatus::Failed
            ])
            .unwrap(),
            r#"["updated","notFound","failed"]"#
        );
        assert_eq!(
            serde_json::to_value(&list_from_store(&connection).unwrap()[0]).unwrap()["enabled"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn a_failing_enabled_change_keeps_the_state() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        connection
            .execute_batch(
                "CREATE TRIGGER refuse BEFORE UPDATE ON dictionaries BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        assert!(set_enabled_in_store(&connection, 1, false).is_err());
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1")]
        );
        assert_eq!(lookup_from_store(&connection, "詠む").unwrap().len(), 1);
    }

    #[test]
    fn large_banks_keep_their_row_order_through_parallel_compression() {
        let directory = tempdir().unwrap();
        let rows: Vec<String> = (0..1001)
            .map(|row| format!(r#"["語{row}","ご","","",{row},["gloss {row}"],{row},""]"#))
            .collect();
        let bank = format!("[{}]", rows.join(","));
        let archive = fixture_with(
            directory.path(),
            "large.zip",
            &[("index.json", INDEX), ("term_bank_1.json", &bank)],
        );
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );

        let stored: Vec<(String, String)> = connection
            .prepare("SELECT expression, glossary FROM terms ORDER BY rowid")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, inflate(&row.get::<_, Vec<u8>>(1)?)))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(stored.len(), 1001);
        for (row, (expression, glossary)) in stored.iter().enumerate() {
            assert_eq!(expression, &format!("語{row}"));
            assert_eq!(glossary, &format!(r#"["gloss {row}"]"#));
        }
    }

    #[test]
    fn a_failing_bank_rolls_back_the_whole_archive() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        // Earlier term banks and later bank kinds would be written in the same transaction.
        for (name, contents) in [
            ("term_bank_10.json", r#"[["本"]]"#),
            ("kanji_meta_bank_1.json", r#"[["本","pitch",10]]"#),
            // Tags are written last, after every other bank kind.
            ("tag_bank_2.json", r#"[["jouyou","frequent",0,""]]"#),
        ] {
            let archive = fixture_with(directory.path(), "broken.zip", &replaced(name, contents));
            assert_eq!(
                import_one(&mut connection, &archive),
                (ImportStatus::Invalid, Some("Fixture".into()))
            );
            assert_eq!(row_counts(&connection), [0; 6]);
        }

        // The same title and revision imports once fixed; the refusal left nothing behind.
        let archive = fixture_with(directory.path(), "fixed.zip", &fixture_entries());
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        assert_eq!(row_counts(&connection), [1, 5, 4, 1, 1, 3]);
    }

    #[test]
    fn duplicates_are_refused_by_title_and_revision() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let copy = fixture_with(directory.path(), "copy.zip", &fixture_entries());
        let revised = fixture_with(
            directory.path(),
            "revised.zip",
            &replaced(
                "index.json",
                r#"{"title":"Fixture","revision":"fixture-2","format":3}"#,
            ),
        );

        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        for path in [&archive, &copy] {
            assert_eq!(
                import_one(&mut connection, path),
                (ImportStatus::AlreadyImported, Some("Fixture".into()))
            );
        }
        assert_eq!(row_counts(&connection), [1, 5, 4, 1, 1, 3]);

        assert_eq!(
            import_one(&mut connection, &revised).0,
            ImportStatus::Imported
        );
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1"), summary(2, "fixture-2")]
        );
    }

    #[test]
    fn batch_reports_each_archive_by_file_name_only() {
        let directory = tempdir().unwrap();
        let mut connection = open_store(&directory.path().join(DATABASE_FILE_NAME)).unwrap();
        let valid = fixture_with(directory.path(), "valid.zip", &fixture_entries());
        let not_zip = directory.path().join("notes.zip");
        std::fs::write(&not_zip, "not an archive").unwrap();
        let format_one = fixture_with(
            directory.path(),
            "old.zip",
            &[("index.json", r#"{"title":"Old","revision":"1","format":1}"#)],
        );
        let missing = directory.path().join("missing.zip");

        let results = import_paths(
            &mut connection,
            &[valid.clone(), not_zip, format_one, missing, valid],
        );
        let result = |file_name: &str, status, title: Option<&str>| DictionaryImportResult {
            file_name: file_name.into(),
            status,
            title: title.map(Into::into),
        };
        assert_eq!(
            results,
            vec![
                result("valid.zip", ImportStatus::Imported, Some("Fixture")),
                result("notes.zip", ImportStatus::Invalid, None),
                result("old.zip", ImportStatus::Invalid, None),
                result("missing.zip", ImportStatus::Unreadable, None),
                result("valid.zip", ImportStatus::AlreadyImported, Some("Fixture")),
            ]
        );

        let json = serde_json::to_string(&DictionaryImportBatch {
            canceled: false,
            results,
        })
        .unwrap();
        assert!(json.starts_with(
            r#"{"canceled":false,"results":[{"fileName":"valid.zip","status":"imported","title":"Fixture"}"#
        ));
        assert!(json.contains(r#""status":"alreadyImported""#));
        let private = directory.path().to_string_lossy().replace('\\', "\\\\");
        assert!(!json.contains(&private));
        let list = serde_json::to_string(&list_from_store(&connection).unwrap()).unwrap();
        assert_eq!(
            list,
            r#"[{"id":1,"title":"Fixture","revision":"fixture-1","enabled":true,"termCount":5,"termMetaCount":4,"kanjiCount":1,"kanjiMetaCount":1,"hasDefinitions":true,"hasFrequency":true,"hasPitch":true}]"#
        );
    }

    #[test]
    fn imports_persist_across_restart_and_leave_archives_unchanged() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let archive = fixture_with(directory.path(), "fixture.zip", &fixture_entries());
        let hash = || Sha256::digest(std::fs::read(&archive).unwrap());
        let modified = || std::fs::metadata(&archive).unwrap().modified().unwrap();
        let (hash_before, modified_before) = (hash(), modified());

        let mut connection = open_store(&database).unwrap();
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::Imported
        );
        drop(connection);

        let mut connection = open_store(&database).unwrap();
        assert_eq!(
            list_from_store(&connection).unwrap(),
            vec![summary(1, "fixture-1")]
        );
        assert_eq!(row_counts(&connection), [1, 5, 4, 1, 1, 3]);
        assert_eq!(
            import_one(&mut connection, &archive).0,
            ImportStatus::AlreadyImported
        );
        assert_eq!((hash(), modified()), (hash_before, modified_before));
    }

    #[test]
    fn schema_is_created_once_and_newer_versions_are_refused() {
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let connection = open_store(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let journal: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let indexes: Vec<String> = connection
            .prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!((version, journal.as_str()), (SCHEMA_VERSION, "wal"));
        assert_eq!(
            indexes,
            [
                "kanji_character",
                "kanji_dictionary",
                "kanji_meta_character",
                "kanji_meta_dictionary",
                "tags_dictionary_name",
                "term_meta_dictionary",
                "term_meta_expression",
                "terms_dictionary",
                "terms_expression",
                "terms_reading"
            ]
        );
        // Removal finds a dictionary's rows through an index instead of scanning every row.
        for table in ["terms", "term_meta", "kanji", "kanji_meta", "tags"] {
            let plan: String = connection
                .query_row(
                    &format!("EXPLAIN QUERY PLAN DELETE FROM {table} WHERE dictionary = 1"),
                    [],
                    |row| row.get(3),
                )
                .unwrap();
            assert!(
                plan.contains("USING INDEX") || plan.contains("USING COVERING INDEX"),
                "{plan}"
            );
        }
        assert!(list_from_store(&connection).unwrap().is_empty());
        drop(connection);

        assert!(open_store(&database).is_ok());
        Connection::open(&database)
            .unwrap()
            .execute_batch("PRAGMA user_version = 9")
            .unwrap();
        assert!(open_store(&database).is_err());
    }

    /// Exercises maintenance with real archives in a temporary store only. Unlike the import
    /// helper, this deliberately never accepts KOMORI_DICTIONARY_DATABASE.
    #[test]
    #[ignore = "requires overlapping term, kanji, and kanji-frequency archives; temporary store only"]
    fn real_dictionary_maintenance() {
        let archives = std::env::var("KOMORI_DICTIONARY_SAMPLES")
            .expect("set KOMORI_DICTIONARY_SAMPLES to |-separated archive paths");
        let paths: Vec<PathBuf> = archives.split('|').map(PathBuf::from).collect();
        assert!(paths.len() >= 3, "supply at least three distinct archives");
        let hashes: Vec<_> = paths
            .iter()
            .map(|path| Sha256::digest(std::fs::read(path).unwrap()))
            .collect();
        let directory = tempdir().unwrap();
        let database = directory.path().join(DATABASE_FILE_NAME);
        let mut connection = open_store(&database).unwrap();
        for path in &paths {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        let original_list = list_from_store(&connection).unwrap();
        // Audit the Reader policy on real imports in this disposable store too.
        use super::super::sources::SourceSelection::{None, Selected};
        let definition_ids: Vec<_> = original_list
            .iter()
            .filter(|s| s.term_count > 0 || s.kanji_count > 0)
            .map(|s| s.id)
            .collect();
        let frequency_ids: Vec<_> = original_list
            .iter()
            .filter(|s| s.has_frequency)
            .map(|s| s.id)
            .collect();
        let pitch_ids: Vec<_> = original_list
            .iter()
            .filter(|s| s.has_pitch)
            .map(|s| s.id)
            .collect();
        let explicit = SourcePolicy {
            definitions: Selected {
                ids: definition_ids.clone(),
            },
            frequency: Selected { ids: frequency_ids },
            pitch: Selected { ids: pitch_ids },
        };
        for query in ["読む", "読んだ", "日本語です", "本"] {
            let all = lookup_longest_start_from_store(&connection, query).unwrap();
            assert_eq!(
                lookup_longest_start_with_sources(&connection, query, &explicit).unwrap(),
                all
            );
            let mut policy = explicit.clone();
            policy.frequency = None;
            policy.pitch = None;
            let definitions =
                lookup_longest_start_with_sources(&connection, query, &policy).unwrap();
            assert_eq!(definitions.text, all.text);
            assert!(definitions
                .groups
                .iter()
                .all(|g| g.frequencies.is_empty() && g.pitches.is_empty()));
            policy.definitions = None;
            assert!(
                lookup_longest_start_with_sources(&connection, query, &policy)
                    .unwrap()
                    .groups
                    .is_empty()
            );
        }
        for id in definition_ids {
            let mut policy = explicit.clone();
            policy.definitions = Selected { ids: vec![id] };
            assert!(
                lookup_longest_start_with_sources(&connection, "読んだ", &policy)
                    .unwrap()
                    .groups
                    .iter()
                    .flat_map(|g| &g.terms)
                    .all(|row| row.dictionary_id == id)
            );
        }
        assert_eq!(
            lookup_kanji_with_sources(&connection, "本", &explicit).unwrap(),
            lookup_kanji_from_store(&connection, "本").unwrap()
        );
        println!("Real Reader source policies: all/explicit/none, exact/inflected/shorter starts and kanji passed.");
        let queries = std::env::var("KOMORI_TERM_QUERY")
            .unwrap_or_else(|_| "読む|読まされていました|日本語で|本".into());
        let terms = |connection: &Connection| {
            queries
                .split('|')
                .map(|query| lookup_longest_start_from_store(connection, query).unwrap())
                .collect::<Vec<_>>()
        };
        let original_terms = terms(&connection);
        assert!(original_terms
            .iter()
            .all(|result| !result.groups.is_empty()));
        let original_kanji = lookup_kanji_from_store(&connection, "本").unwrap();
        assert!(!original_kanji.entries.is_empty());
        assert!(!original_kanji.frequencies.is_empty());

        // Each real source disappears from every result kind while disabled, then returns
        // byte-for-byte in the DTOs without losing rows or its position.
        let counts = row_counts(&connection);
        for dictionary in &original_list {
            let id = dictionary.id;
            assert_eq!(
                set_enabled_in_store(&connection, id, false).unwrap(),
                EnabledStatus::Updated
            );
            for result in terms(&connection) {
                for group in result.groups {
                    assert!(group.terms.iter().all(|row| row.dictionary_id != id));
                    assert!(group.frequencies.iter().all(|row| row.dictionary_id != id));
                    assert!(group.pitches.iter().all(|row| row.dictionary_id != id));
                }
            }
            let kanji = lookup_kanji_from_store(&connection, "本").unwrap();
            assert!(kanji.entries.iter().all(|row| row.dictionary_id != id));
            assert!(kanji.frequencies.iter().all(|row| row.dictionary_id != id));
            assert_eq!(
                set_enabled_in_store(&connection, id, true).unwrap(),
                EnabledStatus::Updated
            );
            assert_eq!(terms(&connection), original_terms);
            assert_eq!(
                lookup_kanji_from_store(&connection, "本").unwrap(),
                original_kanji
            );
            assert_eq!(row_counts(&connection), counts);
        }
        assert_eq!(list_from_store(&connection).unwrap(), original_list);

        // Use a shared headword from the smallest term source, rather than assuming that
        // a corpus contains a particular word in two dictionaries.
        let shared_id = original_list
            .iter()
            .filter(|row| row.term_count > 0)
            .min_by_key(|row| row.term_count)
            .unwrap()
            .id;
        let shared_query: String = connection
            .query_row(
                "SELECT a.expression FROM terms a WHERE a.dictionary = ?1 AND EXISTS (
                SELECT 1 FROM terms b WHERE b.expression = a.expression
                AND b.reading = a.reading AND b.dictionary <> a.dictionary) LIMIT 1",
                [shared_id],
                |row| row.get(0),
            )
            .expect("supply two term dictionaries with a shared expression and reading");
        let shared_before = lookup_from_store(&connection, &shared_query).unwrap();
        let last_id = shared_id;
        assert_eq!(
            move_in_store(&mut connection, last_id, 0).unwrap(),
            MoveStatus::Moved
        );
        assert_eq!(listed_ids(&connection)[0], last_id);
        let shared_after = lookup_from_store(&connection, &shared_query).unwrap();
        for group in &shared_after {
            if group.terms.iter().any(|row| row.dictionary_id == shared_id) {
                assert_eq!(group.terms[0].dictionary_id, shared_id);
            }
        }
        for dictionary in &original_list {
            assert_eq!(
                only_from(&shared_after, dictionary.id),
                only_from(&shared_before, dictionary.id)
            );
        }
        let reordered = list_from_store(&connection).unwrap();
        let reordered_terms = terms(&connection);
        let reordered_kanji = lookup_kanji_from_store(&connection, "本").unwrap();
        drop(connection);
        connection = open_store(&database).unwrap();
        assert_eq!(list_from_store(&connection).unwrap(), reordered);
        assert_eq!(terms(&connection), reordered_terms);
        assert_eq!(
            lookup_kanji_from_store(&connection, "本").unwrap(),
            reordered_kanji
        );

        let removed_ids: Vec<_> = original_list.iter().take(2).map(|row| row.id).collect();
        let removed = remove_many_from_store(&mut connection, &removed_ids);
        assert!(removed
            .iter()
            .all(|row| row.status == RemovalStatus::Removed));
        for table in ["terms", "term_meta", "kanji", "kanji_meta", "tags"] {
            for id in &removed_ids {
                let remaining: i64 = connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE dictionary = ?1"),
                        [id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(remaining, 0);
            }
        }
        let retained_list = list_from_store(&connection).unwrap();
        let retained_terms = terms(&connection);
        let retained_kanji = lookup_kanji_from_store(&connection, "本").unwrap();
        let CompactionResult::Compacted {
            size_before,
            size_after,
        } = compact_store(&connection, &database).unwrap()
        else {
            panic!("the store was not compacted");
        };
        assert!(size_after < size_before);
        assert_eq!(list_from_store(&connection).unwrap(), retained_list);
        assert_eq!(terms(&connection), retained_terms);
        assert_eq!(
            lookup_kanji_from_store(&connection, "本").unwrap(),
            retained_kanji
        );
        for path in paths.iter().take(2) {
            assert_eq!(import_one(&mut connection, path).0, ImportStatus::Imported);
        }
        assert_eq!(row_counts(&connection), counts);
        for original in &original_list {
            let reimported = list_from_store(&connection)
                .unwrap()
                .into_iter()
                .find(|row| row.title == original.title && row.revision == original.revision)
                .unwrap();
            assert_eq!(reimported.term_count, original.term_count);
            assert_eq!(reimported.term_meta_count, original.term_meta_count);
            assert_eq!(reimported.kanji_count, original.kanji_count);
            assert_eq!(reimported.kanji_meta_count, original.kanji_meta_count);
        }
        for (path, hash) in paths.iter().zip(hashes) {
            assert_eq!(Sha256::digest(std::fs::read(path).unwrap()), hash);
        }
        println!("{} archives: disable/enable, reorder/reopen, remove two, compact ({size_before} → {size_after} bytes), reimport; SHA-256 unchanged", paths.len());
    }

    /// Imports `KOMORI_DICTIONARY_SAMPLES` (`|`-separated archive paths) into a temporary store,
    /// or into `KOMORI_DICTIONARY_DATABASE` when set, printing each title, status, and time, then
    /// each stored dictionary's row counts and the store's size (never paths). Every archive's
    /// bytes must stay unchanged.
    #[test]
    #[ignore = "requires explicit real dictionary archives; run with --release"]
    fn real_dictionary_import() {
        let archives = std::env::var("KOMORI_DICTIONARY_SAMPLES")
            .expect("set KOMORI_DICTIONARY_SAMPLES to |-separated archive paths");
        let directory = tempdir().unwrap();
        let database = std::env::var_os("KOMORI_DICTIONARY_DATABASE")
            .map_or_else(|| directory.path().join(DATABASE_FILE_NAME), PathBuf::from);
        let paths: Vec<PathBuf> = archives.split('|').map(PathBuf::from).collect();
        let hashes: Vec<_> = paths
            .iter()
            .map(|path| Sha256::digest(std::fs::read(path).unwrap()))
            .collect();
        let mut connection = open_store(&database).unwrap();
        for path in &paths {
            let started = Instant::now();
            let (status, title) = import_one(&mut connection, path);
            println!(
                "{} | {status:?} | {:.1} s",
                title.unwrap_or_default(),
                started.elapsed().as_secs_f64()
            );
        }
        for dictionary in list_from_store(&connection).unwrap() {
            let tags: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM tags WHERE dictionary = ?1",
                    [dictionary.id],
                    |row| row.get(0),
                )
                .unwrap();
            println!(
                "{} | {} | [{}, {}, {}, {}] | {tags} tags",
                dictionary.id,
                dictionary.title,
                dictionary.term_count,
                dictionary.term_meta_count,
                dictionary.kanji_count,
                dictionary.kanji_meta_count
            );
        }
        drop(connection);
        println!(
            "store: {:.0} MiB",
            std::fs::metadata(&database).unwrap().len() as f64 / 1_048_576.0
        );
        for (path, hash) in paths.iter().zip(hashes) {
            assert_eq!(Sha256::digest(std::fs::read(path).unwrap()), hash);
        }
    }
}
