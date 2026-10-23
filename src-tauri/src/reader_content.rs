//! Catalog-scoped, read-only access to an archived EPUB's entries for the Reader.

use std::{
    cmp::Ordering,
    collections::{HashMap, VecDeque},
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::{Decompress, FlushDecompress, Status};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, State, UriSchemeContext, UriSchemeResponder, Wry,
};
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive};

use crate::{epub, library::CatalogState};

const SCHEME: &str = "komori-book";
/// The Reader's limit for one archive entry, which no response exceeds either.
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
/// One bundle holds at most this many declared bytes, which bounds its response buffer.
const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES: usize = 10_000;
/// No book has this many entries; listing them would only spend memory.
const MAX_ENTRIES: usize = 100_000;
/// Archives kept open between requests, each with one read-only source handle.
const OPEN_ARCHIVES: usize = 4;
/// Bundle frames for an entry over the entry limit and for damaged entry data. Real lengths
/// never reach them, since no entry exceeds the entry limit.
const TOO_LARGE_FRAME: u32 = u32::MAX;
const DAMAGED_FRAME: u32 = u32::MAX - 1;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAccess {
    status: ContentStatus,
    url: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ContentStatus {
    Ready,
    Unknown,
    Missing,
    Unreadable,
    Invalid,
    TooLarge,
    Failed,
}

impl ContentAccess {
    fn failure(status: ContentStatus) -> Self {
        Self { status, url: None }
    }
}

/// The archives the Reader has opened, each tied to the catalog ID and source version it read.
#[derive(Clone)]
pub struct ReaderArchives(Arc<Archives>);

struct Archives {
    /// A key for this run, so a stamp tells nothing about the source it names.
    key: [u8; 16],
    open: Mutex<VecDeque<Arc<OpenArchive>>>,
}

impl Default for ReaderArchives {
    fn default() -> Self {
        Self(Arc::new(Archives {
            key: *Uuid::new_v4().as_bytes(),
            open: Mutex::default(),
        }))
    }
}

struct OpenArchive {
    id: Uuid,
    source: SourceVersion,
    /// Names this source version in content URLs, so entry numbers always mean its entries.
    stamp: String,
    archive: ZipArchive<SharedFile>,
    entries: Vec<Entry>,
}

#[derive(PartialEq, Eq)]
struct SourceVersion {
    path: String,
    len: u64,
    modified: Option<SystemTime>,
}

struct Entry {
    index: usize,
    name: String,
    size: u64,
}

enum EntryFailure {
    TooLarge,
    Damaged,
}

#[tauri::command]
pub async fn prepare_book_content(
    catalog: State<'_, CatalogState>,
    archives: State<'_, ReaderArchives>,
    id: String,
) -> Result<ContentAccess, String> {
    let database = catalog.database.clone();
    let archives = archives.inner().clone();
    let diagnostic_id = Uuid::parse_str(&id).ok();
    match tauri::async_runtime::spawn_blocking(move || prepare(&database, &archives, &id)).await {
        Ok(access) => Ok(access),
        Err(_) => {
            eprintln!(
                "{}",
                content_diagnostic(diagnostic_id, &ContentStatus::Failed)
            );
            Ok(ContentAccess::failure(ContentStatus::Failed))
        }
    }
}

fn prepare(database: &Path, archives: &ReaderArchives, id: &str) -> ContentAccess {
    match archives.resolve(database, id) {
        Ok(archive) => ContentAccess {
            status: ContentStatus::Ready,
            url: Some(content_url(id, &archive.stamp)),
        },
        Err(status) => ContentAccess::failure(status),
    }
}

fn content_url(id: &str, stamp: &str) -> String {
    // WebView2 maps custom schemes to a localhost origin on Windows and Android.
    if cfg!(any(target_os = "windows", target_os = "android")) {
        format!("http://{SCHEME}.localhost/{id}/{stamp}")
    } else {
        format!("{SCHEME}://localhost/{id}/{stamp}")
    }
}

/// Diagnostics contain only a validated catalog ID (or unknown) and a typed status.
fn content_diagnostic(id: Option<Uuid>, status: &ContentStatus) -> String {
    let id = id.map_or_else(|| "unknown".to_owned(), |id| id.to_string());
    format!("Komori Reader content {id}: {status:?}")
}

impl ReaderArchives {
    /// Resolves the catalog's current source for `id` on every call. The open archive serves
    /// it while the source keeps its path, size and modification time; any other source is
    /// opened, validated and listed again.
    fn resolve(&self, database: &Path, id: &str) -> Result<Arc<OpenArchive>, ContentStatus> {
        // Catalog IDs are UUIDs generated by Komori. Reject path-shaped and malformed input first.
        let id = Uuid::parse_str(id).map_err(|_| ContentStatus::Unknown)?;
        let resolved = source_path(database, id).and_then(|path| {
            let version = source_version(id, path, |path| std::fs::metadata(path))?;
            match self.reuse(id, &version) {
                Some(archive) => Ok(archive),
                None => self.open(id, version.path),
            }
        });
        let mut open = self.0.open.lock().unwrap_or_else(PoisonError::into_inner);
        // Keep one version of a book, and no handle on a source the catalog no longer serves.
        open.retain(|archive| archive.id != id);
        if let Ok(archive) = &resolved {
            open.push_front(archive.clone());
            open.truncate(OPEN_ARCHIVES);
        }
        resolved
    }

    fn reuse(&self, id: Uuid, version: &SourceVersion) -> Option<Arc<OpenArchive>> {
        let open = self.0.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.iter()
            .find(|archive| archive.id == id && archive.source == *version)
            .cloned()
    }

    fn open(&self, id: Uuid, path: String) -> Result<Arc<OpenArchive>, ContentStatus> {
        let source = File::open(&path).map_err(|error| source_failure(id, &error))?;
        // The version comes from the open handle, which every later read uses.
        let version = source_version(id, path, |_| source.metadata())?;
        let invalid = || {
            eprintln!("{}", content_diagnostic(Some(id), &ContentStatus::Invalid));
            ContentStatus::Invalid
        };
        // Opening reads the central directory, the local headers, the container and the
        // package document. It never writes the source or extracts a copy.
        let mut archive =
            ZipArchive::new(SharedFile::new(source, version.len)).map_err(|_| invalid())?;
        epub::validate_archive(&mut archive).map_err(|_| invalid())?;
        let entries = list_entries(&mut archive).inspect_err(|status| {
            eprintln!("{}", content_diagnostic(Some(id), status));
        })?;
        Ok(Arc::new(OpenArchive {
            id,
            stamp: self.stamp(id, &version),
            source: version,
            archive,
            entries,
        }))
    }

    fn stamp(&self, id: Uuid, version: &SourceVersion) -> String {
        let modified = version
            .modified
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |modified| modified.as_nanos());
        let digest = Sha256::new()
            .chain_update(self.0.key)
            .chain_update(id.as_bytes())
            .chain_update(version.path.as_bytes())
            .chain_update(version.len.to_le_bytes())
            .chain_update(modified.to_le_bytes())
            .finalize();
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn source_path(database: &Path, id: Uuid) -> Result<String, ContentStatus> {
    let failed = |_| {
        eprintln!("{}", content_diagnostic(Some(id), &ContentStatus::Failed));
        ContentStatus::Failed
    };
    let connection =
        Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(failed)?;
    connection
        .query_row(
            "SELECT source_path FROM books WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .ok_or(ContentStatus::Unknown)
}

fn source_version(
    id: Uuid,
    path: String,
    metadata: impl FnOnce(&str) -> io::Result<std::fs::Metadata>,
) -> Result<SourceVersion, ContentStatus> {
    match metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(SourceVersion {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            path,
        }),
        Ok(_) => Err(ContentStatus::Unreadable),
        Err(error) => Err(source_failure(id, &error)),
    }
}

fn source_failure(id: Uuid, error: &io::Error) -> ContentStatus {
    let status = if error.kind() == io::ErrorKind::NotFound {
        ContentStatus::Missing
    } else {
        ContentStatus::Unreadable
    };
    eprintln!("{}", content_diagnostic(Some(id), &status));
    status
}

/// Lists the archive's files as EPUB.js's JSZip names them: raw names read as UTF-8 unless a
/// Unicode path field names them, folders left out, and a later duplicate replacing an earlier
/// one. As in JSZip, one encrypted entry, or one compressed other than stored or deflate,
/// refuses the whole archive.
fn list_entries(archive: &mut ZipArchive<SharedFile>) -> Result<Vec<Entry>, ContentStatus> {
    if archive.len() > MAX_ENTRIES {
        return Err(ContentStatus::TooLarge);
    }
    let mut entries: Vec<Entry> = Vec::with_capacity(archive.len());
    let mut positions = HashMap::with_capacity(archive.len());
    for index in 0..archive.len() {
        let file = archive
            .by_index_raw(index)
            .map_err(|_| ContentStatus::Invalid)?;
        if file.encrypted()
            || !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
        {
            return Err(ContentStatus::Invalid);
        }
        let name = String::from_utf8_lossy(file.name_raw()).into_owned();
        if name.ends_with('/') {
            continue;
        }
        let entry = Entry {
            index,
            size: file.size(),
            name,
        };
        match positions.get(&entry.name) {
            Some(&position) => entries[position] = entry,
            None => {
                positions.insert(entry.name.clone(), entries.len());
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

impl OpenArchive {
    /// The entry list, as `[name, declared size]` pairs whose positions are entry numbers.
    fn index(&self) -> Vec<u8> {
        let entries: Vec<(&str, u64)> = self
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.size))
            .collect();
        serde_json::to_vec(&entries).expect("entry names and sizes serialize")
    }

    fn entry(&self, number: usize) -> Result<Vec<u8>, StatusCode> {
        let entry = self.entries.get(number).ok_or(StatusCode::NOT_FOUND)?;
        read_entry(&mut self.archive.clone(), entry).map_err(|failure| match failure {
            EntryFailure::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            EntryFailure::Damaged => StatusCode::UNPROCESSABLE_ENTITY,
        })
    }

    /// The entries that little-endian u32 entry numbers name, each framed by its u32 length,
    /// or by a too-large or damaged frame in its place.
    fn bundle(&self, numbers: &[u8]) -> Result<Vec<u8>, StatusCode> {
        if !numbers.len().is_multiple_of(4) || numbers.len() / 4 > MAX_BUNDLE_ENTRIES {
            return Err(StatusCode::BAD_REQUEST);
        }
        let entries = numbers
            .as_chunks::<4>()
            .0
            .iter()
            .map(|number| {
                self.entries
                    .get(usize::try_from(u32::from_le_bytes(*number)).ok()?)
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(StatusCode::NOT_FOUND)?;
        let declared: u64 = entries
            .iter()
            .map(|entry| entry.size)
            .filter(|size| *size <= MAX_ENTRY_BYTES)
            .sum();
        if declared > MAX_BUNDLE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let mut archive = self.archive.clone();
        let mut bundle =
            Vec::with_capacity(usize::try_from(declared).unwrap_or(0) + 4 * entries.len());
        for entry in entries {
            match read_entry(&mut archive, entry) {
                Ok(bytes) => {
                    let length = u32::try_from(bytes.len()).expect("entries are within the limit");
                    bundle.extend_from_slice(&length.to_le_bytes());
                    bundle.extend_from_slice(&bytes);
                }
                Err(EntryFailure::TooLarge) => {
                    bundle.extend_from_slice(&TOO_LARGE_FRAME.to_le_bytes());
                }
                Err(EntryFailure::Damaged) => {
                    bundle.extend_from_slice(&DAMAGED_FRAME.to_le_bytes());
                }
            }
        }
        Ok(bundle)
    }
}

/// Reads one entry within the entry limit and never past its declared size. Like JSZip, it
/// does not check CRCs.
fn read_entry(
    archive: &mut ZipArchive<SharedFile>,
    entry: &Entry,
) -> Result<Vec<u8>, EntryFailure> {
    if entry.size > MAX_ENTRY_BYTES {
        return Err(EntryFailure::TooLarge);
    }
    let declared = usize::try_from(entry.size).map_err(|_| EntryFailure::TooLarge)?;
    let file = archive
        .by_index_raw(entry.index)
        .map_err(|_| EntryFailure::Damaged)?;
    // One byte past the declared size shows that the data is longer than declared.
    let mut bytes = Vec::with_capacity(declared + 1);
    if file.compression() == CompressionMethod::Stored {
        file.take(entry.size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| EntryFailure::Damaged)?;
    } else {
        inflate(file, &mut bytes, declared)?;
    }
    // JSZip refuses data of any other length than declared, shorter data as damaged.
    match bytes.len().cmp(&declared) {
        Ordering::Greater => Err(EntryFailure::TooLarge),
        Ordering::Less => Err(EntryFailure::Damaged),
        Ordering::Equal => Ok(bytes),
    }
}

/// Inflates raw deflate data into `output`'s spare capacity. Data that ends before its stream
/// does is damaged.
fn inflate(input: impl Read, output: &mut Vec<u8>, declared: usize) -> Result<(), EntryFailure> {
    let mut input = BufReader::with_capacity(64 * 1024, input);
    let mut inflater = Decompress::new(false);
    loop {
        let chunk = input.fill_buf().map_err(|_| EntryFailure::Damaged)?;
        let flush = if chunk.is_empty() {
            FlushDecompress::Finish
        } else {
            FlushDecompress::None
        };
        let (read, written) = (inflater.total_in(), output.len());
        let status = inflater
            .decompress_vec(chunk, output, flush)
            .map_err(|_| EntryFailure::Damaged)?;
        let consumed = usize::try_from(inflater.total_in() - read).unwrap_or(usize::MAX);
        input.consume(consumed);
        match status {
            Status::StreamEnd => return Ok(()),
            _ if output.len() > declared => return Err(EntryFailure::TooLarge),
            _ if consumed == 0 && output.len() == written => return Err(EntryFailure::Damaged),
            _ => {}
        }
    }
}

/// A source handle that reads at its own position, so each clone of an archive reads alone.
#[derive(Clone)]
struct SharedFile {
    file: Arc<File>,
    len: u64,
    position: u64,
}

impl SharedFile {
    fn new(file: File, len: u64) -> Self {
        Self {
            file: Arc::new(file),
            len,
            position: 0,
        }
    }
}

impl Read for SharedFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        #[cfg(windows)]
        let read = std::os::windows::fs::FileExt::seek_read(&*self.file, buffer, self.position)?;
        #[cfg(unix)]
        let read = std::os::unix::fs::FileExt::read_at(&*self.file, buffer, self.position)?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for SharedFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.position = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => self.len.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        Ok(self.position)
    }
}

pub fn serve_book(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // The only current webview is the app-owned main Reader/Library window.
    if context.webview_label() != "main" {
        responder.respond(response(StatusCode::FORBIDDEN, Vec::new(), None, None));
        return;
    }
    let app = context.app_handle();
    let database = app.state::<CatalogState>().database.clone();
    let archives = app.state::<ReaderArchives>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(handle_request(&database, &archives, &request))
    });
}

enum Route {
    Index,
    Entry(usize),
    Bundle,
}

fn handle_request(
    database: &Path,
    archives: &ReaderArchives,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| allowed_origin(origin));
    // A web page outside Komori cannot fetch or embed this protocol's content.
    if origin.is_none() || !matches!(*request.method(), Method::GET | Method::POST) {
        return response(StatusCode::FORBIDDEN, Vec::new(), None, None);
    }
    let Some((id, stamp, route)) = route(request) else {
        return response(StatusCode::NOT_FOUND, Vec::new(), None, origin);
    };
    let archive = match archives.resolve(database, id) {
        Ok(archive) => archive,
        Err(status) => return response(http_status(status), Vec::new(), None, origin),
    };
    // A stale stamp names a source version the catalog no longer serves.
    if archive.stamp != stamp {
        return response(StatusCode::NOT_FOUND, Vec::new(), None, origin);
    }
    let (served, kind) = match route {
        Route::Index => (Ok(archive.index()), "application/json"),
        Route::Entry(number) => (archive.entry(number), "application/octet-stream"),
        Route::Bundle => (archive.bundle(request.body()), "application/octet-stream"),
    };
    match served {
        Ok(bytes) => response(StatusCode::OK, bytes, Some(kind), origin),
        Err(status) => response(status, Vec::new(), None, origin),
    }
}

/// `GET /<id>/<stamp>` lists the entries, `GET /<id>/<stamp>/<number>` reads one, and
/// `POST /<id>/<stamp>` reads the entries its body numbers. Nothing else is a route, and no
/// route takes an entry name or a filesystem path.
fn route(request: &Request<Vec<u8>>) -> Option<(&str, &str, Route)> {
    if request.uri().query().is_some() {
        return None;
    }
    let mut segments = request.uri().path().strip_prefix('/')?.split('/');
    let (id, stamp, number) = (segments.next()?, segments.next()?, segments.next());
    let stamped = stamp.len() == 16
        && stamp
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if segments.next().is_some() || Uuid::parse_str(id).is_err() || !stamped {
        return None;
    }
    let route = match (request.method(), number) {
        (&Method::GET, None) => Route::Index,
        (&Method::POST, None) => Route::Bundle,
        (&Method::GET, Some(number))
            if (1..=9).contains(&number.len())
                && number.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Route::Entry(number.parse().ok()?)
        }
        _ => return None,
    };
    Some((id, stamp, route))
}

