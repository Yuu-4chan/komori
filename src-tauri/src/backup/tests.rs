use super::*;

#[test]
fn furigana_styles_round_trip_in_backups_and_legacy_hiding_stays_enabled() {
    let fixture = fixture();
    let mut connection = open_catalog(&fixture.database).unwrap();
    for style in ["hide", "partial", "toggle", "full"] {
        write_record(
            &connection,
            "appearance",
            Some(
                &serde_json::json!({"readerHideFurigana": true, "readerFuriganaStyle": style})
                    .to_string(),
            ),
        )
        .unwrap();
        let backup = collect(&mut connection, START).unwrap();
        assert_eq!(
            backup.preferences.appearance.as_ref().unwrap()["readerFuriganaStyle"],
            style
        );
        write_record(&connection, "appearance", Some("{}")).unwrap();
        assert_eq!(
            restore(&fixture.database, &backup, START + 1)
                .unwrap()
                .status,
            "restored"
        );
        let restored: Value =
            serde_json::from_str(&record_text(&connection, "appearance").unwrap()).unwrap();
        assert_eq!(restored["readerFuriganaStyle"], style);
        assert_eq!(restored["readerHideFurigana"], true);
        let mut legacy = serde_json::to_value(&backup).unwrap();
        legacy["preferences"]["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("readerFuriganaStyle");
        let legacy: Backup = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            restore(&fixture.database, &legacy, START + 2)
                .unwrap()
                .status,
            "restored"
        );
        let restored: Value =
            serde_json::from_str(&record_text(&connection, "appearance").unwrap()).unwrap();
        assert_eq!(restored["readerHideFurigana"], true);
        assert!(restored.get("readerFuriganaStyle").is_none());
    }
}

#[test]
fn session_corrections_round_trip_and_older_backups_restore_uncorrected_measurements() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 10, "Book B");
    read_state(&fixture);
    let mut connection = open_catalog(&fixture.database).unwrap();
    connection
        .execute(
            "UPDATE reading_sessions SET units_adjustment = -100, active_adjustment = 600000",
            [],
        )
        .unwrap();
    let backup = collect(&mut connection, START).unwrap();
    assert_eq!(
        backup.sessions[0].adjustment,
        Some(SessionAdjustment {
            units_delta: -100,
            active_ms_delta: 600000
        })
    );
    assert!(backup.is_valid());
    connection
        .execute(
            "UPDATE reading_sessions SET units_adjustment = 0, active_adjustment = 0",
            [],
        )
        .unwrap();
    restore(&fixture.database, &backup, START + 1).unwrap();
    assert_eq!(
        collect(&mut connection, START).unwrap().sessions,
        backup.sessions
    );
    let mut old = serde_json::to_value(&backup).unwrap();
    old["sessions"][0]
        .as_object_mut()
        .unwrap()
        .remove("adjustment");
    let older: Backup = serde_json::from_value(old).unwrap();
    assert!(older.is_valid());
    restore(&fixture.database, &older, START + 2).unwrap();
    assert_eq!(
        collect(&mut connection, START).unwrap().sessions[0].adjustment,
        Some(SessionAdjustment::default())
    );
    let mut invalid = backup;
    invalid.sessions[0].adjustment.as_mut().unwrap().units_delta = 1_000_000_001;
    assert!(!invalid.is_valid());
}

