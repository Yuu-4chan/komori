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
// as the one the Series dialog suggests for the same books. A title's own `！` or `？` stays.
static TRAILING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[[\s\p{N}\p{Po}\p{Ps}\p{Pi}\p{Pc}]--[!?！？‼⁉⁈⁇]]+$").unwrap());
static VOLUME_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[^\p{L}\p{N}])(vol(?:ume)?|ep(?:isode)?|book|part|tome|tomo|livro|parte)$",
    )
    .unwrap()
});
static CLOSING_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Pd}\p{S}]$").unwrap());
/// One part of a volume split in two or three, closing a title: `（上）`, `〈下〉`, `前編`, `中巻`.
static PART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[（(〈【［\[]\s*([上中下前後])[編巻]?\s*[）)〉】］\]]|([上中下前後])[編巻])$")
        .unwrap()
});
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
/// one the name before its subtitle names (`俺の…カノジョ ※みんな激重になった01`), or an
/// earlier number names (`その者。のちに…08新婚旅行編01`), as a volume that series does not
/// have yet.
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
    let mut series: HashSet<&str> = sharing
        .iter()
        .filter(|(name, indexes)| {
            named.contains(*name) || indexes.iter().any(|index| *index != indexes[0])
        })
        .map(|(name, _)| *name)
        .chain(named.iter().copied())
        .collect();
    // A volume whose title alone carries a subtitle (`たかがアイドル！～されど…～01` beside
    // `たかがアイドル！02`) makes the name before it a series with the other book's volume.
    let shorter: Vec<Vec<String>> = candidates
        .iter()
        .map(|options| {
            options
                .first()
                .map(|(name, _)| subtitle_names(name))
                .unwrap_or_default()
        })
        .collect();
    for (options, shorter) in candidates.iter().zip(&shorter) {
        let Some((name, index)) = options.first() else {
            continue;
        };
        if series.contains(name.as_str()) {
            continue;
        }
        let promoted = shorter.iter().find_map(|short| {
            sharing
                .get_key_value(short.as_str())
                .filter(|(_, indexes)| indexes.iter().any(|other| other != index))
                .map(|(name, _)| *name)
        });
        if let Some(name) = promoted {
            series.insert(name);
        }
    }

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
    for ((options, shorter), chosen) in candidates.iter().zip(&shorter).zip(chosen.iter_mut()) {
        if chosen.is_some() {
            continue;
        }
        let free = |name: &str, index: &f64| {
            series.contains(name) && !volumes.get(name).is_some_and(|taken| taken.contains(index))
        };
        let joined = options
            .first()
            .and_then(|(_, index)| {
                shorter
                    .iter()
                    .find(|name| free(name, index))
                    .map(|name| (name.clone(), *index))
            })
            .or_else(|| {
                options
                    .iter()
                    .skip(1)
                    .find(|(name, index)| free(name, index))
                    .cloned()
            });
        if let Some((name, index)) = joined {
            volumes.entry(name.clone()).or_default().push(index);
            *chosen = Some((name, index));
        }
    }
    chosen
}