fn allowed_origin(origin: &str) -> bool {
    matches!(origin, "http://tauri.localhost" | "tauri://localhost")
        || (cfg!(debug_assertions) && origin == "http://127.0.0.1:1420")
}

fn http_status(status: ContentStatus) -> StatusCode {
    match status {
        ContentStatus::Ready => StatusCode::OK,
        ContentStatus::Unknown | ContentStatus::Missing => StatusCode::NOT_FOUND,
        ContentStatus::Unreadable => StatusCode::FORBIDDEN,
        ContentStatus::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
        ContentStatus::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        ContentStatus::Failed => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn response(
    status: StatusCode,
    bytes: Vec<u8>,
    kind: Option<&str>,
    origin: Option<&str>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind.unwrap_or("text/plain"))
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("Vary", "Origin");
    if let Some(origin) = origin {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    builder
        .body(bytes)
        .expect("static response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, ZipWriter};

    const ORIGIN: &str = "http://tauri.localhost";
    const CONTAINER: &str = "META-INF/container.xml";
    const PACKAGE: &str = "Nested/OPS/book.opf";
    const CHAPTER: &str = "Nested/OPS/Text/one.xhtml";

    /// A stored container, a deflated package and chapter, a folder entry and `extra` files.
    fn fixture_with(path: &Path, title: &str, extra: &[(&str, &[u8])]) {
        let extra: Vec<_> = extra
            .iter()
            .map(|&(name, bytes)| (name, bytes, CompressionMethod::Deflated))
            .collect();
        fixture_compressed(path, title, &extra);
    }

    fn fixture_compressed(path: &Path, title: &str, extra: &[(&str, &[u8], CompressionMethod)]) {
        let mut archive = ZipWriter::new(File::create(path).unwrap());
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        archive.start_file(CONTAINER, stored).unwrap();
        archive
            .write_all(br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="Nested/OPS/book.opf"/></rootfiles></container>"#)
            .unwrap();
        archive.add_directory("Nested/OPS/Text/", stored).unwrap();
        archive.start_file(PACKAGE, deflated).unwrap();
        archive
            .write_all(format!("<package xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><metadata><dc:title>{title}</dc:title></metadata><manifest><item id=\"chapter\" href=\"Text/one.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chapter\"/></spine></package>").as_bytes())
            .unwrap();
        archive.start_file(CHAPTER, deflated).unwrap();
        archive
            .write_all(format!("<html><body>{}</body></html>", "Fixture ".repeat(512)).as_bytes())
            .unwrap();
        for &(name, bytes, method) in extra {
            let options = SimpleFileOptions::default().compression_method(method);
            archive.start_file(name, options).unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap();
    }

    fn fixture(path: &Path, title: &str) {
        fixture_with(path, title, &[]);
    }

    fn catalog(database: &Path, id: &str, source: &Path) {
        let connection = Connection::open(database).unwrap();
        connection
            .execute_batch("CREATE TABLE books (id TEXT PRIMARY KEY, source_path TEXT NOT NULL)")
            .unwrap();
        connection
            .execute(
                "INSERT INTO books (id, source_path) VALUES (?1, ?2)",
                rusqlite::params![id, source.to_string_lossy()],
            )
            .unwrap();
    }

    fn relink(database: &Path, id: &str, source: &Path) {
        Connection::open(database)
            .unwrap()
            .execute(
                "UPDATE books SET source_path = ?1 WHERE id = ?2",
                rusqlite::params![source.to_string_lossy(), id],
            )
            .unwrap();
    }

    fn request(method: Method, path: &str, origin: &str, body: Vec<u8>) -> Request<Vec<u8>> {
        Request::builder()
            .method(method)
            .uri(format!("http://komori-book.localhost{path}"))
            .header(header::ORIGIN, origin)
            .body(body)
            .unwrap()
    }

    /// The protocol path of a prepared book.
    fn book_path(database: &Path, archives: &ReaderArchives, id: &str) -> String {
        let access = prepare(database, archives, id);
        assert_eq!(access.status, ContentStatus::Ready);
        let url = access.url.unwrap();
        url.split_once("localhost").unwrap().1.to_owned()
    }

    fn get(database: &Path, archives: &ReaderArchives, path: &str) -> Response<Vec<u8>> {
        handle_request(
            database,
            archives,
            &request(Method::GET, path, ORIGIN, Vec::new()),
        )
    }

    fn post(
        database: &Path,
        archives: &ReaderArchives,
        path: &str,
        numbers: &[u32],
    ) -> Response<Vec<u8>> {
        let body = numbers
            .iter()
            .flat_map(|number| number.to_le_bytes())
            .collect();
        handle_request(
            database,
            archives,
            &request(Method::POST, path, ORIGIN, body),
        )
    }

    fn index(served: &Response<Vec<u8>>) -> Vec<(String, u64)> {
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(served.headers()[header::CONTENT_TYPE], "application/json");
        serde_json::from_slice(served.body()).unwrap()
    }

    fn number(entries: &[(String, u64)], name: &str) -> u32 {
        entries.iter().position(|(entry, _)| entry == name).unwrap() as u32
    }

    /// Each bundle frame's bytes, or its too-large or damaged frame.
    fn frames(served: &Response<Vec<u8>>) -> Vec<Result<Vec<u8>, u32>> {
        assert_eq!(served.status(), StatusCode::OK);
        let mut rest = served.body().as_slice();
        let mut frames = Vec::new();
        while !rest.is_empty() {
            let length = u32::from_le_bytes(rest[..4].try_into().unwrap());
            rest = &rest[4..];
            if length >= DAMAGED_FRAME {
                frames.push(Err(length));
            } else {
                frames.push(Ok(rest[..length as usize].to_vec()));
                rest = &rest[length as usize..];
            }
        }
        frames
    }

    /// An entry's data as the zip crate reads it, CRC checked.
    fn checked(source: &Path, name: &str) -> Vec<u8> {
        let mut archive = ZipArchive::new(File::open(source).unwrap()).unwrap();
        let mut bytes = Vec::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    }

    /// The start of the local (`PK\x03\x04`) or central (`PK\x01\x02`) header naming `name`.
    fn header_start(bytes: &[u8], central: bool, name: &str) -> usize {
        let (signature, name_at) = if central {
            (b"PK\x01\x02", 46)
        } else {
            (b"PK\x03\x04", 30)
        };
        let length_at = if central { 28 } else { 26 };
        (0..bytes.len() - name_at)
            .find(|&at| {
                let length = u16::from_le_bytes([bytes[at + length_at], bytes[at + length_at + 1]]);
                bytes[at..].starts_with(signature)
                    && bytes[at + name_at..].starts_with(name.as_bytes())
                    && length as usize == name.len()
            })
            .unwrap()
    }

    /// Overwrites bytes at `offset` in the central header of `name`.
    fn patch_central(source: &Path, name: &str, offset: usize, value: &[u8]) {
        let mut bytes = fs::read(source).unwrap();
        let at = header_start(&bytes, true, name) + offset;
        bytes[at..at + value.len()].copy_from_slice(value);
        fs::write(source, bytes).unwrap();
    }

    #[test]
    fn catalog_id_lists_and_reads_entries_without_touching_source() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("private.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture(&source, "One");
        catalog(&database, &id, &source);
        let original = fs::read(&source).unwrap();
        let modified = source.metadata().unwrap().modified().unwrap();

        let access = prepare(&database, &archives, &id);
        assert_eq!(access.status, ContentStatus::Ready);
        let url = access.url.as_deref().unwrap();
        let stamp = url.rsplit_once('/').unwrap().1;
        assert_eq!(url, content_url(&id, stamp));
        assert!(stamp.len() == 16 && stamp.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!serde_json::to_string(&access)
            .unwrap()
            .contains("private.epub"));
        let path = book_path(&database, &archives, &id);
        let listed = get(&database, &archives, &path);
        assert_eq!(listed.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(listed.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            listed.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
        let entries = index(&listed);
        // The folder entry is not a file, as JSZip's `file()` does not return folders.
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, [CONTAINER, PACKAGE, CHAPTER]);
        for (number, (name, size)) in entries.iter().enumerate() {
            let served = get(&database, &archives, &format!("{path}/{number}"));
            assert_eq!(served.status(), StatusCode::OK);
            assert_eq!(
                served.headers()[header::CONTENT_TYPE],
                "application/octet-stream"
            );
            assert_eq!(served.body(), &checked(&source, name));
            assert_eq!(served.body().len() as u64, *size);
        }
        let bundle = post(&database, &archives, &path, &[2, 0, 2]);
        assert_eq!(
            frames(&bundle),
            [
                Ok(checked(&source, CHAPTER)),
                Ok(checked(&source, CONTAINER)),
                Ok(checked(&source, CHAPTER))
            ]
        );
        assert!(frames(&post(&database, &archives, &path, &[])).is_empty());
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(source.metadata().unwrap().modified().unwrap(), modified);
    }

    #[test]
    fn entry_names_and_duplicates_follow_jszip() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("names.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture_with(
            &source,
            "Names",
            &[
                ("Nested/OPS/Text/章.xhtml", b"unflagged"),
                ("Nested/OPS/Text/a.xhtml", b"first"),
                ("Nested/OPS/Text/b.xhtml", b"second"),
            ],
        );
        let mut bytes = fs::read(&source).unwrap();
        // Many Japanese tools write UTF-8 names without the UTF-8 flag. JSZip still reads them
        // as UTF-8, where the zip crate reads code page 437.
        for central in [false, true] {
            let at = header_start(&bytes, central, "Nested/OPS/Text/章.xhtml");
            bytes[at + if central { 9 } else { 7 }] &= !0x08;
        }
        // A later duplicate name replaces the earlier entry, in JSZip's order.
        for central in [false, true] {
            let at = header_start(&bytes, central, "Nested/OPS/Text/b.xhtml");
            let name = at + if central { 46 } else { 30 };
            bytes[name..name + 23].copy_from_slice(b"Nested/OPS/Text/a.xhtml");
        }
        fs::write(&source, bytes).unwrap();
        assert!(ZipArchive::new(File::open(&source).unwrap())
            .unwrap()
            .file_names()
            .all(|name| name != "Nested/OPS/Text/章.xhtml"));
        catalog(&database, &id, &source);

        let path = book_path(&database, &archives, &id);
        let entries = index(&get(&database, &archives, &path));
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                CONTAINER,
                PACKAGE,
                CHAPTER,
                "Nested/OPS/Text/章.xhtml",
                "Nested/OPS/Text/a.xhtml"
            ]
        );
        assert_eq!(
            frames(&post(&database, &archives, &path, &[3, 4])),
            [Ok(b"unflagged".to_vec()), Ok(b"second".to_vec())]
        );
    }

    #[test]
    fn entries_are_read_within_declared_sizes_and_damage_is_refused() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("sizes.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        let long = "Long ".repeat(4096);
        let damaged = "Damaged ".repeat(4096);
        let truncated = "Truncated ".repeat(4096);
        let deflated = CompressionMethod::Deflated;
        fixture_compressed(
            &source,
            "Sizes",
            &[
                ("long.txt", long.as_bytes(), deflated),
                ("huge.txt", b"declared over the entry limit", deflated),
                ("damaged.txt", damaged.as_bytes(), deflated),
                ("truncated.txt", truncated.as_bytes(), deflated),
                ("short.txt", b"deflated, declared longer", deflated),
                (
                    "short-stored.txt",
                    b"stored, declared longer",
                    CompressionMethod::Stored,
                ),
            ],
        );
        // Declared sizes below the data's, and one over the entry limit.
        patch_central(&source, "long.txt", 24, &100u32.to_le_bytes());
        patch_central(
            &source,
            "huge.txt",
            24,
            &(MAX_ENTRY_BYTES as u32 + 1).to_le_bytes(),
        );
        let mut bytes = fs::read(&source).unwrap();
        let data = header_start(&bytes, false, "damaged.txt") + 30 + "damaged.txt".len();
        bytes[data..data + 16].fill(0xff);
        fs::write(&source, bytes).unwrap();
        // Compressed data that ends before its deflate stream does, and data shorter than declared.
        patch_central(&source, "truncated.txt", 20, &8u32.to_le_bytes());
        patch_central(&source, "short.txt", 24, &64u32.to_le_bytes());
        patch_central(&source, "short-stored.txt", 24, &64u32.to_le_bytes());
        catalog(&database, &id, &source);

        let path = book_path(&database, &archives, &id);
        let entries = index(&get(&database, &archives, &path));
        let long = number(&entries, "long.txt");
        let huge = number(&entries, "huge.txt");
        let damaged = number(&entries, "damaged.txt");
        let truncated = number(&entries, "truncated.txt");
        let short = number(&entries, "short.txt");
        let short_stored = number(&entries, "short-stored.txt");
        assert_eq!(entries[huge as usize].1, MAX_ENTRY_BYTES + 1);
        assert_eq!(entries[short_stored as usize].1, 64);
        for (entry, status) in [
            (long, StatusCode::PAYLOAD_TOO_LARGE),
            (huge, StatusCode::PAYLOAD_TOO_LARGE),
            (damaged, StatusCode::UNPROCESSABLE_ENTITY),
            (truncated, StatusCode::UNPROCESSABLE_ENTITY),
            (short, StatusCode::UNPROCESSABLE_ENTITY),
            (short_stored, StatusCode::UNPROCESSABLE_ENTITY),
        ] {
            assert_eq!(
                get(&database, &archives, &format!("{path}/{entry}")).status(),
                status
            );
        }
        // A bundle marks the refused entries and still serves the others.
        assert_eq!(
            frames(&post(
                &database,
                &archives,
                &path,
                &[long, huge, damaged, truncated, short, short_stored, 0]
            )),
            [
                Err(TOO_LARGE_FRAME),
                Err(TOO_LARGE_FRAME),
                Err(DAMAGED_FRAME),
                Err(DAMAGED_FRAME),
                Err(DAMAGED_FRAME),
                Err(DAMAGED_FRAME),
                Ok(checked(&source, CONTAINER))
            ]
        );
    }

    #[test]
    fn bundles_are_bounded() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("bundles.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture_with(
            &source,
            "Bundles",
            &[("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")],
        );
        // Each entry is within the entry limit; together they exceed one bundle.
        for name in ["a.txt", "b.txt", "c.txt"] {
            patch_central(&source, name, 24, &(30u32 * 1024 * 1024).to_le_bytes());
        }
        catalog(&database, &id, &source);
        let path = book_path(&database, &archives, &id);
        let entries = index(&get(&database, &archives, &path));
        let [a, b, c] = ["a.txt", "b.txt", "c.txt"].map(|name| number(&entries, name));
        assert_eq!(
            post(&database, &archives, &path, &[a, b, c]).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            post(&database, &archives, &path, &[0; MAX_BUNDLE_ENTRIES + 1]).status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&database, &archives, &path, &[0; MAX_BUNDLE_ENTRIES]).status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&database, &archives, &path, &[entries.len() as u32]).status(),
            StatusCode::NOT_FOUND
        );
        let uneven = request(Method::POST, &path, ORIGIN, vec![0; 3]);
        assert_eq!(
            handle_request(&database, &archives, &uneven).status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn encrypted_and_unsupported_entries_refuse_the_archive() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        let source = directory.path().join("refused.epub");
        catalog(&database, &id, &source);
        for (offset, value) in [(8, 0x01u16), (10, 14)] {
            // The encryption flag, then LZMA, which JSZip cannot read either.
            fixture_with(&source, "Refused", &[("extra.txt", b"extra")]);
            patch_central(&source, "extra.txt", offset, &value.to_le_bytes());
            assert_eq!(
                prepare(&database, &archives, &id).status,
                ContentStatus::Invalid
            );
        }
    }

    #[test]
    fn recovered_package_is_served_unchanged_and_unknown_xml_is_refused() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("recovered.epub");
        let database = directory.path().join("catalog.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        crate::library::tests::tolerance_fixture(
            &source,
            crate::library::tests::MISSING_DC_PACKAGE,
        );
        catalog(&database, &id, &source);
        let before = fs::read(&source).unwrap();
        let path = book_path(&database, &archives, &id);
        let entries = index(&get(&database, &archives, &path));
        let package = entries
            .iter()
            .position(|(name, _)| name.ends_with(".opf"))
            .unwrap();
        assert_eq!(
            get(&database, &archives, &format!("{path}/{package}")).body(),
            &checked(&source, &entries[package].0)
        );
        assert_eq!(fs::read(&source).unwrap(), before);
        crate::library::tests::tolerance_fixture(
            &source,
            "<package version=\"3\"><other:title>Unknown</other:title></package>",
        );
        assert_eq!(
            prepare(&database, &archives, &id).status,
            ContentStatus::Invalid
        );
        assert_eq!(
            get(&database, &archives, &path).status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn diagnostics_contain_only_catalog_ids_and_typed_statuses() {
        let id = Uuid::nil();
        for (status, label) in [
            (ContentStatus::Unknown, "Unknown"),
            (ContentStatus::Missing, "Missing"),
            (ContentStatus::Unreadable, "Unreadable"),
            (ContentStatus::Invalid, "Invalid"),
            (ContentStatus::TooLarge, "TooLarge"),
            (ContentStatus::Failed, "Failed"),
        ] {
            assert_eq!(
                content_diagnostic(Some(id), &status),
                format!("Komori Reader content {id}: {label}")
            );
        }
        assert_eq!(
            content_diagnostic(
                Uuid::parse_str("../private-source.epub").ok(),
                &ContentStatus::Failed
            ),
            "Komori Reader content unknown: Failed"
        );
    }

    #[test]
    fn typed_failures_have_no_private_paths() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("private-source.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture(&source, "One");
        catalog(&database, &id, &source);

        assert_eq!(
            prepare(&database, &archives, &Uuid::new_v4().to_string()).status,
            ContentStatus::Unknown
        );
        assert_eq!(
            prepare(&database, &archives, "../private-source.epub").status,
            ContentStatus::Unknown
        );
        fs::remove_file(&source).unwrap();
        assert_eq!(
            prepare(&database, &archives, &id).status,
            ContentStatus::Missing
        );
        fs::create_dir(&source).unwrap();
        assert_eq!(
            prepare(&database, &archives, &id).status,
            ContentStatus::Unreadable
        );
        fs::remove_dir(&source).unwrap();
        fs::write(&source, b"not an EPUB").unwrap();
        assert_eq!(
            prepare(&database, &archives, &id).status,
            ContentStatus::Invalid
        );
        assert_eq!(
            prepare(&directory.path().join("missing.sqlite3"), &archives, &id).status,
            ContentStatus::Failed
        );
        for status in [
            ContentStatus::Unknown,
            ContentStatus::Missing,
            ContentStatus::Unreadable,
            ContentStatus::Invalid,
            ContentStatus::TooLarge,
            ContentStatus::Failed,
        ] {
            let encoded = serde_json::to_string(&ContentAccess::failure(status)).unwrap();
            assert!(!encoded.contains("private-source"));
            assert!(!encoded.contains("source_path"));
            assert!(encoded.contains("\"url\":null"));
        }
    }

    #[test]
    fn protocol_rejects_other_origins_methods_and_path_shapes() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("book.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture(&source, "One");
        catalog(&database, &id, &source);
        let path = book_path(&database, &archives, &id);
        let stamp = path.rsplit_once('/').unwrap().1.to_owned();
        let other = request(Method::GET, &path, "https://other.example", Vec::new());
        assert_eq!(
            handle_request(&database, &archives, &other).status(),
            StatusCode::FORBIDDEN
        );
        for method in [Method::PUT, Method::DELETE, Method::OPTIONS] {
            let request = request(method, &path, ORIGIN, Vec::new());
            assert_eq!(
                handle_request(&database, &archives, &request).status(),
                StatusCode::FORBIDDEN
            );
        }
        for bad in [
            format!("/{id}"),
            format!("/{id}/"),
            format!("/{id}/0000000000000000"),
            format!("/{id}/{}", "A".repeat(16)),
            format!("/{id}/{stamp}0"),
            format!("/{id}/{stamp}/"),
            format!("/{id}/{stamp}/x"),
            format!("/{id}/{stamp}/+1"),
            format!("/{id}/{stamp}/9"),
            format!("/{id}/{stamp}/0/0"),
            format!("/{id}/{stamp}?entry=0"),
            format!("/{id}/{stamp}/{CHAPTER}"),
            format!("/..%2Fbook.epub/{stamp}"),
            format!("/not-a-catalog-id/{stamp}"),
            format!("/book.epub/{stamp}/0"),
        ] {
            assert_eq!(
                get(&database, &archives, &bad).status(),
                StatusCode::NOT_FOUND,
                "{bad}"
            );
        }
        let entry_post = request(Method::POST, &format!("{path}/0"), ORIGIN, vec![0; 4]);
        assert_eq!(
            handle_request(&database, &archives, &entry_post).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn every_request_resolves_the_current_catalog_source() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.epub");
        let second = directory.path().join("second.epub");
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let id = Uuid::new_v4().to_string();
        fixture(&first, "One");
        fixture(&second, "Two");
        catalog(&database, &id, &first);
        let original = fs::read(&first).unwrap();
        let first_path = book_path(&database, &archives, &id);
        let package = |path: &str| {
            let entries = index(&get(&database, &archives, path));
            let package = number(&entries, PACKAGE);
            get(&database, &archives, &format!("{path}/{package}"))
                .body()
                .clone()
        };
        assert_eq!(package(&first_path), checked(&first, PACKAGE));

        // A relinked source has a new stamp; numbers from the old index are not served.
        relink(&database, &id, &second);
        assert_eq!(
            get(&database, &archives, &format!("{first_path}/0")).status(),
            StatusCode::NOT_FOUND
        );
        let second_path = book_path(&database, &archives, &id);
        assert_ne!(second_path, first_path);
        assert_eq!(package(&second_path), checked(&second, PACKAGE));

        // So does a source changed in place.
        fixture_with(&second, "Two", &[("added.txt", b"added")]);
        assert_eq!(
            get(&database, &archives, &second_path).status(),
            StatusCode::NOT_FOUND
        );
        let changed_path = book_path(&database, &archives, &id);
        assert_ne!(changed_path, second_path);
        assert_eq!(index(&get(&database, &archives, &changed_path)).len(), 4);

        Connection::open(&database)
            .unwrap()
            .execute("DELETE FROM books WHERE id = ?1", [&id])
            .unwrap();
        assert_eq!(
            get(&database, &archives, &changed_path).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(fs::read(&first).unwrap(), original);
    }

    #[test]
    fn open_archives_are_reused_and_bounded() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let archives = ReaderArchives::default();
        let ids: Vec<String> = (0..=OPEN_ARCHIVES)
            .map(|index| {
                let id = Uuid::new_v4().to_string();
                let source = directory.path().join(format!("{index}.epub"));
                fixture(&source, "Book");
                if index == 0 {
                    catalog(&database, &id, &source);
                } else {
                    Connection::open(&database)
                        .unwrap()
                        .execute(
                            "INSERT INTO books (id, source_path) VALUES (?1, ?2)",
                            rusqlite::params![id, source.to_string_lossy()],
                        )
                        .unwrap();
                }
                id
            })
            .collect();
        let first = archives.resolve(&database, &ids[0]).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &archives.resolve(&database, &ids[0]).unwrap()
        ));
        for id in &ids[1..] {
            archives.resolve(&database, id).unwrap();
        }
        let open = archives.0.open.lock().unwrap();
        assert_eq!(open.len(), OPEN_ARCHIVES);
        assert!(open.iter().all(|archive| !Arc::ptr_eq(archive, &first)));
        drop(open);
        // The stamp of an unchanged source survives reopening.
        assert_eq!(
            archives.resolve(&database, &ids[0]).unwrap().stamp,
            first.stamp
        );
    }

    #[test]
    #[ignore = "reads only explicitly selected external EPUB samples"]
    fn real_corpus_content_smoke() {
        let samples = std::env::var("KOMORI_EPUB_SAMPLES").expect("set sample EPUB paths");
        let directory = tempdir().unwrap();
        for (sample, path) in samples.split('|').enumerate() {
            let source = Path::new(path);
            let before = Sha256::digest(fs::read(source).unwrap());
            let database = directory.path().join(format!("sample-{sample}.sqlite3"));
            let archives = ReaderArchives::default();
            let id = Uuid::new_v4().to_string();
            catalog(&database, &id, source);
            let started = std::time::Instant::now();
            let book = book_path(&database, &archives, &id);
            let opened = started.elapsed();
            let entries = index(&get(&database, &archives, &book));
            let listed = started.elapsed();
            let mut checked_archive = ZipArchive::new(File::open(source).unwrap()).unwrap();
            let mut served = 0;
            for (number, (name, size)) in entries.iter().enumerate() {
                if *size > MAX_ENTRY_BYTES {
                    continue;
                }
                let response = get(&database, &archives, &format!("{book}/{number}"));
                assert_eq!(response.status(), StatusCode::OK, "{name}");
                let mut expected = Vec::new();
                if let Some(at) = checked_archive.index_for_name(name) {
                    checked_archive
                        .by_index(at)
                        .unwrap()
                        .read_to_end(&mut expected)
                        .unwrap();
                    assert_eq!(response.body(), &expected, "{name}");
                }
                served += response.body().len();
            }
            assert_eq!(Sha256::digest(fs::read(source).unwrap()), before);
            println!(
                "sample {sample}: {} entries, {served} bytes; opened in {opened:?}, listed in {listed:?}; source SHA-256 unchanged",
                entries.len()
            );
        }
    }

    #[test]
    #[ignore = "reads one available record from an explicitly selected Library database"]
    fn real_library_content_smoke() {
        let database = std::env::var("KOMORI_LIBRARY_DATABASE").expect("set Library database");
        let connection =
            Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let records = connection
            .prepare("SELECT id, source_path FROM books ORDER BY imported_at DESC")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let (id, source) = records
            .into_iter()
            .find(|(_, source)| Path::new(source).is_file())
            .expect("Library needs an available EPUB record");
        let before = Sha256::digest(fs::read(&source).unwrap());
        let archives = ReaderArchives::default();
        let access = prepare(Path::new(&database), &archives, &id);
        assert_eq!(access.status, ContentStatus::Ready);
        assert!(!serde_json::to_string(&access).unwrap().contains(&source));
        let book = book_path(Path::new(&database), &archives, &id);
        let entries = index(&get(Path::new(&database), &archives, &book));
        assert!(!entries.is_empty());
        assert_eq!(Sha256::digest(fs::read(&source).unwrap()), before);
        println!(
            "Library catalog ID {id}: {} entries; source SHA-256 unchanged",
            entries.len()
        );
    }
}