#[test]
fn startup_choices_round_trip_without_window_or_last_book_and_older_backups_preserve_them() {
    let fixture = fixture();
    let mut connection = open_catalog(&fixture.database).unwrap();
    let choices = crate::startup::Preferences {
        launch_at_startup: true,
        restore_last_book: false,
        remember_window_size: false,
        minimize_to_tray: true,
        check_for_updates: false,
    };
    crate::startup::save_to(&connection, choices).unwrap();
    write_record(
        &connection,
        "window",
        Some(r#"{"width":1100,"height":700,"maximized":false}"#),
    )
    .unwrap();
    write_record(&connection, "last-book", Some(A)).unwrap();
    let backup = collect(&mut connection, START).unwrap();
    assert_eq!(backup.preferences.startup, Some(choices));
    let text = serde_json::to_string(&backup).unwrap();
    assert!(!text.contains("last-book"));
    assert!(!text.contains("width"));
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["preferences"]
        .as_object_mut()
        .unwrap()
        .remove("startup");
    let older: Backup = serde_json::from_value(value.clone()).unwrap();
    assert!(older.is_valid());
    restore(&fixture.database, &older, START + 1).unwrap();
    assert_eq!(crate::startup::load(&fixture.database).unwrap(), choices);
    crate::startup::save_to(&connection, Default::default()).unwrap();
    restore(&fixture.database, &backup, START + 2).unwrap();
    assert_eq!(crate::startup::load(&fixture.database).unwrap(), choices);
    assert_eq!(record_text(&connection, "last-book"), Some(A.to_string()));
    value["preferences"]["startup"] = serde_json::json!({"launchAtStartup": "yes", "restoreLastBook": true, "rememberWindowSize": true, "minimizeToTray": false});
    assert!(serde_json::from_value::<Backup>(value).is_err());
}

#[test]
fn discord_choices_round_trip_and_older_backups_preserve_them() {
    let fixture = fixture();
    let mut connection = open_catalog(&fixture.database).unwrap();
    let empty = collect(&mut connection, START).unwrap();
    assert_eq!(empty.preferences.discord, None);
    // A Library that never saved them writes no field, so older Komori reads the backup.
    assert!(!serde_json::to_string(&empty).unwrap().contains("discord"));
    let choices = crate::discord_presence::Preferences {
        enabled: true,
        show_book_title: false,
        show_book_progress: true,
        book_progress_format: crate::discord_presence::ProgressFormat::Both,
        show_chapter_progress: false,
        show_reading_speed: true,
    };
    crate::discord_presence::save_to(&connection, choices).unwrap();
    let backup = collect(&mut connection, START).unwrap();
    assert_eq!(backup.preferences.discord, Some(choices));
    crate::discord_presence::save_to(&connection, Default::default()).unwrap();
    restore(&fixture.database, &empty, START + 1).unwrap();
    assert_eq!(
        crate::discord_presence::load(&fixture.database).unwrap(),
        Default::default()
    );
    restore(&fixture.database, &backup, START + 2).unwrap();
    assert_eq!(
        crate::discord_presence::load(&fixture.database).unwrap(),
        choices
    );
    let mut value = serde_json::to_value(&backup).unwrap();
    value["preferences"]["discord"]["enabled"] = serde_json::json!("yes");
    assert!(serde_json::from_value::<Backup>(value).is_err());
}

fn record_text(connection: &Connection, name: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const OTHER_A: &str = "33333333-3333-4333-8333-333333333333";
const SESSION: &str = "44444444-4444-4444-8444-444444444444";
const GONE: &str = "55555555-5555-4555-8555-555555555555";
const START: i64 = 1_759_000_000_000;

struct Fixture {
    _directory: tempfile::TempDir,
    database: PathBuf,
    sources: PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data").join("library.sqlite3");
    std::fs::create_dir_all(database.parent().unwrap()).unwrap();
    let sources = directory.path().join("books");
    std::fs::create_dir_all(&sources).unwrap();
    open_catalog(&database).unwrap();
    Fixture {
        _directory: directory,
        database,
        sources,
    }
}

fn add_book(fixture: &Fixture, id: &str, file: &str, bytes: usize, title: &str) {
    let source = fixture.sources.join(file);
    std::fs::write(&source, vec![b'x'; bytes]).unwrap();
    open_catalog(&fixture.database)
        .unwrap()
        .execute(
            "INSERT INTO books (id, source_path, file_name, title, author)
             VALUES (?1, ?2, ?3, ?4, 'Author')",
            params![id, source.to_string_lossy(), file, title],
        )
        .unwrap();
}

/// Reading state as rows, for comparing before and after.
fn state(database: &Path) -> Vec<String> {
    let connection = open_catalog(database).unwrap();
    let mut rows = Vec::new();
    for sql in [
        "SELECT name || '=' || value FROM preferences WHERE name != 'backup' ORDER BY name",
        "SELECT book_id || ':' || spine_index || ':' || coalesce(section_key, '') || ':' ||
                progress || ':' || updated_at FROM reading_positions ORDER BY book_id",
        "SELECT book_id || ':' || unit || ':' || current_units || '/' || total_units || ':' ||
                updated_at FROM book_progress ORDER BY book_id",
        "SELECT book_id || ':' || coalesce(series, '<none>') || ':' || coalesce(series_index, '')
           FROM book_series ORDER BY book_id",
        "SELECT book_id || ':' || locator || ':' || label || ':' || excerpt || ':' || created_at
           FROM bookmarks ORDER BY book_id, created_at",
        "SELECT id || ':' || book_id || ':' || units_read || ':' || coalesce(book_title, '') ||
                ':' || finish_cleared FROM reading_sessions ORDER BY id",
    ] {
        let mut statement = connection.prepare(sql).unwrap();
        rows.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap),
        );
        rows.push("--".into());
    }
    rows
}

fn read_state(fixture: &Fixture) {
    let connection = open_catalog(&fixture.database).unwrap();
    connection
        .execute_batch(&format!(
            "INSERT INTO reading_positions (book_id, spine_index, section_key, progress, updated_at)
               VALUES ('{A}', 3, '0a1b2c3d', 0.25, '2026-09-30T10:00:00.000Z');
             INSERT INTO book_progress (book_id, unit, current_units, total_units, updated_at)
               VALUES ('{A}', 'characters', 1200, 90000, '2026-09-30T10:00:01.000Z');
             INSERT INTO book_series (book_id, series, series_index) VALUES ('{A}', 'Saga', 2);
             INSERT INTO book_series (book_id, series, series_index) VALUES ('{B}', NULL, NULL);
             INSERT INTO bookmarks (id, book_id, locator, label, excerpt, created_at) VALUES
               ('{GONE}', '{A}',
                '{{\"spineIndex\":3,\"sectionKey\":\"0a1b2c3d\",\"progress\":0.5,\"contentKey\":\"{key}\"}}',
                'Duel', 'The duel begins', '2026-09-30T11:00:00.000Z');
             INSERT INTO reading_sessions
               (id, book_id, started_at, ended_at, active_ms, unit, units_read, start_units,
                end_units, total_units, book_title, finish_cleared)
               VALUES ('{SESSION}', '{A}', {START}, {START} + 600000, 60000, 'characters', 500,
                       700, 1200, 90000, 'Book A', 0);",
            key = "a".repeat(64)
        ))
        .unwrap();
    let appearance = AppearancePreferences::from_stored(
        &serde_json::json!({"theme": "dark", "readerFontSize": 20}),
    );
    write_record(
        &connection,
        "appearance",
        Some(&serde_json::to_string(&appearance).unwrap()),
    )
    .unwrap();
    save(
        &connection,
        &anki::Preferences {
            port: 8766,
            ..anki::Preferences::default()
        },
    );
}

