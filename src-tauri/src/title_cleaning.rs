//! Catalog-only title presentation. Source EPUB metadata is never rewritten.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};

use crate::library::storage_error;

const TAGS: &str = include_str!("../../docs/title-cleaning-list.txt");
const WORDS: &str = include_str!("../../docs/title-cleaning-words.txt");

/// Raised whenever the lists or the cleaning change, so the catalog cleans its titles again.
const REVISION: i64 = 2;
const REVISION_RECORD: &str = "title-cleaning";

/// Bracket kinds that can hold listed words. A kind opens with any of its forms and closes
/// with any of them, half-width, full-width (as the Japanese IME types them) or other, so
/// `(電子版)`, `（電子版）` and a mixed `（電子版)` all match. Quotes such as 「」 and 『』 are not
/// among them: titles quote their own words in them.
const BRACKETS: &[(&[char], &[char])] = &[
    (&['(', '（'], &[')', '）']),
    (&['[', '［'], &[']', '］']),
    (&['{', '｛'], &['}', '｝']),
    (
        &['<', '＜', '〈', '\u{2329}', '⟨'],
        &['>', '＞', '〉', '\u{232A}', '⟩'],
    ),
    (&['《', '≪', '«'], &['》', '≫', '»']),
    (&['【'], &['】']),
    (&['〖'], &['〗']),
    (&['〔'], &['〕']),
    (&['〘'], &['〙']),
    (&['｟'], &['｠']),
];

/// What may follow a listed word: `特典` + `付き`.
const JOINERS: &[&str] = &["付き", "付", "つき"];
/// What may stand between listed words, after folding: `電子版・特典付き`.
const SEPARATORS: &[char] = &['・', '/', '+', '&', ',', '、'];
/// The most a label's name may hold before its ending: `富士見ファンタジア` before `文庫`.
const MAX_LABEL_NAME: usize = 12;

/// Punctuation a removed tag's leading space should not stay before: `Vol. 1 (LN): Title`.
const CLOSING: &[char] = &[
    ':', ';', ',', '.', '!', '?', ')', ']', '}', '：', '；', '，', '．', '！', '？', '、', '。',
    '）', '］', '｝', '」', '』', '〉', '》', '】', '〕', '〗', '〙', '»', '’', '”',
];

struct Words {
    words: Vec<Vec<char>>,
    endings: Vec<Vec<char>>,
}

static LISTED: LazyLock<Words> = LazyLock::new(|| {
    let mut listed = Words {
        words: Vec::new(),
        endings: Vec::new(),
    };
    for line in WORDS.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match line.strip_prefix('*') {
            Some(ending) => listed.endings.push(fold(ending)),
            None => listed.words.push(fold(line)),
        }
    }
    listed
});

/// Full-width letters, digits and punctuation as half-width ones, without spaces, in lower case.
fn fold(text: &str) -> Vec<char> {
    text.chars()
        .map(|character| match character {
            '\u{FF01}'..='\u{FF5E}' => {
                char::from_u32(character as u32 - 0xFEE0).unwrap_or(character)
            }
            '\u{FF65}' => '・',
            '’' => '\'',
            other => other,
        })
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether bracketed text is listed words alone, perhaps joined (`特典付き`) and separated
/// (`電子版・特典付き`), or a label with a listed ending (`HJ文庫`).
fn listed_words(content: &str) -> bool {
    let content = fold(content);
    if content.is_empty() {
        return false;
    }
    let labelled = LISTED.endings.iter().any(|ending| {
        content.ends_with(ending) && (1..=MAX_LABEL_NAME).contains(&(content.len() - ending.len()))
    });
    if labelled {
        return true;
    }
    // Where a word may start, and where one (with any joiner) has ended.
    let mut starts = vec![false; content.len() + 1];
    let mut ends = vec![false; content.len() + 1];
    starts[0] = true;
    for index in 0..content.len() {
        let rest = &content[index..];
        if ends[index] {
            starts[index] = true;
            for joiner in JOINERS {
                let joiner: Vec<char> = joiner.chars().collect();
                if rest.starts_with(&joiner) {
                    ends[index + joiner.len()] = true;
                }
            }
            if SEPARATORS.contains(&rest[0]) {
                starts[index + 1] = true;
            }
        }
        if starts[index] {
            for word in &LISTED.words {
                if rest.starts_with(word) {
                    ends[index + word.len()] = true;
                }
            }
        }
    }
    ends[content.len()]
}

/// The byte range of the first bracket pair holding only listed words, brackets included.
fn bracketed_words(title: &str) -> Option<(usize, usize)> {
    for (start, open) in title.char_indices() {
        let Some(&(openers, closers)) =
            BRACKETS.iter().find(|(openers, _)| openers.contains(&open))
        else {
            continue;
        };
        let inside = start + open.len_utf8();
        let Some((length, close)) = title[inside..]
            .char_indices()
            .find(|(_, candidate)| closers.contains(candidate))
        else {
            continue;
        };
        let content = &title[inside..inside + length];
        // An inner pair of the same kind, in any of its forms, is met on its own.
        if !content.contains(openers) && listed_words(content) {
            return Some((start, inside + length + close.len_utf8()));
        }
    }
    None
}

/// The first bracketed listed words, with their brackets, else the first exact listed tag.
fn next_tag(title: &str) -> Option<(usize, usize)> {
    bracketed_words(title).or_else(|| {
        TAGS.lines()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && !tag.starts_with('#'))
            .find_map(|tag| title.find(tag).map(|start| (start, start + tag.len())))
    })
}

