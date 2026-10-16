//! Curated, native-owned starter downloads. No caller URLs, paths or remote lookup.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    archive::{BankKind, DictionaryArchive},
    store::{self, DictionaryStoreState, ImportStatus},
};

const MAX_DOWNLOAD: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
const EVENT: &str = "starter-dictionaries-changed";
const FAILURE: &str =
    "Could not download or verify this dictionary. Check your connection and try again.";

struct Source {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    attribution: &'static str,
    page: &'static str,
    url: &'static str,
    asset_repository: Option<&'static str>,
    hash: Option<&'static str>,
    title_prefix: &'static str,
    /// The bank a genuine archive of this source must contain.
    bank: BankKind,
}

// Explicit snapshots: downloads never update an existing imported revision automatically.
// New sources are appended: each saved download status is stored by its position here.
const SOURCES: [Source; 5] = [
    Source {
        id: "jitendex", name: "Jitendex", description: "Japanese–English definitions with examples and usage notes.",
        attribution: "Stephen Kraus; JMdict by EDRDG, examples by Tatoeba (CC BY 2.0 FR), furigana by JmdictFurigana.",
        page: "https://jitendex.org/pages/legal.html",
        url: "https://github.com/stephenmk/stephenmk.github.io/releases/download/2026.10.03.0/jitendex-yomitan.zip",
        asset_repository: Some("744330420"),
        hash: Some("e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356"),
        title_prefix: "Jitendex", bank: BankKind::Term,
    },
    Source {
        id: "jmdict", name: "JMdict", description: "Japanese–English definitions without examples.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); Yomitan package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/JMdict_english.zip",
        asset_repository: Some("696075636"),
        hash: Some("a2053ac64d4bf1fd17f5d7a5d1cf2df5f7ebc4415da0d63ae04a724ef6c330dd"),
        title_prefix: "JMdict", bank: BankKind::Term,
    },
    Source {
        id: "jiten", name: "Jiten frequency", description: "Global word frequency ranks from Japanese media. Add a term dictionary for definitions.",
        attribution: "Jiten — global Japanese media frequency list.",
        page: "https://jiten.moe/frequency-dictionaries",
        url: "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan",
        asset_repository: None, hash: None, title_prefix: "Jiten", bank: BankKind::TermMeta,
    },
    Source {
        id: "kanjidic", name: "KANJIDIC", description: "Kanji meanings, on and kun readings, stroke counts and grades.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); Yomitan package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/KANJIDIC_english.zip",
        asset_repository: Some("696075636"),
        hash: Some("a657edea5035cb436366b5581f3e77d4c7dbc93e214048100cf441602d50e8a2"),
        title_prefix: "KANJIDIC", bank: BankKind::Kanji,
    },
    Source {
        id: "jmnedict", name: "JMnedict", description: "Japanese proper names: people, places, companies and works.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); Yomitan package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/JMnedict.zip",
        asset_repository: Some("696075636"),
        hash: Some("09c9e4f7947beddf87924bcf36915c1f5bf8555c354246dd6b3057d3569b6f57"),
        title_prefix: "JMnedict", bank: BankKind::Term,
    },
];

