//! Series named from the catalog's titles, for books neither the reader nor the book's own
//! metadata gave one. Computed as the Library lists; never stored, and source EPUBs are untouched.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;

/// What the grouping reads of a catalog book.
pub(crate) struct TitledBook<'a> {
    pub(crate) title: Option<&'a str>,
    /// The series set by hand, or else the book's own.
    pub(crate) series: Option<&'a str>,
    pub(crate) series_index: Option<f64>,
    /// Whether the series (or having none) was set by hand.
    pub(crate) series_manual: bool,
}

/// A volume's number: `07`, `０７`, `4.5`.
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9０-９]+(?:[.．][0-9０-９]+)?").unwrap());
/// A Roman numeral ending the title after a space (`Unnamed Memory XII`), or a numeral sign.
static ROMAN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:\s([IVXLC]+)|\s*([Ⅰ-Ⅻ]))$").unwrap());
/// A number heading the title before a dot: `01. Fate/Zero`.
static LEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9０-９]+)[.．]\s*(.+)$").unwrap());
// The cleaning below is the Library's `seriesFromTitles`, so a series named here reads the same
// as the one the Series dialog suggests for the same books.
static TRAILING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s\p{N}\p{Po}\p{Ps}\p{Pi}\p{Pc}]+$").unwrap());
static VOLUME_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[^\p{L}\p{N}])(vol(?:ume)?|ep(?:isode)?|book|part|tome|tomo|livro|parte)$",
    )
    .unwrap()
});
static CLOSING_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Pd}\p{S}]$").unwrap());
static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}").unwrap());