fn save(connection: &Connection, preferences: &anki::Preferences) {
    write_record(
        connection,
        "anki",
        Some(&serde_json::to_string(preferences).unwrap()),
    )
    .unwrap();
}

fn write(fixture: &Fixture, name: &str, backup: &Backup) -> PathBuf {
    let path = fixture.sources.join(name);
    write_backup(&path, backup).unwrap();
    path
}

#[test]
fn export_and_restore_return_this_library_to_the_backup_exactly() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    read_state(&fixture);
    let before = state(&fixture.database);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    assert_eq!(backup.books.len(), 2);
    assert_eq!(backup.books[0].file_size, Some(10));
    assert_eq!(backup.books[0].bookmarks.len(), 1);
    assert_eq!(
        backup.preferences.appearance,
        Some(serde_json::json!({"theme": "dark", "readerFontSize": 20}))
    );
    // Invalid stored appearance fields are not carried along.
    write_record(
        &open_catalog(&fixture.database).unwrap(),
        "appearance",
        Some(r#"{"theme":"dark","readerFontSize":20,"bogus":1,"readerLineHeight":"x"}"#),
    )
    .unwrap();
    assert_eq!(
        collect(&mut open_catalog(&fixture.database).unwrap(), START)
            .unwrap()
            .preferences,
        backup.preferences
    );
    write_record(
        &open_catalog(&fixture.database).unwrap(),
        "appearance",
        Some(&serde_json::to_string(backup.preferences.appearance.as_ref().unwrap()).unwrap()),
    )
    .unwrap();
    let path = write(&fixture, "a.komoribackup", &backup);
    assert_eq!(read_backup(&path), Ok(backup.clone()));

    // Change everything the backup holds.
    let connection = open_catalog(&fixture.database).unwrap();
    connection
        .execute_batch(&format!(
            "UPDATE preferences SET value = '{{\"theme\":\"light\"}}' WHERE name = 'appearance';
             DELETE FROM preferences WHERE name = 'anki';
             UPDATE reading_positions SET progress = 0.9;
             DELETE FROM book_progress;
             INSERT INTO reading_positions (book_id, spine_index, progress) VALUES ('{B}', 1, 0.1);
             DELETE FROM book_series WHERE book_id = '{A}';
             DELETE FROM bookmarks;
             UPDATE reading_sessions SET units_read = 1;"
        ))
        .unwrap();
    assert_ne!(state(&fixture.database), before);

    let (preview, held) = prepare(&fixture.database, &path).unwrap();
    assert_eq!(preview.status, "ready");
    assert_eq!((preview.books, preview.matched), (2, 2));
    assert_eq!(
        (preview.positions, preview.bookmarks, preview.sessions),
        (1, 1, 1)
    );
    assert!(preview.appearance && preview.anki);
    let result = restore(&fixture.database, &held.unwrap(), START + 1).unwrap();
    assert_eq!(result.status, "restored");
    assert_eq!((result.books, result.unmatched_count), (2, 0));
    assert_eq!(state(&fixture.database), before);

    // The state from before the restore was kept as a snapshot.
    let snapshots = snapshots(&snapshot_folder(&fixture.database));
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].kind, "restore");
    assert_eq!(Some(snapshots[0].id.clone()), result.snapshot);
}

#[test]
fn another_library_matches_books_by_file_and_metadata_and_names_the_rest() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    read_state(&fixture);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    let path = write(&fixture, "a.komoribackup", &backup);

    let other = super::tests::fixture();
    // Same file (name and size) under another catalog ID; Book B is missing.
    add_book(&other, OTHER_A, "A.EPUB", 10, "Renamed title");
    add_book(&other, GONE, "c.epub", 30, "Book C");
    let (preview, held) = prepare(&other.database, &path).unwrap();
    assert_eq!((preview.matched, preview.unmatched_count), (1, 1));
    assert_eq!(preview.unmatched, vec!["Book B".to_owned()]);
    let result = restore(&other.database, &held.unwrap(), START).unwrap();
    assert_eq!(result.unmatched, vec!["Book B".to_owned()]);
    let rows = state(&other.database);
    assert!(rows
        .iter()
        .any(|row| row.starts_with(&format!("{OTHER_A}:3:0a1b2c3d"))));
    assert!(rows
        .iter()
        .any(|row| row.starts_with(&format!("{OTHER_A}:Saga"))));
    // The session moved to the matched book; Book C is untouched.
    assert!(rows
        .iter()
        .any(|row| row.starts_with(&format!("{SESSION}:{OTHER_A}"))));
    assert!(!rows.iter().any(|row| row.contains(GONE)));
}

#[test]
fn matching_prefers_ids_then_file_then_unique_title() {
    let book = |id: &str, file: &str, size: Option<u64>, title: &str| BackupBook {
        id: id.into(),
        file_name: file.into(),
        file_size: size,
        title: Some(title.into()),
        author: Some("Author".into()),
        manual_series: None,
        position: None,
        progress: None,
        bookmarks: Vec::new(),
        notes: None,
    };
    let candidate = |id: &str, file: &str, size: Option<u64>, title: &str| CatalogBook {
        id: id.into(),
        file_name: file.into(),
        file_size: size,
        title: Some(title.into()),
        author: Some("author".into()),
    };
    let books = [
        book(A, "x.epub", Some(1), "One"),
        book(B, "y.epub", Some(2), "Two"),
        book(SESSION, "z.epub", None, "Three"),
        book(GONE, "w.epub", None, "Twin"),
        book(OTHER_A, "v.epub", None, "Twin"),
    ];
    let catalog = [
        candidate(A, "renamed.epub", None, "One"),
        candidate("c", "y.epub", Some(2), "Changed"),
        candidate("d", "moved.epub", Some(9), "three"),
        candidate("e", "a.epub", None, "Twin"),
        candidate("f", "b.epub", None, "Twin"),
    ];
    assert_eq!(
        match_books(&books, &catalog),
        vec![
            Some(A.into()),
            Some("c".into()),
            Some("d".into()),
            // Two books share title and author on each side: neither is guessed.
            None,
            None
        ]
    );
}

