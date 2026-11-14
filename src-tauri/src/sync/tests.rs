use rusqlite::{params, Connection};
use tempfile::{tempdir, TempDir};

use super::*;
use crate::library::open_catalog;

const BOOK: &str = "11111111-1111-4111-8111-111111111111";
/// A copy made before syncing, under its own ID on the phone.
const OLD_COPY: &str = "22222222-2222-4222-8222-222222222222";
const OLD_PC: &str = "33333333-3333-4333-8333-333333333333";
const PHONE_ONLY: &str = "44444444-4444-4444-8444-444444444444";
const PC_DEVICE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE_DEVICE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

struct Sides {
    _directory: TempDir,
    pc: Connection,
    phone: Connection,
    /// The phone's books whose place the last sync moved.
    moved: Vec<String>,
}

fn sides() -> Sides {
    let directory = tempdir().unwrap();
    let pc = open_catalog(&directory.path().join("pc.sqlite3")).unwrap();
    let phone = open_catalog(&directory.path().join("phone.sqlite3")).unwrap();
    for id in [BOOK, OLD_PC] {
        add_book(&pc, id);
    }
    for id in [BOOK, OLD_COPY, PHONE_ONLY] {
        add_book(&phone, id);
    }
    phone
        .execute_batch(&format!(
            "CREATE TABLE pc_books (
               book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
               pc_book TEXT NOT NULL UNIQUE,
               kept INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO pc_books (book_id, pc_book) VALUES ('{BOOK}', '{BOOK}'), ('{OLD_COPY}', '{OLD_PC}');"
        ))
        .unwrap();
    Sides {
        _directory: directory,
        pc,
        phone,
        moved: Vec::new(),
    }
}

fn add_book(connection: &Connection, id: &str) {
    connection
        .execute(
            "INSERT INTO books (id, source_path, file_name, title) VALUES (?1, ?2, 'book.epub', ?3)",
            params![id, format!("{id}.epub"), format!("Book {}", &id[..4])],
        )
        .unwrap();
}

fn own() -> ReadingDevice {
    ReadingDevice {
        id: PC_DEVICE.into(),
        name: "KOMORI-PC".into(),
    }
}

fn phone_device() -> ReadingDevice {
    ReadingDevice {
        id: PHONE_DEVICE.into(),
        name: "Galaxy".into(),
    }
}

/// One whole sync, as `pc_link` runs it over the network; `between` runs after the PC answers
/// the pull, before the phone pushes.
fn sync_with(sides: &mut Sides, between: impl FnOnce(&mut Sides)) -> PushResponse {
    let request = pull_request(&sides.phone);
    let pulled = pull(&sides.pc, &own(), &[phone_device()], &request).unwrap();
    // The answer crosses the network as JSON.
    let pulled: PullResponse =
        serde_json::from_str(&serde_json::to_string(&pulled).unwrap()).unwrap();
    let plan = plan(&sides.phone, PHONE_DEVICE, &pulled).unwrap();
    between(sides);
    let push_request: PushRequest =
        serde_json::from_str(&serde_json::to_string(&plan.push).unwrap()).unwrap();
    let answer = push(&mut sides.pc, PC_DEVICE, &phone_device(), &push_request).unwrap();
    sides.moved = finish(&mut sides.phone, &plan, &answer).unwrap();
    answer
}

fn sync(sides: &mut Sides) -> PushResponse {
    sync_with(sides, |_| {})
}

fn place(spine_index: i64, progress: f64, current: i64) -> Reading {
    Reading {
        position: Some(ReadingPosition {
            spine_index,
            section_key: None,
            progress,
        }),
        progress: Some(BookProgress {
            unit: "characters".into(),
            current,
            total: 1000,
        }),
    }
}

fn read_to(connection: &Connection, book: &str, reading: &Reading) {
    write_reading(connection, book, reading, None).unwrap();
}

fn reading(connection: &Connection, book: &str) -> Reading {
    reading_of(connection, book).unwrap().0
}

fn locator(spine_index: i64) -> BookmarkLocator {
    BookmarkLocator {
        spine_index,
        section_key: "0123abcd".into(),
        progress: 0.25,
        content_key: "a".repeat(64),
    }
}

