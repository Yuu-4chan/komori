//! Read-only reading of a dictionary archive (`index.json` plus the term, term-meta,
//! kanji, kanji-meta, and tag banks at the archive root). The archive is opened read-only and never
//! written. Archive entry names in errors are native diagnostics and never reach the frontend.

use std::{fs::File, io::Read, path::Path};

use serde::{
    de::{DeserializeOwned, Error as _, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::value::RawValue;
use zip::{read::ZipReadOptions, ZipArchive};

const INDEX_ENTRY: &str = "index.json";
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
/// The largest bank in the real corpus is about 190 MB; this bounds a hostile entry.
const MAX_BANK_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum DictionaryArchiveError {
    /// The file could not be opened or read.
    Unreadable,
    /// The file is not a ZIP archive.
    NotArchive,
    MissingIndex,
    /// `index.json` is not valid JSON or lacks a title, revision, or format.
    InvalidIndex,
    /// Only formats 2 and 3 share the bank layout read here; format 1 is not supported.
    UnsupportedFormat(u64),
    EntryTooLarge {
        entry: String,
    },
    UnreadableEntry {
        entry: String,
    },
    /// A bank is not a JSON array of well-formed rows.
    InvalidBank {
        entry: String,
        detail: String,
    },
}

/// A native diagnostic; archive entry names never reach the frontend.
impl std::fmt::Display for DictionaryArchiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => write!(formatter, "unreadable file"),
            Self::NotArchive => write!(formatter, "not a ZIP archive"),
            Self::MissingIndex => write!(formatter, "no root index.json"),
            Self::InvalidIndex => write!(formatter, "invalid index.json"),
            Self::UnsupportedFormat(format) => write!(formatter, "unsupported format {format}"),
            Self::EntryTooLarge { entry } => write!(formatter, "{entry} is too large"),
            Self::UnreadableEntry { entry } => write!(formatter, "{entry} is unreadable"),
            Self::InvalidBank { entry, detail } => {
                write!(formatter, "{entry} is invalid: {detail}")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrequencyMode {
    OccurrenceBased,
    RankBased,
}

impl FrequencyMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FrequencyMode::OccurrenceBased => "occurrence-based",
            FrequencyMode::RankBased => "rank-based",
        }
    }
}

#[derive(Debug)]
pub(crate) struct DictionaryIndex {
    pub(crate) title: String,
    pub(crate) revision: String,
    pub(crate) format: u64,
    pub(crate) sequenced: bool,
    pub(crate) author: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) attribution: Option<String>,
    pub(crate) source_language: Option<String>,
    pub(crate) target_language: Option<String>,
    pub(crate) frequency_mode: Option<FrequencyMode>,
    pub(crate) tag_meta: Vec<TagEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BankKind {
    Term,
    TermMeta,
    Kanji,
    KanjiMeta,
    Tag,
}

impl BankKind {
    const ALL: [BankKind; 5] = [
        BankKind::Term,
        BankKind::TermMeta,
        BankKind::Kanji,
        BankKind::KanjiMeta,
        BankKind::Tag,
    ];

    fn prefix(self) -> &'static str {
        match self {
            BankKind::Term => "term_bank_",
            BankKind::TermMeta => "term_meta_bank_",
            BankKind::Kanji => "kanji_bank_",
            BankKind::KanjiMeta => "kanji_meta_bank_",
            BankKind::Tag => "tag_bank_",
        }
    }

    fn position(self) -> usize {
        self as usize
    }
}

#[derive(Debug)]
pub(crate) struct TermEntry {
    pub(crate) expression: String,
    /// The reading, or the expression when the bank leaves it empty.
    pub(crate) reading: String,
    pub(crate) definition_tags: String,
    pub(crate) rules: String,
    pub(crate) score: f64,
    /// The glossary as its original JSON array text.
    pub(crate) glossary: Box<RawValue>,
    pub(crate) sequence: i64,
    pub(crate) term_tags: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TermMetaMode {
    Frequency,
    Pitch,
    Ipa,
}

impl TermMetaMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TermMetaMode::Frequency => "freq",
            TermMetaMode::Pitch => "pitch",
            TermMetaMode::Ipa => "ipa",
        }
    }
}

#[derive(Debug)]
pub(crate) struct TermMetaEntry {
    pub(crate) expression: String,
    pub(crate) mode: TermMetaMode,
    /// The mode's data as its original JSON text.
    pub(crate) data: Box<RawValue>,
}

#[derive(Debug)]
pub(crate) struct KanjiEntry {
    pub(crate) character: String,
    pub(crate) onyomi: String,
    pub(crate) kunyomi: String,
    pub(crate) tags: String,
    pub(crate) meanings: Vec<String>,
    /// The stats object as its original JSON text.
    pub(crate) stats: Box<RawValue>,
}