#[test]
fn ambiguous_file_or_metadata_matches_are_never_guessed_in_either_catalog_order() {
    let book = |id: &str, size: Option<u64>| BackupBook {
        id: id.into(),
        file_name: "copy.epub".into(),
        file_size: size,
        title: Some("Twin".into()),
        author: Some("Author".into()),
        manual_series: None,
        position: None,
        progress: None,
        bookmarks: Vec::new(),
        notes: None,
    };
    let candidate = |id: &str, size: Option<u64>| CatalogBook {
        id: id.into(),
        file_name: "COPY.epub".into(),
        file_size: size,
        title: Some("Twin".into()),
        author: Some("Author".into()),
    };
    // Two catalog books with the same name and size (pass 1), or the same name, title and
    // author (pass 2), for one backup book.
    for sizes in [(Some(10), Some(10)), (None, Some(7))] {
        let mut catalog = vec![candidate("c", sizes.0), candidate("d", sizes.1)];
        for _ in 0..2 {
            assert_eq!(match_books(&[book(A, Some(10))], &catalog), vec![None]);
            catalog.reverse();
        }
    }
    // Two backup books for the one catalog book that satisfies each pass.
    for size in [Some(10), None] {
        let mut books = vec![book(A, size), book(B, size)];
        for _ in 0..2 {
            assert_eq!(
                match_books(&books, &[candidate("c", Some(10))]),
                vec![None, None]
            );
            books.reverse();
        }
    }
    // A unique match on either side still matches, edited metadata included.
    let edited = CatalogBook {
        title: Some("Edited".into()),
        ..candidate("c", Some(10))
    };
    assert_eq!(
        match_books(&[book(A, Some(10))], &[edited, candidate("d", Some(9))]),
        vec![Some("c".into())]
    );
}

#[test]
fn restore_leaves_two_equally_matching_copies_untouched_in_either_catalog_order() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    full_state(&fixture);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    let path = write(&fixture, "a.komoribackup", &backup);

    for order in [[OTHER_A, GONE], [GONE, OTHER_A]] {
        let other = super::tests::fixture();
        let mut connection = open_catalog(&other.database).unwrap();
        for (copy, id) in order.iter().enumerate() {
            // The same file name, size, title and author in two folders.
            let folder = other.sources.join(format!("copy{copy}"));
            std::fs::create_dir_all(&folder).unwrap();
            let source = folder.join("a.epub");
            std::fs::write(&source, vec![b'x'; 10]).unwrap();
            connection
                .execute(
                    "INSERT INTO books (id, source_path, file_name, title, author, imported_at)
                     VALUES (?1, ?2, 'a.epub', 'Book A', 'Author', ?3)",
                    params![
                        id,
                        source.to_string_lossy(),
                        format!("2026-01-0{}", copy + 1)
                    ],
                )
                .unwrap();
            connection
                .execute_batch(&format!(
                    "INSERT INTO reading_positions (book_id, spine_index, progress, updated_at)
                       VALUES ('{id}', 7, 0.5, 'here');
                     INSERT INTO book_progress (book_id, unit, current_units, total_units, updated_at)
                       VALUES ('{id}', 'characters', 10, 100, 'here');
                     INSERT INTO book_series (book_id, series, series_index) VALUES ('{id}', 'Own', 1);
                     INSERT INTO bookmarks (id, book_id, locator, label, excerpt, created_at) VALUES
                       ('bookmark-{id}', '{id}',
                        '{{\"spineIndex\":7,\"sectionKey\":\"0a1b2c3d\",\"progress\":0.5,\"contentKey\":\"{key}\"}}',
                        'Mine', 'Mine', 'here');",
                    key = "b".repeat(64)
                ))
                .unwrap();
            crate::reader_notes::create(
                &mut connection,
                id,
                BookmarkLocator {
                    spine_index: 7,
                    section_key: "0a1b2c3d".into(),
                    progress: 0.5,
                    content_key: "b".repeat(64),
                },
                "Own passage".into(),
                "Own thought".into(),
            )
            .unwrap();
        }
        let before = owned_state(&other.database);
        let books = |rows: &[String]| -> Vec<String> {
            rows.iter()
                .filter(|row| row.contains(OTHER_A) || row.contains(GONE))
                .filter(|row| !row.starts_with(SESSION))
                .cloned()
                .collect()
        };
        let (preview, held) = prepare(&other.database, &path).unwrap();
        assert_eq!(preview.matched, 0);
        assert!(preview.unmatched.contains(&"Book A".to_owned()));
        let result = restore(&other.database, &held.unwrap(), START).unwrap();
        assert!(result.unmatched.contains(&"Book A".to_owned()));
        let after = owned_state(&other.database);
        assert_eq!(books(&after), books(&before));
        assert!(!after.iter().any(|row| row.contains("Thought")));
    }
}

