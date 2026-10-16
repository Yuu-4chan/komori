//! Each book's language, series, and CJK text counts, and the series readers set by hand.
//!
//! `book_details` is derived from the source at import and relink, and in the background at
//! startup for books imported before Komori read it, read by an older details version, or whose
//! source file changed since (its size or modified time differ, as when Calibre embeds new
//! metadata). `book_series` is
//! reader-owned: a series set by hand, or none, overriding the book's own. Both are additive
//! tables keyed by catalog ID that cascade with removal, so an older Komori still opens the
//! catalog. Sources are only read.

use std::{fs::File, path::Path, time::Instant, time::UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    epub::{self, BookDetails},
    library::{open_catalog, storage_error, CatalogState},
};

/// Bump to count every book again after the counting rules change.
pub(crate) const DETAILS_VERSION: i64 = 3;
/// Tells the Library that more books have their details.
pub(crate) const DETAILS_EVENT: &str = "library-details-updated";
const MAX_SERIES_IDS: usize = 10_000;
const MAX_SERIES_CHARS: usize = 200;

pub(crate) const DETAILS_PENDING_SQL: &str =
    "SELECT books.id, books.source_path, details.details_version, details.source_stamp
       FROM books
       LEFT JOIN book_details AS details ON details.book_id = books.id
      ORDER BY books.imported_at DESC, books.id DESC";

pub(crate) fn create_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS book_details (
               book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
               details_version INTEGER NOT NULL,
               declared_language TEXT,
               language TEXT,
               series TEXT,
               series_index REAL,
               characters INTEGER,
               unique_kanji INTEGER,
               kanji TEXT,
               source_stamp TEXT,
               words INTEGER
             );
             CREATE TABLE IF NOT EXISTS book_series (
               book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
               series TEXT,
               series_index REAL,
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );",
        )
        .map_err(storage_error)?;
    // Version 2 adds word counts; the version bump counts every book again.
    let worded: bool = connection
        .query_row(
            "SELECT count(*) FROM pragma_table_info('book_details') WHERE name = 'words'",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !worded {
        connection
            .execute_batch("ALTER TABLE book_details ADD COLUMN words INTEGER;")
            .map_err(storage_error)?;
    }
    reshow_languages(connection)
}

/// Shown languages stored before they were reduced to the language (and Chinese script) are
/// reduced in place; once done, no stored tag has a subtag other than `zh-Hans` or `zh-Hant`.
fn reshow_languages(connection: &Connection) -> Result<(), String> {
    let tags: Vec<String> = {
        let mut statement = connection
            .prepare(
                "SELECT DISTINCT language FROM book_details
                  WHERE language LIKE '%-%' AND language NOT IN ('zh-Hans', 'zh-Hant')",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    for tag in tags {
        connection
            .execute(
                "UPDATE book_details SET language = ?1 WHERE language = ?2",
                [epub::details::shown_language(&tag), tag],
            )
            .map_err(storage_error)?;
    }
    Ok(())
}

/// The source file's size and modified time, which change when the file is rewritten.
pub(crate) fn source_stamp(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!("{}:{modified}", metadata.len()))
}

/// Saves a book's details and the stamp of the source they were read from; a book removed
/// meanwhile gets none.
pub(crate) fn store(
    connection: &Connection,
    id: &str,
    details: &BookDetails,
    stamp: Option<&str>,
) -> Result<(), String> {
    let text = details.text.as_ref();
    connection
        .execute(
            "INSERT INTO book_details
               (book_id, details_version, declared_language, language, series, series_index,
                characters, unique_kanji, kanji, source_stamp, words)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
              WHERE EXISTS (SELECT 1 FROM books WHERE id = ?1)
             ON CONFLICT(book_id) DO UPDATE
                SET details_version = excluded.details_version,
                    declared_language = excluded.declared_language,
                    language = excluded.language,
                    series = excluded.series,
                    series_index = excluded.series_index,
                    characters = excluded.characters,
                    unique_kanji = excluded.unique_kanji,
                    kanji = excluded.kanji,
                    source_stamp = excluded.source_stamp,
                    words = excluded.words",
            params![
                id,
                DETAILS_VERSION,
                details.package.language,
                details.language(),
                details.package.series,
                details.package.series_index,
                text.map(|text| text.characters),
                text.map(|text| text.kanji.chars().count() as i64),
                text.map(|text| text.kanji.as_str()),
                stamp,
                details.words,
            ],
        )
        .map(|_| ())
        .map_err(storage_error)
}