fn add_bookmark(connection: &Connection, book: &str, id: &str, spine: i64, label: &str) {
    connection
        .execute(
            "INSERT INTO bookmarks (id, book_id, locator, label, excerpt) VALUES (?1, ?2, ?3, ?4, 'Excerpt')",
            params![id, book, locator(spine).canonical().unwrap(), label],
        )
        .unwrap();
}

fn bookmarks(connection: &Connection, book: &str) -> Vec<(String, String)> {
    bookmarks_of(connection, book, book)
        .unwrap()
        .into_iter()
        .map(|bookmark| (bookmark.id, bookmark.label))
        .collect()
}

fn add_note(connection: &Connection, book: &str, id: &str, body: &str) {
    connection
        .execute(
            "INSERT INTO reader_notes (id, book_id, locator, passage, body) VALUES (?1, ?2, ?3, 'A passage', ?4)",
            params![id, book, locator(3).canonical().unwrap(), body],
        )
        .unwrap();
}

fn note_bodies(connection: &Connection, book: &str) -> Vec<(String, String)> {
    let mut notes: Vec<(String, String)> = notes_of(connection, book, book)
        .unwrap()
        .into_iter()
        .map(|note| (note.id, note.body))
        .collect();
    notes.sort();
    notes
}

fn session(id: &str, started_at: i64) -> ReadingSession {
    ReadingSession {
        id: id.into(),
        started_at,
        ended_at: started_at + 60_000,
        active_ms: 50_000,
        unit: "characters".into(),
        units_read: 300,
        start_units: 0,
        end_units: 300,
        total_units: 1000,
    }
}

fn sessions(connection: &Connection) -> Vec<(String, String, Option<String>)> {
    reading_sessions::list_from(connection)
        .unwrap()
        .into_iter()
        .map(|stored| (stored.session.id, stored.book_id, stored.device))
        .collect()
}

const ID_A: &str = "a0000000-0000-4000-8000-000000000001";
const ID_B: &str = "a0000000-0000-4000-8000-000000000002";
const ID_C: &str = "a0000000-0000-4000-8000-000000000003";
const ID_D: &str = "a0000000-0000-4000-8000-000000000004";
const T: i64 = 1_760_000_000_000;

#[test]
fn a_first_sync_combines_both_sides_with_who_read_each_session() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(4, 0.5, 400));
    read_to(&sides.phone, OLD_COPY, &place(1, 0.1, 100));
    add_bookmark(&sides.pc, BOOK, ID_A, 1, "PC mark");
    add_bookmark(&sides.phone, BOOK, ID_B, 2, "Phone mark");
    add_note(&sides.phone, OLD_COPY, ID_C, "Phone note");
    assert!(reading_sessions::save_to(&sides.pc, BOOK, &session(ID_A, T)).unwrap());
    assert!(reading_sessions::save_to(&sides.phone, OLD_COPY, &session(ID_B, T + 1)).unwrap());
    assert!(reading_sessions::save_to(&sides.phone, PHONE_ONLY, &session(ID_C, T + 2)).unwrap());

    assert_eq!(sync(&mut sides), PushResponse::default());

    // Each side's place went where there was none.
    assert_eq!(reading(&sides.phone, BOOK), place(4, 0.5, 400));
    assert_eq!(reading(&sides.pc, OLD_PC), place(1, 0.1, 100));
    // The PC's place keeps its time on the phone.
    assert_eq!(
        reading_of(&sides.phone, BOOK).unwrap().1,
        reading_of(&sides.pc, BOOK).unwrap().1
    );
    let both = vec![
        (ID_A.to_owned(), "PC mark".to_owned()),
        (ID_B.to_owned(), "Phone mark".to_owned()),
    ];
    let mut pc_marks = bookmarks(&sides.pc, BOOK);
    pc_marks.sort();
    let mut phone_marks = bookmarks(&sides.phone, BOOK);
    phone_marks.sort();
    assert_eq!((pc_marks, phone_marks), (both.clone(), both));
    // A copy from before syncing matches its PC book.
    assert_eq!(
        note_bodies(&sides.pc, OLD_PC),
        [(ID_C.into(), "Phone note".into())]
    );

    // Every session is on both sides, each with the device that read it, and its book as that
    // side knows it; the phone's own book's sessions go too.
    assert_eq!(
        sessions(&sides.pc),
        [
            (ID_A.into(), BOOK.into(), None),
            (ID_B.into(), OLD_PC.into(), Some(PHONE_DEVICE.into())),
            (ID_C.into(), PHONE_ONLY.into(), Some(PHONE_DEVICE.into())),
        ]
    );
    assert_eq!(
        sessions(&sides.phone),
        [
            (ID_A.into(), BOOK.into(), Some(PC_DEVICE.into())),
            (ID_B.into(), OLD_COPY.into(), None),
            (ID_C.into(), PHONE_ONLY.into(), None),
        ]
    );
    assert_eq!(
        reading_sessions::devices_from(&sides.phone).unwrap(),
        [own()]
    );
    assert_eq!(
        reading_sessions::devices_from(&sides.pc).unwrap(),
        [phone_device()]
    );
    // Another device's sessions are not those of removed books.
    let counts = serde_json::to_value(reading_sessions::counts_from(&sides.pc).unwrap()).unwrap();
    assert_eq!(counts["orphanSessions"], 0);

    // A second sync finds nothing to do.
    let pulled = pull(&sides.pc, &own(), &[], &pull_request(&sides.phone)).unwrap();
    let plan = plan(&sides.phone, PHONE_DEVICE, &pulled).unwrap();
    assert!(!plan.pushes() && !plan.changes_phone(), "{plan:?}");
}

