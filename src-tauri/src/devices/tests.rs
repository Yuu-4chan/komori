use std::path::PathBuf;

use tempfile::{tempdir, TempDir};

use super::client::{Client, LinkError, Pairing};
use super::{protocol, test_server, Shared};
use crate::dictionary::store::{import_archive_for_tests, import_pack, open_store, PackImport};
use crate::library::{import_paths, open_catalog, tests::fixture};

struct Pc {
    _directory: TempDir,
    directory: PathBuf,
    shared: std::sync::Arc<Shared>,
    port: u16,
}

fn pc() -> Pc {
    let directory = tempdir().unwrap();
    let path = directory.path().to_owned();
    let catalog = path.join("library.sqlite3");
    let dictionaries = path.join("dictionaries.sqlite3");
    let book = path.join("Alice.epub");
    fixture(&book, Some("Alice"), Some("Carroll"), true);
    let missing = path.join("Gone.epub");
    fixture(&missing, Some("Gone"), None, false);
    let mut connection = open_catalog(&catalog).unwrap();
    import_paths(&mut connection, &[book, missing.clone()]);
    std::fs::remove_file(&missing).unwrap();
    let archive = path.join("fixture.zip");
    crate::dictionary::archive::tests::write_archive(
        &archive,
        &crate::dictionary::archive::tests::fixture_entries(),
    );
    assert!(import_archive_for_tests(
        &mut open_store(&dictionaries).unwrap(),
        &archive
    ));
    let (shared, port) = test_server(&catalog, &dictionaries);
    Pc {
        _directory: directory,
        directory: path,
        shared,
        port,
    }
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn pair(pc: &Pc, code: &str) -> Result<Pairing, LinkError> {
    run(Client::new("127.0.0.1", pc.port, None, None)
        .unwrap()
        .pair(code, "Test phone"))
}

fn paired(pc: &Pc, pairing: &Pairing) -> Client {
    Client::new(
        "127.0.0.1",
        pc.port,
        Some(pairing.fingerprint),
        Some(&pairing.token),
    )
    .unwrap()
}

#[test]
fn a_phone_pairs_with_the_code_and_then_reads_the_library_without_paths() {
    let pc = pc();
    let unpaired = Client::new("127.0.0.1", pc.port, None, None).unwrap();
    assert_eq!(run(unpaired.library()).unwrap_err(), LinkError::NotPaired);
    // Before pairing, the PC tells only the protocol it speaks: no name, no version.
    let hello = run(unpaired.hello()).unwrap();
    assert_eq!((hello.protocol, hello.name), (protocol::PROTOCOL, None));

    let code = pc.shared.code();
    let pairing = pair(&pc, &code).unwrap();
    assert_eq!(pc.shared.device_names(), ["Test phone"]);
    assert_eq!(pairing.pc_name, super::pc_name());
    // A code pairs one phone.
    assert_ne!(pc.shared.code(), code);

    let client = paired(&pc, &pairing);
    let library = run(client.library()).unwrap();
    // Only the book whose file is still on the PC, by ID, with its size and cover.
    assert_eq!(library.books.len(), 1);
    let book = &library.books[0];
    assert_eq!(book.title.as_deref(), Some("Alice"));
    assert_eq!(book.file_name, "Alice.epub");
    assert!(book.cover.is_some());
    let listing = serde_json::to_string(&library).unwrap();
    let directory = pc.directory.to_string_lossy().replace('\\', "\\\\");
    assert!(!listing.contains(&*directory), "{listing}");
    assert!(!listing.contains("Gone"));

    // The Library's kanji, for the phone's Statistics.
    open_catalog(&pc.shared.catalog)
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO book_details (book_id, details_version, language, kanji)
             VALUES (?1, 1, 'ja', '日本')",
            [&book.id],
        )
        .unwrap();
    let kanji = serde_json::to_value(run(client.library_kanji()).unwrap()).unwrap();
    assert_eq!(kanji[0]["language"], "ja");
    assert_eq!(kanji[0]["books"], 1);
    assert_eq!(kanji[0]["kanji"].as_array().unwrap().len(), 2);
    assert_eq!(
        run(unpaired.library_kanji()).unwrap_err(),
        LinkError::NotPaired
    );

    let (kind, cover) = run(client.cover(&book.id)).unwrap();
    assert!(kind.starts_with("image/"));
    assert!(!cover.is_empty());

    // The book's file arrives whole.
    let target = pc.directory.join("phone").join("Alice.epub");
    let mut last = (0, 0);
    run(client.download(
        &format!("/v1/books/{}/file", book.id),
        &target,
        |received, total| last = (received, total),
    ))
    .unwrap();
    assert_eq!(
        std::fs::read(&target).unwrap(),
        std::fs::read(pc.directory.join("Alice.epub")).unwrap()
    );
    assert_eq!(last, (book.size, book.size));
    assert!(!target.with_extension("part").exists());
    assert_eq!(
        run(client.download(
            "/v1/books/00000000-0000-0000-0000-000000000000/file",
            &target,
            |_, _| {}
        ))
        .unwrap_err(),
        LinkError::NotFound
    );
    assert_eq!(
        run(client.download("/v1/books/..%2Flibrary.sqlite3/file", &target, |_, _| {}))
            .unwrap_err(),
        LinkError::NotFound
    );
}

