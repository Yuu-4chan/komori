//! Settings > Devices: the PC's server for paired phones. It is off until the reader allows
//! devices, then serves HTTPS on one port with the PC's own certificate (made once and kept in
//! the catalog's preferences), pairs a phone with the code it shows (see `protocol`), and answers
//! paired phones with the Library's books and the installed dictionaries, by ID, never by path,
//! and with the reading state they sync (see `sync`).
#![cfg_attr(mobile, allow(dead_code))]

pub(crate) mod client;
mod http;
pub(crate) mod protocol;

use std::{
    cell::Cell,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use rusqlite::{Connection, OptionalExtension};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Tells the PC's pages that something changed, by the event they listen for.
type Notify = Box<dyn Fn(&'static str) + Send + Sync>;
const DEVICES_EVENT: &str = "devices-changed";
use uuid::Uuid;

use crate::library::{open_catalog, storage_error};
use crate::reading_sessions::ReadingDevice;
use protocol::{decode, encode, Hello, PairFinish, PairStart, PairStarted, Paired};

const SETTINGS: &str = "devices";
const IDENTITY: &str = "devices-identity";
/// The PC's own device ID, which the sessions it read carry on a phone.
const SELF: &str = "devices-self";
/// Connections answered at once; more are closed.
const CONNECTIONS: usize = 32;
/// Connections answered at once from one address, so no one host takes them all.
const PER_ADDRESS: usize = 8;
/// How long a connection has for its whole request (its TLS handshake, head and small body), so
/// one that sends slowly or not at all cannot keep its place.
#[cfg(not(test))]
const REQUEST_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
const REQUEST_WAIT: Duration = Duration::from_secs(2);
/// How long one read waits once a paired phone's large sync is on its way.
const READ_WAIT: Duration = Duration::from_secs(20);
/// How long a started pairing waits for its proof.
const PAIRING_WAIT: Duration = Duration::from_secs(120);
/// How long a wrong code waits for its answer, so codes cannot be tried quickly.
#[cfg(not(test))]
const WRONG_CODE_WAIT: Duration = Duration::from_secs(1);
#[cfg(test)]
const WRONG_CODE_WAIT: Duration = Duration::from_millis(200);
/// A device's last connection is written at most this often.
const SEEN_EVERY: Duration = Duration::from_secs(60);
const DEVICE_NAME_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    allowed: bool,
    port: u16,
    #[serde(default)]
    devices: Vec<Device>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            allowed: false,
            port: protocol::DEFAULT_PORT,
            devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    /// The SHA-256 of the device's token; the token itself is only on the phone.
    token_hash: String,
    paired_at: String,
    last_seen_at: Option<String>,
    #[serde(default)]
    last_synced_at: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct IdentityRecord {
    certificate: String,
    key: String,
}

struct Identity {
    certificate: Vec<u8>,
    key: Vec<u8>,
}

/// Settings > Devices as the page shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesView {
    allowed: bool,
    port: u16,
    /// The PC's address on its network, when it has one.
    address: Option<String>,
    /// The code a phone pairs with, while devices are allowed, the server runs and pairing is
    /// not stopped.
    code: Option<String>,
    /// Whether pairing stopped after too many wrong codes, until a new code.
    pairing_locked: bool,
    /// `off`, `listening`, `portInUse` or `failed`.
    status: &'static str,
    devices: Vec<DeviceView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceView {
    id: String,
    name: String,
    paired_at: String,
    last_seen_at: Option<String>,
    last_synced_at: Option<String>,
}

struct Pending {
    session: String,
    key: Vec<u8>,
    device: String,
    started: Instant,
}

struct Server {
    port: u16,
    /// Where a connection reaches the listener, to wake its blocking accept when stopping.
    wake: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // The accept waits for a connection, so one wakes it to see the stop. Without one the
        // thread ends at the next phone's connection instead, and is not waited for.
        let woke = TcpStream::connect_timeout(&self.wake, Duration::from_secs(2)).is_ok();
        if let Some(thread) = self.thread.take() {
            if woke {
                let _ = thread.join();
            }
        }
    }
}

#[derive(Default)]
struct Runtime {
    server: Option<Server>,
    failure: Option<&'static str>,
    code: String,
    /// Wrong codes since the code was made.
    attempts: u32,
    pending: Option<Pending>,
    /// When each device's last connection was written.
    seen: Vec<(String, Instant)>,
}

impl Runtime {
    /// Whether pairing stopped after too many wrong codes: it waits for a new code, so the code
    /// cannot be guessed from the network.
    fn locked(&self) -> bool {
        self.attempts >= protocol::PAIRING_ATTEMPTS
    }
}

pub(crate) struct Shared {
    catalog: PathBuf,
    dictionaries: PathBuf,
    /// Where the server listens: every interface for phones, loopback in tests.
    bind: IpAddr,
    notify: Option<Notify>,
    runtime: Mutex<Runtime>,
    /// Settings changes, from the page and from the server's threads, one at a time.
    settings: Mutex<()>,
    /// The address of each connection being answered.
    connections: Mutex<Vec<IpAddr>>,
}

pub struct DevicesState(Arc<Shared>);

impl Shared {
    fn new(catalog: PathBuf, dictionaries: PathBuf, bind: IpAddr, notify: Option<Notify>) -> Self {
        Self {
            catalog,
            dictionaries,
            bind,
            notify,
            runtime: Mutex::new(Runtime::default()),
            settings: Mutex::new(()),
            connections: Mutex::new(Vec::new()),
        }
    }

    fn changed(&self) {
        self.emit(DEVICES_EVENT);
    }

    fn emit(&self, event: &'static str) {
        if let Some(notify) = &self.notify {
            notify(event);
        }
    }

    fn connections(&self) -> std::sync::MutexGuard<'_, Vec<IpAddr>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn runtime(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let _guard = self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let connection = open_catalog(&self.catalog)?;
        let mut settings = load_settings(&connection)?;
        change(&mut settings);
        save_record(&connection, SETTINGS, &settings)?;
        Ok(settings)
    }
}