#[test]
fn a_place_changed_on_one_side_goes_to_the_other() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(1, 0.1, 100));
    sync(&mut sides);
    read_to(&sides.phone, BOOK, &place(2, 0.2, 200));
    sync(&mut sides);
    assert_eq!(reading(&sides.pc, BOOK), place(2, 0.2, 200));
    read_to(&sides.pc, BOOK, &place(3, 0.3, 300));
    sync(&mut sides);
    assert_eq!(reading(&sides.phone, BOOK), place(3, 0.3, 300));
    // An open Reader follows the PC there.
    assert_eq!(sides.moved, [BOOK]);
    sync(&mut sides);
    assert!(sides.moved.is_empty());
    // Marked unread on the PC: unread on the phone too.
    read_to(&sides.pc, BOOK, &Reading::default());
    sync(&mut sides);
    assert_eq!(reading(&sides.phone, BOOK), Reading::default());
    assert_eq!(conflict_of(&sides.phone, BOOK).unwrap(), None);
}

#[test]
fn opening_a_book_at_its_place_is_not_reading_it() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(1, 0.1, 100));
    sync(&mut sides);
    // The phone lays the place out again, a little off within the section; the PC reads on.
    read_to(&sides.phone, BOOK, &place(1, 0.10003, 100));
    read_to(&sides.pc, BOOK, &place(4, 0.4, 400));
    sync(&mut sides);
    assert_eq!(conflict_of(&sides.phone, BOOK).unwrap(), None);
    assert_eq!(reading(&sides.phone, BOOK), place(4, 0.4, 400));
    // And the other way.
    read_to(&sides.pc, BOOK, &place(4, 0.40002, 400));
    read_to(&sides.phone, BOOK, &place(5, 0.5, 500));
    sync(&mut sides);
    assert_eq!(conflict_of(&sides.phone, BOOK).unwrap(), None);
    assert_eq!(reading(&sides.pc, BOOK), place(5, 0.5, 500));
    // Another character is another place.
    read_to(&sides.phone, BOOK, &place(5, 0.5, 501));
    read_to(&sides.pc, BOOK, &place(6, 0.6, 600));
    sync(&mut sides);
    assert!(conflict_of(&sides.phone, BOOK).unwrap().is_some());
}