/// Kanji meta rows only carry frequencies.
#[derive(Debug)]
pub(crate) struct KanjiMetaEntry {
    pub(crate) character: String,
    pub(crate) data: Box<RawValue>,
}

/// A tag definition: the name that term, kanji, and pitch rows refer to, its category, sorting
/// order, notes, and popularity score.
#[derive(Debug)]
pub(crate) struct TagEntry {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) order: f64,
    pub(crate) notes: String,
    pub(crate) score: f64,
}

pub(crate) struct DictionaryArchive {
    archive: ZipArchive<File>,
    index: DictionaryIndex,
    /// Root-level bank entry names per kind, in bank-number order.
    banks: [Vec<String>; 5],
}

impl DictionaryArchive {
    pub(crate) fn open(path: &Path) -> Result<Self, DictionaryArchiveError> {
        let file = File::open(path).map_err(|_| DictionaryArchiveError::Unreadable)?;
        let mut archive = ZipArchive::new(file).map_err(|error| match error {
            zip::result::ZipError::Io(_) => DictionaryArchiveError::Unreadable,
            _ => DictionaryArchiveError::NotArchive,
        })?;
        if archive.index_for_name(INDEX_ENTRY).is_none() {
            return Err(DictionaryArchiveError::MissingIndex);
        }
        let index = parse_index(&read_entry(&mut archive, INDEX_ENTRY, MAX_INDEX_BYTES)?)?;
        let banks = BankKind::ALL.map(|kind| bank_entries(&archive, kind));
        Ok(Self {
            archive,
            index,
            banks,
        })
    }

    pub(crate) fn index(&self) -> &DictionaryIndex {
        &self.index
    }

    pub(crate) fn bank_count(&self, kind: BankKind) -> usize {
        self.banks[kind.position()].len()
    }

    pub(crate) fn read_term_bank(
        &mut self,
        position: usize,
    ) -> Result<Vec<TermEntry>, DictionaryArchiveError> {
        self.read_bank(BankKind::Term, position, |row: TermRow| {
            if !row.5.get().starts_with('[') {
                return Err("glossary is not an array");
            }
            let reading = if row.1.is_empty() {
                row.0.clone()
            } else {
                row.1
            };
            Ok(TermEntry {
                expression: row.0,
                reading,
                definition_tags: row.2.unwrap_or_default(),
                rules: row.3.unwrap_or_default(),
                score: row.4,
                glossary: row.5,
                sequence: row.6,
                term_tags: row.7.unwrap_or_default(),
            })
        })
    }

    pub(crate) fn read_term_meta_bank(
        &mut self,
        position: usize,
    ) -> Result<Vec<TermMetaEntry>, DictionaryArchiveError> {
        self.read_bank(BankKind::TermMeta, position, |row: TermMetaRow| {
            let mode = match row.1.as_str() {
                "freq" => TermMetaMode::Frequency,
                "pitch" => TermMetaMode::Pitch,
                "ipa" => TermMetaMode::Ipa,
                _ => return Err("unknown term meta mode"),
            };
            Ok(TermMetaEntry {
                expression: row.0,
                mode,
                data: row.2,
            })
        })
    }

    pub(crate) fn read_kanji_bank(
        &mut self,
        position: usize,
    ) -> Result<Vec<KanjiEntry>, DictionaryArchiveError> {
        self.read_bank(BankKind::Kanji, position, |row: KanjiRow| {
            if !row.5.get().starts_with('{') {
                return Err("kanji stats are not an object");
            }
            Ok(KanjiEntry {
                character: row.0,
                onyomi: row.1,
                kunyomi: row.2,
                tags: row.3,
                meanings: row.4,
                stats: row.5,
            })
        })
    }

    pub(crate) fn read_kanji_meta_bank(
        &mut self,
        position: usize,
    ) -> Result<Vec<KanjiMetaEntry>, DictionaryArchiveError> {
        self.read_bank(BankKind::KanjiMeta, position, |row: TermMetaRow| {
            if row.1 != "freq" {
                return Err("unknown kanji meta mode");
            }
            Ok(KanjiMetaEntry {
                character: row.0,
                data: row.2,
            })
        })
    }

    pub(crate) fn read_tag_bank(
        &mut self,
        position: usize,
    ) -> Result<Vec<TagEntry>, DictionaryArchiveError> {
        self.read_bank(BankKind::Tag, position, |row: TagRow| {
            Ok(TagEntry {
                name: row.0,
                category: row.1,
                order: row.2,
                notes: row.3,
                score: row.4,
            })
        })
    }