fn load_record<T: for<'de> Deserialize<'de>>(
    connection: &Connection,
    name: &str,
) -> Result<Option<T>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
}

fn save_record(connection: &Connection, name: &str, value: &impl Serialize) -> Result<(), String> {
    let value = serde_json::to_string(value).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [name, &value],
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn load_settings(connection: &Connection) -> Result<Settings, String> {
    Ok(load_record(connection, SETTINGS)?.unwrap_or_default())
}

fn now(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(storage_error)
}

/// The PC's own device ID, made the first time a phone syncs.
fn own_device(connection: &Connection) -> Result<String, String> {
    #[derive(Serialize, Deserialize)]
    struct Own {
        id: String,
    }
    if let Some(own) = load_record::<Own>(connection, SELF)? {
        if Uuid::parse_str(&own.id).is_ok() {
            return Ok(own.id);
        }
    }
    let id = Uuid::new_v4().to_string();
    save_record(connection, SELF, &Own { id: id.clone() })?;
    Ok(id)
}

/// The PC's certificate and key, made the first time devices are allowed.
fn identity(connection: &Connection) -> Result<Identity, String> {
    if let Some(record) = load_record::<IdentityRecord>(connection, IDENTITY)? {
        if let (Some(certificate), Some(key)) = (decode(&record.certificate), decode(&record.key)) {
            return Ok(Identity { certificate, key });
        }
    }
    let made = rcgen::generate_simple_self_signed(vec!["komori.local".to_owned()])
        .map_err(|error| format!("The PC's certificate could not be made: {error}"))?;
    let identity = Identity {
        certificate: made.cert.der().to_vec(),
        key: made.signing_key.serialize_der(),
    };
    save_record(
        connection,
        IDENTITY,
        &IdentityRecord {
            certificate: encode(&identity.certificate),
            key: encode(&identity.key),
        },
    )?;
    Ok(identity)
}

fn tls_config(identity: &Identity) -> Result<rustls::ServerConfig, String> {
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|error| error.to_string())?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(identity.certificate.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(identity.key.clone())),
        )
        .map_err(|error| error.to_string())
}

/// The name phones show for this PC: the computer's own.
pub(crate) fn pc_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Komori PC".to_owned())
}

/// The PC's address on the network it reaches others through; no packet is sent.
fn local_address() -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_unspecified() && !address.is_loopback()).then(|| address.to_string())
}

