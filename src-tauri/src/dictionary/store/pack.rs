//! A dictionary as a paired phone copies it from the PC: its stored rows in a small SQLite file
//! of the same schema version, so the phone needs neither the archive nor a fresh import.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::{open_store, storage_error, SCHEMA_VERSION};
use crate::devices::protocol::RemoteDictionary;

/// The tables keyed by a dictionary's ID, as removal lists them.
const TABLES: [&str; 5] = ["terms", "term_meta", "kanji", "kanji_meta", "tags"];
/// The dictionary columns that belong to one store, not to the dictionary.
#[cfg_attr(desktop, allow(dead_code))]
const LOCAL_COLUMNS: [&str; 4] = ["id", "imported_at", "enabled", "position"];

/// The installed dictionaries, in the reader's order.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn remote_dictionaries(database: &Path) -> Result<Vec<RemoteDictionary>, String> {
    let connection = open_store(database)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, revision, term_count, term_meta_count, kanji_count,
                    kanji_meta_count, has_definitions, has_frequency, has_pitch
               FROM dictionaries ORDER BY position, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(RemoteDictionary {
                id: row.get(0)?,
                title: row.get(1)?,
                revision: row.get(2)?,
                term_count: row.get(3)?,
                term_meta_count: row.get(4)?,
                kanji_count: row.get(5)?,
                kanji_meta_count: row.get(6)?,
                has_definitions: row.get(7)?,
                has_frequency: row.get(8)?,
                has_pitch: row.get(9)?,
                size: None,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<_, _>>().map_err(storage_error)
}

/// Writes dictionary `id` to a new file at `pack`; false when no dictionary has that ID.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn write_pack(database: &Path, id: i64, pack: &Path) -> Result<bool, String> {
    let connection = open_store(database)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM dictionaries WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !exists {
        return Ok(false);
    }
    let _ = std::fs::remove_file(pack);
    connection
        .execute(
            "ATTACH DATABASE ?1 AS pack",
            [pack.to_string_lossy().as_ref()],
        )
        .map_err(storage_error)?;
    let written = (|| {
        let transaction = connection.unchecked_transaction()?;
        for (table, key) in TABLES
            .iter()
            .map(|table| (*table, "dictionary"))
            .chain([("dictionaries", "id")])
        {
            transaction.execute_batch(&format!(
                "CREATE TABLE pack.{table} AS SELECT * FROM main.{table} WHERE 0;"
            ))?;
            transaction.execute(
                &format!("INSERT INTO pack.{table} SELECT * FROM main.{table} WHERE {key} = ?1"),
                [id],
            )?;
        }
        transaction.execute_batch(&format!("PRAGMA pack.user_version = {SCHEMA_VERSION};"))?;
        transaction.commit()
    })();
    let detached = connection.execute_batch("DETACH DATABASE pack;");
    written.and(detached).map_err(storage_error)?;
    Ok(true)
}

#[cfg_attr(desktop, allow(dead_code))]
#[derive(Debug, PartialEq)]
pub(crate) enum PackImport {
    /// The dictionary is in the store under this ID, last in the order.
    Imported(i64),
    /// A dictionary with the same title and revision already is.
    AlreadyImported,
}