fn source(id: &str) -> Result<&'static Source, String> {
    SOURCES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Unknown starter dictionary.".into())
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    #[default]
    Ready,
    Downloading,
    Verifying,
    Importing,
    Imported,
    AlreadyImported,
    Failed,
    Interrupted,
}
impl Phase {
    fn active(self) -> bool {
        matches!(self, Self::Downloading | Self::Verifying | Self::Importing)
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    phase: Phase,
    received: u64,
    total: Option<u64>,
    /// The imported dictionary's title, so the list says added only while it is installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    started: bool,
    dismissed: bool,
    /// One per source, by position; a status saved before a source was added has fewer.
    jobs: Vec<Job>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            started: false,
            dismissed: false,
            jobs: vec![Job::default(); SOURCES.len()],
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    attribution: &'static str,
    license: &'static str,
    #[serde(flatten)]
    job: Job,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    revision: u64,
    started: bool,
    dismissed: bool,
    entries: Vec<Entry>,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    journal: Journal,
}
pub(crate) struct StarterState {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

fn snapshot(inner: &Inner) -> Snapshot {
    Snapshot {
        revision: inner.revision,
        started: inner.journal.started,
        dismissed: inner.journal.dismissed,
        entries: SOURCES
            .iter()
            .zip(&inner.journal.jobs)
            .map(|(s, job)| Entry {
                id: s.id,
                name: s.name,
                description: s.description,
                attribution: s.attribution,
                license: "CC BY-SA 4.0",
                job: job.clone(),
            })
            .collect(),
    }
}

fn safe(path: &Path, directory: bool) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| "Starter dictionary storage is unavailable.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Unsafe starter dictionary storage.".into());
        }
    }
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err("Unsafe starter dictionary storage.".into());
    }
    Ok(())
}

fn clean(root: &Path) -> Result<(), String> {
    safe(root, true)?;
    for name in SOURCES
        .iter()
        .map(|s| format!("{}.part", s.id))
        .chain(["state.pending".into()])
    {
        let path = root.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            safe(&path, false)?;
            fs::remove_file(path)
                .map_err(|_| "Could not clean the interrupted dictionary download.")?;
        }
    }
    Ok(())
}

fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    safe(root, true)?;
    let path = root.join("state.json");
    if fs::symlink_metadata(&path).is_ok() {
        safe(&path, false)?;
    }
    let bytes = serde_json::to_vec(journal).map_err(|_| "Could not save download status.")?;
    let pending = root.join("state.pending");
    if fs::symlink_metadata(&pending).is_ok() {
        safe(&pending, false)?;
        fs::remove_file(&pending).map_err(|_| "Could not save download status.")?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .map_err(|_| "Could not save download status.")?;
    let stage = Stage(pending);
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save download status.")?;
    drop(file);
    fs::rename(&stage.0, path).map_err(|_| "Could not save download status.".into())
}

fn initialize_at(root: PathBuf) -> Result<StarterState, String> {
    fs::create_dir_all(&root).map_err(|_| "Starter dictionary storage is unavailable.")?;
    clean(&root)?;
    let path = root.join("state.json");
    let mut journal = if path.exists() {
        safe(&path, false)?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| "Could not read download status.")?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read download status.")?;
        if bytes.len() > 4096 {
            Journal::default()
        } else {
            serde_json::from_slice::<Journal>(&bytes).unwrap_or_default()
        }
    } else {
        Journal::default()
    };
    journal.jobs.resize(SOURCES.len(), Job::default());
    for job in &mut journal.jobs {
        if job.phase.active() {
            job.phase = Phase::Interrupted;
        }
        job.received = 0;
        job.total = None;
    }
    save(&root, &journal)?;
    Ok(StarterState {
        root,
        inner: Arc::new(Mutex::new(Inner {
            revision: 0,
            journal,
        })),
    })
}

pub(crate) fn initialize(app: &AppHandle) -> Result<StarterState, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate dictionary storage.")?
        .join("starter-dictionaries");
    initialize_at(root)
}