fn start_server(shared: &Arc<Shared>, port: u16) -> Result<Server, &'static str> {
    let identity = open_catalog(&shared.catalog)
        .and_then(|connection| identity(&connection))
        .map_err(|error| {
            eprintln!("Komori devices could not start: {error}");
            "failed"
        })?;
    let config = Arc::new(tls_config(&identity).map_err(|error| {
        eprintln!("Komori devices could not start: {error}");
        "failed"
    })?);
    let fingerprint = protocol::fingerprint(&identity.certificate);
    let listener = TcpListener::bind(SocketAddr::new(shared.bind, port)).map_err(|error| {
        if error.kind() == io::ErrorKind::AddrInUse {
            "portInUse"
        } else {
            eprintln!("Komori devices could not listen: {error}");
            "failed"
        }
    })?;
    let port = listener.local_addr().map_or(port, |address| address.port());
    let stop = Arc::new(AtomicBool::new(false));
    // A blocking accept answers a phone the moment it connects; polling would make every
    // request wait for the next poll.
    let thread = {
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || {
            for accepted in listener.incoming() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = accepted else {
                    // Out of sockets or similar: try again shortly rather than spin.
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                };
                let Some(slot) = stream
                    .peer_addr()
                    .ok()
                    .and_then(|peer| Slot::take(&shared, peer.ip()))
                else {
                    continue;
                };
                let (shared, config) = (shared.clone(), config.clone());
                std::thread::spawn(move || {
                    serve(&shared, config, fingerprint, stream);
                    drop(slot);
                });
            }
        })
    };
    Ok(Server {
        port,
        wake: SocketAddr::new(wake_address(shared.bind), port),
        stop,
        thread: Some(thread),
    })
}

/// A connection's place among those answered at once; it frees the place when dropped.
struct Slot {
    shared: Arc<Shared>,
    address: IpAddr,
}

impl Slot {
    /// A place for a connection from `address`, unless all are taken or that address has its
    /// share.
    fn take(shared: &Arc<Shared>, address: IpAddr) -> Option<Self> {
        let mut open = shared.connections();
        if open.len() >= CONNECTIONS
            || open.iter().filter(|other| **other == address).count() >= PER_ADDRESS
        {
            return None;
        }
        open.push(address);
        Some(Self {
            shared: shared.clone(),
            address,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut open = self.shared.connections();
        if let Some(index) = open.iter().position(|other| *other == self.address) {
            open.swap_remove(index);
        }
    }
}

/// A connection's socket, whose reads end at the request's deadline until that is lifted.
struct Timed {
    stream: TcpStream,
    deadline: Rc<Cell<Option<Instant>>>,
    /// Whether the socket's read timeout follows the deadline.
    bounded: bool,
}

impl Read for Timed {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.deadline.get() {
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                self.stream.set_read_timeout(Some(left.min(READ_WAIT)))?;
            }
            None if self.bounded => {
                self.stream.set_read_timeout(Some(READ_WAIT))?;
                self.bounded = false;
            }
            None => {}
        }
        self.stream.read(buffer)
    }
}