#[test]
fn a_place_changed_on_both_sides_waits_for_the_reader_to_choose() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(1, 0.1, 100));
    sync(&mut sides);
    read_to(&sides.pc, BOOK, &place(6, 0.41, 410));
    read_to(&sides.phone, BOOK, &place(5, 0.35, 350));
    sync(&mut sides);
    // Neither side moved.
    assert_eq!(reading(&sides.pc, BOOK), place(6, 0.41, 410));
    assert_eq!(reading(&sides.phone, BOOK), place(5, 0.35, 350));
    let conflict = serde_json::to_value(conflict_of(&sides.phone, BOOK).unwrap().unwrap()).unwrap();
    assert_eq!(conflict["pc"]["position"]["spineIndex"], 6);
    assert_eq!(conflict["phone"]["position"]["spineIndex"], 5);
    assert!(conflict["pcAt"].is_string() && conflict["phoneAt"].is_string());

    // This phone: its place goes to the PC.
    assert!(resolve(&mut sides.phone, BOOK, false).unwrap());
    assert_eq!(conflict_of(&sides.phone, BOOK).unwrap(), None);
    sync(&mut sides);
    assert_eq!(reading(&sides.pc, BOOK), place(5, 0.35, 350));

    // The PC: its place comes here.
    read_to(&sides.pc, BOOK, &place(8, 0.8, 800));
    read_to(&sides.phone, BOOK, &place(7, 0.7, 700));
    sync(&mut sides);
    assert!(conflict_of(&sides.phone, BOOK).unwrap().is_some());
    assert!(resolve(&mut sides.phone, BOOK, true).unwrap());
    assert_eq!(reading(&sides.phone, BOOK), place(8, 0.8, 800));
    sync(&mut sides);
    assert_eq!(reading(&sides.pc, BOOK), place(8, 0.8, 800));
    assert_eq!(conflict_of(&sides.phone, BOOK).unwrap(), None);
    // Nothing is left to settle.
    assert!(!resolve(&mut sides.phone, BOOK, true).unwrap());
}

#[test]
fn the_pc_refuses_a_place_that_moved_there_after_the_pull() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(1, 0.1, 100));
    sync(&mut sides);
    read_to(&sides.phone, BOOK, &place(2, 0.2, 200));
    let answer = sync_with(&mut sides, |sides| {
        read_to(&sides.pc, BOOK, &place(9, 0.9, 900));
    });
    assert_eq!(answer.refused, [BOOK]);
    assert_eq!(reading(&sides.pc, BOOK), place(9, 0.9, 900));
    // Both changed since they last agreed: the Reader asks.
    sync(&mut sides);
    assert!(conflict_of(&sides.phone, BOOK).unwrap().is_some());
}

#[test]
fn the_reader_moving_during_a_sync_keeps_its_place() {
    let mut sides = sides();
    read_to(&sides.pc, BOOK, &place(1, 0.1, 100));
    sync(&mut sides);
    read_to(&sides.pc, BOOK, &place(3, 0.3, 300));
    sync_with(&mut sides, |sides| {
        read_to(&sides.phone, BOOK, &place(2, 0.2, 200));
    });
    assert_eq!(reading(&sides.phone, BOOK), place(2, 0.2, 200));
    assert!(sides.moved.is_empty());
    // The next sync sees it changed since the PC's place was agreed, and sends it.
    sync(&mut sides);
    assert_eq!(reading(&sides.pc, BOOK), place(2, 0.2, 200));
}

#[test]
fn deletions_reach_the_other_side_but_a_change_outlives_one() {
    let mut sides = sides();
    add_bookmark(&sides.pc, BOOK, ID_A, 1, "One");
    add_bookmark(&sides.pc, BOOK, ID_B, 2, "Two");
    add_note(&sides.phone, BOOK, ID_C, "Note");
    add_note(&sides.phone, BOOK, ID_D, "Kept");
    reading_sessions::save_to(&sides.pc, BOOK, &session(ID_A, T)).unwrap();
    reading_sessions::save_to(&sides.phone, BOOK, &session(ID_B, T + 1)).unwrap();
    sync(&mut sides);

    sides
        .pc
        .execute("DELETE FROM bookmarks WHERE id = ?1", [ID_A])
        .unwrap();
    sides
        .phone
        .execute("DELETE FROM reader_notes WHERE id = ?1", [ID_C])
        .unwrap();
    // Deleted on the phone while renamed on the PC: the new name stays.
    sides
        .phone
        .execute("DELETE FROM bookmarks WHERE id = ?1", [ID_B])
        .unwrap();
    sides
        .pc
        .execute(
            "UPDATE bookmarks SET label = 'Renamed' WHERE id = ?1",
            [ID_B],
        )
        .unwrap();
    // Statistics deleted on the phone go from the PC too.
    reading_sessions::delete_from(&sides.phone, false).unwrap();
    sync(&mut sides);

    assert_eq!(
        bookmarks(&sides.phone, BOOK),
        [(ID_B.into(), "Renamed".into())]
    );
    assert_eq!(
        bookmarks(&sides.pc, BOOK),
        [(ID_B.into(), "Renamed".into())]
    );
    assert_eq!(note_bodies(&sides.pc, BOOK), [(ID_D.into(), "Kept".into())]);
    assert_eq!(sessions(&sides.pc), []);
    assert_eq!(sessions(&sides.phone), []);
}