/// Removes a tag; a space before it goes too when a space, closing punctuation or the end
/// follows, so `前 (GA文庫) 後` keeps one space and `Vol. 1 (LN): Title` none.
fn cut(title: &str, start: usize, end: usize) -> String {
    let (before, after) = (&title[..start], &title[end..]);
    let joins = after
        .chars()
        .next()
        .is_none_or(|next| next.is_whitespace() || CLOSING.contains(&next));
    let before = if joins {
        before.trim_end_matches(char::is_whitespace)
    } else {
        before
    };
    format!("{before}{after}")
}

/// Removes every exact, case-sensitive listed tag from `title-cleaning-list.txt` wherever it is,
/// and every bracket pair holding only words from `title-cleaning-words.txt`, then trims outer
/// Unicode whitespace. Other text, punctuation and whitespace stay. Repeats until nothing is
/// left to remove, so removing one tag cannot leave another for the next catalog refresh. A
/// title of only tags and whitespace becomes the existing missing-title fallback.
pub(crate) fn clean(title: &str) -> Option<String> {
    let mut cleaned = title.to_owned();
    while let Some((start, end)) = next_tag(&cleaned) {
        cleaned = cut(&cleaned, start, end);
    }
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

/// Cleans every catalog title again, once, after the cleaning changed: the `title-cleaning`
/// preference records the revision last applied. Only titles change, in place, so every
/// catalog ID and its reading state stay attached; an older Komori keeps opening the catalog.
pub(crate) fn refresh_catalog(connection: &Connection) -> Result<(), String> {
    let applied = || -> Result<i64, String> {
        let record: Option<String> = connection
            .query_row(
                "SELECT value FROM preferences WHERE name = ?1",
                [REVISION_RECORD],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        Ok(record
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .and_then(|value| value.get("revision")?.as_i64())
            .unwrap_or(0))
    };
    if applied()? >= REVISION {
        return Ok(());
    }
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    // Another connection may have refreshed meanwhile.
    if applied()? >= REVISION {
        return Ok(());
    }
    let titles: Vec<(String, String)> = {
        let mut statement = transaction
            .prepare("SELECT id, title FROM books WHERE title IS NOT NULL")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    for (id, title) in titles {
        let cleaned = clean(&title);
        if cleaned.as_deref() != Some(title.as_str()) {
            transaction
                .execute(
                    "UPDATE books SET title = ?1 WHERE id = ?2",
                    rusqlite::params![cleaned, id],
                )
                .map_err(storage_error)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET
               value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [
                REVISION_RECORD,
                &serde_json::json!({ "revision": REVISION }).to_string(),
            ],
        )
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed_tags() -> impl Iterator<Item = &'static str> {
        TAGS.lines()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && !tag.starts_with('#'))
    }

    #[test]
    fn every_listed_tag_is_removed_in_any_position_and_repeated_cleaning_is_stable() {
        for tag in listed_tags() {
            let cleaned = clean(&format!("\u{3000}{tag}本：第２巻{tag}！{tag} \t"));
            assert_eq!(cleaned.as_deref(), Some("本：第２巻！"), "{tag}");
            assert_eq!(clean(cleaned.as_deref().unwrap()), cleaned);
            assert_eq!(clean(&format!(" {tag}{tag}\u{3000}")), None, "{tag}");
        }
    }

    #[test]
    fn every_listed_word_and_ending_is_removed_in_every_kind_of_bracket() {
        for line in WORDS.lines().map(str::trim) {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let content = match line.strip_prefix('*') {
                Some(ending) => format!("レーベル{ending}"),
                None => line.to_owned(),
            };
            // Every opening form with every closing form of its kind: `(…)`, `（…）`, `（…)`.
            for (openers, closers) in BRACKETS {
                for open in *openers {
                    for close in *closers {
                        assert_eq!(
                            clean(&format!("題名 2 {open}{content}{close}")).as_deref(),
                            Some("題名 2"),
                            "{open}{content}{close}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn words_count_in_either_width_and_case_joined_or_separated() {
        for title in [
            "題名（Ｋｉｎｄｌｅ版）",
            "題名 [light novel]",
            "題名 (LIGHT NOVEL)",
            "題名【BOOK☆WALKER限定 特典付き】",
            "題名（電子版・特典付き）",
            "題名〈電子版／ＳＳ付き〉",
            "題名【電子書籍限定書き下ろしＳＳ付き】",
            "題名【電子版あとがき付】",
            "題名 ≪Collector’s Edition≫",
            "題名 «Yen Press»",
            "題名（電子版)",
            "題名(ＨＪ文庫）",
            "題名［Kindle版]",
            "題名＜限定版>",
            "題名 《特典付き≫",
        ] {
            assert_eq!(clean(title).as_deref(), Some("題名"), "{title}");
        }
        // The tags from a BOOK☆WALKER library, which the exact list does not hold.
        for tag in [
            "(ヴァリアントノベルズ)",
            "【TOジュニア文庫】",
            "【合本版】",
            "【期間限定購入特典】",
            "【購入特典】",
            "(角川文庫)",
        ] {
            assert_eq!(
                clean(&format!("題名 1{tag}")).as_deref(),
                Some("題名 1"),
                "{tag}"
            );
        }
    }

    #[test]
    fn brackets_holding_a_titles_own_words_stay() {
        for title in [
            "落第騎士の英雄譚＜キャバルリィ＞ 1",
            "最弱無敗の神装機竜≪バハムート≫",
            "ダンジョン就活のススメ 〈ダン活〉",
            "【状態異常スキル】で最強になった俺",
            "物語（上）",
            "物語〈下〉",
            "【朗報】俺の許嫁になった地味子",
            "86―エイティシックス―［ナンバーシックス］",
            "<運命に愛されてごめんなさい。>",
            "《このラブコメがすごい!!》金賞",
            "スキル（×3）",
            "題名「電子版」",
            "ゲーマーズ！11",
            "電子版の謎",
            "(題名を長く書いたとても長い名前の文庫)",
            "Title (Graphic Novel)",
            "題名【レンタル】",
            // Kinds do not mix: a round bracket never closes a square or lenticular one.
            "題名（電子版]",
            "題名【電子版)",
        ] {
            assert_eq!(clean(title).as_deref(), Some(title), "{title}");
        }
    }

    #[test]
    fn a_removed_tag_takes_its_leading_space_where_it_would_double_or_dangle() {
        assert_eq!(clean("前 (GA文庫) 後").as_deref(), Some("前 後"));
        assert_eq!(
            clean("Overlord, Vol. 1 (light novel): The Undead King").as_deref(),
            Some("Overlord, Vol. 1: The Undead King")
        );
        assert_eq!(clean("題名 (電子版)／副題").as_deref(), Some("題名 ／副題"));
        assert_eq!(clean("題名(電子版) 2").as_deref(), Some("題名 2"));
    }

    #[test]
    fn unrelated_text_punctuation_case_and_internal_whitespace_are_preserved() {
        assert_eq!(
            clean(" \t題名  ～続編～\n(別の本) (ga本)【電子版】\u{3000}"),
            Some("題名  ～続編～\n(別の本) (ga本)".into())
        );
        assert_eq!(clean("VG文庫題名"), Some("題名".into()));
        // Exact tags are case-sensitive outside brackets.
        assert_eq!(clean("vg文庫題名"), Some("vg文庫題名".into()));
        assert_eq!(clean(""), None);
        assert_eq!(clean("\t\n\u{3000}"), None);
        assert_eq!(clean("【電子版】"), None);
        assert_eq!(clean("題名(GA【電子版】文庫)"), Some("題名".into()));
        // An inner pair of the same kind, in either width, is met on its own.
        assert_eq!(clean("(題名（電子版)) 2"), Some("(題名) 2".into()));
    }

    #[test]
    fn the_catalog_cleans_its_titles_again_once_after_the_cleaning_changed() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = crate::library::open_catalog(&database).unwrap();
        let revision = |connection: &Connection| -> String {
            connection
                .query_row(
                    "SELECT value FROM preferences WHERE name = 'title-cleaning'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(revision(&connection), r#"{"revision":2}"#);
        connection
            .execute_batch(
                "INSERT INTO books (id, source_path, file_name, title) VALUES
                   ('a', 'C:/a.epub', 'a.epub', '題名 1（電子版）'),
                   ('b', 'C:/b.epub', 'b.epub', '【電子版】'),
                   ('c', 'C:/c.epub', 'c.epub', '物語（上）');",
            )
            .unwrap();
        drop(connection);
        // Up to date: titles stay as they are.
        let connection = crate::library::open_catalog(&database).unwrap();
        let title = |connection: &Connection, id: &str| -> Option<String> {
            connection
                .query_row("SELECT title FROM books WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(title(&connection, "a").as_deref(), Some("題名 1（電子版）"));
        connection
            .execute(
                "UPDATE preferences SET value = '{\"revision\":1}' WHERE name = 'title-cleaning'",
                [],
            )
            .unwrap();
        drop(connection);
        let connection = crate::library::open_catalog(&database).unwrap();
        assert_eq!(title(&connection, "a").as_deref(), Some("題名 1"));
        assert_eq!(title(&connection, "b"), None);
        assert_eq!(title(&connection, "c").as_deref(), Some("物語（上）"));
        assert_eq!(revision(&connection), r#"{"revision":2}"#);
    }
}