    fn read_bank<Row: DeserializeOwned, Entry>(
        &mut self,
        kind: BankKind,
        position: usize,
        convert: impl Fn(Row) -> Result<Entry, &'static str>,
    ) -> Result<Vec<Entry>, DictionaryArchiveError> {
        let entry = self.banks[kind.position()][position].clone();
        let bytes = read_entry(&mut self.archive, &entry, MAX_BANK_BYTES)?;
        let invalid = |detail: String| DictionaryArchiveError::InvalidBank {
            entry: entry.clone(),
            detail,
        };
        let rows: Vec<Row> = parse_json(&bytes).map_err(|error| invalid(error.to_string()))?;
        rows.into_iter()
            .enumerate()
            .map(|(row, value)| {
                convert(value).map_err(|detail| invalid(format!("row {row}: {detail}")))
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct TermRow(
    String,
    String,
    Option<String>,
    Option<String>,
    f64,
    Box<RawValue>,
    i64,
    Option<String>,
);

#[derive(Deserialize)]
struct TermMetaRow(String, String, Box<RawValue>);

#[derive(Deserialize)]
struct KanjiRow(String, String, String, String, Vec<String>, Box<RawValue>);

#[derive(Deserialize)]
struct TagRow(String, String, f64, String, f64);

/// Keep index tag definitions in source order, as the archive importer appends them after banks.
#[derive(Debug, Default)]
struct TagMeta(Vec<TagEntry>);

impl<'de> Deserialize<'de> for TagMeta {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TagMetaVisitor;

        impl<'de> Visitor<'de> for TagMetaVisitor {
            type Value = TagMeta;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object of tag definitions")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut tags: Vec<TagEntry> = Vec::new();
                while let Some((name, value)) = map.next_entry::<String, serde_json::Value>()? {
                    let serde_json::Value::Object(fields) = value else {
                        return Err(A::Error::custom("a tag definition must be an object"));
                    };
                    let definition: TagMetaDefinition =
                        serde_json::from_value(serde_json::Value::Object(fields))
                            .map_err(A::Error::custom)?;
                    let tag = TagEntry {
                        name,
                        category: definition.category,
                        order: definition.order,
                        notes: definition.notes,
                        score: definition.score,
                    };
                    // JSON.parse keeps the last value for a repeated object key in its first
                    // position. Do not let a duplicate name change first-definition lookup.
                    if let Some(existing) = tags.iter_mut().find(|entry| entry.name == tag.name) {
                        *existing = tag;
                    } else {
                        tags.push(tag);
                    }
                }
                Ok(TagMeta(tags))
            }
        }

        deserializer.deserialize_map(TagMetaVisitor)
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TagMetaDefinition {
    category: String,
    order: f64,
    notes: String,
    score: f64,
}

impl Default for TagMetaDefinition {
    fn default() -> Self {
        Self {
            category: String::new(),
            order: 0.0,
            notes: String::new(),
            score: 0.0,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndex {
    title: Option<String>,
    revision: Option<String>,
    format: Option<u64>,
    version: Option<u64>,
    #[serde(default)]
    sequenced: bool,
    author: Option<String>,
    url: Option<String>,
    description: Option<String>,
    attribution: Option<String>,
    source_language: Option<String>,
    target_language: Option<String>,
    frequency_mode: Option<String>,
    #[serde(default)]
    tag_meta: TagMeta,
}

fn parse_index(bytes: &[u8]) -> Result<DictionaryIndex, DictionaryArchiveError> {
    let raw: RawIndex = parse_json(bytes).map_err(|_| DictionaryArchiveError::InvalidIndex)?;
    let required = |value: Option<String>| {
        value
            .filter(|value| !value.trim().is_empty())
            .ok_or(DictionaryArchiveError::InvalidIndex)
    };
    let title = required(raw.title)?;
    let revision = required(raw.revision)?;
    let format = raw
        .format
        .or(raw.version)
        .ok_or(DictionaryArchiveError::InvalidIndex)?;
    if !(2..=3).contains(&format) {
        return Err(DictionaryArchiveError::UnsupportedFormat(format));
    }
    let frequency_mode = match raw.frequency_mode.as_deref() {
        None => None,
        Some("occurrence-based") => Some(FrequencyMode::OccurrenceBased),
        Some("rank-based") => Some(FrequencyMode::RankBased),
        Some(_) => return Err(DictionaryArchiveError::InvalidIndex),
    };
    Ok(DictionaryIndex {
        title,
        revision,
        format,
        sequenced: raw.sequenced,
        author: raw.author,
        url: raw.url,
        description: raw.description,
        attribution: raw.attribution,
        source_language: raw.source_language,
        target_language: raw.target_language,
        frequency_mode,
        tag_meta: raw.tag_meta.0,
    })
}

/// Root-level `<prefix><number>.json` entries, ordered by number.
fn bank_entries(archive: &ZipArchive<File>, kind: BankKind) -> Vec<String> {
    let mut entries: Vec<(u64, String)> = archive
        .file_names()
        .filter_map(|name| {
            let number = name
                .strip_prefix(kind.prefix())?
                .strip_suffix(".json")
                .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))?
                .parse()
                .ok()?;
            Some((number, name.to_owned()))
        })
        .collect();
    entries.sort();
    entries.into_iter().map(|(_, name)| name).collect()
}

fn read_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, DictionaryArchiveError> {
    let unreadable = || DictionaryArchiveError::UnreadableEntry {
        entry: name.to_owned(),
    };
    let too_large = || DictionaryArchiveError::EntryTooLarge {
        entry: name.to_owned(),
    };
    let position = archive.index_for_name(name).ok_or_else(unreadable)?;
    // Komori, like other readers, does not check CRCs: real archives (several pitch dictionaries) carry
    // wrong CRCs for valid content. Deflate errors and the JSON parse still catch corruption.
    let options = ZipReadOptions::new().ignore_crc32(true);
    let entry = archive
        .by_index_with_options(position, options)
        .map_err(|_| unreadable())?;
    if entry.size() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    // The declared size is not trusted: never read more than the limit.
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(bytes)
}

/// Parses JSON as JavaScript's `JSON.parse` does : a leading BOM is skipped, and when
/// strict parsing fails, unpaired UTF-16 surrogate escapes (which `JSON.parse` accepts and a real
/// kanji dictionary contains) are read as U+FFFD before parsing again.
fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> serde_json::Result<T> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_slice(bytes).or_else(|error| match replace_lone_surrogates(bytes) {
        Some(replaced) => serde_json::from_slice(&replaced),
        None => Err(error),
    })
}

/// Replaces each `\uXXXX` escape of an unpaired surrogate with `\ufffd`, or returns `None` when
/// there is none. Backslashes only occur in JSON strings, so scanning finds every escape.
fn replace_lone_surrogates(bytes: &[u8]) -> Option<Vec<u8>> {
    fn code_unit(bytes: &[u8], at: usize) -> Option<u16> {
        let escape = bytes.get(at..at + 6)?;
        if &escape[..2] != br"\u" {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()
    }
    let is_high = |unit: u16| (0xd800..0xdc00).contains(&unit);
    let is_low = |unit: u16| (0xdc00..0xe000).contains(&unit);

    let mut output = Vec::with_capacity(bytes.len());
    let mut replaced = false;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            output.push(bytes[at]);
            at += 1;
            continue;
        }
        match code_unit(bytes, at) {
            Some(unit) if is_high(unit) && code_unit(bytes, at + 6).is_some_and(is_low) => {
                output.extend_from_slice(&bytes[at..at + 12]);
                at += 12;
            }
            Some(unit) if is_high(unit) || is_low(unit) => {
                output.extend_from_slice(br"\ufffd");
                replaced = true;
                at += 6;
            }
            // Any other escape, including an escaped backslash, is copied whole.
            _ => {
                let end = (at + 2).min(bytes.len());
                output.extend_from_slice(&bytes[at..end]);
                at = end;
            }
        }
    }
    replaced.then_some(output)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    pub(crate) const INDEX: &str =
        r#"{"title":"Fixture","revision":"fixture-1","format":3,"sequenced":true}"#;
    pub(crate) const TERMS_1: &str = r#"[
        ["読む","よむ","v5","v5",10,["to read"],1,"common"],
        ["詠む","よむ",null,"v5",-1,[{"type":"structured-content","content":"to compose"}],2,""],
        ["よむ","",null,"v5",0,["to read (kana)"],1,""]
    ]"#;
    pub(crate) const TERMS_2: &str = r#"[["本","ほん","n","",0,["book"],3,""]]"#;
    pub(crate) const TERMS_10: &str = r#"[["本","もと","n","",0,["origin"],4,""]]"#;
    pub(crate) const TERM_META: &str = r#"[
        ["読む","freq",120],
        ["読む","freq",{"reading":"よむ","frequency":{"value":7,"displayValue":"7"}}],
        ["読む","pitch",{"reading":"よむ","pitches":[{"position":1}]}],
        ["本","ipa",{"reading":"ほん","transcriptions":[{"ipa":"hoɴ","tags":[]}]}]
    ]"#;
    pub(crate) const KANJI: &str =
        r#"[["本","ホン","もと","jouyou",["book","origin"],{"strokes":"5"}]]"#;
    pub(crate) const KANJI_META: &str = r#"[["本","freq",10]]"#;
    pub(crate) const TAGS_1: &str = r#"[
        ["v5","partOfSpeech",-3,"Godan verb",0],
        ["common","popular",-10.5,"",5]
    ]"#;
    pub(crate) const TAGS_2: &str = r#"[["jouyou","frequent",0,"Jōyō kanji",-1]]"#;