#[test]
fn malformed_foreign_and_newer_files_are_refused_without_changes() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    read_state(&fixture);
    let before = state(&fixture.database);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    let mut value = serde_json::to_value(&backup).unwrap();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("foreign", b"PK\x03\x04 not json".to_vec()),
        (
            "foreign",
            br#"{"format":"something-else","version":1}"#.to_vec(),
        ),
        (
            "newer",
            br#"{"format":"komori-backup","version":2}"#.to_vec(),
        ),
        (
            "damaged",
            br#"{"format":"komori-backup","version":1}"#.to_vec(),
        ),
        ("damaged", {
            value["books"][0]["position"]["progress"] = serde_json::json!(4.0);
            serde_json::to_vec(&value).unwrap()
        }),
        ("damaged", {
            value["books"][0]["position"]["progress"] = serde_json::json!(0.5);
            value["sessions"][0]["session"]["activeMs"] = serde_json::json!(-1);
            serde_json::to_vec(&value).unwrap()
        }),
        ("damaged", {
            value["sessions"][0]["session"]["activeMs"] = serde_json::json!(1);
            value["preferences"]["anki"]["port"] = serde_json::json!(0);
            serde_json::to_vec(&value).unwrap()
        }),
        ("damaged", {
            value["preferences"]["anki"]["port"] = serde_json::json!(8765);
            value["books"][0]["extra"] = serde_json::json!(true);
            serde_json::to_vec(&value).unwrap()
        }),
    ];
    for (index, (status, bytes)) in cases.into_iter().enumerate() {
        let path = fixture.sources.join(format!("{index}.komoribackup"));
        std::fs::write(&path, bytes).unwrap();
        let (preview, held) = prepare(&fixture.database, &path).unwrap();
        assert_eq!((index, preview.status), (index, status));
        assert!(preview.token.is_none() && held.is_none());
    }
    assert_eq!(state(&fixture.database), before);
    assert!(snapshots(&snapshot_folder(&fixture.database)).is_empty());
}

#[test]
fn backup_file_reads_refuse_non_files_and_oversized_metadata() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(read_backup(directory.path()).err(), Some("unreadable"));
    let path = directory.path().join("oversized.komoribackup");
    File::create(&path)
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    assert_eq!(read_backup(&path).err(), Some("tooLarge"));
}

// Realistic large Libraries (thousands of books, three long notes each) stay well inside.
const _: () = assert!(MAX_FILE_BYTES >= 256 * 1024 * 1024);

#[test]
fn backups_larger_than_the_read_limit_are_refused_before_they_are_written() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    let size = serde_json::to_vec(&backup).unwrap().len() as u64;
    let path = fixture.sources.join("limit.komoribackup");
    assert_eq!(
        write_backup_within(&path, &backup, size - 1),
        Err(WriteError::TooLarge)
    );
    assert!(!path.exists());
    assert!(!fixture.sources.join("limit.komoribackup.partial").exists());
    write_backup_within(&path, &backup, size).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), size);
    assert_eq!(
        read_backup_bytes(File::open(&path).unwrap(), size)
            .unwrap()
            .len() as u64,
        size
    );
}

#[test]
fn backup_byte_reads_stop_at_the_actual_limit() {
    let mut exact = std::io::Cursor::new(b"abcd");
    assert_eq!(read_backup_bytes(&mut exact, 4).unwrap(), b"abcd");
    let mut oversized = std::io::Cursor::new(b"abcdefghijk");
    assert_eq!(read_backup_bytes(&mut oversized, 4), Err("tooLarge"));
    assert_eq!(oversized.position(), 5);
}

#[test]
fn backup_byte_reads_refuse_a_file_that_grows_after_metadata() {
    use std::io::Write;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("growing.komoribackup");
    std::fs::write(&path, b"{}").unwrap();
    let source = File::open(&path).unwrap();
    let metadata = source.metadata().unwrap();
    assert!(metadata.is_file());
    assert_eq!(metadata.len(), 2);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"   ")
        .unwrap();
    assert_eq!(read_backup_bytes(source, metadata.len()), Err("tooLarge"));
}

#[test]
fn automatic_snapshots_follow_the_saved_frequency_and_keep() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    let folder = snapshot_folder(&fixture.database);
    let connection = open_catalog(&fixture.database).unwrap();
    assert_eq!(
        load_settings(&connection).unwrap(),
        BackupSettings::default()
    );

    // Daily by default: one now, none an hour later, another a day later.
    assert!(run_automatic(&fixture.database, START).unwrap().is_some());
    assert!(run_automatic(&fixture.database, START + 3_600_000)
        .unwrap()
        .is_none());
    assert!(run_automatic(&fixture.database, START + DAY_MS)
        .unwrap()
        .is_some());
    take_snapshot(&fixture.database, "manual", START + 5).unwrap();

    let settings = BackupSettings {
        automatic: true,
        frequency: "weekly".into(),
        keep: 3,
    };
    save_settings(&connection, &settings).unwrap();
    assert_eq!(load_settings(&connection).unwrap(), settings);
    assert!(run_automatic(&fixture.database, START + 2 * DAY_MS)
        .unwrap()
        .is_none());
    for week in 1..=3 {
        assert!(
            run_automatic(&fixture.database, START + DAY_MS + week * 7 * DAY_MS)
                .unwrap()
                .is_some()
        );
    }
    let kept = snapshots(&folder);
    // Three automatic snapshots, newest first, and the manual one, which is never pruned.
    assert_eq!(
        kept.iter()
            .map(|snapshot| snapshot.kind)
            .collect::<Vec<_>>(),
        ["automatic", "automatic", "automatic", "manual"]
    );
    assert_eq!(kept[0].created_at, START + DAY_MS + 21 * DAY_MS);

    // Off takes none; invalid stored fields fall back on their own.
    save_settings(
        &connection,
        &BackupSettings {
            automatic: false,
            ..settings
        },
    )
    .unwrap();
    assert!(run_automatic(&fixture.database, START + 400 * DAY_MS)
        .unwrap()
        .is_none());
    write_record(
        &connection,
        SETTINGS_RECORD,
        Some(r#"{"automatic":false,"frequency":"hourly","keep":5}"#),
    )
    .unwrap();
    assert_eq!(
        load_settings(&connection).unwrap(),
        BackupSettings {
            automatic: false,
            ..BackupSettings::default()
        }
    );
    assert!(!BackupSettings {
        keep: 5,
        ..BackupSettings::default()
    }
    .is_valid());
}

