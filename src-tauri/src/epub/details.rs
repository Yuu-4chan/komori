//! A book's language, series, and, for Chinese, Japanese, and Korean books, how much text it has.
//!
//! The language and series come from the package metadata. The text counts read every spine
//! document's text the way the Reader counts it: letters and numbers outside ruby annotations
//! for Chinese, Japanese, and Korean books, words for the rest.

use std::{
    collections::{BTreeSet, HashMap},
    io::{Read, Seek},
};

use roxmltree::{Document, Node};
use zip::ZipArchive;

use super::{cover::archive_path_candidates, entry_exists, read_entry_flexible};

// A content document over this is not counted; real chapters are far smaller.
const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
// The most content text one book may decompress for counting, so an archive can't stall it.
const MAX_BOOK_TEXT_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PackageDetails {
    /// The first `dc:language`, normalized (`ja`, `zh-TW`, `en`), when it names a language.
    pub(crate) language: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_index: Option<f64>,
}

/// The text of a mostly Chinese, Japanese, or Korean book.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TextStatistics {
    /// `ja`, `zh`, or `ko`, from the scripts the text uses.
    pub(crate) language: &'static str,
    /// Letters and numbers, as the Reader counts characters.
    pub(crate) characters: i64,
    /// Every distinct Han ideograph, in code point order.
    pub(crate) kanji: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BookDetails {
    pub(crate) package: PackageDetails,
    /// Counts for a CJK book; none for other books or when no text could be read.
    pub(crate) text: Option<TextStatistics>,
    /// The words of any other book with text, as the Reader counts them.
    pub(crate) words: Option<i64>,
}

impl BookDetails {
    /// The language to show: the declared one, unless the text is clearly Chinese, Japanese, or
    /// Korean and the declaration is not (exported metadata often keeps a default `en`).
    pub(crate) fn language(&self) -> Option<String> {
        match (&self.package.language, &self.text) {
            (Some(declared), Some(text)) if !is_cjk_language(declared) => {
                Some(text.language.to_string())
            }
            (Some(declared), _) => Some(shown_language(declared)),
            (None, Some(text)) => Some(text.language.to_string()),
            (None, None) => None,
        }
    }
}

/// A normalized tag as the Library shows and groups it: the language alone (`ja-JP` is `ja`),
/// except Chinese, which keeps its script, `zh-Hans` or `zh-Hant`, from the tag's script or
/// else its region (CN, SG and MY write Simplified; TW, HK and MO Traditional).
pub(crate) fn shown_language(tag: &str) -> String {
    let mut parts = tag.split('-');
    let primary = parts.next().unwrap_or_default();
    if primary != "zh" {
        return primary.to_string();
    }
    let mut script = None;
    for part in parts {
        script = script.or(match part.to_ascii_uppercase().as_str() {
            "HANS" | "CN" | "SG" | "MY" => Some("zh-Hans"),
            "HANT" | "TW" | "HK" | "MO" => Some("zh-Hant"),
            _ => None,
        });
        if part.len() == 4 {
            break;
        }
    }
    script.unwrap_or("zh").to_string()
}

pub(super) fn package_details(document: &Document<'_>) -> PackageDetails {
    let Some(metadata) = document
        .descendants()
        .find(|node| node.tag_name().name() == "metadata")
    else {
        return PackageDetails::default();
    };
    let language = metadata
        .children()
        .filter(|node| node.tag_name().name() == "language")
        .find_map(|node| node.text().and_then(normalize_language));
    let (series, series_index) = calibre_series(metadata)
        .or_else(|| collection_series(metadata))
        .map_or((None, None), |(series, index)| (Some(series), index));
    PackageDetails {
        language,
        series,
        series_index,
    }
}

fn calibre_series(metadata: Node<'_, '_>) -> Option<(String, Option<f64>)> {
    let named = |name: &str| {
        metadata
            .children()
            .find(|node| node.tag_name().name() == "meta" && node.attribute("name") == Some(name))
            .and_then(|node| node.attribute("content"))
    };
    let series = clean_text(named("calibre:series")?)?;
    Some((
        series,
        named("calibre:series_index").and_then(series_number),
    ))
}