#[cfg_attr(desktop, allow(dead_code))]
fn columns(connection: &Connection, schema: &str, table: &str) -> rusqlite::Result<Vec<String>> {
    connection
        .prepare(&format!("PRAGMA {schema}.table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

/// Adds the dictionary in `pack` to the store, unless the store already has it.
#[cfg_attr(desktop, allow(dead_code))]
pub(crate) fn import_pack(connection: &mut Connection, pack: &Path) -> Result<PackImport, String> {
    connection
        .execute(
            "ATTACH DATABASE ?1 AS pack",
            [pack.to_string_lossy().as_ref()],
        )
        .map_err(storage_error)?;
    let imported = copy_pack(connection);
    let _ = connection.execute_batch("DETACH DATABASE pack;");
    imported
}

#[cfg_attr(desktop, allow(dead_code))]
fn copy_pack(connection: &mut Connection) -> Result<PackImport, String> {
    let version: i64 = connection
        .query_row("PRAGMA pack.user_version", [], |row| row.get(0))
        .map_err(storage_error)?;
    if version != SCHEMA_VERSION {
        return Err("This dictionary is from another version of Komori; update both.".into());
    }
    let mut statement = connection
        .prepare("SELECT title, revision FROM pack.dictionaries")
        .map_err(storage_error)?;
    let found = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);
    let [(title, revision)] = found.as_slice() else {
        return Err("The PC sent no dictionary.".into());
    };
    let existing: Option<i64> = connection
        .query_row(
            "SELECT id FROM main.dictionaries WHERE title = ?1 AND revision = ?2",
            params![title, revision],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if existing.is_some() {
        return Ok(PackImport::AlreadyImported);
    }
    let shared = |table: &str, skip: &[&str]| -> Result<String, String> {
        let theirs = columns(connection, "pack", table).map_err(storage_error)?;
        Ok(columns(connection, "main", table)
            .map_err(storage_error)?
            .into_iter()
            .filter(|column| !skip.contains(&column.as_str()) && theirs.contains(column))
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", "))
    };
    let dictionary_columns = shared("dictionaries", &LOCAL_COLUMNS)?;
    let row_columns = TABLES
        .iter()
        .map(|table| shared(table, &["dictionary"]).map(|columns| (*table, columns)))
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = connection.transaction().map_err(storage_error)?;
    transaction
        .execute_batch(&format!(
            "INSERT INTO main.dictionaries ({dictionary_columns}, position)
             SELECT {dictionary_columns},
                    (SELECT COALESCE(MAX(position), 0) + 1 FROM main.dictionaries)
               FROM pack.dictionaries;"
        ))
        .map_err(storage_error)?;
    let id = transaction.last_insert_rowid();
    for (table, columns) in row_columns {
        transaction
            .execute(
                &format!(
                    "INSERT INTO main.{table} (dictionary, {columns})
                     SELECT ?1, {columns} FROM pack.{table}"
                ),
                [id],
            )
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(PackImport::Imported(id))
}

/// Imports a dictionary archive the way the Dictionary page does, for other modules' tests.
#[cfg(test)]
pub(crate) fn import_archive_for_tests(connection: &mut Connection, path: &Path) -> bool {
    super::import_one(connection, path).0 == super::ImportStatus::Imported
}

/// The headwords a lookup finds, for other modules' tests.
#[cfg(test)]
pub(crate) fn headwords_for_tests(connection: &Connection, query: &str) -> Vec<String> {
    super::lookup_from_store(connection, query)
        .unwrap()
        .iter()
        .map(|group| format!("{group:?}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::archive::tests::{fixture_entries, write_archive};
    use tempfile::tempdir;

    fn counts(connection: &Connection) -> Vec<i64> {
        TABLES
            .iter()
            .chain(&["dictionaries"])
            .map(|table| {
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn a_pack_carries_one_dictionary_into_another_store_once() {
        let directory = tempdir().unwrap();
        let archive = directory.path().join("fixture.zip");
        write_archive(&archive, &fixture_entries());
        let pc = directory.path().join("pc.sqlite3");
        let mut source = open_store(&pc).unwrap();
        assert!(import_archive_for_tests(&mut source, &archive));
        let id: i64 = source
            .query_row("SELECT id FROM dictionaries", [], |row| row.get(0))
            .unwrap();
        let pack = directory.path().join("pack.sqlite3");
        assert!(!write_pack(&pc, id + 1, &pack).unwrap());
        assert!(write_pack(&pc, id, &pack).unwrap());

        // The phone already has another dictionary, so the copy gets its own ID, last in order.
        let phone = directory.path().join("phone.sqlite3");
        let mut target = open_store(&phone).unwrap();
        target
            .execute(
                "INSERT INTO dictionaries (title, revision, format, sequenced, position)
                 VALUES ('Other', '1', 3, 0, 4)",
                [],
            )
            .unwrap();
        let PackImport::Imported(copied) = import_pack(&mut target, &pack).unwrap() else {
            panic!("the pack was not imported");
        };
        let position: i64 = target
            .query_row(
                "SELECT position FROM dictionaries WHERE id = ?1",
                [copied],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(position, 5);
        let mut expected = counts(&source);
        *expected.last_mut().unwrap() += 1;
        assert_eq!(counts(&target), expected);
        assert_eq!(
            headwords_for_tests(&target, "読む")
                .join("")
                .replace(&format!("id: {copied}"), "id: X"),
            headwords_for_tests(&source, "読む")
                .join("")
                .replace(&format!("id: {id}"), "id: X")
        );
        assert_eq!(
            import_pack(&mut target, &pack).unwrap(),
            PackImport::AlreadyImported
        );
        // The pack is detached again, and a pack from another version is refused.
        Connection::open(&pack)
            .unwrap()
            .execute_batch("PRAGMA user_version = 99;")
            .unwrap();
        target
            .execute("DELETE FROM dictionaries WHERE id = ?1", [copied])
            .unwrap();
        assert!(import_pack(&mut target, &pack).is_err());
    }
}