#[tauri::command]
pub(crate) fn get_starter_dictionaries(state: State<'_, StarterState>) -> Snapshot {
    snapshot(&state.inner.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
pub(crate) fn dismiss_starter_dictionaries(
    state: State<'_, StarterState>,
) -> Result<Snapshot, String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.journal.jobs.iter().any(|job| job.phase.active()) {
        return Err("Wait for the download to finish.".into());
    }
    let mut journal = inner.journal.clone();
    journal.dismissed = true;
    save(&state.root, &journal)?;
    inner.journal = journal;
    inner.revision += 1;
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn open_starter_information(id: String, license: bool) -> Result<(), String> {
    let s = source(&id)?;
    crate::external_link::open_external_link(if license {
        "https://creativecommons.org/licenses/by-sa/4.0/".into()
    } else {
        s.page.into()
    })
    .await
}

fn update(
    state: &StarterState,
    app: &AppHandle,
    index: usize,
    phase: Phase,
    received: u64,
    total: Option<u64>,
    title: Option<String>,
) {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.journal.jobs[index] = Job {
        phase,
        received,
        total,
        title,
    };
    inner.revision += 1;
    if !phase.active() {
        let _ = save(&state.root, &inner.journal);
    }
    let _ = app.emit_to("main", EVENT, snapshot(&inner));
}

#[tauri::command]
pub(crate) fn download_starter_dictionary(
    id: String,
    app: AppHandle,
    state: State<'_, StarterState>,
    store: State<'_, DictionaryStoreState>,
) -> Result<Snapshot, String> {
    let s = source(&id)?;
    let index = SOURCES.iter().position(|entry| entry.id == s.id).unwrap();
    let initial = {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.journal.jobs.iter().any(|job| job.phase.active()) {
            return Err("Another starter download is running.".into());
        }
        let mut journal = inner.journal.clone();
        journal.started = true;
        journal.dismissed = false;
        journal.jobs[index] = Job {
            phase: Phase::Downloading,
            ..Job::default()
        };
        save(&state.root, &journal)?;
        inner.journal = journal;
        inner.revision += 1;
        snapshot(&inner)
    };
    let worker = StarterState {
        root: state.root.clone(),
        inner: Arc::clone(&state.inner),
    };
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(
            &worker.root,
            s,
            &database,
            &write_lock,
            &|phase, received, total| {
                update(&worker, &app, index, phase, received, total, None);
            },
            fetch,
        );
        let (phase, title) =
            result.map_or((Phase::Failed, None), |(phase, title)| (phase, Some(title)));
        update(&worker, &app, index, phase, 0, None, title);
    });
    Ok(initial)
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

type Progress<'a> = &'a dyn Fn(Phase, u64, Option<u64>);
fn install(
    root: &Path,
    s: &Source,
    database: &Path,
    lock: &Mutex<()>,
    progress: Progress<'_>,
    get: impl Fn(&Source, &mut File, Progress<'_>) -> Result<(), String>,
) -> Result<(Phase, String), String> {
    safe(root, true)?;
    let path = root.join(format!("{}.part", s.id));
    // Create-new refuses links, stale files and concurrent staging collisions.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| FAILURE)?;
    let stage = Stage(path);
    get(s, &mut file, progress)?;
    file.sync_all().map_err(|_| FAILURE)?;
    drop(file);
    progress(Phase::Verifying, 0, None);
    verify(&stage.0, s)?;
    progress(Phase::Importing, 0, None);
    let _writing = lock.lock().map_err(|_| "Could not save this dictionary.")?;
    let mut connection =
        store::open_store(database).map_err(|_| "Could not save this dictionary.")?;
    match store::import_one(&mut connection, &stage.0) {
        (ImportStatus::Imported, Some(title)) => Ok((Phase::Imported, title)),
        (ImportStatus::AlreadyImported, Some(title)) => Ok((Phase::AlreadyImported, title)),
        _ => Err("Could not import this dictionary. Nothing was added. Try again.".into()),
    }
}

fn verify(path: &Path, s: &Source) -> Result<(), String> {
    safe(path, false)?;
    let mut file = File::open(path).map_err(|_| FAILURE)?;
    if file.metadata().map_err(|_| FAILURE)?.len() > MAX_DOWNLOAD {
        return Err(FAILURE.into());
    }
    if let Some(expected) = s.hash {
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 32768];
        loop {
            let read = file.read(&mut buffer).map_err(|_| FAILURE)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        if format!("{:x}", hash.finalize()) != expected {
            return Err(FAILURE.into());
        }
    }
    // Strict CRC checking for downloaded archives; legacy manual archives retain their reader.
    let mut zip =
        zip::ZipArchive::new(File::open(path).map_err(|_| FAILURE)?).map_err(|_| FAILURE)?;
    if zip.len() > 20_000 {
        return Err(FAILURE.into());
    }
    let mut total = 0u64;
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| FAILURE)?;
        total = total.checked_add(entry.size()).ok_or(FAILURE)?;
        if total > MAX_EXPANDED
            || entry.size() > 512 * 1024 * 1024
            || !names.insert(entry.name().to_owned())
        {
            return Err(FAILURE.into());
        }
        let limit = entry.size();
        let read = std::io::copy(&mut entry.by_ref().take(limit + 1), &mut std::io::sink())
            .map_err(|_| FAILURE)?;
        if read != limit {
            return Err(FAILURE.into());
        }
    }
    let archive = DictionaryArchive::open(path).map_err(|_| FAILURE)?;
    if !archive.index().title.starts_with(s.title_prefix) || archive.bank_count(s.bank) == 0 {
        return Err(FAILURE.into());
    }
    Ok(())
}