#[test]
fn snapshot_ids_name_only_snapshot_files() {
    assert_eq!(snapshot_kind("automatic-1759"), Some(("automatic", 1759)));
    assert_eq!(snapshot_kind("restore-1"), Some(("restore", 1)));
    for id in [
        "",
        "manual-",
        "manual-12a",
        "other-1",
        "manual-1/../../x",
        "manual-1234567890123456",
        "..\\manual-1",
    ] {
        assert_eq!(snapshot_kind(id), None, "{id}");
    }
    assert!(valid_timestamp("2026-09-30T10:00:00.000Z"));
    assert!(!valid_timestamp("2026-09-30 10:00:00"));
}

#[test]
fn notes_backup_round_trips_preserves_older_backup_and_refuses_damage() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 50, "Book A");
    let mut connection = open_catalog(&fixture.database).unwrap();
    let locator = BookmarkLocator {
        spine_index: 1,
        section_key: "abcd1234".into(),
        progress: 0.5,
        content_key: "a".repeat(64),
    };
    crate::reader_notes::create(
        &mut connection,
        A,
        locator,
        "Selected passage".into(),
        "Thought\nDetail".into(),
    )
    .unwrap();
    let backup = collect(&mut connection, START).unwrap();
    assert_eq!(backup.books[0].notes.as_ref().unwrap().len(), 1);
    let encoded = serde_json::to_value(&backup).unwrap();
    let mut older = encoded.clone();
    older["books"][0].as_object_mut().unwrap().remove("notes");
    connection
        .execute("UPDATE reader_notes SET body = 'Current thought'", [])
        .unwrap();
    restore(
        &fixture.database,
        &serde_json::from_value(older).unwrap(),
        START + 1,
    )
    .unwrap();
    assert_eq!(
        crate::reader_notes::list(&connection, A).unwrap()[0].body,
        "Current thought"
    );
    restore(&fixture.database, &backup, START + 2).unwrap();
    assert_eq!(
        crate::reader_notes::list(&connection, A).unwrap()[0].body,
        "Thought\nDetail"
    );
    let snapshots = snapshots(&snapshot_folder(&fixture.database));
    let path = snapshot_folder(&fixture.database).join(format!("{}.komoribackup", snapshots[0].id));
    let snapshot = read_backup(&path).unwrap();
    assert!(snapshot.books[0]
        .notes
        .as_ref()
        .is_some_and(|notes| !notes.is_empty()));
    for value in [
        serde_json::json!(" padded"),
        serde_json::json!("x".repeat(4097)),
        serde_json::json!("\u{0000}"),
    ] {
        let mut damaged = encoded.clone();
        damaged["books"][0]["notes"][0]["body"] = value;
        let invalid: Backup = serde_json::from_value(damaged).unwrap();
        assert!(!invalid.is_valid());
    }
    // A highlight is a note with an empty body.
    let mut highlight = encoded.clone();
    highlight["books"][0]["notes"][0]["body"] = serde_json::json!("");
    assert!(serde_json::from_value::<Backup>(highlight)
        .unwrap()
        .is_valid());
    let mut empty = backup.clone();
    empty.books[0].notes = Some(Vec::new());
    restore(&fixture.database, &empty, START + 3).unwrap();
    assert!(crate::reader_notes::list(&connection, A)
        .unwrap()
        .is_empty());
}

/// Every row a restore may touch, including notes (without their regenerated IDs), session
/// timing and corrections, and the backup settings that `state` leaves out.
fn owned_state(database: &Path) -> Vec<String> {
    let mut rows = state(database);
    let connection = open_catalog(database).unwrap();
    for sql in [
        "SELECT coalesce((SELECT value FROM preferences WHERE name = 'backup'), '<none>')",
        "SELECT book_id || ':' || locator || ':' || passage || ':' || body || ':' || created_at ||
                ':' || updated_at FROM reader_notes ORDER BY book_id, created_at, body",
        "SELECT id || ':' || started_at || ':' || ended_at || ':' || active_ms || ':' || unit ||
                ':' || start_units || ':' || end_units || ':' || total_units || ':' ||
                units_adjustment || ':' || active_adjustment FROM reading_sessions ORDER BY id",
    ] {
        let mut statement = connection.prepare(sql).unwrap();
        rows.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap),
        );
        rows.push("--".into());
    }
    rows
}

