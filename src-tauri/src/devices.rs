//! Settings > Devices: the PC's server for paired phones. It is off until the reader allows
//! devices, then serves HTTPS on one port with the PC's own certificate (made once and kept in
//! the catalog's preferences), pairs a phone with the code it shows (see `protocol`), and answers
//! paired phones with the Library's books and the installed dictionaries, by ID, never by path.
#![cfg_attr(mobile, allow(dead_code))]

pub(crate) mod client;
mod http;
pub(crate) mod protocol;

use std::{
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use rusqlite::{Connection, OptionalExtension};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Tells the Devices page that something changed.
type Notify = Box<dyn Fn() + Send + Sync>;
use uuid::Uuid;

use crate::library::{open_catalog, storage_error};
use protocol::{decode, encode, Hello, PairFinish, PairStart, PairStarted, Paired};

const SETTINGS: &str = "devices";
const IDENTITY: &str = "devices-identity";
/// Connections answered at once; more wait for the next.
const CONNECTIONS: usize = 8;
/// How long a started pairing waits for its proof.
const PAIRING_WAIT: Duration = Duration::from_secs(120);
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
    /// The code a phone pairs with, while devices are allowed and the server runs.
    code: Option<String>,
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
}

struct Pending {
    session: String,
    key: Vec<u8>,
    device: String,
    started: Instant,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
struct Runtime {
    server: Option<Server>,
    failure: Option<&'static str>,
    code: String,
    attempts: u32,
    pending: Option<Pending>,
    /// When each device's last connection was written.
    seen: Vec<(String, Instant)>,
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
    connections: AtomicUsize,
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
            connections: AtomicUsize::new(0),
        }
    }

    fn changed(&self) {
        if let Some(notify) = &self.notify {
            notify();
        }
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
    listener.set_nonblocking(true).map_err(|_| "failed")?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if shared.connections.load(Ordering::SeqCst) >= CONNECTIONS {
                            continue;
                        }
                        shared.connections.fetch_add(1, Ordering::SeqCst);
                        let (shared, config) = (shared.clone(), config.clone());
                        std::thread::spawn(move || {
                            serve(&shared, config, fingerprint, stream);
                            shared.connections.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        })
    };
    Ok(Server {
        port,
        stop,
        thread: Some(thread),
    })
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
    Ok(DevicesView {
        allowed: settings.allowed,
        port: settings.port,
        address: local_address(),
        code: listening.then(|| runtime.code.clone()),
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
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let Ok(connection) = rustls::ServerConnection::new(config) else {
        return;
    };
    let mut tls = rustls::StreamOwned::new(connection, stream);
    match http::read_request(&mut tls) {
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
            return http::respond_json(
                stream,
                200,
                &Hello {
                    protocol: protocol::PROTOCOL,
                    name: pc_name(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                },
            )
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
    let pending = runtime.pending.take_if(|pending| {
        pending.session == finish.session && pending.started.elapsed() < PAIRING_WAIT
    });
    let Some(pending) = pending else {
        return error(stream, 409, "noPairing");
    };
    if !protocol::phone_proof_matches(&pending.key, certificate, &proof) {
        runtime.attempts += 1;
        if runtime.attempts >= protocol::PAIRING_ATTEMPTS {
            runtime.code = protocol::pairing_code();
            runtime.attempts = 0;
        }
        drop(runtime);
        shared.changed();
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
        },
    )
}

/// Starts the server at launch when devices are allowed.
pub fn start(catalog: PathBuf, dictionaries: PathBuf, app: AppHandle) -> DevicesState {
    let shared = Arc::new(Shared::new(
        catalog,
        dictionaries,
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        Some(Box::new(move || {
            let _ = app.emit("devices-changed", ());
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

#[tauri::command]
pub async fn new_pairing_code(devices: State<'_, DevicesState>) -> Result<DevicesView, String> {
    let shared = devices.0.clone();
    blocking(move || {
        {
            let mut runtime = shared.runtime();
            if runtime.server.is_some() {
                runtime.code = protocol::pairing_code();
                runtime.attempts = 0;
                runtime.pending = None;
            }
        }
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

    pub(crate) fn remove_all_devices(&self) {
        self.update(|settings| settings.devices.clear()).unwrap();
    }
}