impl Write for Timed {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

/// The address that reaches a listener bound to `bind`: loopback for an unspecified one.
fn wake_address(bind: IpAddr) -> IpAddr {
    match bind {
        IpAddr::V4(address) if address.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(address) if address.is_unspecified() => {
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        }
        address => address,
    }
}

/// Starts or stops the server to match the saved settings, with a fresh code when it starts.
fn apply(shared: &Arc<Shared>, settings: &Settings) {
    let mut runtime = shared.runtime();
    let running = runtime.server.as_ref().map(|server| server.port);
    if !settings.allowed {
        runtime.server = None;
        runtime.failure = None;
        runtime.pending = None;
        return;
    }
    if running == Some(settings.port) {
        return;
    }
    runtime.server = None;
    match start_server(shared, settings.port) {
        Ok(server) => {
            runtime.server = Some(server);
            runtime.failure = None;
            runtime.code = protocol::pairing_code();
            runtime.attempts = 0;
            runtime.pending = None;
        }
        Err(failure) => runtime.failure = Some(failure),
    }
}

fn view(shared: &Shared) -> Result<DevicesView, String> {
    let settings = load_settings(&open_catalog(&shared.catalog)?)?;
    let runtime = shared.runtime();
    let listening = runtime.server.is_some();
    let locked = listening && runtime.locked();
    Ok(DevicesView {
        allowed: settings.allowed,
        port: settings.port,
        address: local_address(),
        code: (listening && !locked).then(|| runtime.code.clone()),
        pairing_locked: locked,
        status: if !settings.allowed {
            "off"
        } else if listening {
            "listening"
        } else {
            runtime.failure.unwrap_or("failed")
        },
        devices: settings
            .devices
            .into_iter()
            .map(|device| DeviceView {
                id: device.id,
                name: device.name,
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
                last_synced_at: device.last_synced_at,
            })
            .collect(),
    })
}

fn serve(
    shared: &Shared,
    config: Arc<rustls::ServerConfig>,
    certificate: [u8; 32],
    stream: TcpStream,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let Ok(connection) = rustls::ServerConnection::new(config) else {
        return;
    };
    let deadline = Rc::new(Cell::new(Some(Instant::now() + REQUEST_WAIT)));
    let socket = Timed {
        stream,
        deadline: deadline.clone(),
        bounded: true,
    };
    let mut tls = rustls::StreamOwned::new(connection, socket);
    let limit = |method: &str, path: &str, token: Option<&str>| {
        if method == "POST"
            && path.starts_with("/v1/sync/")
            && authenticate(shared, token).is_some()
        {
            // A paired phone's large sync may take longer than the deadline on a slow network.
            deadline.set(None);
            http::SYNC_BODY_LIMIT
        } else {
            http::BODY_LIMIT
        }
    };
    match http::read_request(&mut tls, limit) {
        Ok(request) => {
            if let Err(error) = route(shared, &certificate, &request, &mut tls) {
                eprintln!("Komori devices could not answer {}: {error}", request.path);
            }
        }
        Err(http::ReadError::Closed) => return,
        Err(_) => {
            let _ = http::respond(&mut tls, 400, "text/plain", b"");
        }
    }
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

fn error(stream: &mut impl Write, status: u16, code: &str) -> io::Result<()> {
    http::respond_json(stream, status, &serde_json::json!({ "error": code }))
}

fn route(
    shared: &Shared,
    certificate: &[u8; 32],
    request: &http::Request,
    stream: &mut impl Write,
) -> io::Result<()> {
    let path = request.path.as_str();
    match (request.method.as_str(), path) {
        ("GET", "/v1/hello") => {
            // Anyone on the network learns only that Komori answers; a paired phone, its name.
            let name = authenticate(shared, request.authorization.as_deref()).map(|_| pc_name());
            return http::respond_json(
                stream,
                200,
                &Hello {
                    protocol: protocol::PROTOCOL,
                    name,
                },
            );
        }
        ("POST", "/v1/pair/start") => return pair_start(shared, request, stream),
        ("POST", "/v1/pair/finish") => return pair_finish(shared, certificate, request, stream),
        _ => {}
    }
    let Some(device) = authenticate(shared, request.authorization.as_deref()) else {
        return error(stream, 401, "notPaired");
    };
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["v1", "library"]) => {
            let books = open_catalog(&shared.catalog)
                .and_then(|connection| crate::library::remote_books(&connection));
            match books {
                Ok(books) => http::respond_json(stream, 200, &protocol::RemoteLibrary { books }),
                Err(message) => {
                    eprintln!("Komori devices could not list the Library: {message}");
                    error(stream, 500, "failed")
                }
            }
        }
        ("GET", ["v1", "library", "kanji"]) => {
            let kanji = open_catalog(&shared.catalog)
                .and_then(|connection| crate::reading_sessions::kanji_from(&connection));
            match kanji {
                Ok(kanji) => http::respond_json(stream, 200, &kanji),
                Err(message) => {
                    eprintln!("Komori devices could not list the Library's kanji: {message}");
                    error(stream, 500, "failed")
                }
            }
        }
        ("GET", ["v1", "books", id, "cover"]) => {
            let cover = Uuid::parse_str(id)
                .ok()
                .and_then(|_| open_catalog(&shared.catalog).ok())
                .and_then(|connection| crate::covers::load_thumbnail(&connection, id).ok())
                .flatten();
            match cover {
                Some((_, cover)) => http::respond(stream, 200, &cover.mime, &cover.bytes),
                None => error(stream, 404, "notFound"),
            }
        }
        ("GET", ["v1", "books", id, "file"]) => {
            let source = Uuid::parse_str(id)
                .ok()
                .and_then(|_| open_catalog(&shared.catalog).ok())
                .and_then(|connection| crate::library::source_of(&connection, id).ok())
                .flatten();
            let Some(source) = source else {
                return error(stream, 404, "notFound");
            };
            let opened = crate::book_source::open(&source)
                .and_then(|file| Ok((file.metadata()?.len(), file)));
            match opened {
                Ok((length, mut file)) => {
                    http::respond_stream(stream, "application/epub+zip", length, &mut file)
                }
                Err(_) => error(stream, 404, "notFound"),
            }
        }
        ("GET", ["v1", "dictionaries"]) => {
            match crate::dictionary::store::remote_dictionaries(&shared.dictionaries) {
                Ok(dictionaries) => http::respond_json(stream, 200, &dictionaries),
                Err(message) => {
                    eprintln!("Komori devices could not list dictionaries: {message}");
                    error(stream, 500, "failed")
                }
            }
        }
        ("GET", ["v1", "dictionaries", id, "pack"]) => {
            let Ok(id) = id.parse::<i64>() else {
                return error(stream, 404, "notFound");
            };
            let pack = std::env::temp_dir().join(format!("komori-pack-{}.sqlite3", Uuid::new_v4()));
            let written = crate::dictionary::store::write_pack(&shared.dictionaries, id, &pack);
            let result = match written {
                Ok(true) => match std::fs::File::open(&pack)
                    .and_then(|file| Ok((file.metadata()?.len(), file)))
                {
                    Ok((length, mut file)) => {
                        http::respond_stream(stream, "application/vnd.sqlite3", length, &mut file)
                    }
                    Err(_) => error(stream, 500, "failed"),
                },
                Ok(false) => error(stream, 404, "notFound"),
                Err(message) => {
                    eprintln!("Komori devices could not pack a dictionary: {message}");
                    error(stream, 500, "failed")
                }
            };
            let _ = std::fs::remove_file(&pack);
            result
        }
        ("POST", ["v1", "sync", "pull"]) => sync_pull(shared, request, stream),
        ("POST", ["v1", "sync", "push"]) => sync_push(shared, &device, request, stream),
        ("DELETE", ["v1", "device"]) => {
            let removed = shared.update(|settings| {
                settings.devices.retain(|known| known.id != device);
            });
            shared.changed();
            match removed {
                Ok(_) => http::respond_json(stream, 200, &serde_json::json!({})),
                Err(_) => error(stream, 500, "failed"),
            }
        }
        _ => error(stream, 404, "notFound"),
    }
}

