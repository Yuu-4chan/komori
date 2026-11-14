//! Series named automatically, in order of preference: what the reader set by hand, then numbered
//! file names, then the book's own series, then numbered titles. Computed as the Library lists;
//! never stored, and source EPUBs are untouched.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;

/// What the grouping reads of a catalog book.
pub(crate) struct TitledBook<'a> {
    pub(crate) file_name: Option<&'a str>,
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
/// A Roman numeral, in ASCII or full-width letters (`XI`, `ＸI`), or a numeral sign (`Ⅳ`).
static ROMAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[IVXLCＩＶＸＬＣ]+|[Ⅰ-Ⅻ]").unwrap());
/// A volume counted in kanji: `四巻`, `十二巻`, `一〇巻`.
static KANJI_VOLUME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([〇一二三四五六七八九十百]+)巻").unwrap());
/// An edition note after a volume number, not a subtitle: `11 特装版【短編小説付き】`.
static EDITION_NOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\s　]*(?:特装版|限定版|通常版|初回|特典|[【\[［(（])").unwrap()
});
/// A volume note heading a file name: `【小説9巻】`, `【3】`, `【第１弾】`.
static LEADING_VOLUME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^【[^】0-9０-９]*?([0-9０-９]+)(?:巻|弾)?】\s*(.+)$").unwrap());
/// A number heading a file name before a space: `09 Title.epub`, but not a year.
static LEADING_SPACED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9０-９]{1,3})[\s　]+(\S.*)$").unwrap());
/// A title naming its own series at its end: `朱色の研究 「火村英生」シリーズ`.
static NAMED_SERIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)((?:[「『][^」』]+[」』])?[^\s「『」』]*シリーズ)$").unwrap()
});
/// A number heading the title before a dot: `01. Fate/Zero`.
static LEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9０-９]+)[.．]\s*(.+)$").unwrap());
// The cleaning below is the Library's `seriesFromTitles`, so a series named here reads the same
// as the one the Series dialog suggests for the same books. A title's own `！` or `？` stays.
static TRAILING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[[\s\p{N}\p{Po}\p{Ps}\p{Pi}\p{Pc}]--[!?！？‼⁉⁈⁇]]+$").unwrap());
static VOLUME_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[^\p{L}\p{N}])(v|vol(?:ume)?|ep(?:isode)?|book|part|tome|tomo|livro|parte)$",
    )
    .unwrap()
});
/// A volume word right before a number: `Vol 13 - 2002` is volume 13, not 2002.
static NUMBERED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:(?:^|[^\p{L}\p{N}])(?:v|vol(?:ume)?|ep(?:isode)?|book|part|tome|tomo|livro|parte)[.\s]*|第)$",
    )
    .unwrap()
});
/// An opening bracket heading a name that never closes it, maybe after a bonus note:
/// `『八男って…！ 26』BOOK☆WALKER…`, `購入特典『Unnamed Memory -after the end-IV』…`.
static UNCLOSED_OPENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[^\p{Ps}\p{Pi}\p{Pe}\p{Pf}]*(?:特典|限定|SS|ＳＳ)\s*)?[\p{Ps}\p{Pi}]\s*([^\p{Pe}\p{Pf}]*)$")
        .unwrap()
});
static CLOSING_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Pd}\p{S}]$").unwrap());
/// One part of a volume split in two or three, closing a title: `（上）`, `〈下〉`, `〔上〕`, `前編`,
/// `中巻`, ` 下`.
static PART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[（(〈【［\[〔]\s*([上中下前後])[編巻]?\s*[）)〉】］\]〕]|([上中下前後])[編巻]|[\s　]([上中下]))$")
        .unwrap()
});
static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}").unwrap());
/// A copy's mark closing a file name, not a volume: `Title (1)`, `Title - Copy`.
static COPY_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:\s+\(\d+\)|\s+-\s+copy)$").unwrap());
/// A bracketed note closing a file name: `(2020)`, `[Group]`, `(z-lib.org)`.
static FILE_NOTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*(?:\[([^\[\]]*)\]|\(([^()]*)\))$").unwrap());
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:19|20)\d\d$").unwrap());
/// Sites a file was downloaded from: `(z-library.sk, 1lib.sk, z-lib.sk)`.
static SITES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9-]+\.[a-z]{2,4}(?:\s*,\s*[a-z0-9-]+\.[a-z]{2,4})*$").unwrap()
});
/// A file's checksum, as release groups add: `[CFEE3F0A]`.
static CHECKSUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Fa-f]{8}$").unwrap());
static LEADING_NOTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\[[^\[\]]*\]\s*").unwrap());
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.epub$").unwrap());

/// What a catalog book offers one pass of the naming.
struct Reading<'a> {
    text: Option<&'a str>,
    series: Option<&'a str>,
    series_index: Option<f64>,
}