/// Reading state plus a note, session corrections, startup choices and backup settings.
fn full_state(fixture: &Fixture) {
    read_state(fixture);
    let mut connection = open_catalog(&fixture.database).unwrap();
    crate::reader_notes::create(
        &mut connection,
        A,
        BookmarkLocator {
            spine_index: 1,
            section_key: "abcd1234".into(),
            progress: 0.5,
            content_key: "a".repeat(64),
        },
        "Selected passage".into(),
        "Thought".into(),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE reading_sessions SET units_adjustment = -100, active_adjustment = 600000",
            [],
        )
        .unwrap();
    crate::startup::save_to(
        &connection,
        crate::startup::Preferences {
            launch_at_startup: true,
            restore_last_book: false,
            remember_window_size: false,
            minimize_to_tray: true,
            check_for_updates: false,
        },
    )
    .unwrap();
    save_settings(
        &connection,
        &BackupSettings {
            automatic: true,
            frequency: "weekly".into(),
            keep: 3,
        },
    )
    .unwrap();
}

/// Changes every kind of owned row so a restore of the earlier backup would differ.
fn change_everything(database: &Path) {
    let connection = open_catalog(database).unwrap();
    connection
        .execute_batch(&format!(
            "UPDATE preferences SET value = '{{\"theme\":\"light\"}}' WHERE name = 'appearance';
             DELETE FROM preferences WHERE name = 'anki';
             UPDATE reading_positions SET progress = 0.9;
             DELETE FROM book_progress;
             INSERT INTO reading_positions (book_id, spine_index, progress) VALUES ('{B}', 1, 0.1);
             DELETE FROM book_series WHERE book_id = '{A}';
             DELETE FROM bookmarks;
             UPDATE reader_notes SET body = 'Current thought';
             UPDATE reading_sessions SET units_read = 1, units_adjustment = 0;"
        ))
        .unwrap();
    crate::startup::save_to(&connection, Default::default()).unwrap();
    save_settings(&connection, &BackupSettings::default()).unwrap();
}

#[test]
fn a_restore_that_fails_late_or_cannot_snapshot_leaves_every_owned_row_unchanged() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    full_state(&fixture);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    change_everything(&fixture.database);
    let before = owned_state(&fixture.database);

    // Sessions are written last, after every preference, note and per-book row.
    let connection = open_catalog(&fixture.database).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_late BEFORE INSERT ON reading_sessions
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();
    assert!(restore(&fixture.database, &backup, START + 1).is_err());
    assert_eq!(owned_state(&fixture.database), before);
    connection.execute_batch("DROP TRIGGER fail_late").unwrap();

    // A refused safety snapshot stops the restore before any row changes.
    let folder = snapshot_folder(&fixture.database);
    std::fs::remove_dir_all(&folder).unwrap();
    std::fs::write(&folder, b"not a folder").unwrap();
    let result = restore(&fixture.database, &backup, START + 2).unwrap();
    assert_eq!((result.status, result.snapshot), ("snapshotFailed", None));
    assert_eq!(owned_state(&fixture.database), before);
}

#[test]
fn the_pre_restore_snapshot_restores_the_replaced_library_into_a_fresh_catalog() {
    let fixture = fixture();
    add_book(&fixture, A, "a.epub", 10, "Book A");
    add_book(&fixture, B, "b.epub", 20, "Book B");
    full_state(&fixture);
    let backup = collect(&mut open_catalog(&fixture.database).unwrap(), START).unwrap();
    change_everything(&fixture.database);
    let replaced = owned_state(&fixture.database);
    let result = restore(&fixture.database, &backup, START + 1).unwrap();
    assert_eq!(result.status, "restored");
    assert_ne!(owned_state(&fixture.database), replaced);

    let snapshot = snapshots(&snapshot_folder(&fixture.database))
        .into_iter()
        .find(|snapshot| Some(&snapshot.id) == result.snapshot.as_ref())
        .unwrap();
    assert_eq!(snapshot.kind, "restore");
    let path = snapshot_folder(&fixture.database).join(format!("{}.{EXTENSION}", snapshot.id));
    let fresh = super::tests::fixture();
    add_book(&fresh, A, "a.epub", 10, "Book A");
    add_book(&fresh, B, "b.epub", 20, "Book B");
    let (preview, held) = prepare(&fresh.database, &path).unwrap();
    assert_eq!((preview.status, preview.matched), ("ready", 2));
    let reopened = restore(&fresh.database, &held.unwrap(), START + 2).unwrap();
    assert_eq!(reopened.status, "restored");
    assert_eq!(owned_state(&fresh.database), replaced);
}

/// Installs dictionaries beside the fixture's catalog in this order, returning their IDs.
fn install_dictionaries(fixture: &Fixture, titles: &[&str]) -> Vec<i64> {
    let store = crate::dictionary::store::open_store(
        &fixture
            .database
            .with_file_name(crate::dictionary::store::DATABASE_FILE_NAME),
    )
    .unwrap();
    titles
        .iter()
        .map(|title| {
            store
                .execute(
                    "INSERT INTO dictionaries (title, revision, format, sequenced)
                     VALUES (?1, 'r1', 3, 0)",
                    [title],
                )
                .unwrap();
            store.last_insert_rowid()
        })
        .collect()
}

fn dictionary_preferences(database: &Path) -> (Value, anki::Preferences) {
    let connection = open_catalog(database).unwrap();
    (
        serde_json::from_str(&record_text(&connection, "appearance").unwrap()).unwrap(),
        serde_json::from_str(&record_text(&connection, "anki").unwrap()).unwrap(),
    )
}