/// Reads the details of every book that has none for the current version or whose source
/// changed since, newest imports first, telling the Library as books are done. Checking for
/// changes reads only file attributes. A missing or unreadable source is tried again at the
/// next start; an invalid EPUB is stored with no details.
pub(crate) fn build_missing(database: &Path, app: Option<&AppHandle>) -> Result<usize, String> {
    let connection = open_catalog(database)?;
    type Row = (String, String, Option<i64>, Option<String>);
    let rows: Vec<Row> = {
        let mut statement = connection
            .prepare(DETAILS_PENDING_SQL)
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    let pending = rows
        .into_iter()
        .filter_map(|(id, source_path, version, stored)| {
            let stamp = source_stamp(Path::new(&source_path))?;
            let current = version.is_some_and(|version| version >= DETAILS_VERSION)
                && stored.as_deref() == Some(stamp.as_str());
            (!current).then_some((id, source_path, stamp))
        });
    let notify = || {
        if let Some(app) = app {
            let _ = app.emit(DETAILS_EVENT, ());
        }
    };
    let mut built = 0;
    let mut last_notice = Instant::now();
    for (id, source_path, stamp) in pending {
        let Ok(source) = File::open(&source_path) else {
            continue;
        };
        let details = epub::read_details(source).unwrap_or_else(|_| BookDetails {
            package: Default::default(),
            text: None,
            words: None,
        });
        store(&connection, &id, &details, Some(&stamp))?;
        built += 1;
        if last_notice.elapsed().as_millis() >= 1500 {
            notify();
            last_notice = Instant::now();
        }
    }
    if built > 0 {
        notify();
    }
    Ok(built)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesResult {
    updated: usize,
}

/// Puts the books, in the given order, in one series by hand (numbered from 1), or in none
/// when `series` is null, whatever their own metadata says.
#[tauri::command]
pub async fn set_book_series(
    catalog: State<'_, CatalogState>,
    ids: Vec<String>,
    series: Option<String>,
) -> Result<SeriesResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = open_catalog(&database)?;
        assign_series(&mut connection, &ids, series.as_deref())
    })
    .await
    .map_err(|error| format!("Series task failed: {error}"))?
}

/// Lets the books follow their own metadata's series again.
#[tauri::command]
pub async fn reset_book_series(
    catalog: State<'_, CatalogState>,
    ids: Vec<String>,
) -> Result<SeriesResult, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = open_catalog(&database)?;
        reset_series(&mut connection, &ids)
    })
    .await
    .map_err(|error| format!("Series task failed: {error}"))?
}

fn valid_ids(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() || ids.len() > MAX_SERIES_IDS {
        return Err("Choose between 1 and 10,000 books.".into());
    }
    if ids.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("A book could not be identified.".into());
    }
    Ok(())
}

/// A series name of 1–200 characters with its whitespace collapsed and no control characters.
pub(crate) fn clean_series_name(name: &str) -> Option<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty()
        && name.chars().count() <= MAX_SERIES_CHARS
        && !name.chars().any(char::is_control))
    .then_some(name)
}

fn assign_series(
    connection: &mut Connection,
    ids: &[String],
    series: Option<&str>,
) -> Result<SeriesResult, String> {
    valid_ids(ids)?;
    let series = match series {
        Some(name) => {
            Some(clean_series_name(name).ok_or("Enter a series name of up to 200 characters.")?)
        }
        None => None,
    };
    let transaction = connection.transaction().map_err(storage_error)?;
    let mut updated = 0;
    for (position, id) in ids.iter().enumerate() {
        let index = series.as_ref().map(|_| (position + 1) as f64);
        updated += transaction
            .execute(
                "INSERT INTO book_series (book_id, series, series_index)
                 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM books WHERE id = ?1)
                 ON CONFLICT(book_id) DO UPDATE
                    SET series = excluded.series,
                        series_index = excluded.series_index,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![id, series, index],
            )
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(SeriesResult { updated })
}