/// The automatic series and volume of each book, in the same order; `None` for books that keep
/// their own series or none. A side story joins its series without a volume.
///
/// A series set by hand is never changed. Numbered file names come first, so what the reader
/// named their files wins over the book's metadata, unless the file's name shares no word with a
/// numbered title (`SUN_6.epub`); then the book's own series stays; then numbered titles can name
/// books with neither, and books without a number join the series their titles begin with (see
/// `join_unnumbered`). See `name_series` for what makes a series. A series a file name gives reads
/// as the books' titles spell it, as a file can't have a `:`.
pub(crate) fn series_from_titles(books: &[TitledBook<'_>]) -> Vec<Option<(String, Option<f64>)>> {
    let file_titles: Vec<Option<String>> = books
        .iter()
        .map(|book| {
            book.file_name
                .filter(|_| !book.series_manual)
                .and_then(file_title)
        })
        .collect();
    // The book's own series can't name it here, but a file name can join a series by that name.
    let readings: Vec<Reading<'_>> = books
        .iter()
        .zip(&file_titles)
        .map(|(book, text)| Reading {
            text: text.as_deref(),
            series: book.series.filter(|_| book.series_manual),
            series_index: book.series_index.filter(|_| book.series_manual),
        })
        .chain(
            books
                .iter()
                .filter(|book| !book.series_manual && book.series.is_some())
                .map(|book| Reading {
                    text: None,
                    series: book.series,
                    series_index: book.series_index,
                }),
        )
        .collect();
    let mut from_files = name_series(&readings, false);
    from_files.truncate(books.len());
    spell_as_titles(books, &mut from_files);
    let strays = named_by_titles_instead(books, &from_files);
    for ((book, named), stray) in books.iter().zip(from_files.iter_mut()).zip(strays) {
        if stray
            || named
                .as_ref()
                .is_some_and(|(series, _)| spells_a_reading(series, book.title))
        {
            *named = None;
        }
    }

    let readings: Vec<Reading<'_>> = books
        .iter()
        .zip(&from_files)
        .map(|(book, named)| match named {
            Some((series, index)) => Reading {
                text: None,
                series: Some(series),
                series_index: Some(*index),
            },
            None => Reading {
                text: book
                    .title
                    .filter(|_| book.series.is_none() && !book.series_manual),
                series: book.series,
                series_index: book.series_index,
            },
        })
        .collect();
    let from_titles = name_series(&readings, true);
    let mut named: Vec<Option<(String, Option<f64>)>> = from_files
        .into_iter()
        .zip(from_titles)
        .map(|(file, title)| file.or(title).map(|(series, index)| (series, Some(index))))
        .collect();
    join_unnumbered(books, &mut named);
    named
}

/// Which books a file name's series leaves out of the series their titles name with more books
/// that no file name names, as a few files can be named apart (`SUN_6.epub` for
/// `時々ボソッとロシア語でデレる隣のアーリャさん6`): the file's series shares no word with the
/// title, the title's series has more such books than the file's, and none of them has this
/// volume. A book whose title is only another edition's name (`RAM 4` in `Trinity Blood - Rage
/// Against the Moons`) keeps its file's series, as no other book's title names it.
fn named_by_titles_instead(
    books: &[TitledBook<'_>],
    from_files: &[Option<(String, f64)>],
) -> Vec<bool> {
    let titled: Vec<Option<(String, f64)>> = books
        .iter()
        .map(|book| {
            let (name, index) = volume_candidates(book.title?).into_iter().next()?;
            Some((comparison_key(&name), index))
        })
        .collect();
    let mut by_files: HashMap<&str, usize> = HashMap::new();
    for (series, _) in from_files.iter().flatten() {
        *by_files.entry(series).or_default() += 1;
    }
    let mut by_titles: HashMap<&str, Vec<(f64, Option<&str>)>> = HashMap::new();
    for (titled, file) in titled.iter().zip(from_files) {
        if let Some((name, index)) = titled {
            let file = file.as_ref().map(|(series, _)| series.as_str());
            by_titles.entry(name).or_default().push((*index, file));
        }
    }
    books
        .iter()
        .zip(from_files)
        .zip(&titled)
        .map(|((book, file), titled)| {
            let (Some((series, _)), Some((name, index)), Some(title)) = (file, titled, book.title)
            else {
                return false;
            };
            let title = words_key(title);
            let shares_a_word = comparison_key(series)
                .split(|c: char| !c.is_alphanumeric())
                .any(|word| word.chars().count() >= 2 && title.contains(word));
            let others: Vec<f64> = by_titles
                .get(name.as_str())
                .into_iter()
                .flatten()
                .filter(|(_, file)| *file != Some(series.as_str()))
                .map(|(index, _)| *index)
                .collect();
            !shares_a_word && others.len() > by_files[series.as_str()] && !others.contains(index)
        })
        .collect()
}

/// Gives books without a number the series their titles begin with: a title that is the series'
/// name, or its name and the subtitle its volumes carry (`サイレント・ウィッチ　沈黙の魔女の隠しごと`
/// beside `サイレント・ウィッチ X　沈黙の魔女の隠しごと`), is its first volume when the series has
/// none; any other is a side story, in the series without a volume (`魔女の旅々　学園物語`,
/// `冴えない彼女の育てかたFD`), unless a number follows the name. The name must end the way names do or be followed by a space or a
/// subtitle mark (`魔法少女アニメの…` is not of `魔法少女`); after Latin letters, by `:`, `,`,
/// ` - ` or ` (`, as words are spaced anyway (`Another World…` is not of `Another`). Books still
/// without a series whose titles end in the same series' name (`「火村英生」シリーズ`) share it.
/// A lone numbered volume first makes a series with the book whose whole title is its name
/// (`隣の席の佐藤さん２` with `隣の席の佐藤さん`).
fn join_unnumbered(books: &[TitledBook<'_>], named: &mut [Option<(String, Option<f64>)>]) {
    let unnamed = |at: usize, named: &[Option<(String, Option<f64>)>]| {
        named[at].is_none() && books[at].series.is_none() && !books[at].series_manual
    };
    let mut whole: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, book) in books.iter().enumerate() {
        if let Some(title) = book.title.filter(|_| unnamed(at, named)) {
            whole
                .entry(comparison_key(title.trim()))
                .or_default()
                .push(at);
        }
    }
    for at in 0..books.len() {
        let Some(title) = books[at].title.filter(|_| unnamed(at, named)) else {
            continue;
        };
        let mut candidates = volume_candidates(title);
        candidates.extend(subtitled_candidates(title));
        let first = candidates.into_iter().find_map(|(name, index)| {
            let first = *whole
                .get(&comparison_key(&name))?
                .iter()
                .find(|&&other| other != at && unnamed(other, named))?;
            (index > 1.0).then_some((name, index, first))
        });
        if let Some((name, index, first)) = first {
            named[first] = Some((name.clone(), Some(1.0)));
            named[at] = Some((name, Some(index)));
        }
    }

    let mut series: HashMap<String, (String, Vec<f64>, Vec<&str>)> = HashMap::new();
    for (book, named) in books.iter().zip(named.iter()) {
        let (name, index) = match named {
            Some((name, index)) => (name.as_str(), *index),
            None if !book.series_manual => match book.series {
                Some(name) => (name, book.series_index),
                None => continue,
            },
            None => continue,
        };
        let entry = series
            .entry(comparison_key(name))
            .or_insert_with(|| (name.to_owned(), Vec::new(), Vec::new()));
        entry.1.extend(index);
        entry.2.extend(book.title);
    }
    let separated = |name: &str, rest: &str| {
        let Some(last) = name.chars().next_back() else {
            return false;
        };
        let Some(first) = rest.chars().next() else {
            return true;
        };
        if "!?。…".contains(last) {
            return true;
        }
        if !last.is_ascii() {
            return first.is_whitespace()
                || first.is_ascii_alphanumeric()
                || SUBTITLE_MARKS.contains(first)
                || "+-(「『【〈《<[".contains(first);
        }
        [":", ",", " - ", " – ", " — ", " ("]
            .iter()
            .any(|mark| rest.starts_with(mark))
    };
    for (book, named) in books.iter().zip(named.iter_mut()) {
        let Some(title) = book
            .title
            .filter(|_| named.is_none() && book.series.is_none() && !book.series_manual)
        else {
            continue;
        };
        let key = comparison_key(title);
        let joined = key
            .char_indices()
            .map(|(at, _)| at)
            .chain([key.len()])
            .rev()
            .filter(|&at| key[..at].chars().count() >= 3)
            .find_map(|at| {
                let (name, rest) = key.split_at(at);
                let entry = series.get(name)?;
                separated(name, rest).then_some((name.to_owned(), rest.to_owned(), entry))
            });
        // A numbered spin-off keeps apart, as its volumes would mix with the series' own.
        let Some((name, rest, (spelling, volumes, titles))) = joined
            .filter(|(_, rest, _)| numbers(rest).is_empty() && roman_numerals(rest).is_empty())
        else {
            continue;
        };
        let words = words_key(&rest);
        let first = rest.is_empty()
            || (!words.is_empty()
                && titles
                    .iter()
                    .any(|other| *other != title && words_key(other).contains(&words)));
        let index = (first && !volumes.contains(&1.0)).then_some(1.0);
        *named = Some((spelling.clone(), index));
        if index.is_some() {
            series.get_mut(&name).unwrap().1.push(1.0);
        }
    }

    let mut naming: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, (book, named)) in books.iter().zip(named.iter()).enumerate() {
        if named.is_some() || book.series.is_some() || book.series_manual {
            continue;
        }
        let Some(name) = book
            .title
            .and_then(|title| NAMED_SERIES.captures(title.trim()))
            .map(|found| found[1].to_owned())
            .filter(|name| LETTER.is_match(&name.replace("シリーズ", "")))
        else {
            continue;
        };
        naming.entry(name).or_default().push(at);
    }
    for (name, at) in naming {
        if at.len() >= 2 {
            for at in at {
                named[at] = Some((name.clone(), None));
            }
        }
    }
}

/// Gives each series named by file names the spelling most of its books' titles have for the
/// same words (`Re-ZERO` for `Re:ZERO`, `Bing - An` for `Bing: An`), unless a book has its own
/// series by the file names' spelling.
fn spell_as_titles(books: &[TitledBook<'_>], named: &mut [Option<(String, f64)>]) {
    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    for (book, named) in books.iter().zip(named.iter()) {
        let Some((series, _)) = named else { continue };
        let Some((spelling, _)) = book
            .title
            .and_then(|title| volume_candidates(title).into_iter().next())
        else {
            continue;
        };
        if words_key(&spelling) == words_key(series) {
            *counts.entry((series.clone(), spelling)).or_default() += 1;
        }
    }
    let mut spellings: HashMap<String, (usize, String)> = HashMap::new();
    for ((series, spelling), count) in counts {
        let best = spellings.entry(series).or_default();
        if count > best.0 || (count == best.0 && spelling < best.1) {
            *best = (count, spelling);
        }
    }
    for (series, _) in named.iter_mut().flatten() {
        let Some((_, spelling)) = spellings.get(series.as_str()) else {
            continue;
        };
        if !books
            .iter()
            .any(|book| book.series == Some(series.as_str()))
        {
            spelling.clone_into(series);
        }
    }
}

/// Whether a series a file name gives only spells, in katakana, the reading of a title written
/// otherwise, as some libraries name files (`ハチナンッテソレハナイデショウ30` for
/// `八男って、それはないでしょう！ 30`); the title then names the series.
fn spells_a_reading(series: &str, title: Option<&str>) -> bool {
    let katakana = |c: char| matches!(c, '\u{30A0}'..='\u{30FF}' | '\u{FF66}'..='\u{FF9F}');
    series.chars().all(|c| katakana(c) || !c.is_alphabetic())
        && title.is_some_and(|title| title.chars().any(|c| c.is_alphabetic() && !katakana(c)))
}

/// A series name's letters and digits alone, for comparing a file's spelling with a title's.
fn words_key(name: &str) -> String {
    comparison_key(name)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// The title a file name reads as: without its extension, a copy's mark, or bracketed notes such
/// as a year, a group or a checksum, and with `_` or `.` between words read as spaces. A note
/// holding another number stays, as it can be the volume (`Title [v2]`), and the store and
/// edition tags titles drop go.
fn file_title(file_name: &str) -> Option<String> {
    let mut name = EXTENSION.replace(file_name.trim(), "").into_owned();
    loop {
        let mut next = COPY_MARK.replace(&name, "").into_owned();
        if let Some(note) = FILE_NOTE.captures(&next) {
            let inner = note
                .get(1)
                .or(note.get(2))
                .map_or("", |inner| inner.as_str());
            let inner = inner.trim();
            if !inner.chars().any(|c| c.is_ascii_digit())
                || YEAR.is_match(inner)
                || CHECKSUM.is_match(inner)
                || SITES.is_match(inner)
            {
                next.truncate(note.get(0).unwrap().start());
            }
        }
        if next == name {
            break;
        }
        name = next;
    }
    // A volume note heading the name numbers the title before its part or subtitle:
    // `【小説9巻】本好きの下剋上～…～第三部「領主の養女II」` is volume 9 of `本好きの下剋上～…～`,
    // and an author after ` - ` is left out (`【2】Title - Author`).
    if let Some(volume) = LEADING_VOLUME.captures(&name) {
        let rest = volume[2].trim();
        let rest = rest
            .rfind(" - ")
            .map(|at| &rest[..at])
            .filter(|title| LETTER.is_match(title))
            .unwrap_or(rest);
        let head = rest
            .find(['第', '「', '『'])
            .map(|at| &rest[..at])
            .filter(|head| LETTER.is_match(head))
            .unwrap_or(rest);
        name = format!("{head} {}", &volume[1]);
    }
    let mut name = LEADING_NOTE.replace(&name, "").replace('_', " ");
    if !name.contains(char::is_whitespace) && name.matches('.').count() >= 2 {
        name = name.replace('.', " ");
    }
    // A number heading the name before a space is its volume when it holds no other number.
    if let Some(leading) = LEADING_SPACED
        .captures(&name)
        .filter(|leading| numbers(&leading[2]).is_empty())
    {
        name = format!("{}. {}", &leading[1], &leading[2]);
    }
    // Store and edition tags go as from titles: `【電子版限定特典付き】Title 3`.
    crate::title_cleaning::clean(&name)
}

/// A series name for comparing only: full-width letters, digits and signs read as their usual
/// forms (`８６` as `86`), and case and runs of spaces do not matter.
fn comparison_key(name: &str) -> String {
    let folded: String = name
        .chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            other => other,
        })
        .flat_map(char::to_lowercase)
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The series each reading's text names; `None` for one without text or naming none.
///
/// A text's last number is its volume and the text before it, cleaned, the series (`幼女戦記07`,
/// `86─エイティシックス─Ep.05─…─`, `涼宮ハルヒ09の分裂`); a title without one can end in a
/// Roman numeral (`Unnamed Memory VI`) or begin with its number (`01. Fate/Zero`). A name
/// becomes a series once two such books share it with different volumes, or when another book
/// already has a series by that name. A book whose last number names no series can still join
/// one the name before its subtitle names (`俺の…カノジョ ※みんな激重になった01`), or an
/// earlier number names (`その者。のちに…08新婚旅行編01`), as a volume that series does not
/// have yet. Names are compared by `comparison_key`, and shown as a series already spells them,
/// or else in the spelling that sorts first, which has half-width digits.
fn name_series(books: &[Reading<'_>], subtitled: bool) -> Vec<Option<(String, f64)>> {
    let mut volumes: HashMap<String, Vec<f64>> = HashMap::new();
    for book in books {
        if let (Some(series), Some(index)) = (book.series, book.series_index) {
            volumes.entry(series.to_owned()).or_default().push(index);
        }
    }
    let named: HashSet<&str> = books.iter().filter_map(|book| book.series).collect();
    let mut candidates: Vec<Vec<(String, f64)>> = books
        .iter()
        .map(|book| book.text.map(volume_candidates).unwrap_or_default())
        .collect();
    let mut spellings: HashMap<String, String> = HashMap::new();
    for (name, _) in candidates.iter().flatten() {
        let spelling = spellings.entry(comparison_key(name)).or_default();
        if spelling.is_empty() || name < spelling {
            name.clone_into(spelling);
        }
    }
    for name in &named {
        spellings.insert(comparison_key(name), (*name).to_owned());
    }
    let spelled = |name: String| {
        spellings
            .get(&comparison_key(&name))
            .cloned()
            .unwrap_or(name)
    };
    for (name, _) in candidates.iter_mut().flatten() {
        *name = spelled(std::mem::take(name));
    }

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
                .map(|(name, _)| {
                    subtitle_names(name)
                        .into_iter()
                        .map(&spelled)
                        .collect::<Vec<_>>()
                })
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

    // Titles still without a series can share one read without their number, when it comes
    // before a subtitle they all carry; not file names, where an author often follows.
    let subtitled: Vec<Vec<(String, f64)>> = books
        .iter()
        .zip(&chosen)
        .map(|(book, chosen)| match (book.text, chosen) {
            (Some(text), None) if subtitled => subtitled_candidates(text),
            _ => Vec::new(),
        })
        .collect();
    let mut sharing: HashMap<String, (String, Vec<f64>)> = HashMap::new();
    for (name, index) in subtitled.iter().flatten() {
        let shared = sharing
            .entry(comparison_key(name))
            .or_insert_with(|| (name.clone(), Vec::new()));
        shared.1.push(*index);
    }
    for (options, chosen) in subtitled.iter().zip(chosen.iter_mut()) {
        let joined = options.iter().find_map(|(name, index)| {
            let (spelling, indexes) = sharing.get(&comparison_key(name))?;
            let spelling = spelled(spelling.clone());
            let taken = volumes
                .get(&spelling)
                .is_some_and(|taken| taken.contains(index));
            (indexes.iter().any(|other| other != index) && !taken).then_some((spelling, *index))
        });
        if let Some((name, index)) = joined {
            volumes.entry(name.clone()).or_default().push(index);
            *chosen = Some((name, index));
        }
    }
    chosen
}

/// Every series name and volume a title can be read as, the likeliest first: from its last
/// number back to its first (`07`, `③`, `四巻`), those after a volume word before the others, then
/// its Roman numerals from the last (`キノの旅XX the Beautiful World`); without either, a closing
/// part (`（上）` is 1, `（中）` 2, `（下）` 3), then a heading number.
fn volume_candidates(title: &str) -> Vec<(String, f64)> {
    let mut numbers = numbers(title);
    numbers.reverse();
    numbers.sort_by_key(|number| !NUMBERED.is_match(&title[..number.start]));
    let mut numerals = roman_numerals(title);
    numerals.reverse();
    let mut candidates: Vec<(String, f64)> = numbers
        .into_iter()
        .chain(numerals)
        .filter_map(|number| Some((series_name(&title[..number.start])?, number.value)))
        .collect();
    if candidates.is_empty() {
        if let Some(part) = PART.captures(title.trim_end()) {
            let value = match part
                .get(1)
                .or(part.get(2))
                .or(part.get(3))
                .map(|part| part.as_str())
            {
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

/// A number a title holds, where it stands and what it counts.
struct Number {
    start: usize,
    end: usize,
    value: f64,
}

/// A title's numbers in order: digits (`07`, `０７`, `4.5`), circled numbers (`③`) and volumes
/// counted in kanji (`四巻`, but not `全五巻`).
fn numbers(title: &str) -> Vec<Number> {
    let mut found: Vec<Number> = NUMBER
        .find_iter(title)
        .filter_map(|number| {
            Some(Number {
                start: number.start(),
                end: number.end(),
                value: parse_number(number.as_str())?,
            })
        })
        .collect();
    found.extend(title.char_indices().filter_map(|(at, character)| {
        let value = match character {
            '①'..='⑳' => character as u32 - '①' as u32 + 1,
            '㉑'..='㉟' => character as u32 - '㉑' as u32 + 21,
            '㊱'..='㊿' => character as u32 - '㊱' as u32 + 36,
            _ => return None,
        };
        Some(Number {
            start: at,
            end: at + character.len_utf8(),
            value: f64::from(value),
        })
    }));
    found.extend(KANJI_VOLUME.captures_iter(title).filter_map(|volume| {
        let digits = volume.get(1)?;
        if title[..digits.start()].ends_with('全') {
            return None;
        }
        Some(Number {
            start: digits.start(),
            end: volume.get(0)?.end(),
            value: kanji_value(digits.as_str())?,
        })
    }));
    found.sort_by_key(|number| number.start);
    found
}

/// A number written in kanji up to 999: `四`, `十二`, `二十`, `百五`.
fn kanji_value(kanji: &str) -> Option<f64> {
    if !kanji.contains(['十', '百']) {
        // Written digit by digit: `一〇`, `二五`.
        let value = kanji.chars().try_fold(0, |value, character| {
            "〇一二三四五六七八九"
                .chars()
                .position(|c| c == character)
                .map(|digit| value * 10 + digit)
        })?;
        return (value > 0 && value < 1000).then_some(value as f64);
    }
    let digit = |character| "一二三四五六七八九".chars().position(|c| c == character);
    let (mut total, mut pending) = (0, None::<usize>);
    for character in kanji.chars() {
        match character {
            '十' | '百' => {
                let unit = if character == '十' { 10 } else { 100 };
                total += pending.take().map_or(1, |value| value + 1) * unit;
            }
            other => {
                if pending.is_some() {
                    return None;
                }
                pending = Some(digit(other)?);
            }
        }
    }
    let value = total + pending.map_or(0, |value| value + 1);
    (value > 0).then_some(value as f64)
}

/// A title's Roman numerals that read as a volume: a sign (`Ⅳ`) or letters standing apart from
/// other letters. Beside Japanese or Chinese text they can stand anywhere (`狼と羊皮紙XI`,
/// `サイレント・ウィッチ X　沈黙の魔女の隠しごと`, `亡刻のシェオル（Ⅳ）囚われの翼狼`); after a
/// word in Latin letters they close the title or come before `:`, `,` or ` - `
/// (`Unnamed Memory XII`, `Side Story II: Dai Katana`), as `I` is also a word. `L` and `C` count
/// only in a numeral closing the title.
fn roman_numerals(title: &str) -> Vec<Number> {
    let latin =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, 'Ａ'..='Ｚ' | 'ａ'..='ｚ' | '０'..='９');
    ROMAN
        .find_iter(title)
        .filter_map(|numeral| {
            let before = title[..numeral.start()].chars().next_back();
            let rest = &title[numeral.end()..];
            let after = rest.chars().next();
            if before.is_some_and(latin) || after.is_some_and(char::is_alphabetic) {
                return None;
            }
            let closing = rest.trim().is_empty();
            let letters: String = numeral
                .as_str()
                .chars()
                .map(|c| match c {
                    'Ａ'..='Ｚ' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
                    other => other,
                })
                .collect();
            let value = match letters.chars().next()? {
                sign @ 'Ⅰ'..='Ⅻ' => f64::from(sign as u32 - 0x215F),
                _ => {
                    if letters.contains(['L', 'C']) && !closing {
                        return None;
                    }
                    let word_before = title[..numeral.start()]
                        .trim_end()
                        .chars()
                        .next_back()
                        .filter(|_| before.is_some_and(char::is_whitespace));
                    if word_before.is_some_and(|c| c.is_ascii())
                        && !closing
                        && ![":", ",", " -", " –", " —", "：", ")", "]"]
                            .iter()
                            .any(|mark| rest.starts_with(mark))
                    {
                        return None;
                    }
                    roman_value(&letters)?
                }
            };
            Some(Number {
                start: numeral.start(),
                end: numeral.end(),
                value,
            })
        })
        .collect()
}

/// The series a title gives when its volume number comes before a subtitle the volumes share,
/// read without the number: `終わりのセラフ７　一瀬グレン、１６歳の破滅` is volume 7 of
/// `終わりのセラフ　一瀬グレン、１６歳の破滅`. Only for volumes no other reading names.
fn subtitled_candidates(title: &str) -> Vec<(String, f64)> {
    let mut found = numbers(title);
    found.extend(roman_numerals(title));
    found
        .into_iter()
        .filter_map(|number| {
            let rest = &title[number.end..];
            if !rest.starts_with(|c: char| c.is_whitespace() || SUBTITLE_MARKS.contains(c))
                || !LETTER.is_match(rest)
            {
                return None;
            }
            let head = series_name(&title[..number.start])?;
            if EDITION_NOTE.is_match(rest) {
                return Some((head, number.value));
            }
            Some((series_name(&format!("{head}{rest}"))?, number.value))
        })
        .collect()
}

/// Marks that set a subtitle apart from the name before it.
const SUBTITLE_MARKS: &str = "～〜~※―—–:：";

/// The series name a title's start gives: volume words, parts, numbers, separators, and
/// opening brackets at its end are left out, and so is a dash or symbol unless it closes one
/// opening earlier in the name (`─エイティシックス─`, `＜インフィニット・ストラトス＞`). A dash
/// after a space only separates (`Bing - An - Vol 3`), and an opening bracket heading the name
/// that it never closes is left out.
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
            let separator = opening == mark.as_str() && earlier.ends_with(char::is_whitespace);
            if separator || (!earlier.contains(mark.as_str()) && !earlier.contains(opening)) {
                next.truncate(mark.start());
            }
        }
        if next == stem {
            break;
        }
        stem = next;
    }
    if let Some(name) = UNCLOSED_OPENING
        .captures(&stem)
        .map(|name| name[1].to_owned())
    {
        stem = name;
    }
    LETTER.is_match(&stem).then_some(stem)
}

/// The names a series name gives before a subtitle it may carry, longest first:
/// `たかがアイドル！～されど、やっぱり顔はいい～` gives `たかがアイドル`. A space sets a subtitle
/// apart only in a name with Japanese or Chinese text (`B.A.D. チョコレートデイズ`), as words in
/// Latin letters are spaced anyway (`The Faraway Paladin` gives no `The`).
fn subtitle_names(name: &str) -> Vec<String> {
    let spaced = !name.chars().any(|c| c.is_alphabetic() && !c.is_ascii());
    let mut names: Vec<String> = name
        .char_indices()
        .filter(|&(_, character)| {
            SUBTITLE_MARKS.contains(character) || (character.is_whitespace() && !spaced)
        })
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
            file_name: None,
            title: Some(title),
            series: None,
            series_index: None,
            series_manual: false,
        }
    }

    fn named(titles: &[&str]) -> Vec<Option<(String, Option<f64>)>> {
        series_from_titles(
            &titles
                .iter()
                .map(|title| untitled(title))
                .collect::<Vec<_>>(),
        )
    }

    fn volume(series: &str, index: f64) -> Option<(String, Option<f64>)> {
        Some((series.to_owned(), Some(index)))
    }

    fn side(series: &str) -> Option<(String, Option<f64>)> {
        Some((series.to_owned(), None))
    }

    fn filed<'a>(
        file_name: &'a str,
        title: &'a str,
        series: Option<(&'a str, f64)>,
    ) -> TitledBook<'a> {
        TitledBook {
            file_name: Some(file_name),
            title: Some(title),
            series: series.map(|(name, _)| name),
            series_index: series.map(|(_, index)| index),
            series_manual: false,
        }
    }

    #[test]
    fn release_file_names_lead_and_read_as_their_titles_spell_the_series() {
        let books = [
            filed(
                "Re-ZERO -Starting Life- - Vol 15 [Yen Press][Kobo][38DDB429].epub",
                "Re:ZERO -Starting Life-, Vol. 15",
                None,
            ),
            // Its title reads apart from the others, but its file name doesn't.
            filed(
                "Re-ZERO -Starting Life- - Vol 16 [Yen Press][Kobo][A99CED40].epub",
                "Re:ZERO: -Starting Life-, Vol. 16",
                None,
            ),
            filed(
                "Re-ZERO -Starting Life- - Vol 17 [Yen Press][Kobo][A9C4DC5D].epub",
                "Re:ZERO -Starting Life-, Vol. 17",
                None,
            ),
            filed(
                "Case File - Bing An - Volume 03 [Seven Seas].epub",
                "Case File: Bing An Vol. 3",
                None,
            ),
            filed(
                "Case File - Bing An - Volume 04 [Seven Seas].epub",
                "Case File: Bing An Vol. 4",
                None,
            ),
            // Titles that read as other words leave the file names' spelling.
            filed("Perle - Joachim - Volume 01 [M].epub", "Perle Vol. I", None),
            filed(
                "Perle - Joachim - Volume 02 [M].epub",
                "Perle Vol. II",
                None,
            ),
        ];
        assert_eq!(
            series_from_titles(&books),
            [
                volume("Re:ZERO -Starting Life-", 15.0),
                volume("Re:ZERO -Starting Life-", 16.0),
                volume("Re:ZERO -Starting Life-", 17.0),
                volume("Case File: Bing An", 3.0),
                volume("Case File: Bing An", 4.0),
                volume("Perle - Joachim", 1.0),
                volume("Perle - Joachim", 2.0),
            ]
        );
    }

    #[test]
    fn a_number_after_a_volume_word_is_the_volume_before_a_later_year() {
        let books = [
            filed(
                "Baccano! - Vol 01 - 1930 - The Rolling Bootlegs.epub",
                "Baccano! Vol. 1: The Rolling Bootlegs",
                None,
            ),
            filed(
                "Baccano! - Vol 13 - 2002 - B - Blood Sabbath.epub",
                "Baccano! Vol. 13: 2002 [B Side] Blood Sabbath",
                None,
            ),
        ];
        assert_eq!(
            series_from_titles(&books),
            [volume("Baccano!", 1.0), volume("Baccano!", 13.0)]
        );
    }

    #[test]
    fn file_names_spelling_a_reading_leave_the_series_to_the_titles() {
        let books = [
            filed(
                "ハチナンッテソレハナイデショウ029 - Y.A.epub",
                "八男って、それはないでしょう！ 29",
                None,
            ),
            filed(
                "ハチナンッテソレハナイデショウ030 - Y.A.epub",
                "八男って、それはないでしょう！ 30",
                None,
            ),
            filed(
                "ソードアートオンライン01.epub",
                "ソードアート・オンライン 1",
                None,
            ),
            filed(
                "ソードアートオンライン02.epub",
                "ソードアート・オンライン 2",
                None,
            ),
        ];
        assert_eq!(
            series_from_titles(&books),
            [
                volume("八男って、それはないでしょう！", 29.0),
                volume("八男って、それはないでしょう！", 30.0),
                volume("ソードアート・オンライン", 1.0),
                volume("ソードアート・オンライン", 2.0),
            ]
        );
    }

    #[test]
    fn file_names_drop_the_tags_titles_drop() {
        let books = [
            filed(
                "【電子版限定特典付き】才女のお世話 1.epub",
                "才女のお世話 1",
                None,
            ),
            filed("才女のお世話 2.epub", "才女のお世話 2", None),
        ];
        assert_eq!(
            series_from_titles(&books),
            [volume("才女のお世話", 1.0), volume("才女のお世話", 2.0)]
        );
    }

    #[test]
    fn numbered_file_names_come_before_the_books_series_and_titles() {
        let books = [
            filed(
                "Harry Potter 1.epub",
                "Philosopher's Stone",
                Some(("Wizards", 7.0)),
            ),
            filed("Harry Potter 2.epub", "Chamber of Secrets", None),
            // No numbered name: its own series stays, and then numbered titles name the rest.
            filed("wizards.epub", "Wizards", Some(("Wizards", 1.0))),
            filed("a.epub", "Cat Tales 01", None),
            filed("b.epub", "Cat Tales 02", None),
            // A lone numbered name is no series and leaves the book's own.
            filed(
                "Fahrenheit 451.epub",
                "Fahrenheit 451",
                Some(("Bradbury", 3.0)),
            ),
        ];
        assert_eq!(
            series_from_titles(&books),
            [
                volume("Harry Potter", 1.0),
                volume("Harry Potter", 2.0),
                None,
                volume("Cat Tales", 1.0),
                volume("Cat Tales", 2.0),
                None,
            ]
        );
    }

    #[test]
    fn a_lone_file_name_joins_a_series_by_its_name_but_never_one_set_by_hand() {
        let manual = TitledBook {
            file_name: Some("Bar 9.epub"),
            title: Some("Other"),
            series: Some("Mine"),
            series_index: Some(1.0),
            series_manual: true,
        };
        let none_by_hand = TitledBook {
            file_name: Some("Bar 8.epub"),
            title: Some("Bar 8"),
            series: None,
            series_index: None,
            series_manual: true,
        };
        let books = [
            filed("x.epub", "First", Some(("Bar", 1.0))),
            filed("bar 2.epub", "Second", None),
            manual,
            none_by_hand,
        ];
        assert_eq!(
            series_from_titles(&books),
            [None, volume("Bar", 2.0), None, None]
        );
    }

    #[test]
    fn file_names_are_read_without_their_extension_copies_and_notes() {
        let title = |name: &str| file_title(name);
        assert_eq!(title("Harry Potter 1.EPUB").unwrap(), "Harry Potter 1");
        assert_eq!(title("download (1).epub").unwrap(), "download");
        assert_eq!(title("Title 2 - Copy (3).epub").unwrap(), "Title 2");
        assert_eq!(
            title("[Group] Title v01 (2020) [x].epub").unwrap(),
            "Title v01"
        );
        assert_eq!(title("Title (z-lib.org).epub").unwrap(), "Title");
        assert_eq!(title("Title [v2].epub").unwrap(), "Title [v2]");
        assert_eq!(title("Harry_Potter_1.epub").unwrap(), "Harry Potter 1");
        assert_eq!(title("Harry.Potter.1.epub").unwrap(), "Harry Potter 1");
        assert_eq!(title("Title 4.5.epub").unwrap(), "Title 4.5");
        assert_eq!(title("タイトル（上）.epub").unwrap(), "タイトル（上）");

        // Copies of one download are not volumes; numbered volumes with notes are.
        let books = [
            filed("download (1).epub", "One", None),
            filed("download (2).epub", "Two", None),
            filed("[G] Title v01 (2020).epub", "Three", None),
            filed("[G] Title v02 (2021).epub", "Four", None),
        ];
        assert_eq!(
            series_from_titles(&books),
            [None, None, volume("Title", 1.0), volume("Title", 2.0)]
        );
    }

    #[test]
    fn full_width_and_half_width_spellings_are_one_series() {
        assert_eq!(
            named(&["Title 4", "Title ５"]),
            [volume("Title", 4.0), volume("Title", 5.0)]
        );
        assert_eq!(
            named(&["８６ エイティシックス 1", "86 エイティシックス ２"]),
            [
                volume("86 エイティシックス", 1.0),
                volume("86 エイティシックス", 2.0),
            ]
        );
        assert_eq!(
            named(&["ＡＢＣ　1", "ABC 2"]),
            [volume("ABC", 1.0), volume("ABC", 2.0)]
        );
        // The same volume twice is no series yet, in either spelling.
        assert_eq!(named(&["Title 4", "Title ４"]), [None, None]);
        // A series already named keeps its spelling.
        let books = [
            TitledBook {
                file_name: None,
                title: Some("x"),
                series: Some("ＡＢＣ"),
                series_index: Some(1.0),
                series_manual: false,
            },
            untitled("ABC 2"),
        ];
        assert_eq!(series_from_titles(&books)[1], volume("ＡＢＣ", 2.0));
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
                file_name: None,
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
                "『八男って、それはないでしょう！ ",
                Some("八男って、それはないでしょう！"),
            ),
            ("「ロウきゅーぶ！」", Some("「ロウきゅーぶ！」")),
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
    fn reads_numerals_signs_and_kanji_volumes_anywhere_in_japanese_titles() {
        assert_eq!(
            named(&[
                "キノの旅II the Beautiful World",
                "キノの旅XIV the Beautiful World",
                "亡刻のシェオル（Ⅳ）囚われの翼狼",
                "亡刻のシェオル Ⅴ リヴァールの遺志",
                "性転恋譚①: 朝起きたら",
                "性転恋譚②: 朝起きたら",
                "駆除人（原液）四巻",
                "駆除人（原液）一〇巻",
                "駆除人（原液）十二巻",
            ]),
            vec![
                volume("キノの旅", 2.0),
                volume("キノの旅", 14.0),
                volume("亡刻のシェオル", 4.0),
                volume("亡刻のシェオル", 5.0),
                volume("性転恋譚", 1.0),
                volume("性転恋譚", 2.0),
                volume("駆除人（原液）", 4.0),
                volume("駆除人（原液）", 10.0),
                volume("駆除人（原液）", 12.0),
            ]
        );
        // After a word in Latin letters, `I` and `V` inside a title are words; a set's size is
        // not a volume.
        assert_eq!(
            named(&["Dear I Hope", "Dear V Day", "物語 全三巻", "物語 全五巻"]),
            vec![None, None, None, None]
        );
    }

    #[test]
    fn names_series_by_the_subtitle_after_the_number_unless_it_is_an_edition() {
        assert_eq!(
            named(&[
                "終わりのセラフ２　一瀬グレン、１６歳の破滅",
                "終わりのセラフ３　一瀬グレン、１６歳の破滅",
                "終わりのセラフ　一瀬グレン、１６歳の破滅",
                "ダリヤ ～職人ライフ～11 特装版【短編小説付き】",
                "ダリヤ ～職人ライフ～12 特装版【イラスト集付き】",
            ]),
            vec![
                volume("終わりのセラフ　一瀬グレン、１６歳の破滅", 2.0),
                volume("終わりのセラフ　一瀬グレン、１６歳の破滅", 3.0),
                volume("終わりのセラフ　一瀬グレン、１６歳の破滅", 1.0),
                volume("ダリヤ ～職人ライフ～", 11.0),
                volume("ダリヤ ～職人ライフ～", 12.0),
            ]
        );
    }

    #[test]
    fn joins_first_volumes_and_side_stories_without_a_number() {
        assert_eq!(
            named(&[
                "魔女の旅々 2",
                "魔女の旅々 3",
                "魔女の旅々",
                "魔女の旅々　学園物語",
                "魔女の旅々アニメの本",
                "Mushoku Tensei 2",
                "Mushoku Tensei 3",
                "Mushoku Tensei: Recollections",
                "Mushoku Tensei Fanbook",
            ]),
            vec![
                volume("魔女の旅々", 2.0),
                volume("魔女の旅々", 3.0),
                volume("魔女の旅々", 1.0),
                side("魔女の旅々"),
                None,
                volume("Mushoku Tensei", 2.0),
                volume("Mushoku Tensei", 3.0),
                side("Mushoku Tensei"),
                None,
            ]
        );
        // With volume 1 taken, an unnumbered copy is in the series without a volume; a
        // numbered spin-off keeps apart.
        assert_eq!(
            named(&[
                "義妹生活 1",
                "義妹生活 2",
                "義妹生活",
                "義妹生活 another days 2"
            ]),
            vec![
                volume("義妹生活", 1.0),
                volume("義妹生活", 2.0),
                side("義妹生活"),
                None,
            ]
        );
    }

    #[test]
    fn pairs_a_lone_volume_with_its_first_and_reads_halves() {
        assert_eq!(
            named(&[
                "隣の席の佐藤さん",
                "隣の席の佐藤さん２",
                "オービタル・クラウド〔上〕",
                "オービタル・クラウド〔下〕",
                "終物語　上",
                "終物語　中",
                "終物語　下",
                "朱色の研究 「火村英生」シリーズ",
                "ダリの繭 「火村英生」シリーズ",
                "人間失格",
            ]),
            vec![
                volume("隣の席の佐藤さん", 1.0),
                volume("隣の席の佐藤さん", 2.0),
                volume("オービタル・クラウド", 1.0),
                volume("オービタル・クラウド", 3.0),
                volume("終物語", 1.0),
                volume("終物語", 2.0),
                volume("終物語", 3.0),
                side("「火村英生」シリーズ"),
                side("「火村英生」シリーズ"),
                None,
            ]
        );
    }

    #[test]
    fn file_names_give_volume_notes_and_heading_numbers_and_drop_sites_and_authors() {
        let title = |name: &str| file_title(name);
        assert_eq!(
            title("【小説9巻】本好きの下剋上～司書～第三部「領主の養女II」.epub").unwrap(),
            "本好きの下剋上～司書～ 9"
        );
        assert_eq!(
            title("【2】宅配員のおねえさんがやってきた - ウンポーコ.epub").unwrap(),
            "宅配員のおねえさんがやってきた 2"
        );
        assert_eq!(title("09 俺の妹.epub").unwrap(), "09. 俺の妹");
        assert_eq!(
            title("86 Alter - Vol 02.epub").unwrap(),
            "86 Alter - Vol 02"
        );
        assert_eq!(
            title("ほうかごがかり6 あかね (甲田学人) (z-library.sk, 1lib.sk, z-lib.sk).epub")
                .unwrap(),
            "ほうかごがかり6 あかね"
        );
        // A few files named apart join the series their titles name with more books.
        let books = [
            filed("アーリャさん 3.epub", "アーリャさん3", None),
            filed("アーリャさん 4.epub", "アーリャさん4", None),
            filed("アーリャさん 5.epub", "アーリャさん5", None),
            filed("SUN_6.epub", "アーリャさん6", None),
            filed("SUN_7.epub", "アーリャさん7", None),
        ];
        assert_eq!(
            series_from_titles(&books),
            [3.0, 4.0, 5.0, 6.0, 7.0].map(|index| volume("アーリャさん", index))
        );
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
                file_name: None,
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
                    .map(|(series, index)| {
                        (series, index.map(|i| i.to_string()).unwrap_or_default())
                    })
                    .unwrap_or_default();
                [row[0], row[1], row[2], &series, &index].join("\t") + "\n"
            })
            .collect();
        std::fs::write(format!("{path}.out"), out).unwrap();
    }
}