/// EPUB 3's `belongs-to-collection` of type series (or of no stated type).
fn collection_series(metadata: Node<'_, '_>) -> Option<(String, Option<f64>)> {
    let metas: Vec<Node<'_, '_>> = metadata
        .children()
        .filter(|node| node.tag_name().name() == "meta")
        .collect();
    let refinement = |id: &str, property: &str| {
        metas
            .iter()
            .find(|node| {
                node.attribute("refines")
                    .is_some_and(|refines| refines.trim_start_matches('#') == id)
                    && node.attribute("property") == Some(property)
            })
            .and_then(|node| node.text())
            .map(str::trim)
    };
    metas.iter().find_map(|node| {
        if node.attribute("property") != Some("belongs-to-collection") {
            return None;
        }
        let name = clean_text(node.text()?)?;
        let id = node.attribute("id").unwrap_or_default();
        if !id.is_empty() && refinement(id, "collection-type").is_some_and(|kind| kind != "series")
        {
            return None;
        }
        let index = if id.is_empty() {
            None
        } else {
            refinement(id, "group-position").and_then(series_number)
        };
        Some((name, index))
    })
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty() && value.chars().count() <= 200).then_some(value)
}

fn series_number(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && (0.0..=100_000.0).contains(number))
}

/// A BCP 47 tag with its language subtag in ISO 639-1 where one exists, so `jpn` and `ja-JP`
/// group as `ja`; `und` and malformed values name no language.
pub(crate) fn normalize_language(value: &str) -> Option<String> {
    let value = value.trim().replace('_', "-");
    let mut parts = value.split('-');
    let primary = parts.next()?.to_ascii_lowercase();
    if !(2..=3).contains(&primary.len()) || !primary.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let primary = match primary.as_str() {
        "und" | "mul" | "zxx" => return None,
        "jpn" => "ja",
        "zho" | "chi" => "zh",
        "kor" => "ko",
        "eng" => "en",
        "fra" | "fre" => "fr",
        "deu" | "ger" => "de",
        "spa" => "es",
        "por" => "pt",
        "ita" => "it",
        "rus" => "ru",
        other => other,
    }
    .to_string();
    // Keep a script or region (zh-TW, zh-Hant) but not private or extension parts.
    let rest: Vec<String> = parts
        .take_while(|part| part.len() > 1 && part.chars().all(|c| c.is_ascii_alphanumeric()))
        .take(2)
        .map(|part| match part.len() {
            2 => part.to_ascii_uppercase(),
            4 => {
                let mut chars = part.chars();
                let first = chars.next().unwrap_or_default().to_ascii_uppercase();
                std::iter::once(first)
                    .chain(chars.map(|c| c.to_ascii_lowercase()))
                    .collect()
            }
            _ => part.to_ascii_lowercase(),
        })
        .collect();
    Some(
        std::iter::once(primary)
            .chain(rest)
            .collect::<Vec<_>>()
            .join("-"),
    )
}

pub(crate) fn is_cjk_language(language: &str) -> bool {
    matches!(
        language.split('-').next(),
        Some("ja" | "zh" | "ko" | "yue" | "cmn" | "wuu" | "lzh")
    )
}

/// Counts the text of every linear spine document: statistics for a book whose text is mostly
/// Chinese, Japanese, or Korean, otherwise its words; neither without readable text.
pub(super) fn text_statistics<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_path: &str,
    document: &Document<'_>,
) -> (Option<TextStatistics>, Option<i64>) {
    let base = package_path.rsplit_once('/').map_or("", |(base, _)| base);
    let manifest: HashMap<&str, (&str, &str)> = document
        .descendants()
        .filter(|node| node.tag_name().name() == "item")
        .filter_map(|node| {
            Some((
                node.attribute("id")?,
                (
                    node.attribute("href")?,
                    node.attribute("media-type").unwrap_or_default(),
                ),
            ))
        })
        .collect();
    let mut counter = TextCounter::default();
    let mut budget = MAX_BOOK_TEXT_BYTES;
    // As EPUB.js reads the spine for the Reader's progress: only `linear="yes"` (or no value)
    // is linear.
    for itemref in document
        .descendants()
        .filter(|node| node.tag_name().name() == "itemref")
        .filter(|node| {
            node.attribute("linear")
                .is_none_or(|linear| linear.is_empty() || linear == "yes")
        })
    {
        let Some((href, media_type)) = itemref.attribute("idref").and_then(|id| manifest.get(id))
        else {
            continue;
        };
        if !matches!(*media_type, "application/xhtml+xml" | "text/html" | "") {
            continue;
        }
        let Some(path) = archive_path_candidates(base, href)
            .into_iter()
            .find(|path| entry_exists(archive, path))
        else {
            continue;
        };
        let Ok(bytes) = read_entry_flexible(archive, &path, MAX_DOCUMENT_BYTES.min(budget)) else {
            continue;
        };
        budget -= bytes.len();
        counter.count_markup(&String::from_utf8_lossy(&bytes));
        if budget == 0 {
            break;
        }
    }
    let words = counter.words();
    (counter.statistics(), words)
}