fn reset_series(connection: &mut Connection, ids: &[String]) -> Result<SeriesResult, String> {
    valid_ids(ids)?;
    let transaction = connection.transaction().map_err(storage_error)?;
    let mut updated = 0;
    for id in ids {
        updated += transaction
            .execute("DELETE FROM book_series WHERE book_id = ?1", [id])
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(SeriesResult { updated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{import_paths, list_from_catalog, relink_one};
    use serde_json::Value;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    /// An EPUB whose spine chapters hold `chapters`, with optional language and series.
    fn book(path: &Path, language: Option<&str>, series: Option<(&str, &str)>, chapters: &[&str]) {
        let mut archive = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive
            .write_all(br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>"#)
            .unwrap();
        let language = language.map_or(String::new(), |value| {
            format!("<dc:language>{value}</dc:language>")
        });
        let series = series.map_or(String::new(), |(name, index)| {
            format!(r#"<meta name="calibre:series" content="{name}"/><meta name="calibre:series_index" content="{index}"/>"#)
        });
        let items: String = (0..chapters.len())
            .map(|index| format!(r#"<item id="c{index}" href="text/c{index}.xhtml" media-type="application/xhtml+xml"/>"#))
            .collect();
        let refs: String = (0..chapters.len())
            .map(|index| format!(r#"<itemref idref="c{index}"/>"#))
            .collect();
        archive.start_file("OEBPS/book.opf", options).unwrap();
        archive
            .write_all(
                format!(
                    r#"<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>{}</dc:title>{language}{series}</metadata><manifest>{items}</manifest><spine>{refs}</spine></package>"#,
                    path.file_stem().unwrap().to_string_lossy()
                )
                .as_bytes(),
            )
            .unwrap();
        for (index, chapter) in chapters.iter().enumerate() {
            archive
                .start_file(format!("OEBPS/text/c{index}.xhtml"), options)
                .unwrap();
            archive
                .write_all(
                    format!("<html><head><title>章</title></head><body>{chapter}</body></html>")
                        .as_bytes(),
                )
                .unwrap();
        }
        archive.finish().unwrap();
    }

    fn listed(connection: &Connection) -> Vec<Value> {
        let mut books: Vec<Value> = list_from_catalog(connection)
            .unwrap()
            .into_iter()
            .map(|book| serde_json::to_value(book).unwrap())
            .collect();
        books.sort_by_key(|book| book["title"].as_str().unwrap_or_default().to_string());
        books
    }

    #[test]
    fn shown_languages_keep_only_the_language_and_chinese_script() {
        let directory = tempdir().unwrap();
        let chinese = directory.path().join("chinese.epub");
        let japanese = directory.path().join("japanese.epub");
        book(
            &chinese,
            Some("zh-CN"),
            None,
            &["<p>今天下雨，我们在家看书。</p>"],
        );
        book(&japanese, Some("ja-JP"), None, &["<p>今日は雨です。</p>"]);
        let database = directory.path().join("library.sqlite3");
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, &[chinese, japanese]);
        let languages = |connection: &Connection| {
            let mut statement = connection
                .prepare("SELECT declared_language, language FROM book_details ORDER BY language")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String)>, _>>()
                .unwrap()
        };
        assert_eq!(
            languages(&connection),
            [
                ("ja-JP".to_string(), "ja".to_string()),
                ("zh-CN".to_string(), "zh-Hans".to_string())
            ]
        );

        // Tags shown before are reduced when the catalog opens.
        connection
            .execute_batch(
                "UPDATE book_details SET language = 'ja-JP' WHERE language = 'ja';
                 UPDATE book_details SET language = 'zh-TW' WHERE language = 'zh-Hans';",
            )
            .unwrap();
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        assert_eq!(
            languages(&connection),
            [
                ("ja-JP".to_string(), "ja".to_string()),
                ("zh-CN".to_string(), "zh-Hant".to_string())
            ]
        );
    }

    #[test]
    fn import_reads_language_series_and_cjk_counts_without_touching_the_source() {
        let directory = tempdir().unwrap();
        let japanese = directory.path().join("a-japanese.epub");
        let english = directory.path().join("b-english.epub");
        book(
            &japanese,
            Some("en"),
            Some(("猫の本", "2.0")),
            &[
                "<p>小さな<ruby>犬<rt>いぬ</rt></ruby>が来た。</p>",
                "<p>空は青くて広い。犬</p>",
            ],
        );
        book(
            &english,
            Some("eng"),
            None,
            &["<p>An English book about 漢字.</p>"],
        );
        let before = std::fs::read(&japanese).unwrap();
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, &[japanese.clone(), english]);

        let books = listed(&connection);
        // The text is clearly Japanese, so a declared default `en` gives way to it.
        assert_eq!(books[0]["language"], "ja");
        assert_eq!(books[0]["series"], "猫の本");
        assert_eq!(books[0]["seriesIndex"], 2.0);
        assert_eq!(books[0]["seriesManual"], false);
        // 小さな犬が来た + 空は青くて広い犬; the furigana is not counted.
        assert_eq!(books[0]["characters"], 15);
        assert_eq!(books[0]["uniqueKanji"], 6);
        assert_eq!(books[1]["language"], "en");
        assert_eq!(books[1]["characters"], Value::Null);
        assert_eq!(books[1]["uniqueKanji"], Value::Null);
        // An, English, book, about, 漢字: words, as the Reader counts them.
        assert_eq!(books[1]["words"], 5);
        assert_eq!(books[0]["words"], Value::Null);
        assert_eq!(std::fs::read(&japanese).unwrap(), before);
    }

    /// Reads the details of real sources listed in the live catalog without writing to it (or
    /// to any source), comparing character counts with the Reader's saved totals.
    #[test]
    #[ignore = "reads the live Library catalog and its sources"]
    fn real_library_details() {
        let database = std::env::var("KOMORI_LIVE_CATALOG").expect("set KOMORI_LIVE_CATALOG");
        let limit: usize = std::env::var("KOMORI_DETAILS_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(50);
        let connection =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut statement = connection
            .prepare(
                "SELECT books.source_path, books.title, progress.total_units FROM books
                   LEFT JOIN book_progress AS progress
                     ON progress.book_id = books.id AND progress.unit = 'characters'
                  ORDER BY progress.total_units IS NULL, books.imported_at DESC LIMIT ?1",
            )
            .unwrap();
        let rows: Vec<(String, Option<String>, Option<i64>)> = statement
            .query_map([limit as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let started = Instant::now();
        let (mut cjk, mut differences) = (0, Vec::new());
        for (path, title, reader_total) in &rows {
            let Ok(source) = File::open(path) else {
                continue;
            };
            let details = epub::read_details(source).unwrap();
            if let Some(text) = &details.text {
                cjk += 1;
                if let Some(total) = reader_total {
                    differences.push((text.characters - total) as f64 / *total as f64);
                }
                println!(
                    "{:?} {:?} chars {} (Reader {:?}) kanji {}",
                    title,
                    details.language(),
                    text.characters,
                    reader_total,
                    text.kanji.chars().count()
                );
            } else {
                println!("{:?} {:?} not CJK", title, details.language());
            }
        }
        let elapsed = started.elapsed();
        differences.sort_by(f64::total_cmp);
        println!(
            "{} books ({cjk} CJK) in {elapsed:?}; Reader comparisons {}, median difference {:?}, extremes {:?} / {:?}",
            rows.len(),
            differences.len(),
            differences.get(differences.len() / 2),
            differences.first(),
            differences.last()
        );
    }

    #[test]
    fn older_books_get_details_in_the_background_once() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("book.epub");
        let database = directory.path().join("library.sqlite3");
        book(&source, Some("ja"), None, &["<p>日本語の本。</p>"]);
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        // As a catalog from before details.
        connection.execute("DELETE FROM book_details", []).unwrap();
        assert_eq!(listed(&connection)[0]["characters"], Value::Null);

        assert_eq!(build_missing(&database, None).unwrap(), 1);
        assert_eq!(listed(&connection)[0]["characters"], 5);
        assert_eq!(build_missing(&database, None).unwrap(), 0);

        // A rewritten source, as when Calibre embeds new metadata, is read again.
        std::thread::sleep(std::time::Duration::from_millis(20));
        book(
            &source,
            Some("en"),
            Some(("Re-embedded", "3")),
            &["<p>日本語の本です。</p>"],
        );
        assert_eq!(build_missing(&database, None).unwrap(), 1);
        let book = &listed(&connection)[0];
        assert_eq!(book["characters"], 7);
        assert_eq!(book["series"], "Re-embedded");
        assert_eq!(build_missing(&database, None).unwrap(), 0);

        // A newer counting version counts again; a missing source waits for the next start.
        connection
            .execute("UPDATE book_details SET details_version = 0", [])
            .unwrap();
        std::fs::remove_file(&source).unwrap();
        assert_eq!(build_missing(&database, None).unwrap(), 0);
    }

    #[test]
    fn non_linear_spine_items_are_not_counted_and_older_counts_are_redone() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("appendix.epub");
        let mut archive = ZipWriter::new(File::create(&source).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, content) in [
            ("META-INF/container.xml", r#"<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>"#.to_owned()),
            ("book.opf", r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Appendix</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/><itemref idref="notes" linear="no"/></spine></package>"#.to_owned()),
            ("body.xhtml", format!("<html><body><p>{}</p></body></html>", "あ".repeat(100))),
            ("notes.xhtml", format!("<html><body><p>{}</p></body></html>", "ね".repeat(100))),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        let details = epub::read_details(File::open(&source).unwrap()).unwrap();
        assert_eq!(details.text.unwrap().characters, 100);

        // Counts stored under the previous rules are counted again on the next start.
        let database = directory.path().join("library.sqlite3");
        let mut connection = open_catalog(&database).unwrap();
        import_paths(&mut connection, std::slice::from_ref(&source));
        assert_eq!(listed(&connection)[0]["characters"], 100);
        connection
            .execute(
                "UPDATE book_details SET details_version = 2, characters = 200",
                [],
            )
            .unwrap();
        assert_eq!(listed(&connection)[0]["characters"], 200);
        assert_eq!(build_missing(&database, None).unwrap(), 1);
        assert_eq!(listed(&connection)[0]["characters"], 100);
    }

    #[test]
    fn series_set_by_hand_overrides_and_resets_to_the_books_own() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("a.epub");
        let second = directory.path().join("b.epub");
        book(&first, None, Some(("Own", "7")), &["<p>本</p>"]);
        book(&second, None, None, &["<p>本</p>"]);
        let mut connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        import_paths(&mut connection, &[first.clone(), second]);
        let ids: Vec<String> = listed(&connection)
            .iter()
            .map(|book| book["id"].as_str().unwrap().to_string())
            .collect();

        let reversed = vec![ids[1].clone(), ids[0].clone()];
        let result = assign_series(&mut connection, &reversed, Some("  My   series ")).unwrap();
        assert_eq!(result.updated, 2);
        let books = listed(&connection);
        assert_eq!(books[0]["series"], "My series");
        assert_eq!(books[0]["seriesIndex"], 2.0);
        assert_eq!(books[1]["seriesIndex"], 1.0);
        assert_eq!(books[0]["seriesManual"], true);

        // No series by hand hides the book's own; relinking keeps that choice.
        assign_series(&mut connection, &ids[..1], None).unwrap();
        relink_one(&mut connection, &ids[0], &first).unwrap();
        let books = listed(&connection);
        assert_eq!(books[0]["series"], Value::Null);
        assert_eq!(books[0]["seriesManual"], true);

        reset_series(&mut connection, &ids).unwrap();
        let books = listed(&connection);
        assert_eq!(books[0]["series"], "Own");
        assert_eq!(books[0]["seriesIndex"], 7.0);
        assert_eq!(books[1]["series"], Value::Null);

        assert!(assign_series(&mut connection, &ids, Some("   ")).is_err());
        assert!(assign_series(&mut connection, &["../path".into()], Some("A")).is_err());
        assert!(assign_series(&mut connection, &[], Some("A")).is_err());
        // Unknown books are not created.
        let unknown = Uuid::new_v4().to_string();
        assert_eq!(
            assign_series(&mut connection, &[unknown], Some("A"))
                .unwrap()
                .updated,
            0
        );

        // Removal takes the series set by hand with it.
        assign_series(&mut connection, &ids, Some("A")).unwrap();
        connection.execute("DELETE FROM books", []).unwrap();
        let left: i64 = connection
            .query_row("SELECT count(*) FROM book_series", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