#[test]
fn a_note_edited_on_both_sides_is_kept_twice() {
    let mut sides = sides();
    add_note(&sides.pc, BOOK, ID_A, "First");
    sync(&mut sides);
    sides
        .pc
        .execute(
            "UPDATE reader_notes SET body = 'PC edit' WHERE id = ?1",
            [ID_A],
        )
        .unwrap();
    sides
        .phone
        .execute(
            "UPDATE reader_notes SET body = 'Phone edit' WHERE id = ?1",
            [ID_A],
        )
        .unwrap();
    sync(&mut sides);
    let pc = note_bodies(&sides.pc, BOOK);
    assert_eq!(pc, note_bodies(&sides.phone, BOOK));
    assert_eq!(pc.len(), 2);
    assert!(pc.contains(&(ID_A.into(), "PC edit".into())));
    assert!(pc
        .iter()
        .any(|(id, body)| id != ID_A && body == "Phone edit"));
    // Settled: the next sync changes nothing.
    let pulled = pull(&sides.pc, &own(), &[], &pull_request(&sides.phone)).unwrap();
    let plan = plan(&sides.phone, PHONE_DEVICE, &pulled).unwrap();
    assert!(!plan.pushes() && !plan.changes_phone(), "{plan:?}");
}

#[test]
fn one_place_bookmarked_on_both_sides_becomes_the_pcs_bookmark() {
    let mut sides = sides();
    add_bookmark(&sides.pc, BOOK, ID_A, 4, "PC name");
    add_bookmark(&sides.phone, BOOK, ID_B, 4, "Phone name");
    add_bookmark(&sides.pc, BOOK, ID_C, 5, "Shared");
    sync(&mut sides);
    let expected = vec![
        (ID_A.to_owned(), "PC name".to_owned()),
        (ID_C.to_owned(), "Shared".to_owned()),
    ];
    assert_eq!(bookmarks(&sides.pc, BOOK), expected);
    assert_eq!(bookmarks(&sides.phone, BOOK), expected);

    // Renamed on both sides: the PC's name.
    sides
        .pc
        .execute(
            "UPDATE bookmarks SET label = 'From PC' WHERE id = ?1",
            [ID_C],
        )
        .unwrap();
    sides
        .phone
        .execute(
            "UPDATE bookmarks SET label = 'From phone' WHERE id = ?1",
            [ID_C],
        )
        .unwrap();
    sync(&mut sides);
    assert_eq!(
        bookmarks(&sides.phone, BOOK)[1],
        (ID_C.into(), "From PC".into())
    );
}

#[test]
fn a_book_gone_from_one_side_deletes_nothing_on_the_other() {
    let mut sides = sides();
    add_bookmark(&sides.pc, OLD_PC, ID_A, 1, "Mark");
    add_note(&sides.pc, OLD_PC, ID_B, "Note");
    read_to(&sides.pc, OLD_PC, &place(2, 0.2, 200));
    sync(&mut sides);
    assert_eq!(bookmarks(&sides.phone, OLD_COPY).len(), 1);
    // The copy's record goes from the phone, and its bookmarks and notes with it.
    sides
        .phone
        .execute("DELETE FROM books WHERE id = ?1", [OLD_COPY])
        .unwrap();
    sync(&mut sides);
    assert_eq!(bookmarks(&sides.pc, OLD_PC).len(), 1);
    assert_eq!(note_bodies(&sides.pc, OLD_PC).len(), 1);
    assert_eq!(reading(&sides.pc, OLD_PC), place(2, 0.2, 200));
}