/// The paired phones by name, as their sessions show in Statistics.
fn phones(connection: &Connection) -> Result<Vec<ReadingDevice>, String> {
    Ok(load_settings(connection)?
        .devices
        .into_iter()
        .map(|device| ReadingDevice {
            id: device.id,
            name: device.name,
        })
        .collect())
}

fn sync_pull(shared: &Shared, request: &http::Request, stream: &mut impl Write) -> io::Result<()> {
    let Ok(pull) = serde_json::from_slice::<crate::sync::PullRequest>(&request.body) else {
        return error(stream, 400, "malformed");
    };
    let answer = open_catalog(&shared.catalog).and_then(|connection| {
        let own = ReadingDevice {
            id: own_device(&connection)?,
            name: pc_name(),
        };
        crate::sync::pull(&connection, &own, &phones(&connection)?, &pull)
    });
    match answer {
        Ok(answer) => http::respond_json(stream, 200, &answer),
        Err(message) => {
            eprintln!("Komori devices could not answer a sync: {message}");
            error(stream, 500, "failed")
        }
    }
}

fn sync_push(
    shared: &Shared,
    device: &str,
    request: &http::Request,
    stream: &mut impl Write,
) -> io::Result<()> {
    let Ok(push) = serde_json::from_slice::<crate::sync::PushRequest>(&request.body) else {
        return error(stream, 400, "malformed");
    };
    let answer = open_catalog(&shared.catalog).and_then(|mut connection| {
        let own = own_device(&connection)?;
        let phone = phones(&connection)?
            .into_iter()
            .find(|phone| phone.id == device)
            .ok_or_else(|| "The phone is no longer paired.".to_owned())?;
        let answer = crate::sync::push(&mut connection, &own, &phone, &push)?;
        let at = now(&connection)?;
        shared.update(|settings| {
            if let Some(known) = settings.devices.iter_mut().find(|known| known.id == device) {
                known.last_synced_at = Some(at);
            }
        })?;
        Ok(answer)
    });
    match answer {
        Ok(answer) => {
            shared.changed();
            // The Library and Statistics show what the phone read.
            shared.emit(crate::book_details::DETAILS_EVENT);
            http::respond_json(stream, 200, &answer)
        }
        Err(message) => {
            eprintln!("Komori devices could not take a sync: {message}");
            error(stream, 500, "failed")
        }
    }
}