/// The automatic series and volume of each book, in the same order; `None` for books that keep
/// their own series or none.
///
/// Only books without a series, whose having none was not chosen by hand, are named. A title's
/// last number is its volume and the text before it, cleaned, the series (`幼女戦記07`,
/// `86─エイティシックス─Ep.05─…─`, `涼宮ハルヒ09の分裂`); a title without one can end in a
/// Roman numeral (`Unnamed Memory VI`) or begin with its number (`01. Fate/Zero`). A name
/// becomes a series once two such books share it with different volumes, or when another book
/// already has a series by that name. A book whose last number names no series can still join
/// one an earlier number names, as a volume that series does not have yet
/// (`その者。のちに…08新婚旅行編01`).
pub(crate) fn series_from_titles(books: &[TitledBook<'_>]) -> Vec<Option<(String, f64)>> {
    let mut volumes: HashMap<String, Vec<f64>> = HashMap::new();
    for book in books {
        if let (Some(series), Some(index)) = (book.series, book.series_index) {
            volumes.entry(series.to_owned()).or_default().push(index);
        }
    }
    let named: HashSet<&str> = books.iter().filter_map(|book| book.series).collect();
    let candidates: Vec<Vec<(String, f64)>> = books
        .iter()
        .map(|book| match book.title {
            Some(title) if book.series.is_none() && !book.series_manual => volume_candidates(title),
            _ => Vec::new(),
        })
        .collect();

    let mut sharing: HashMap<&str, Vec<f64>> = HashMap::new();
    for (name, index) in candidates.iter().filter_map(|options| options.first()) {
        sharing.entry(name.as_str()).or_default().push(*index);
    }
    let series: HashSet<&str> = sharing
        .iter()
        .filter(|(name, indexes)| {
            named.contains(*name) || indexes.iter().any(|index| *index != indexes[0])
        })
        .map(|(name, _)| *name)
        .chain(named.iter().copied())
        .collect();

    let mut chosen: Vec<Option<(String, f64)>> = candidates
        .iter()
        .map(|options| {
            options
                .first()
                .filter(|(name, _)| series.contains(name.as_str()))
                .cloned()
        })
        .collect();
    for (name, index) in chosen.iter().flatten() {
        volumes.entry(name.clone()).or_default().push(*index);
    }
    for (options, chosen) in candidates.iter().zip(chosen.iter_mut()) {
        if chosen.is_some() {
            continue;
        }
        let joined = options.iter().skip(1).find(|(name, index)| {
            series.contains(name.as_str())
                && !volumes.get(name).is_some_and(|taken| taken.contains(index))
        });
        if let Some((name, index)) = joined {
            volumes.entry(name.clone()).or_default().push(*index);
            *chosen = Some((name.clone(), *index));
        }
    }
    chosen
}

/// Every series name and volume a title can be read as, the likeliest first: from its last
/// number back to its first, then a closing Roman numeral, then a heading number.
fn volume_candidates(title: &str) -> Vec<(String, f64)> {
    let mut candidates: Vec<(String, f64)> = NUMBER
        .find_iter(title)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter_map(|number| {
            Some((
                series_name(&title[..number.start()])?,
                parse_number(number.as_str())?,
            ))
        })
        .collect();
    if candidates.is_empty() {
        if let Some(numeral) = ROMAN.captures(title) {
            let whole = numeral.get(0).unwrap();
            let value = match (numeral.get(1), numeral.get(2)) {
                (Some(letters), _) => roman_value(letters.as_str()),
                (_, Some(sign)) => sign
                    .as_str()
                    .chars()
                    .next()
                    .map(|sign| f64::from(sign as u32 - 0x215F)),
                _ => None,
            };
            if let (Some(name), Some(value)) = (series_name(&title[..whole.start()]), value) {
                candidates.push((name, value));
            }
        }
    }
    if candidates.is_empty() {
        if let Some(leading) = LEADING.captures(title) {
            if let (Some(name), Some(value)) = (series_name(&leading[2]), parse_number(&leading[1]))
            {
                candidates.push((name, value));
            }
        }
    }
    candidates
}

/// The series name a title's start gives: volume words, numbers, separators, and opening
/// brackets at its end are left out, and so is a dash or symbol unless it closes one opening
/// earlier in the name. `None` without a letter.
fn series_name(start: &str) -> Option<String> {
    let mut stem = start.trim().to_owned();
    loop {
        let mut next = TRAILING.replace(&stem, "").into_owned();
        if let Some(word) = VOLUME_WORD.captures(&next).and_then(|word| word.get(1)) {
            next.truncate(word.start());
        } else if let Some(stripped) = next.strip_suffix('第') {
            next.truncate(stripped.len());
        }
        if let Some(mark) = CLOSING_MARK.find(&next) {
            if !next[..mark.start()].contains(mark.as_str()) {
                next.truncate(mark.start());
            }
        }
        if next == stem {
            break;
        }
        stem = next;
    }
    LETTER.is_match(&stem).then_some(stem)
}

fn parse_number(text: &str) -> Option<f64> {
    let ascii: String = text
        .chars()
        .map(|character| match character {
            '０'..='９' => char::from(b'0' + (character as u32 - '０' as u32) as u8),
            '．' => '.',
            other => other,
        })
        .collect();
    ascii.parse().ok()
}

/// A well-formed Roman numeral's value, up to 399.
fn roman_value(numeral: &str) -> Option<f64> {
    let digit = |letter| match letter {
        'I' => 1,
        'V' => 5,
        'X' => 10,
        'L' => 50,
        'C' => 100,
        _ => 0,
    };
    let letters: Vec<u32> = numeral.chars().map(digit).collect();
    let value = letters
        .iter()
        .enumerate()
        .fold(0i64, |total, (position, &value)| {
            if letters.get(position + 1).is_some_and(|&next| next > value) {
                total - i64::from(value)
            } else {
                total + i64::from(value)
            }
        });
    // Only the numeral's own spelling, so `IIII` or `VX` read as no number.
    let value = u32::try_from(value)
        .ok()
        .filter(|value| (1..400).contains(value))?;
    (roman_numeral(value) == numeral).then_some(f64::from(value))
}

fn roman_numeral(mut value: u32) -> String {
    let mut numeral = String::new();
    for (step, letters) in [
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ] {
        while value >= step {
            numeral.push_str(letters);
            value -= step;
        }
    }
    numeral
}

#[cfg(test)]
mod tests {
    use super::*;

    fn untitled(title: &str) -> TitledBook<'_> {
        TitledBook {
            title: Some(title),
            series: None,
            series_index: None,
            series_manual: false,
        }
    }

    fn named(titles: &[&str]) -> Vec<Option<(String, f64)>> {
        series_from_titles(
            &titles
                .iter()
                .map(|title| untitled(title))
                .collect::<Vec<_>>(),
        )
    }

    fn volume(series: &str, index: f64) -> Option<(String, f64)> {
        Some((series.to_owned(), index))
    }

    #[test]
    fn names_a_series_from_volumes_sharing_a_title() {
        assert_eq!(
            named(&[
                "14歳とイラストレーター01",
                "14歳とイラストレーター02",
                "幼女戦記07"
            ]),
            vec![
                volume("14歳とイラストレーター", 1.0),
                volume("14歳とイラストレーター", 2.0),
                None,
            ]
        );
        assert_eq!(
            named(&[
                "Cat Tales Vol. 1",
                "Cat Tales Vol. 2",
                "作品 第1巻",
                "作品 第２巻"
            ]),
            vec![
                volume("Cat Tales", 1.0),
                volume("Cat Tales", 2.0),
                volume("作品", 1.0),
                volume("作品", 2.0),
            ]
        );
        // A subtitle after the number, and a dash closing one earlier in the name.
        assert_eq!(
            named(&[
                "86─エイティシックス─Ep.05─死よ、驕るなかれ─",
                "86─エイティシックス─Ep.06─明けねばこそ夜は永く─",
                "涼宮ハルヒ01の憂鬱",
                "涼宮ハルヒ02の溜息",
            ]),
            vec![
                volume("86─エイティシックス─", 5.0),
                volume("86─エイティシックス─", 6.0),
                volume("涼宮ハルヒ", 1.0),
                volume("涼宮ハルヒ", 2.0),
            ]
        );
        // Numbers inside the name stay in it: only the last one is the volume.
        assert_eq!(
            named(&[
                "転生してから40年。そろそろ、おじさんも恋がしたい。01",
                "転生してから40年。そろそろ、おじさんも恋がしたい。02",
                "アーリャさん04",
                "アーリャさん04.5 Summer Stories",
            ]),
            vec![
                volume("転生してから40年。そろそろ、おじさんも恋がしたい", 1.0),
                volume("転生してから40年。そろそろ、おじさんも恋がしたい", 2.0),
                volume("アーリャさん", 4.0),
                volume("アーリャさん", 4.5),
            ]
        );
    }

    #[test]
    fn reads_roman_numerals_and_heading_numbers() {
        assert_eq!(
            named(&[
                "Unnamed Memory IV",
                "Unnamed Memory XII",
                "Unnamed Memory IIII",
                "01. Fate/Zero",
                "02. Fate/Zero",
                "ダンジョン Ⅱ",
                "ダンジョン Ⅲ",
            ]),
            vec![
                volume("Unnamed Memory", 4.0),
                volume("Unnamed Memory", 12.0),
                None,
                volume("Fate/Zero", 1.0),
                volume("Fate/Zero", 2.0),
                volume("ダンジョン", 2.0),
                volume("ダンジョン", 3.0),
            ]
        );
    }

    #[test]
    fn keeps_single_volumes_spin_offs_and_lone_numbers_apart() {
        assert_eq!(
            named(&[
                "魔法科高校の劣等生01",
                "魔法科高校の劣等生02",
                "魔法科高校の優等生01",
                "続・魔法科高校の劣等生メイジアン・カンパニー01",
                "錬金術師の聖櫃01",
                "人間失格",
                "1984",
            ]),
            vec![
                volume("魔法科高校の劣等生", 1.0),
                volume("魔法科高校の劣等生", 2.0),
                None,
                None,
                None,
                None,
                None,
            ]
        );
        // Two books with the same number are not yet a series: a number inside two titles.
        assert_eq!(
            named(&["ぼっちの僕―たった1回の夜", "ぼっちの僕―たった1回の朝"]),
            vec![None, None]
        );
    }

    #[test]
    fn joins_volumes_a_series_does_not_have_through_an_earlier_number() {
        assert_eq!(
            named(&[
                "その者。のちに…07",
                "その者。のちに...06",
                "その者。のちに…08新婚旅行編01",
                "ようこそ教室へ01",
                "ようこそ教室へ02",
                "ようこそ教室へ2年生編4",
            ]),
            vec![
                volume("その者。のちに", 7.0),
                volume("その者。のちに", 6.0),
                volume("その者。のちに", 8.0),
                volume("ようこそ教室へ", 1.0),
                volume("ようこそ教室へ", 2.0),
                // Volume 2 is taken: a sequel's numbering, not the series' own.
                None,
            ]
        );
    }

    #[test]
    fn leaves_series_set_by_hand_or_read_from_the_book_and_joins_their_names() {
        let books = [
            TitledBook {
                series: Some("灼眼のシャナ"),
                series_index: Some(1.0),
                ..untitled("灼眼のシャナ01")
            },
            untitled("灼眼のシャナ02"),
            TitledBook {
                series_manual: true,
                ..untitled("キノの旅01")
            },
            untitled("キノの旅02"),
            TitledBook {
                title: None,
                ..untitled("")
            },
        ];
        assert_eq!(
            series_from_titles(&books),
            vec![None, volume("灼眼のシャナ", 2.0), None, None, None]
        );
    }

    #[test]
    fn cleans_names_as_the_series_dialog_does() {
        for (start, name) in [
            ("Re:Zero - ", Some("Re:Zero")),
            ("Saga (Light Novel) ", Some("Saga (Light Novel)")),
            (
                "TS剣闘士は異世界で何を見るか。",
                Some("TS剣闘士は異世界で何を見るか"),
            ),
            (
                "ムリムリ！（※ムリじゃなかった!?）",
                Some("ムリムリ！（※ムリじゃなかった!?）"),
            ),
            ("Foo Volume ", Some("Foo")),
            ("Facebook ", Some("Facebook")),
            ("2.", None),
        ] {
            assert_eq!(series_name(start).as_deref(), name, "{start}");
        }
    }
}