#[test]
fn a_session_changed_on_both_sides_keeps_the_version_of_the_device_that_read_it() {
    let mut sides = sides();
    reading_sessions::save_to(&sides.phone, BOOK, &session(ID_A, T)).unwrap();
    reading_sessions::save_to(&sides.pc, BOOK, &session(ID_B, T + 5)).unwrap();
    sync(&mut sides);
    let longer = |id| ReadingSession {
        ended_at: T + 120_000,
        units_read: 600,
        end_units: 600,
        ..session(id, T)
    };
    // The phone read on; the PC corrected the same session's time.
    reading_sessions::save_to(&sides.phone, BOOK, &longer(ID_A)).unwrap();
    sides
        .pc
        .execute(
            "UPDATE reading_sessions SET active_adjustment = 1000 WHERE id = ?1",
            [ID_A],
        )
        .unwrap();
    // The PC read on; the phone marked the book unread.
    reading_sessions::save_to(
        &sides.pc,
        BOOK,
        &ReadingSession {
            ended_at: T + 300_000,
            ..session(ID_B, T + 5)
        },
    )
    .unwrap();
    reading_sessions::mark_unread(&mut sides.phone, BOOK).unwrap();
    sync(&mut sides);
    let on = |connection: &Connection, id: &str| {
        reading_sessions::list_from(connection)
            .unwrap()
            .into_iter()
            .find(|stored| stored.session.id == id)
            .unwrap()
    };
    assert_eq!(on(&sides.pc, ID_A).session.units_read, 600);
    assert_eq!(on(&sides.phone, ID_A).session.units_read, 600);
    assert_eq!(on(&sides.phone, ID_B).session.ended_at, T + 300_000);
    assert_eq!(on(&sides.pc, ID_B).session.ended_at, T + 300_000);
}

#[test]
fn malformed_items_from_the_phone_are_left_out() {
    let mut sides = sides();
    let mut request = PushRequest::default();
    request.sessions.push(SyncSession {
        book_id: "not-a-uuid".into(),
        book_title: None,
        finish_cleared: false,
        adjustment: SessionAdjustment::default(),
        device: None,
        session: session(ID_A, T),
    });
    request.bookmarks.push(SyncBookmark {
        id: ID_B.into(),
        book_id: BOOK.into(),
        locator: BookmarkLocator {
            content_key: "short".into(),
            ..locator(1)
        },
        label: "Bad".into(),
        excerpt: "x".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
    });
    request.positions.push(PositionChange {
        book: PHONE_ONLY.into(),
        expected: Reading::default(),
        next: place(1, 0.1, 100),
        updated_at: None,
    });
    let answer = push(&mut sides.pc, PC_DEVICE, &phone_device(), &request).unwrap();
    assert_eq!(answer.refused, [PHONE_ONLY]);
    assert_eq!(sessions(&sides.pc), []);
    assert_eq!(bookmarks(&sides.pc, BOOK), []);
}

#[test]
fn a_place_with_a_long_fraction_crosses_the_link_unchanged() {
    let mut sides = sides();
    // A progress whose shortest decimal form a lax JSON reader takes for the next number.
    let pc_place = place(1, 0.985_690_694_632_869_5, 100);
    read_to(&sides.pc, BOOK, &pc_place);
    sync(&mut sides);
    assert_eq!(reading(&sides.phone, BOOK), pc_place);
    let further = place(2, 0.123_456_789_012_345_68, 200);
    read_to(&sides.phone, BOOK, &further);
    let answer = sync(&mut sides);
    assert_eq!(answer.refused, [] as [&str; 0]);
    assert_eq!(reading(&sides.pc, BOOK), further);
}

#[test]
fn a_bookmark_a_full_book_cannot_take_stays_where_it_is() {
    let mut sides = sides();
    for number in 0..MAX_BOOKMARKS {
        let id = format!("b0000000-0000-4000-8000-{number:012}");
        add_bookmark(&sides.pc, BOOK, &id, 10 + number, "PC");
    }
    add_bookmark(&sides.phone, BOOK, ID_A, 5, "Phone");
    // The PC's book is full, and the phone's has room for all but one of the PC's.
    let answer = sync(&mut sides);
    assert_eq!(answer.refused_items, [ID_A]);
    let full = MAX_BOOKMARKS as usize;
    for _ in 0..2 {
        let phone = bookmarks(&sides.phone, BOOK);
        assert_eq!(phone.len(), full);
        assert!(phone.contains(&(ID_A.into(), "Phone".into())));
        let pc = bookmarks(&sides.pc, BOOK);
        assert_eq!(pc.len(), full);
        assert!(pc.iter().all(|(_, label)| label == "PC"));
        // Neither side takes the other's lack of one for a deletion.
        sync(&mut sides);
    }
}