// GitHub releases may redirect once to their repository-specific signed asset path.
// Jiten's published API endpoint has no redirect allowance.
fn allowed_redirect(s: &Source, url: &str) -> bool {
    let Some(repository) = s.asset_repository else {
        return false;
    };
    let prefix = format!("https://release-assets.githubusercontent.com/github-production-release-asset/{repository}/");
    let Some(tail) = url.strip_prefix(&prefix) else {
        return false;
    };
    let Some((asset, query)) = tail.split_once('?') else {
        return false;
    };
    uuid::Uuid::parse_str(asset).is_ok()
        && !query.is_empty()
        && url.len() < 8192
        && !url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "\\\"<>#".contains(c))
}

#[cfg(windows)]
fn fetch(s: &Source, file: &mut File, progress: Progress<'_>) -> Result<(), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Networking::WinHttp::*;
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe fn header(request: *mut c_void, kind: u32) -> Option<String> {
        let mut buffer = vec![0u16; 8192];
        let mut size = (buffer.len() * 2) as u32;
        if WinHttpQueryHeaders(
            request,
            kind,
            std::ptr::null(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        Some(
            String::from_utf16_lossy(&buffer[..size as usize / 2])
                .trim_end_matches('\0')
                .to_owned(),
        )
    }
    let started = std::time::Instant::now();
    let mut url = s.url.to_owned();
    // SAFETY: NUL-terminated strings and buffers outlive each WinHTTP call; RAII closes all handles.
    unsafe {
        let session = Handle(WinHttpOpen(
            wide("Komori Starter Dictionaries").as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() || WinHttpSetTimeouts(session.0, 10000, 10000, 15000, 15000) == 0 {
            return Err(FAILURE.into());
        }
        for hop in 0..=1 {
            let (host, path) = url
                .strip_prefix("https://")
                .and_then(|rest| rest.split_once('/'))
                .ok_or(FAILURE)?;
            let connection = Handle(WinHttpConnect(session.0, wide(host).as_ptr(), 443, 0));
            if connection.0.is_null() {
                return Err(FAILURE.into());
            }
            let request = Handle(WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide(&format!("/{path}")).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            ));
            if request.0.is_null() {
                return Err(FAILURE.into());
            }
            let redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
            if WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_REDIRECT_POLICY,
                (&redirects as *const u32).cast(),
                4,
            ) == 0
                || WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0)
                    == 0
                || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0
            {
                return Err(FAILURE.into());
            }
            let status = header(request.0, WINHTTP_QUERY_STATUS_CODE).ok_or(FAILURE)?;
            if status == "302" && hop == 0 {
                let next = header(request.0, WINHTTP_QUERY_LOCATION).ok_or(FAILURE)?;
                if !allowed_redirect(s, &next) {
                    return Err(FAILURE.into());
                }
                url = next;
                continue;
            }
            if status != "200" {
                return Err(FAILURE.into());
            }
            let total = header(request.0, WINHTTP_QUERY_CONTENT_LENGTH)
                .map(|text| text.parse::<u64>().map_err(|_| FAILURE))
                .transpose()?;
            if total.is_some_and(|size| size == 0 || size > MAX_DOWNLOAD) {
                return Err(FAILURE.into());
            }
            let mut received = 0u64;
            let mut announced = 0u64;
            loop {
                if started.elapsed().as_secs() > 180 {
                    return Err(FAILURE.into());
                }
                let mut buffer = [0u8; 32768];
                let mut read = 0;
                if WinHttpReadData(
                    request.0,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                ) == 0
                {
                    return Err(FAILURE.into());
                }
                if read == 0 {
                    break;
                }
                received += read as u64;
                if received > MAX_DOWNLOAD || total.is_some_and(|size| received > size) {
                    return Err(FAILURE.into());
                }
                file.write_all(&buffer[..read as usize])
                    .map_err(|_| FAILURE)?;
                if received - announced >= 256 * 1024 {
                    progress(Phase::Downloading, received, total);
                    announced = received;
                }
            }
            if received == 0 || total.is_some_and(|size| received != size) {
                return Err(FAILURE.into());
            }
            progress(Phase::Downloading, received, total);
            return Ok(());
        }
    }
    Err(FAILURE.into())
}

#[cfg(not(windows))]
fn fetch(_: &Source, _: &mut File, _: Progress<'_>) -> Result<(), String> {
    Err("Starter downloads require Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn archive(title: &str, frequency: bool, malformed: bool) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("index.json", options).unwrap();
        write!(
            zip,
            "{{\"title\":\"{title}\",\"revision\":\"test\",\"format\":3}}"
        )
        .unwrap();
        zip.start_file(
            if frequency {
                "term_meta_bank_1.json"
            } else {
                "term_bank_1.json"
            },
            options,
        )
        .unwrap();
        zip.write_all(if malformed {
            b"[false]"
        } else if frequency {
            br#"[["read","freq",2]]"#
        } else {
            br#"[["read","read","","",1,["to read"],1,""]]"#
        })
        .unwrap();
        zip.finish().unwrap().into_inner()
    }

    fn fixture() -> Source {
        Source {
            hash: None,
            ..SOURCES[0]
        }
    }

    #[test]
    fn descriptions_never_name_yomitan_while_attribution_keeps_its_credit() {
        for source in SOURCES {
            assert!(!source.description.to_lowercase().contains("yomitan"));
        }
        assert!(SOURCES[1]
            .attribution
            .contains("Yomitan package by yomidevs"));
    }

    #[test]
    fn native_catalog_refuses_caller_urls_and_foreign_redirects() {
        for id in ["", "https://jitendex.org", "../jitendex", "Jitendex"] {
            assert!(source(id).is_err());
        }
        let valid = "https://release-assets.githubusercontent.com/github-production-release-asset/744330420/0523806b-6e18-4396-886b-ddefb0fa910e?sig=abc";
        assert!(allowed_redirect(&SOURCES[0], valid));
        for invalid in [
            valid.replace("https://", "http://"),
            valid.replace("744330420", "696075636"),
            valid.replace(".com/", ".com.evil/"),
            format!("{valid}#fragment"),
            format!("{valid}\n"),
            valid.replace("0523806b-6e18-4396-886b-ddefb0fa910e", "../elsewhere"),
        ] {
            assert!(!allowed_redirect(&SOURCES[0], &invalid));
        }
        assert!(!allowed_redirect(&SOURCES[2], valid));
    }

    #[test]
    fn verified_import_duplicate_and_restart_use_the_existing_transactional_store() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionary.sqlite3");
        let s = fixture();
        let bytes = archive("Jitendex fixture", false, false);
        let phases = std::cell::RefCell::new(Vec::new());
        let progress = |phase, _, _| phases.borrow_mut().push(phase);
        let get = |_: &Source, file: &mut File, _: Progress<'_>| {
            file.write_all(&bytes).map_err(|_| FAILURE.into())
        };
        let lock = Mutex::new(());
        assert_eq!(
            install(&state.root, &s, &database, &lock, &progress, get)
                .unwrap()
                .0,
            Phase::Imported
        );
        assert_eq!(*phases.borrow(), [Phase::Verifying, Phase::Importing]);
        assert_eq!(
            install(&state.root, &s, &database, &lock, &progress, get)
                .unwrap()
                .0,
            Phase::AlreadyImported
        );
        let connection = store::open_store(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM dictionaries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT expression FROM terms", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "read"
        );
        assert!(!state.root.join("jitendex.part").exists());
        drop(connection);
        drop(state);
        assert!(initialize_at(dir.path().join("stage")).is_ok());
        assert_eq!(
            store::open_store(&database)
                .unwrap()
                .query_row("SELECT count(*) FROM terms", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn refusal_cleanup_retry_and_rollback_keep_existing_data_and_unowned_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionary.sqlite3");
        let lock = Mutex::new(());
        let s = fixture();
        let file = state.root.join("untouched.zip");
        fs::write(&file, b"private").unwrap();
        let before = fs::metadata(&file).unwrap().modified().unwrap();
        for bytes in [
            b"not a ZIP".to_vec(),
            archive("wrong source", false, false),
            archive("Jitendex broken", false, true),
        ] {
            assert!(install(
                &state.root,
                &s,
                &database,
                &lock,
                &|_, _, _| {},
                |_, file, _| file.write_all(&bytes).map_err(|_| FAILURE.into())
            )
            .is_err());
            assert!(!state.root.join("jitendex.part").exists());
        }
        assert!(install(
            &state.root,
            &s,
            &database,
            &lock,
            &|_, _, _| {},
            |_, file, _| {
                file.write_all(b"partial").unwrap();
                Err(FAILURE.into())
            }
        )
        .is_err());
        let connection = store::open_store(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM dictionaries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let bytes = archive("Jitendex retry", false, false);
        assert_eq!(
            install(
                &state.root,
                &s,
                &database,
                &lock,
                &|_, _, _| {},
                |_, file, _| file.write_all(&bytes).map_err(|_| FAILURE.into())
            )
            .unwrap(),
            (Phase::Imported, "Jitendex retry".into())
        );
        assert_eq!(fs::read(&file).unwrap(), b"private");
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before);
        // Create-new failure must not delete a preexisting file, even at a known stage name.
        fs::write(state.root.join("jitendex.part"), b"existing").unwrap();
        assert!(install(
            &state.root,
            &s,
            &database,
            &lock,
            &|_, _, _| {},
            |_, _, _| panic!("must not download")
        )
        .is_err());
        assert_eq!(
            fs::read(state.root.join("jitendex.part")).unwrap(),
            b"existing"
        );
    }

    #[test]
    fn hash_crc_role_and_archive_size_are_verified_before_import() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.zip");
        let bytes = archive("Jitendex fixture", false, false);
        fs::write(&file, &bytes).unwrap();
        assert!(verify(&file, &SOURCES[0]).is_err()); // wrong pinned SHA-256
        assert!(verify(&file, &fixture()).is_ok());
        let mut corrupt = bytes.clone();
        let start = corrupt.windows(7).position(|w| w == b"to read").unwrap();
        corrupt[start] = b'X';
        fs::write(&file, corrupt).unwrap();
        assert!(verify(&file, &fixture()).is_err());
        fs::write(&file, archive("Jiten", false, false)).unwrap();
        assert!(verify(&file, &SOURCES[2]).is_err());
        fs::write(&file, archive("Jiten", true, false)).unwrap();
        assert!(verify(&file, &SOURCES[2]).is_ok());
        File::create(&file)
            .unwrap()
            .set_len(MAX_DOWNLOAD + 1)
            .unwrap();
        assert!(verify(&file, &fixture()).is_err());
    }

    #[test]
    fn interrupted_phases_reopen_retryably_and_clean_only_owned_staging() {
        for phase in [Phase::Downloading, Phase::Verifying, Phase::Importing] {
            let dir = tempfile::tempdir().unwrap();
            let mut journal = Journal {
                started: true,
                ..Journal::default()
            };
            journal.jobs[0].phase = phase;
            journal.jobs[1].phase = Phase::Imported;
            save(dir.path(), &journal).unwrap();
            fs::write(dir.path().join("jitendex.part"), b"partial").unwrap();
            fs::write(
                dir.path().join("state.pending"),
                b"interrupted journal write",
            )
            .unwrap();
            fs::write(dir.path().join("other.zip"), b"unowned").unwrap();
            let state = initialize_at(dir.path().to_path_buf()).unwrap();
            let recovered = snapshot(&state.inner.lock().unwrap());
            assert_eq!(recovered.entries[0].job.phase, Phase::Interrupted);
            assert_eq!(recovered.entries[1].job.phase, Phase::Imported);
            assert!(recovered.started);
            assert!(!dir.path().join("jitendex.part").exists());
            assert!(!dir.path().join("state.pending").exists());
            assert_eq!(fs::read(dir.path().join("other.zip")).unwrap(), b"unowned");
        }
    }

    #[test]
    fn a_status_saved_before_sources_were_added_keeps_its_entries() {
        let dir = tempfile::tempdir().unwrap();
        let ready = r#"{"phase":"ready","received":0,"total":null}"#;
        let imported = r#"{"phase":"imported","received":0,"total":null}"#;
        fs::write(
            dir.path().join("state.json"),
            format!(
                r#"{{"started":true,"dismissed":false,"jobs":[{ready},{imported},{imported}]}}"#
            ),
        )
        .unwrap();
        let state = initialize_at(dir.path().to_path_buf()).unwrap();
        let entries = snapshot(&state.inner.lock().unwrap()).entries;
        let phases: Vec<_> = entries.iter().map(|e| (e.id, e.job.phase)).collect();
        assert_eq!(
            phases,
            [
                ("jitendex", Phase::Ready),
                ("jmdict", Phase::Imported),
                ("jiten", Phase::Imported),
                ("kanjidic", Phase::Ready),
                ("jmnedict", Phase::Ready),
            ]
        );
    }

    #[test]
    fn a_kanji_source_needs_a_kanji_bank() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kanji.zip");
        let kanji = Source {
            hash: None,
            ..SOURCES[3]
        };
        fs::write(&file, archive("KANJIDIC fixture", false, false)).unwrap();
        assert!(verify(&file, &kanji).is_err());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        zip.start_file("index.json", options).unwrap();
        zip.write_all(br#"{"title":"KANJIDIC fixture","revision":"test","format":3}"#)
            .unwrap();
        zip.start_file("kanji_bank_1.json", options).unwrap();
        zip.write_all(r#"[["読","ドク","よ.む","",["read"],{}]]"#.as_bytes())
            .unwrap();
        fs::write(&file, zip.finish().unwrap().into_inner()).unwrap();
        assert!(verify(&file, &kanji).is_ok());
    }

    #[test]
    #[ignore = "official network downloads; isolated store only"]
    fn real_starter_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionaries.sqlite3");
        for s in &SOURCES {
            let result = install(
                &state.root,
                s,
                &database,
                &Mutex::new(()),
                &|_, _, _| {},
                fetch,
            );
            println!("{}: {:?}", s.name, result);
            assert_eq!(result.unwrap().0, Phase::Imported);
        }
        let connection = store::open_store(&database).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM dictionaries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, SOURCES.len() as i64);
        assert!(
            connection
                .query_row(
                    "SELECT count(*) FROM term_meta WHERE mode='freq'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                > 0
        );
    }
}