#[derive(Default)]
struct TextCounter {
    characters: i64,
    letters: i64,
    cjk: i64,
    kana: i64,
    hangul: i64,
    kanji: BTreeSet<char>,
    words: i64,
    word: WordState,
}

/// Where the text is relative to a word: a run of letters, numbers, and marks, joined into one
/// word across an apostrophe or hyphen between two of them, as the Reader's word pattern.
#[derive(Default, Clone, Copy, PartialEq)]
enum WordState {
    #[default]
    Outside,
    Inside,
    /// Just after an apostrophe or hyphen following a word.
    Joining,
}

impl TextCounter {
    /// Counts the text of one HTML or XHTML document: everything outside tags except the head,
    /// scripts, styles, and ruby annotations (`rt`, `rp`), with numeric character references
    /// decoded. Markup need not be well-formed.
    fn count_markup(&mut self, markup: &str) {
        let mut skipped = 0usize;
        let mut rest = markup;
        while let Some(start) = rest.find(['<', '&']) {
            if skipped == 0 {
                self.count_text(&rest[..start]);
            }
            rest = &rest[start..];
            if rest.starts_with('&') {
                let end = rest[1..]
                    .find(|c: char| c == ';' || c == '<' || c == '&' || c.is_whitespace())
                    .map_or(rest.len(), |end| end + 1);
                if skipped == 0 && rest[end..].starts_with(';') {
                    if let Some(character) = numeric_reference(&rest[1..end]) {
                        self.count_char(character);
                    }
                }
                rest = &rest[end..];
                rest = rest.strip_prefix(';').unwrap_or(rest);
                continue;
            }
            if let Some(after) = rest.strip_prefix("<!--") {
                rest = after.find("-->").map_or("", |end| &after[end + 3..]);
                continue;
            }
            let (tag, after) = split_tag(rest);
            rest = after;
            // The Reader counts each text node on its own, so a tag ends a word.
            self.word = WordState::Outside;
            let Some((name, closing, self_closing)) = tag_name(tag) else {
                continue;
            };
            if !matches!(name.as_str(), "head" | "script" | "style" | "rt" | "rp") {
                continue;
            }
            if closing {
                skipped = skipped.saturating_sub(1);
            } else if !self_closing {
                skipped += 1;
            }
        }
        if skipped == 0 {
            self.count_text(rest);
        }
    }

    fn count_text(&mut self, text: &str) {
        for character in text.chars() {
            self.count_char(character);
        }
    }

    fn count_char(&mut self, character: char) {
        let letter = character.is_alphabetic();
        if letter || character.is_numeric() {
            self.characters += 1;
        }
        self.word = if letter || character.is_numeric() || is_mark(character) {
            if self.word == WordState::Outside {
                self.words += 1;
            }
            WordState::Inside
        } else if self.word == WordState::Inside && matches!(character, '\'' | '’' | '-' | '‐')
        {
            WordState::Joining
        } else {
            WordState::Outside
        };
        if letter {
            self.letters += 1;
        }
        match script(character) {
            Some(Script::Han) => {
                self.cjk += 1;
                if is_ideograph(character) {
                    self.kanji.insert(character);
                }
            }
            Some(Script::Kana) => {
                self.cjk += 1;
                self.kana += 1;
            }
            Some(Script::Hangul) => {
                self.cjk += 1;
                self.hangul += 1;
            }
            None => {}
        }
    }

    /// The words of text the Reader counts in words: with letters, under half of them CJK.
    fn words(&self) -> Option<i64> {
        (self.letters > 0 && self.cjk * 2 < self.letters).then_some(self.words)
    }

    /// The Reader counts characters for text at least half CJK letters; so does this.
    fn statistics(self) -> Option<TextStatistics> {
        if self.letters == 0 || self.cjk * 2 < self.letters {
            return None;
        }
        let language = if self.kana * 20 >= self.cjk {
            "ja"
        } else if self.hangul * 2 >= self.cjk {
            "ko"
        } else {
            "zh"
        };
        Some(TextStatistics {
            language,
            characters: self.characters,
            kanji: self.kanji.into_iter().collect(),
        })
    }
}

/// The tag starting `markup` and what follows it; quoted attribute values may hold `>`.
fn split_tag(markup: &str) -> (&str, &str) {
    let mut quote = None;
    for (index, character) in markup.char_indices().skip(1) {
        match (quote, character) {
            (None, '"' | '\'') => quote = Some(character),
            (Some(open), _) if open == character => quote = None,
            (None, '>') => return (&markup[..=index], &markup[index + 1..]),
            _ => {}
        }
    }
    (markup, "")
}