#[test]
fn a_sync_cut_off_after_the_push_does_not_copy_a_note_again() {
    let mut sides = sides();
    add_note(&sides.pc, BOOK, ID_A, "First");
    sync(&mut sides);
    for (side, body) in [(&sides.pc, "PC edit"), (&sides.phone, "Phone edit")] {
        side.execute(
            "UPDATE reader_notes SET body = ?2 WHERE id = ?1",
            params![ID_A, body],
        )
        .unwrap();
    }
    // The PC stores what the phone pushed, and the phone stops before writing its side.
    for _ in 0..2 {
        let pulled = pull(&sides.pc, &own(), &[], &pull_request(&sides.phone)).unwrap();
        let plan = plan(&sides.phone, PHONE_DEVICE, &pulled).unwrap();
        push(&mut sides.pc, PC_DEVICE, &phone_device(), &plan.push).unwrap();
    }
    sync(&mut sides);
    let pc = note_bodies(&sides.pc, BOOK);
    assert_eq!(pc, note_bodies(&sides.phone, BOOK));
    assert_eq!(pc.len(), 2, "{pc:?}");
    assert!(pc.contains(&(ID_A.into(), "PC edit".into())));
    assert!(pc
        .iter()
        .any(|(id, body)| id != ID_A && body == "Phone edit"));
}

#[test]
fn a_note_edited_on_the_phone_during_a_sync_keeps_its_text() {
    let mut sides = sides();
    add_note(&sides.pc, BOOK, ID_A, "First");
    add_note(&sides.pc, BOOK, ID_B, "Second");
    sync(&mut sides);
    let edit = |side: &Connection, id: &str, body: &str| {
        side.execute(
            "UPDATE reader_notes SET body = ?2 WHERE id = ?1",
            params![id, body],
        )
        .unwrap();
    };
    edit(&sides.pc, ID_A, "PC edit");
    sides
        .pc
        .execute("DELETE FROM reader_notes WHERE id = ?1", [ID_B])
        .unwrap();
    // The phone would take the PC's edit and its deletion, but both notes change here first.
    sync_with(&mut sides, |sides| {
        edit(&sides.phone, ID_A, "Phone edit");
        edit(&sides.phone, ID_B, "Kept");
    });
    assert_eq!(
        note_bodies(&sides.phone, BOOK),
        [
            (ID_A.into(), "Phone edit".into()),
            (ID_B.into(), "Kept".into())
        ]
    );
    // The next sync merges them as changes: one edited on both sides, one outliving a deletion.
    sync(&mut sides);
    let pc = note_bodies(&sides.pc, BOOK);
    assert_eq!(pc, note_bodies(&sides.phone, BOOK));
    assert_eq!(pc.len(), 3, "{pc:?}");
    assert!(pc.contains(&(ID_A.into(), "PC edit".into())));
    assert!(pc.contains(&(ID_B.into(), "Kept".into())));
    assert!(pc.iter().any(|(_, body)| body == "Phone edit"));
}

#[test]
fn an_item_deleted_on_both_sides_is_forgotten() {
    let mut sides = sides();
    add_note(&sides.pc, BOOK, ID_A, "First");
    assert!(reading_sessions::save_to(&sides.pc, BOOK, &session(ID_B, T)).unwrap());
    sync(&mut sides);
    for side in [&sides.pc, &sides.phone] {
        side.execute("DELETE FROM reader_notes WHERE id = ?1", [ID_A])
            .unwrap();
        side.execute("DELETE FROM reading_sessions WHERE id = ?1", [ID_B])
            .unwrap();
    }
    sync(&mut sides);
    let recorded: i64 = sides
        .phone
        .query_row("SELECT count(*) FROM sync_items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(recorded, 0);
}