/// Every series name and volume a title can be read as, the likeliest first: from its last
/// number back to its first, then a closing Roman numeral, then a closing part (`（上）` is 1,
/// `（中）` 2, `（下）` 3), then a heading number.
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
        if let Some(part) = PART.captures(title.trim_end()) {
            let value = match part.get(1).or(part.get(2)).map(|part| part.as_str()) {
                Some("上" | "前") => 1.0,
                Some("中") => 2.0,
                _ => 3.0,
            };
            if let Some(name) = series_name(&title[..part.get(0).unwrap().start()]) {
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

/// The series name a title's start gives: volume words, parts, numbers, separators, and
/// opening brackets at its end are left out, and so is a dash or symbol unless it closes one
/// opening earlier in the name (`─エイティシックス─`, `＜インフィニット・ストラトス＞`).
/// `None` without a letter.
fn series_name(start: &str) -> Option<String> {
    let mut stem = start.trim().to_owned();
    loop {
        let mut next = TRAILING.replace(&stem, "").into_owned();
        if let Some(word) = VOLUME_WORD.captures(&next).and_then(|word| word.get(1)) {
            next.truncate(word.start());
        } else if let Some(stripped) = next.strip_suffix('第') {
            next.truncate(stripped.len());
        } else if let Some(part) = PART.find(&next) {
            next.truncate(part.start());
        }
        if let Some(mark) = CLOSING_MARK.find(&next) {
            let opening = match mark.as_str() {
                ">" => "<",
                "＞" => "＜",
                "﹥" => "﹤",
                same => same,
            };
            let earlier = &next[..mark.start()];
            if !earlier.contains(mark.as_str()) && !earlier.contains(opening) {
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

/// The names a series name gives before a subtitle it may carry, longest first:
/// `たかがアイドル！～されど、やっぱり顔はいい～` gives `たかがアイドル`.
fn subtitle_names(name: &str) -> Vec<String> {
    let mut names: Vec<String> = name
        .char_indices()
        .filter(|(_, character)| character.is_whitespace() || "～〜~※―—–:：".contains(*character))
        .filter_map(|(at, _)| series_name(&name[..at]))
        .filter(|short| short != name)
        .collect();
    names.reverse();
    names.dedup();
    names
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
    fn joins_a_volume_whose_title_alone_carries_a_subtitle_or_a_part() {
        assert_eq!(
            named(&[
                "たかがアイドル！～されど、やっぱり顔はいい～01",
                "たかがアイドル！02",
                "俺の一番になりたい3人の清楚なカノジョ ※みんな激重になった01",
                "俺の一番になりたい3人の清楚なカノジョ02",
                "地味なおじさん、実は英雄でした。01",
                "地味なおじさん、実は英雄でした。02",
                "地味なおじさん、実は英雄でした（上）。05",
                "地味なおじさん、実は英雄でした（下）。06",
                "優等生がアダルトグッズを買いに来た（上）",
                "優等生がアダルトグッズを買いに来た（下）",
            ]),
            vec![
                volume("たかがアイドル！", 1.0),
                volume("たかがアイドル！", 2.0),
                volume("俺の一番になりたい3人の清楚なカノジョ", 1.0),
                volume("俺の一番になりたい3人の清楚なカノジョ", 2.0),
                volume("地味なおじさん、実は英雄でした", 1.0),
                volume("地味なおじさん、実は英雄でした", 2.0),
                volume("地味なおじさん、実は英雄でした", 5.0),
                volume("地味なおじさん、実は英雄でした", 6.0),
                volume("優等生がアダルトグッズを買いに来た", 1.0),
                volume("優等生がアダルトグッズを買いに来た", 3.0),
            ]
        );
        // A spin-off whose volume the series has, the same volume twice, and two subtitles alone
        // stay apart.
        assert_eq!(
            named(&[
                "ヒロインが最後に死ぬラブコメ01",
                "ヒロインが最後に死ぬラブコメ02",
                "ヒロインが最後に死ぬラブコメ～夢の彼女編～01",
                "遊戯に夢中な気まぐれ天使の堕としかた_01",
                "遊戯に夢中な気まぐれ天使の堕としかた～チート使いの美少女天使を～01",
                "The Apothecary Diaries 05",
                "The Faraway Paladin 03",
            ]),
            vec![
                volume("ヒロインが最後に死ぬラブコメ", 1.0),
                volume("ヒロインが最後に死ぬラブコメ", 2.0),
                None,
                None,
                None,
                None,
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
            (
                "IS＜インフィニット・ストラトス＞",
                Some("IS＜インフィニット・ストラトス＞"),
            ),
            (
                "運命に愛されて。<運命に愛されて。>",
                Some("運命に愛されて。<運命に愛されて。>"),
            ),
            ("ギブあっぷ！", Some("ギブあっぷ！")),
            (
                "だれがわたしの百合なのか!? ",
                Some("だれがわたしの百合なのか!?"),
            ),
            ("Re:Zero, ", Some("Re:Zero")),
            ("魔女と傭兵（下）", Some("魔女と傭兵")),
            ("Foo Volume ", Some("Foo")),
            ("Facebook ", Some("Facebook")),
            ("2.", None),
        ] {
            assert_eq!(series_name(start).as_deref(), name, "{start}");
        }
    }

    #[test]
    #[ignore = "reads a TSV of catalog titles named by KOMORI_TITLES_TSV; writes the named series beside it"]
    fn names_series_across_a_real_catalog() {
        let path = std::env::var("KOMORI_TITLES_TSV").expect("KOMORI_TITLES_TSV");
        let text = std::fs::read_to_string(&path).unwrap();
        let rows: Vec<Vec<&str>> = text
            .lines()
            .map(|line| line.split('\t').collect())
            .collect();
        let books: Vec<TitledBook<'_>> = rows
            .iter()
            .map(|row| TitledBook {
                title: Some(row[1]).filter(|title| !title.is_empty()),
                series: Some(row[2]).filter(|series| !series.is_empty()),
                series_index: row[3].parse().ok(),
                series_manual: row[4] == "1",
            })
            .collect();
        let named = series_from_titles(&books);
        let out: String = rows
            .iter()
            .zip(named)
            .map(|(row, named)| {
                let (series, index) = named
                    .map(|(series, index)| (series, index.to_string()))
                    .unwrap_or_default();
                [row[0], row[1], row[2], &series, &index].join("\t") + "\n"
            })
            .collect();
        std::fs::write(format!("{path}.out"), out).unwrap();
    }
}