#[test]
fn five_wrong_codes_stop_pairing_until_a_new_code() {
    let pc = pc();
    let code = pc.shared.code();
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for attempt in 1..=protocol::PAIRING_ATTEMPTS {
        let start = std::time::Instant::now();
        assert_eq!(pair(&pc, wrong).unwrap_err(), LinkError::WrongCode);
        // Each wrong code waits for its answer.
        assert!(start.elapsed() >= super::WRONG_CODE_WAIT);
        let view = super::view(&pc.shared).unwrap();
        let locked = attempt == protocol::PAIRING_ATTEMPTS;
        assert_eq!(view.pairing_locked, locked);
        assert_eq!(view.code.is_none(), locked);
    }
    // Stopped: even the right code no longer pairs, so the code cannot be guessed.
    assert_eq!(pair(&pc, &code).unwrap_err(), LinkError::PairingLocked);
    assert_eq!(pc.shared.code(), code);
    assert!(pc.shared.device_names().is_empty());
    // New code starts pairing again, with a code the wrong ones knew nothing of.
    super::new_code(&pc.shared);
    assert!(!super::view(&pc.shared).unwrap().pairing_locked);
    assert!(pair(&pc, &pc.shared.code()).is_ok());
    assert!(pc.shared.device_names().len() == 1);
}

#[test]
fn a_paired_phone_refuses_another_certificate_and_a_removed_phone_is_refused() {
    let pc = pc();
    let pairing = pair(&pc, &pc.shared.code()).unwrap();
    let mut other = pairing.fingerprint;
    other[0] ^= 1;
    let impostor = Client::new("127.0.0.1", pc.port, Some(other), Some(&pairing.token)).unwrap();
    assert_eq!(run(impostor.library()).unwrap_err(), LinkError::NotThePc);

    let client = paired(&pc, &pairing);
    assert!(run(client.library()).is_ok());
    pc.shared.remove_all_devices();
    assert_eq!(run(client.library()).unwrap_err(), LinkError::NotPaired);

    // A phone that unpairs itself is forgotten too.
    let again = pair(&pc, &pc.shared.code()).unwrap();
    let client = paired(&pc, &again);
    run(client.forget()).unwrap();
    assert!(pc.shared.device_names().is_empty());
    assert_eq!(run(client.library()).unwrap_err(), LinkError::NotPaired);
}