/// A tag's lowercase local name, whether it closes, and whether it closes itself.
fn tag_name(tag: &str) -> Option<(String, bool, bool)> {
    let inner = tag.strip_prefix('<')?.strip_suffix('>').unwrap_or(tag);
    let (closing, inner) = match inner.strip_prefix('/') {
        Some(inner) => (true, inner),
        None => (false, inner),
    };
    let name: String = inner
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '/' && *c != '>')
        .collect();
    if name.is_empty() || name.starts_with(['!', '?']) {
        return None;
    }
    let local = name
        .rsplit(':')
        .next()
        .unwrap_or(&name)
        .to_ascii_lowercase();
    Some((local, closing, inner.trim_end().ends_with('/')))
}

fn numeric_reference(reference: &str) -> Option<char> {
    let number = reference.strip_prefix('#')?;
    let value = match number.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => number.parse().ok()?,
    };
    char::from_u32(value)
}

enum Script {
    Han,
    Kana,
    Hangul,
}

/// The Unicode script of Chinese, Japanese, and Korean letters, as the Reader's `\p{sc=…}` sees
/// them (the prolonged sound mark and middle dot are Common in both).
fn script(character: char) -> Option<Script> {
    match u32::from(character) {
        0x2E80..=0x2FDF
        | 0x3005
        | 0x3007
        | 0x3021..=0x3029
        | 0x3038..=0x303B
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF
        | 0x20000..=0x3FFFF => Some(Script::Han),
        0x3041..=0x3096
        | 0x309D..=0x309F
        | 0x30A1..=0x30FA
        | 0x30FD..=0x30FF
        | 0x31F0..=0x31FF
        | 0x32D0..=0x32FE
        | 0x3300..=0x3357
        | 0xFF66..=0xFF6F
        | 0xFF71..=0xFF9D
        | 0x1B000..=0x1B16F => Some(Script::Kana),
        0x1100..=0x11FF | 0x3131..=0x318E | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xFFA0..=0xFFDC => {
            Some(Script::Hangul)
        }
        _ => None,
    }
}

/// CJK unified and compatibility ideographs: kanji, hanzi, and hanja, not radicals or marks.
/// Combining marks, which belong to the word they follow.
fn is_mark(character: char) -> bool {
    matches!(
        character as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
    )
}