/// The paired device a token belongs to, noting when it last connected.
fn authenticate(shared: &Shared, token: Option<&str>) -> Option<String> {
    let token = decode(token?)?;
    let hash = protocol::hash_token(&token);
    let connection = open_catalog(&shared.catalog).ok()?;
    let device = load_settings(&connection)
        .ok()?
        .devices
        .into_iter()
        .find(|device| device.token_hash == hash)?;
    let due = {
        let mut runtime = shared.runtime();
        let due = runtime
            .seen
            .iter()
            .find(|(id, _)| *id == device.id)
            .is_none_or(|(_, at)| at.elapsed() >= SEEN_EVERY);
        if due {
            runtime.seen.retain(|(id, _)| *id != device.id);
            runtime.seen.push((device.id.clone(), Instant::now()));
        }
        due
    };
    if due {
        if let Ok(at) = now(&connection) {
            let id = device.id.clone();
            if shared
                .update(|settings| {
                    if let Some(known) = settings.devices.iter_mut().find(|known| known.id == id) {
                        known.last_seen_at = Some(at);
                    }
                })
                .is_ok()
            {
                shared.changed();
            }
        }
    }
    Some(device.id)
}

fn pair_start(shared: &Shared, request: &http::Request, stream: &mut impl Write) -> io::Result<()> {
    let Some((start, message)) = serde_json::from_slice::<PairStart>(&request.body)
        .ok()
        .and_then(|start| decode(&start.message).map(|message| (start, message)))
    else {
        return error(stream, 400, "malformed");
    };
    let mut runtime = shared.runtime();
    if runtime.locked() {
        return error(stream, 403, "pairingLocked");
    }
    let (state, answer) = protocol::start_pc(&runtime.code);
    let Ok(key) = state.finish(&message) else {
        return error(stream, 400, "malformed");
    };
    let name: String = start
        .device
        .trim()
        .chars()
        .take(DEVICE_NAME_LIMIT)
        .collect();
    let session = Uuid::new_v4().to_string();
    runtime.pending = Some(Pending {
        session: session.clone(),
        key,
        device: if name.is_empty() {
            "Phone".into()
        } else {
            name
        },
        started: Instant::now(),
    });
    drop(runtime);
    http::respond_json(
        stream,
        200,
        &PairStarted {
            message: encode(&answer),
            session,
        },
    )
}

fn pair_finish(
    shared: &Shared,
    certificate: &[u8; 32],
    request: &http::Request,
    stream: &mut impl Write,
) -> io::Result<()> {
    let Some((finish, proof)) = serde_json::from_slice::<PairFinish>(&request.body)
        .ok()
        .and_then(|finish| decode(&finish.proof).map(|proof| (finish, proof)))
    else {
        return error(stream, 400, "malformed");
    };
    let mut runtime = shared.runtime();
    if runtime.locked() {
        return error(stream, 403, "pairingLocked");
    }
    let pending = runtime.pending.take_if(|pending| {
        pending.session == finish.session && pending.started.elapsed() < PAIRING_WAIT
    });
    let Some(pending) = pending else {
        return error(stream, 409, "noPairing");
    };
    if !protocol::phone_proof_matches(&pending.key, certificate, &proof) {
        // The last wrong code stops pairing until the user asks for a new code.
        runtime.attempts += 1;
        drop(runtime);
        shared.changed();
        std::thread::sleep(WRONG_CODE_WAIT);
        return error(stream, 403, "wrongCode");
    }
    // A code pairs one phone; the next gets a new one.
    runtime.code = protocol::pairing_code();
    runtime.attempts = 0;
    drop(runtime);
    let token = protocol::random_bytes::<32>();
    let id = Uuid::new_v4().to_string();
    let paired = open_catalog(&shared.catalog)
        .and_then(|connection| now(&connection))
        .and_then(|at| {
            shared.update(|settings| {
                settings.devices.push(Device {
                    id: id.clone(),
                    name: pending.device.clone(),
                    token_hash: protocol::hash_token(&token),
                    paired_at: at.clone(),
                    last_seen_at: Some(at),
                    last_synced_at: None,
                })
            })
        });
    shared.changed();
    if paired.is_err() {
        return error(stream, 500, "failed");
    }
    http::respond_json(
        stream,
        200,
        &Paired {
            proof: encode(&protocol::pc_proof(&pending.key, certificate)),
            token: encode(&token),
            device: id,
            name: pc_name(),
        },
    )
}