#[test]
fn a_dictionary_arrives_as_a_pack_the_phone_imports() {
    let pc = pc();
    let pairing = pair(&pc, &pc.shared.code()).unwrap();
    let client = paired(&pc, &pairing);
    let dictionaries = run(client.dictionaries()).unwrap();
    assert_eq!(dictionaries.len(), 1);
    assert_eq!(dictionaries[0].title, "Fixture");
    let pack = pc.directory.join("phone").join("pack.sqlite3");
    run(client.download(
        &format!("/v1/dictionaries/{}/pack", dictionaries[0].id),
        &pack,
        |_, _| {},
    ))
    .unwrap();
    let mut phone = open_store(&pc.directory.join("phone.sqlite3")).unwrap();
    assert!(matches!(
        import_pack(&mut phone, &pack).unwrap(),
        PackImport::Imported(_)
    ));
    assert_eq!(
        run(client.download("/v1/dictionaries/99/pack", &pack, |_, _| {})).unwrap_err(),
        LinkError::NotFound
    );
    // No pack is left behind on the PC.
    let left = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("komori-pack-")
        })
        .count();
    assert_eq!(left, 0);
}

#[test]
fn a_paired_phone_syncs_its_reading_and_the_pc_notes_when() {
    let pc = pc();
    let pairing = pair(&pc, &pc.shared.code()).unwrap();
    let client = paired(&pc, &pairing);
    let hello = run(client.hello()).unwrap();
    assert_eq!((hello.protocol, hello.name), (2, Some(super::pc_name())));
    let book = run(client.library()).unwrap().books.remove(0);

    // The phone has a copy of the PC's book under the PC's ID, and read some of it.
    let phone = open_catalog(&pc.directory.join("phone.sqlite3")).unwrap();
    phone
        .execute(
            "INSERT INTO books (id, source_path, file_name) VALUES (?1, 'copy.epub', 'Alice.epub')",
            [&book.id],
        )
        .unwrap();
    phone
        .execute_batch(&format!(
            "CREATE TABLE pc_books (book_id TEXT PRIMARY KEY, pc_book TEXT NOT NULL UNIQUE,
               kept INTEGER NOT NULL DEFAULT 0);
             INSERT INTO pc_books (book_id, pc_book) VALUES ('{0}', '{0}');",
            book.id
        ))
        .unwrap();
    let position = crate::reading_position::position(3, None, 0.5);
    assert!(crate::reading_position::save_to(&phone, &book.id, &position).unwrap());
    // Enough sessions to need more than a pairing's body.
    for index in 0..400 {
        let session = crate::reading_sessions::ReadingSession {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: 1_760_000_000_000 + index * 100_000,
            ended_at: 1_760_000_000_000 + index * 100_000 + 60_000,
            active_ms: 30_000,
            unit: "characters".into(),
            units_read: 10,
            start_units: 0,
            end_units: 10,
            total_units: 100,
        };
        assert!(crate::reading_sessions::save_to(&phone, &book.id, &session).unwrap());
    }

    let pulled = run(client.sync_pull(&crate::sync::pull_request(&phone))).unwrap();
    assert_eq!(pulled.books.len(), 1);
    assert!(pulled
        .devices
        .iter()
        .any(|device| device.name == "Test phone"));
    let plan = crate::sync::plan(&phone, &pairing.device, &pulled).unwrap();
    assert!(serde_json::to_vec(&plan.push).unwrap().len() > super::http::BODY_LIMIT);
    let answer = run(client.sync_push(&plan.push)).unwrap();
    assert!(answer.refused.is_empty());

    let catalog = open_catalog(&pc.directory.join("library.sqlite3")).unwrap();
    assert_eq!(
        crate::reading_position::load_from(&catalog, &book.id).unwrap(),
        Some(position)
    );
    let sessions = crate::reading_sessions::list_from(&catalog).unwrap();
    assert_eq!(sessions.len(), 400);
    assert!(sessions
        .iter()
        .all(|stored| stored.device.as_deref() == Some(pairing.device.as_str())));
    assert!(pc.shared.last_synced()[0].is_some());

    // Only a paired phone may sync, and only it may send that much.
    let unpaired = Client::new("127.0.0.1", pc.port, Some(pairing.fingerprint), None).unwrap();
    assert_eq!(
        run(unpaired.sync_pull(&Default::default())).unwrap_err(),
        LinkError::NotPaired
    );
    assert!(matches!(
        run(unpaired.sync_push(&plan.push)).unwrap_err(),
        LinkError::Failed(_) | LinkError::Unreachable
    ));
}