#[test]
fn dictionary_selections_follow_title_and_revision_into_a_different_import_order() {
    let source = fixture();
    let [terms, frequency, gone] =
        install_dictionaries(&source, &["Terms", "Frequency", "Gone"])[..]
    else {
        unreachable!()
    };
    let connection = open_catalog(&source.database).unwrap();
    let appearance = serde_json::json!({
        "readerPopupDefinitionSources": {"mode": "selected", "ids": [terms]},
        "readerPopupFrequencySources": {"mode": "selected", "ids": [frequency, terms]},
        "readerPopupPitchSources": {"mode": "selected", "ids": [gone]},
    });
    write_record(&connection, "appearance", Some(&appearance.to_string())).unwrap();
    let mapping = anki::Mapping {
        model_id: None,
        fields: vec!["Front".into(), "Back".into()],
        templates: [
            ("Front".into(), "{{expression}}".into()),
            (
                "Back".into(),
                format!("{{{{dictionary:{terms}}}}}<br>{{{{dictionary:{gone}}}}}{{{{glossary}}}}"),
            ),
        ]
        .into(),
        tags: vec!["komori".into()],
        tag_dictionaries: vec![gone, frequency],
    };
    save(
        &connection,
        &anki::Preferences {
            mappings: [("Basic".into(), mapping)].into(),
            ..anki::Preferences::default()
        },
    );
    let path = source.sources.join("source.komoribackup");
    write_backup(&path, &collect_at(&source.database, START).unwrap()).unwrap();

    // Another computer installed the same dictionaries in the other order, without Gone.
    let target = fixture();
    let ids = install_dictionaries(&target, &["Other", "Frequency", "Terms"]);
    let (frequency_here, terms_here) = (ids[1], ids[2]);
    assert_ne!(terms_here, terms);
    let (_, held) = prepare(&target.database, &path).unwrap();
    let held = held.unwrap();
    assert_eq!(
        restore(&target.database, &held, START + 1).unwrap().status,
        "restored"
    );
    let (appearance, anki) = dictionary_preferences(&target.database);
    assert_eq!(
        appearance["readerPopupDefinitionSources"],
        serde_json::json!({"mode": "selected", "ids": [terms_here]})
    );
    assert_eq!(
        appearance["readerPopupFrequencySources"],
        serde_json::json!({"mode": "selected", "ids": [frequency_here, terms_here]})
    );
    // A dictionary this computer lacks selects nothing rather than another or All.
    assert_eq!(
        appearance["readerPopupPitchSources"],
        serde_json::json!({"mode": "selected", "ids": []})
    );
    let mapping = &anki.mappings["Basic"];
    assert_eq!(
        mapping.templates["Back"],
        format!("{{{{dictionary:{terms_here}}}}}<br>{{{{glossary}}}}")
    );
    assert_eq!(mapping.templates["Front"], "{{expression}}");
    assert_eq!(mapping.tag_dictionaries, vec![frequency_here]);
    assert!(anki.validate().is_ok());

    // Two backup dictionaries with one title and revision name neither.
    let mut ambiguous = held.clone();
    ambiguous.dictionaries.as_mut().unwrap()[2].title = "Terms".into();
    assert!(ambiguous.is_valid());
    restore(&target.database, &ambiguous, START + 2).unwrap();
    let (appearance, _) = dictionary_preferences(&target.database);
    assert_eq!(
        appearance["readerPopupDefinitionSources"],
        serde_json::json!({"mode": "selected", "ids": []})
    );
    assert_eq!(
        appearance["readerPopupFrequencySources"],
        serde_json::json!({"mode": "selected", "ids": [frequency_here]})
    );

    // A backup without dictionaries restores its IDs as they are.
    let mut older = held;
    older.dictionaries = None;
    let mut legacy = serde_json::to_value(&older).unwrap();
    assert!(legacy.get("dictionaries").is_none());
    legacy = serde_json::to_value(serde_json::from_value::<Backup>(legacy).unwrap()).unwrap();
    restore(
        &target.database,
        &serde_json::from_value(legacy).unwrap(),
        START + 3,
    )
    .unwrap();
    let (appearance, anki) = dictionary_preferences(&target.database);
    assert_eq!(
        appearance["readerPopupDefinitionSources"],
        serde_json::json!({"mode": "selected", "ids": [terms]})
    );
    assert_eq!(
        anki.mappings["Basic"].tag_dictionaries,
        vec![gone, frequency]
    );
}

#[test]
fn backup_dictionaries_must_be_named_and_unique() {
    let fixture = fixture();
    install_dictionaries(&fixture, &["Terms"]);
    let backup = collect_at(&fixture.database, START).unwrap();
    assert_eq!(
        backup.dictionaries,
        Some(vec![BackupDictionary {
            id: 1,
            title: "Terms".into(),
            revision: "r1".into()
        }])
    );
    assert!(backup.is_valid());
    for damage in [
        |list: &mut Vec<BackupDictionary>| list.push(list[0].clone()),
        |list: &mut Vec<BackupDictionary>| list[0].id = 0,
        |list: &mut Vec<BackupDictionary>| list[0].title.clear(),
        |list: &mut Vec<BackupDictionary>| list[0].revision = "a\u{0}".into(),
    ] {
        let mut damaged = backup.clone();
        damage(damaged.dictionaries.as_mut().unwrap());
        assert!(!damaged.is_valid());
    }
    // A catalog without a dictionary store beside it names none.
    assert_eq!(installed_dictionaries(&fixture.sources.join("x")), None);
}