fn is_ideograph(character: char) -> bool {
    matches!(
        u32::from(character),
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counted(markup: &str) -> TextCounter {
        let mut counter = TextCounter::default();
        counter.count_markup(markup);
        counter
    }

    #[test]
    fn counts_body_text_without_ruby_head_or_scripts() {
        let counter = counted(
            r#"<?xml version="1.0"?><html><head><title>題名タイトル</title><style>p{}</style></head>
            <body><p>　<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>を読む。「ＡＢ１」</p>
            <p title="a>b">&#x4E00;&#19968;&amp;二</p><script>var x = 1;</script><br/></body></html>"#,
        );
        // 漢字を読む + ＡＢ１ + 一一二; punctuation, spaces, and entities like &amp; are not counted.
        assert_eq!(counter.characters, 11);
        assert_eq!(
            counter.kanji.iter().collect::<String>(),
            "一二字漢読"
                .chars()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<String>()
        );
        assert_eq!(counter.kana, 2);
    }

    #[test]
    fn language_comes_from_the_scripts_used() {
        let japanese = counted("<p>今日は雨が降っている。</p>")
            .statistics()
            .unwrap();
        assert_eq!(japanese.language, "ja");
        let chinese = counted("<p>今天下雨，我们在家看书。</p>")
            .statistics()
            .unwrap();
        assert_eq!(chinese.language, "zh");
        let korean = counted("<p>오늘은 비가 온다. 漢字</p>")
            .statistics()
            .unwrap();
        assert_eq!(korean.language, "ko");
        // Hangul is never kanji.
        assert_eq!(korean.kanji, "字漢");
        assert!(counted("<p>Plain English text with 漢字.</p>")
            .statistics()
            .is_none());
        assert!(counted("<p>…</p>").statistics().is_none());
    }

    #[test]
    fn counts_words_of_western_text_as_the_reader_does() {
        // don't, well-known and dogs' are one word each; -- and a lone ’ separate words;
        // the entity joins its word, and the italic tag splits "wo|rd" as the Reader's text nodes.
        let counter = counted(
            "<html><head><title>Not counted</title></head><body>\
             <p>I don't know—a well-known dogs’ tale, 42 times. A--B ’ x</p>\
             <p>caf\u{e9} cafe\u{301} don&#8217;t <i>wo</i>rd</p></body></html>",
        );
        assert_eq!(counter.words(), Some(17));
        assert!(counter.statistics().is_none());
        assert_eq!(counted("<p>今日は雨です。</p>").words(), None);
        assert_eq!(counted("<p>…</p>").words(), None);
    }

    #[test]
    fn declared_language_is_kept_unless_cjk_text_contradicts_it() {
        let details = |declared: Option<&str>, text: Option<&'static str>| BookDetails {
            package: PackageDetails {
                language: declared.map(str::to_string),
                ..PackageDetails::default()
            },
            text: text.map(|language| TextStatistics {
                language,
                characters: 1,
                kanji: String::new(),
            }),
            words: None,
        };
        assert_eq!(
            details(Some("en"), Some("ja")).language().as_deref(),
            Some("ja")
        );
        assert_eq!(
            details(Some("zh-TW"), Some("zh")).language().as_deref(),
            Some("zh-Hant")
        );
        assert_eq!(details(Some("en"), None).language().as_deref(), Some("en"));
        assert_eq!(details(None, Some("ko")).language().as_deref(), Some("ko"));
        assert_eq!(details(None, None).language(), None);
    }

    #[test]
    fn languages_normalize() {
        assert_eq!(normalize_language(" JPN ").as_deref(), Some("ja"));
        assert_eq!(normalize_language("ja-jp").as_deref(), Some("ja-JP"));
        assert_eq!(
            normalize_language("zh_hant_tw").as_deref(),
            Some("zh-Hant-TW")
        );
        assert_eq!(normalize_language("und"), None);
        for (tag, shown) in [
            ("ja-JP", "ja"),
            ("en-US", "en"),
            ("pt-BR", "pt"),
            ("zh", "zh"),
            ("zh-CN", "zh-Hans"),
            ("zh-SG", "zh-Hans"),
            ("zh-Hans", "zh-Hans"),
            ("zh-TW", "zh-Hant"),
            ("zh-HK", "zh-Hant"),
            ("zh-Hant-CN", "zh-Hant"),
            ("zh-Hans-TW", "zh-Hans"),
            ("zh-yue", "zh"),
        ] {
            assert_eq!(shown_language(tag), shown, "{tag}");
        }
        assert_eq!(normalize_language("Japanese"), None);
        assert_eq!(normalize_language(""), None);
    }

    #[test]
    fn series_comes_from_calibre_or_epub3_collections() {
        let parse = |metadata: &str| {
            let package = format!(
                r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>{metadata}</metadata></package>"#
            );
            package_details(&Document::parse(&package).unwrap())
        };
        let calibre = parse(
            r#"<dc:language>jpn</dc:language><meta name="calibre:series" content=" 物語  シリーズ "/><meta name="calibre:series_index" content="4.0"/>"#,
        );
        assert_eq!(calibre.language.as_deref(), Some("ja"));
        assert_eq!(calibre.series.as_deref(), Some("物語 シリーズ"));
        assert_eq!(calibre.series_index, Some(4.0));

        let collection = parse(
            r##"<meta property="belongs-to-collection" id="c1">Fate/Zero</meta><meta refines="#c1" property="collection-type">series</meta><meta refines="#c1" property="group-position">2</meta>"##,
        );
        assert_eq!(collection.series.as_deref(), Some("Fate/Zero"));
        assert_eq!(collection.series_index, Some(2.0));

        let set = parse(
            r##"<meta property="belongs-to-collection" id="c1">Box</meta><meta refines="#c1" property="collection-type">set</meta>"##,
        );
        assert_eq!(set.series, None);
        assert_eq!(parse("").series, None);

        // Calibre writes EPUB 3 collections with an `opf:` prefix.
        let prefixed = package_details(
            &Document::parse(
                r##"<package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><opf:metadata><dc:language>ja</dc:language><opf:meta property="belongs-to-collection" id="id-2">白い港の物語</opf:meta><opf:meta refines="#id-2" property="collection-type">series</opf:meta><opf:meta refines="#id-2" property="group-position">5</opf:meta></opf:metadata></package>"##,
            )
            .unwrap(),
        );
        assert_eq!(prefixed.series.as_deref(), Some("白い港の物語"));
        assert_eq!(prefixed.series_index, Some(5.0));
    }
}