    pub(crate) fn write_archive(path: &Path, entries: &[(&str, &str)]) {
        let mut archive = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, contents) in entries {
            archive.start_file(*name, options).unwrap();
            archive.write_all(contents.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
    }

    pub(crate) fn fixture_entries() -> Vec<(&'static str, &'static str)> {
        vec![
            ("index.json", INDEX),
            // Numbered out of order and beside a lookalike so ordering and matching are exercised.
            ("term_bank_10.json", TERMS_10),
            ("term_bank_1.json", TERMS_1),
            ("term_bank_2.json", TERMS_2),
            ("nested/term_bank_3.json", "not read"),
            ("term_bank_x.json", "not read"),
            ("term_meta_bank_1.json", TERM_META),
            ("kanji_bank_1.json", KANJI),
            ("kanji_meta_bank_1.json", KANJI_META),
            ("tag_bank_2.json", TAGS_2),
            ("tag_bank_1.json", TAGS_1),
            ("nested/tag_bank_3.json", "not read"),
            ("styles.css", "body {}"),
        ]
    }

    fn open_fixture(entries: &[(&str, &str)]) -> Result<DictionaryArchive, DictionaryArchiveError> {
        let directory = tempdir().unwrap();
        let path = directory.path().join("fixture.zip");
        write_archive(&path, entries);
        DictionaryArchive::open(&path)
    }

    fn with_entry(name: &'static str, contents: &'static str) -> Vec<(&'static str, &'static str)> {
        let mut entries: Vec<_> = fixture_entries()
            .into_iter()
            .filter(|(entry, _)| *entry != name)
            .collect();
        entries.push((name, contents));
        entries
    }

    #[test]
    fn reads_index_and_every_bank_kind_in_bank_order() {
        let mut archive = open_fixture(&fixture_entries()).unwrap();
        let index = archive.index();
        assert_eq!(index.title, "Fixture");
        assert_eq!(index.revision, "fixture-1");
        assert_eq!(index.format, 3);
        assert!(index.sequenced);
        assert_eq!(index.frequency_mode, None);

        assert_eq!(archive.bank_count(BankKind::Term), 3);
        let terms: Vec<TermEntry> = (0..3)
            .flat_map(|bank| archive.read_term_bank(bank).unwrap())
            .collect();
        let readings: Vec<(&str, &str)> = terms
            .iter()
            .map(|term| (term.expression.as_str(), term.reading.as_str()))
            .collect();
        assert_eq!(
            readings,
            [
                ("読む", "よむ"),
                ("詠む", "よむ"),
                ("よむ", "よむ"),
                ("本", "ほん"),
                ("本", "もと"),
            ]
        );
        let first = &terms[0];
        assert_eq!(first.definition_tags, "v5");
        assert_eq!(first.rules, "v5");
        assert_eq!(first.score, 10.0);
        assert_eq!(first.glossary.get(), r#"["to read"]"#);
        assert_eq!(first.sequence, 1);
        assert_eq!(first.term_tags, "common");
        assert_eq!(terms[1].definition_tags, "");
        assert_eq!(terms[1].score, -1.0);
        assert_eq!(
            terms[1].glossary.get(),
            r#"[{"type":"structured-content","content":"to compose"}]"#
        );

        let meta = archive.read_term_meta_bank(0).unwrap();
        let modes: Vec<TermMetaMode> = meta.iter().map(|entry| entry.mode).collect();
        assert_eq!(
            modes,
            [
                TermMetaMode::Frequency,
                TermMetaMode::Frequency,
                TermMetaMode::Pitch,
                TermMetaMode::Ipa
            ]
        );
        assert_eq!(meta[0].data.get(), "120");

        let kanji = archive.read_kanji_bank(0).unwrap();
        assert_eq!(kanji[0].character, "本");
        assert_eq!(kanji[0].onyomi, "ホン");
        assert_eq!(kanji[0].kunyomi, "もと");
        assert_eq!(kanji[0].tags, "jouyou");
        assert_eq!(kanji[0].meanings, ["book", "origin"]);
        assert_eq!(kanji[0].stats.get(), r#"{"strokes":"5"}"#);

        let kanji_meta = archive.read_kanji_meta_bank(0).unwrap();
        assert_eq!(kanji_meta[0].character, "本");
        assert_eq!(kanji_meta[0].data.get(), "10");

        assert_eq!(archive.bank_count(BankKind::Tag), 2);
        let tags: Vec<TagEntry> = (0..2)
            .flat_map(|bank| archive.read_tag_bank(bank).unwrap())
            .collect();
        let tags: Vec<(&str, &str, f64, &str, f64)> = tags
            .iter()
            .map(|tag| {
                (
                    tag.name.as_str(),
                    tag.category.as_str(),
                    tag.order,
                    tag.notes.as_str(),
                    tag.score,
                )
            })
            .collect();
        assert_eq!(
            tags,
            [
                ("v5", "partOfSpeech", -3.0, "Godan verb", 0.0),
                ("common", "popular", -10.5, "", 5.0),
                ("jouyou", "frequent", 0.0, "Jōyō kanji", -1.0),
            ]
        );
    }

    #[test]
    fn index_accepts_version_bom_and_frequency_mode() {
        let archive = open_fixture(&with_entry(
            "index.json",
            concat!(
                "\u{feff}{\"title\":\"Freq\",\"revision\":\"1\",\"version\":2,",
                "\"frequencyMode\":\"rank-based\",\"sourceLanguage\":\"ja\",",
                "\"targetLanguage\":\"en\",\"author\":\"A\",\"url\":\"https://example.org\",",
                "\"description\":\"D\",\"attribution\":\"B\",\"isUpdatable\":true}"
            ),
        ))
        .unwrap();
        let index = archive.index();
        assert_eq!(index.format, 2);
        assert!(!index.sequenced);
        assert_eq!(index.frequency_mode, Some(FrequencyMode::RankBased));
        assert_eq!(index.source_language.as_deref(), Some("ja"));
        assert_eq!(index.target_language.as_deref(), Some("en"));
        assert_eq!(index.author.as_deref(), Some("A"));
        assert_eq!(index.url.as_deref(), Some("https://example.org"));
        assert_eq!(index.description.as_deref(), Some("D"));
        assert_eq!(index.attribution.as_deref(), Some("B"));
        assert_eq!(archive.bank_count(BankKind::Kanji), 1);
    }

    #[test]
    fn index_tag_meta_keeps_source_order_and_defaults() {
        let archive = open_fixture(&[(
            "index.json",
            r#"{"title":"Tags","revision":"1","format":3,"tagMeta":{"z":{"category":"popular","order":-2,"notes":"Popular","score":3},"a":{"notes":"Short"},"z":{"category":"frequent","order":1,"notes":"Updated","score":4}}}"#,
        )])
        .unwrap();
        let tags = &archive.index().tag_meta;
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "z");
        assert_eq!(tags[0].category, "frequent");
        assert_eq!(tags[0].order, 1.0);
        assert_eq!(tags[0].notes, "Updated");
        assert_eq!(tags[0].score, 4.0);
        assert_eq!(tags[1].name, "a");
        assert_eq!(tags[1].category, "");
        assert_eq!(tags[1].order, 0.0);
        assert_eq!(tags[1].notes, "Short");
        assert_eq!(tags[1].score, 0.0);

        let absent = open_fixture(&[("index.json", INDEX)]).unwrap();
        assert!(absent.index().tag_meta.is_empty());
        let empty = open_fixture(&[(
            "index.json",
            r#"{"title":"Tags","revision":"1","format":3,"tagMeta":{}}"#,
        )])
        .unwrap();
        assert!(empty.index().tag_meta.is_empty());
    }

    #[test]
    fn malformed_index_tag_meta_is_an_invalid_index() {
        for tag_meta in [
            "null",
            "[]",
            r#"{"v5":null}"#,
            r#"{"v5":[]}"#,
            r#"{"v5":{"order":"1"}}"#,
            r#"{"v5":{"category":null}}"#,
            r#"{"v5":{"notes":1}}"#,
            r#"{"v5":{"score":false}}"#,
            r#"{"v5":{"extra":1}}"#,
        ] {
            let index =
                format!(r#"{{"title":"Tags","revision":"1","format":3,"tagMeta":{tag_meta}}}"#);
            assert!(
                matches!(
                    open_fixture(&[("index.json", &index)]),
                    Err(DictionaryArchiveError::InvalidIndex)
                ),
                "{tag_meta}"
            );
        }
    }

    #[test]
    fn archives_without_banks_are_empty() {
        let archive = open_fixture(&[("index.json", INDEX)]).unwrap();
        for kind in BankKind::ALL {
            assert_eq!(archive.bank_count(kind), 0);
        }
    }

    #[test]
    fn malformed_files_and_indexes_fail_with_typed_errors() {
        let directory = tempdir().unwrap();
        assert!(matches!(
            DictionaryArchive::open(&directory.path().join("missing.zip")),
            Err(DictionaryArchiveError::Unreadable)
        ));
        let plain = directory.path().join("plain.zip");
        std::fs::write(&plain, b"not a dictionary").unwrap();
        assert!(matches!(
            DictionaryArchive::open(&plain),
            Err(DictionaryArchiveError::NotArchive)
        ));

        assert!(matches!(
            open_fixture(&[("term_bank_1.json", TERMS_1)]),
            Err(DictionaryArchiveError::MissingIndex)
        ));
        assert!(matches!(
            open_fixture(&[("nested/index.json", INDEX)]),
            Err(DictionaryArchiveError::MissingIndex)
        ));
        for index in [
            "{",
            "[]",
            r#"{"revision":"1","format":3}"#,
            r#"{"title":" ","revision":"1","format":3}"#,
            r#"{"title":"T","format":3}"#,
            r#"{"title":"T","revision":"1"}"#,
            r#"{"title":"T","revision":"1","format":"3"}"#,
            r#"{"title":"T","revision":"1","format":3,"frequencyMode":"loud"}"#,
        ] {
            assert!(
                matches!(
                    open_fixture(&[("index.json", index)]),
                    Err(DictionaryArchiveError::InvalidIndex)
                ),
                "{index}"
            );
        }
        for (index, format) in [
            (r#"{"title":"T","revision":"1","format":1}"#, 1),
            (r#"{"title":"T","revision":"1","version":4}"#, 4),
        ] {
            assert!(matches!(
                open_fixture(&[("index.json", index)]),
                Err(DictionaryArchiveError::UnsupportedFormat(found)) if found == format
            ));
        }
    }

    #[test]
    fn malformed_banks_fail_with_the_bank_named() {
        let cases: [(&str, &str); 15] = [
            ("term_bank_1.json", "{"),
            ("term_bank_1.json", "{}"),
            // Too few, too many, and mistyped columns.
            (
                "term_bank_1.json",
                r#"[["読む","よむ","","",0,["to read"],1]]"#,
            ),
            (
                "term_bank_1.json",
                r#"[["読む","よむ","","",0,["to read"],1,"",0]]"#,
            ),
            (
                "term_bank_1.json",
                r#"[["読む","よむ","","",0,"to read",1,""]]"#,
            ),
            (
                "term_bank_1.json",
                r#"[["読む",1,"","",0,["to read"],1,""]]"#,
            ),
            ("term_meta_bank_1.json", r#"[["読む","loud",1]]"#),
            (
                "kanji_bank_1.json",
                r#"[["本","ホン","もと","",["book"],[]]]"#,
            ),
            (
                "kanji_bank_1.json",
                r#"[["本","ホン","もと","","book",{}]]"#,
            ),
            ("kanji_meta_bank_1.json", r#"[["本","pitch",1]]"#),
            ("tag_bank_1.json", "{}"),
            // Too few, too many, mistyped, and null columns.
            ("tag_bank_1.json", r#"[["v5","partOfSpeech",0,""]]"#),
            ("tag_bank_1.json", r#"[["v5","partOfSpeech",0,"",0,0]]"#),
            ("tag_bank_1.json", r#"[["v5","partOfSpeech","0","",0]]"#),
            ("tag_bank_1.json", r#"[["v5",null,0,"",0]]"#),
        ];
        for (name, contents) in cases {
            let mut archive = open_fixture(&with_entry(name, contents)).unwrap();
            let result = match name {
                "term_bank_1.json" => archive.read_term_bank(0).map(|_| ()),
                "term_meta_bank_1.json" => archive.read_term_meta_bank(0).map(|_| ()),
                "kanji_bank_1.json" => archive.read_kanji_bank(0).map(|_| ()),
                "tag_bank_1.json" => archive.read_tag_bank(0).map(|_| ()),
                _ => archive.read_kanji_meta_bank(0).map(|_| ()),
            };
            let error = result.unwrap_err();
            assert!(
                matches!(&error, DictionaryArchiveError::InvalidBank { entry, .. } if entry == name),
                "{name}: {contents}"
            );
            assert!(error
                .to_string()
                .starts_with(&format!("{name} is invalid: ")));
        }
    }

    #[test]
    fn unpaired_surrogate_escapes_read_as_replacement_characters() {
        let mut archive = open_fixture(&with_entry(
            "kanji_bank_1.json",
            r#"[["人","","","",["部首：人 \ud840　\udda2","\ud840\udda2","\\ud840","\udda2\ud840"],{}]]"#,
        ))
        .unwrap();
        let kanji = archive.read_kanji_bank(0).unwrap();
        assert_eq!(
            kanji[0].meanings,
            [
                "部首：人 \u{fffd}　\u{fffd}",
                "\u{201a2}",
                r"\ud840",
                "\u{fffd}\u{fffd}"
            ]
        );

        let mut archive = open_fixture(&with_entry(
            "kanji_bank_1.json",
            r#"[["人","","","",["\ud840", "\x"],{}]]"#,
        ))
        .unwrap();
        assert!(matches!(
            archive.read_kanji_bank(0),
            Err(DictionaryArchiveError::InvalidBank { .. })
        ));
    }

    #[test]
    fn wrong_crcs_are_ignored() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("wrong-crc.zip");
        write_archive(
            &path,
            &[("index.json", INDEX), ("term_bank_1.json", TERMS_2)],
        );
        let crc = ZipArchive::new(File::open(&path).unwrap())
            .unwrap()
            .by_name("term_bank_1.json")
            .unwrap()
            .crc32()
            .to_le_bytes();
        let mut bytes = std::fs::read(&path).unwrap();
        let mut patched = 0;
        for at in 0..bytes.len() - 3 {
            if bytes[at..at + 4] == crc {
                bytes[at] ^= 0xff;
                patched += 1;
            }
        }
        // The local header and the central directory.
        assert_eq!(patched, 2);
        std::fs::write(&path, bytes).unwrap();

        let mut archive = DictionaryArchive::open(&path).unwrap();
        assert_eq!(archive.read_term_bank(0).unwrap()[0].expression, "本");
    }

    #[test]
    fn oversized_entries_are_refused_before_parsing() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large-index.zip");
        let large = format!("{{\"title\":\"{}\"}}", "x".repeat(MAX_INDEX_BYTES as usize));
        write_archive(&path, &[("index.json", &large)]);
        let error = DictionaryArchive::open(&path).err().unwrap();
        assert!(matches!(
            &error,
            DictionaryArchiveError::EntryTooLarge { .. }
        ));
        assert_eq!(error.to_string(), "index.json is too large");
    }

    #[test]
    fn reading_leaves_the_archive_unchanged() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("fixture.zip");
        write_archive(&path, &fixture_entries());
        let before = Sha256::digest(std::fs::read(&path).unwrap());
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();

        let mut archive = DictionaryArchive::open(&path).unwrap();
        for bank in 0..archive.bank_count(BankKind::Term) {
            archive.read_term_bank(bank).unwrap();
        }
        archive.read_term_meta_bank(0).unwrap();
        archive.read_kanji_bank(0).unwrap();
        archive.read_kanji_meta_bank(0).unwrap();
        for bank in 0..archive.bank_count(BankKind::Tag) {
            archive.read_tag_bank(bank).unwrap();
        }
        drop(archive);

        assert_eq!(Sha256::digest(std::fs::read(&path).unwrap()), before);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
    }

    /// Reads every bank of each `|`-separated archive in `KOMORI_DICTIONARY_SAMPLES`, printing
    /// titles and counts (never paths), and checks each archive's bytes are unchanged.
    #[test]
    #[ignore = "requires explicit real dictionary archives; run with --release"]
    fn real_dictionary_archives_read() {
        let archives = std::env::var("KOMORI_DICTIONARY_SAMPLES")
            .expect("set KOMORI_DICTIONARY_SAMPLES to |-separated archive paths");
        let mut failures = Vec::new();
        for (position, path) in archives.split('|').map(Path::new).enumerate() {
            let before = Sha256::digest(std::fs::read(path).unwrap());
            let result = DictionaryArchive::open(path).and_then(|mut archive| {
                let mut counts = [0; 5];
                for bank in 0..archive.bank_count(BankKind::Term) {
                    counts[0] += archive.read_term_bank(bank)?.len();
                }
                for bank in 0..archive.bank_count(BankKind::TermMeta) {
                    counts[1] += archive.read_term_meta_bank(bank)?.len();
                }
                for bank in 0..archive.bank_count(BankKind::Kanji) {
                    counts[2] += archive.read_kanji_bank(bank)?.len();
                }
                for bank in 0..archive.bank_count(BankKind::KanjiMeta) {
                    counts[3] += archive.read_kanji_meta_bank(bank)?.len();
                }
                for bank in 0..archive.bank_count(BankKind::Tag) {
                    counts[4] += archive.read_tag_bank(bank)?.len();
                }
                counts[4] += archive.index().tag_meta.len();
                Ok((archive.index().title.clone(), counts))
            });
            match result {
                Ok((title, counts)) => println!("{} | {title} | {counts:?}", position + 1),
                Err(error) => {
                    println!("{} | failed: {error}", position + 1);
                    failures.push(position + 1);
                }
            }
            assert_eq!(Sha256::digest(std::fs::read(path).unwrap()), before);
        }
        assert!(failures.is_empty(), "archives failed: {failures:?}");
    }
}