#[test]
fn the_pc_answers_each_new_connection_at_once_and_stops_listening_when_turned_off() {
    let pc = pc();
    let client = Client::new("127.0.0.1", pc.port, None, None).unwrap();
    // Each request is a new connection; none waits for the server to look for it.
    let mut times: Vec<_> = (0..7)
        .map(|_| {
            let start = std::time::Instant::now();
            run(client.hello()).unwrap();
            start.elapsed()
        })
        .collect();
    times.sort();
    assert!(
        times[3] < std::time::Duration::from_millis(50),
        "median {:?}",
        times[3]
    );

    // Turning devices off frees the port at once, for this or another program.
    let settings = pc
        .shared
        .update(|settings| settings.allowed = false)
        .unwrap();
    let start = std::time::Instant::now();
    super::apply(&pc.shared, &settings);
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    std::net::TcpListener::bind(("127.0.0.1", pc.port)).unwrap();
}

/// Whether the server closed the connection, waiting at most `wait` to see.
fn closed_within(stream: &mut std::net::TcpStream, wait: std::time::Duration) -> bool {
    use std::io::Read;
    stream.set_read_timeout(Some(wait)).unwrap();
    match stream.read(&mut [0u8; 1]) {
        Ok(read) => read == 0,
        Err(error) => !matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ),
    }
}

#[test]
fn a_connection_that_sends_slowly_or_not_at_all_loses_its_place_at_the_deadline() {
    use std::io::Write;
    use std::net::TcpStream;
    use std::time::{Duration, Instant};
    let pc = pc();
    let client = Client::new("127.0.0.1", pc.port, None, None).unwrap();

    // Connections that send nothing take this address's share; another from it is closed.
    let mut silent: Vec<_> = (0..super::PER_ADDRESS)
        .map(|_| TcpStream::connect(("127.0.0.1", pc.port)).unwrap())
        .collect();
    let opened = Instant::now();
    std::thread::sleep(Duration::from_millis(200));
    assert!(run(client.hello()).is_err());
    // They keep their places until the deadline, and lose them there.
    let early = super::REQUEST_WAIT - Duration::from_millis(500);
    assert!(!closed_within(
        &mut silent[0],
        early
            .saturating_sub(opened.elapsed())
            .max(Duration::from_millis(1))
    ));
    for stream in &mut silent {
        assert!(closed_within(stream, Duration::from_secs(2)));
    }
    assert!(opened.elapsed() < super::REQUEST_WAIT + Duration::from_secs(2));
    run(client.hello()).unwrap();

    // A TLS record trickled a byte at a time, each well within a read's wait, is cut too.
    let mut trickle = TcpStream::connect(("127.0.0.1", pc.port)).unwrap();
    let opened = Instant::now();
    trickle.write_all(&[0x16, 0x03, 0x01, 0x40, 0x00]).unwrap();
    let mut cut = false;
    while opened.elapsed() < super::REQUEST_WAIT * 2 {
        if trickle.write_all(&[0]).is_err()
            || closed_within(&mut trickle, Duration::from_millis(100))
        {
            cut = true;
            break;
        }
    }
    assert!(cut, "still open after {:?}", opened.elapsed());
    assert!(opened.elapsed() >= super::REQUEST_WAIT - Duration::from_millis(200));
    run(client.hello()).unwrap();
}

#[test]
fn one_address_takes_at_most_its_share_of_the_connections() {
    use super::{Slot, CONNECTIONS, PER_ADDRESS};
    let pc = pc();
    let address = |n: u8| std::net::IpAddr::from([192, 168, 1, n]);
    let first: Vec<_> = (0..PER_ADDRESS)
        .map(|_| Slot::take(&pc.shared, address(1)).unwrap())
        .collect();
    assert!(Slot::take(&pc.shared, address(1)).is_none());
    // Other addresses take the rest, up to the limit.
    let others: Vec<_> = (2..=u8::MAX)
        .map_while(|n| Slot::take(&pc.shared, address(n)))
        .collect();
    assert_eq!(first.len() + others.len(), CONNECTIONS);
    assert!(Slot::take(&pc.shared, address(1)).is_none());
    drop(first);
    assert!(Slot::take(&pc.shared, address(1)).is_some());
}