/// Starts the server at launch when devices are allowed.
pub fn start(catalog: PathBuf, dictionaries: PathBuf, app: AppHandle) -> DevicesState {
    let shared = Arc::new(Shared::new(
        catalog,
        dictionaries,
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        Some(Box::new(move |event| {
            let _ = app.emit(event, ());
        })),
    ));
    let starting = shared.clone();
    std::thread::spawn(move || {
        match open_catalog(&starting.catalog).and_then(|connection| load_settings(&connection)) {
            Ok(settings) if settings.allowed => {
                apply(&starting, &settings);
                starting.changed();
            }
            Ok(_) => {}
            Err(error) => eprintln!("Komori devices settings could not be read: {error}"),
        }
    });
    DevicesState(shared)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_devices(devices: State<'_, DevicesState>) -> Result<DevicesView, String> {
    let shared = devices.0.clone();
    blocking(move || view(&shared)).await
}

#[tauri::command]
pub async fn set_devices_allowed(
    devices: State<'_, DevicesState>,
    allowed: bool,
) -> Result<DevicesView, String> {
    let shared = devices.0.clone();
    blocking(move || {
        let settings = shared.update(|settings| settings.allowed = allowed)?;
        apply(&shared, &settings);
        view(&shared)
    })
    .await
}

#[tauri::command]
pub async fn set_devices_port(
    devices: State<'_, DevicesState>,
    port: u16,
) -> Result<DevicesView, String> {
    if port < 1024 {
        return Err("The port must be between 1024 and 65535.".into());
    }
    let shared = devices.0.clone();
    blocking(move || {
        let settings = shared.update(|settings| settings.port = port)?;
        apply(&shared, &settings);
        view(&shared)
    })
    .await
}

/// A fresh code while the server runs, which also lets pairing start again after too many wrong
/// codes.
fn new_code(shared: &Shared) {
    let mut runtime = shared.runtime();
    if runtime.server.is_some() {
        runtime.code = protocol::pairing_code();
        runtime.attempts = 0;
        runtime.pending = None;
    }
}

#[tauri::command]
pub async fn new_pairing_code(devices: State<'_, DevicesState>) -> Result<DevicesView, String> {
    let shared = devices.0.clone();
    blocking(move || {
        new_code(&shared);
        view(&shared)
    })
    .await
}

#[tauri::command]
pub async fn remove_device(
    devices: State<'_, DevicesState>,
    id: String,
) -> Result<DevicesView, String> {
    let shared = devices.0.clone();
    blocking(move || {
        shared.update(|settings| settings.devices.retain(|device| device.id != id))?;
        view(&shared)
    })
    .await
}

#[cfg(test)]
pub(crate) mod tests;

/// A server on loopback for tests, with its port and the database paths it reads.
#[cfg(test)]
pub(crate) fn test_server(
    catalog: &std::path::Path,
    dictionaries: &std::path::Path,
) -> (Arc<Shared>, u16) {
    let shared = Arc::new(Shared::new(
        catalog.to_owned(),
        dictionaries.to_owned(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        None,
    ));
    let settings = shared
        .update(|settings| {
            settings.allowed = true;
            settings.port = 0;
        })
        .unwrap();
    apply(&shared, &settings);
    let port = shared.runtime().server.as_ref().unwrap().port;
    (shared, port)
}

#[cfg(test)]
impl Shared {
    pub(crate) fn code(&self) -> String {
        self.runtime().code.clone()
    }

    pub(crate) fn device_names(&self) -> Vec<String> {
        load_settings(&open_catalog(&self.catalog).unwrap())
            .unwrap()
            .devices
            .into_iter()
            .map(|device| device.name)
            .collect()
    }

    pub(crate) fn last_synced(&self) -> Vec<Option<String>> {
        load_settings(&open_catalog(&self.catalog).unwrap())
            .unwrap()
            .devices
            .into_iter()
            .map(|device| device.last_synced_at)
            .collect()
    }

    pub(crate) fn remove_all_devices(&self) {
        self.update(|settings| settings.devices.clear()).unwrap();
    }
}
