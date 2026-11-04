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

    let code = pc.shared.code();
    let pairing = pair(&pc, &code).unwrap();
    assert_eq!(pc.shared.device_names(), ["Test phone"]);
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
fn a_wrong_code_fails_and_five_replace_the_code() {
    let pc = pc();
    let code = pc.shared.code();
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..protocol::PAIRING_ATTEMPTS - 1 {
        assert_eq!(pair(&pc, wrong).unwrap_err(), LinkError::WrongCode);
        assert_eq!(pc.shared.code(), code);
    }
    assert_eq!(pair(&pc, wrong).unwrap_err(), LinkError::WrongCode);
    assert_ne!(pc.shared.code(), code);
    // The old code no longer pairs; the new one does.
    assert_eq!(pair(&pc, &code).unwrap_err(), LinkError::WrongCode);
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
