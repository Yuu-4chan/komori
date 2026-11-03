//! Komori's Android plugin (`gen/android/.../KomoriPlugin.kt`): the system document picker,
//! read-only descriptors for the documents it granted and the APK's assets, and leaving the app
//! from the Library.
//! Its calls wait for Android's main thread, so they run only from commands and worker threads.

use std::{
    collections::HashMap,
    fs::{File, Metadata},
    io,
    os::{fd::FromRawFd, unix::fs::FileExt},
    path::Path,
    sync::{Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Wry,
};

static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

/// A Reader page asks for a chapter and its images at once; one look at a document answers
/// them all for this long.
const RECENT: Duration = Duration::from_secs(2);
static RECENT_METADATA: Mutex<Option<HashMap<String, (Instant, Metadata)>>> = Mutex::new(None);

pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("komori")
        .setup(|_, api| {
            let _ = PLUGIN.set(api.register_android_plugin("app.komori.reader", "KomoriPlugin")?);
            Ok(())
        })
        .build()
}

fn plugin() -> io::Result<&'static PluginHandle<Wry>> {
    PLUGIN
        .get()
        .ok_or_else(|| io::Error::other("Komori's Android plugin is not loaded"))
}

/// A document the picker granted: its link, and the name the provider shows for it.
#[derive(Debug, Deserialize)]
pub(crate) struct Document {
    pub(crate) uri: String,
    pub(crate) name: String,
}

#[derive(Deserialize)]
struct Picked {
    canceled: bool,
    #[serde(default)]
    documents: Vec<Document>,
}

/// Book sources picked on the phone are document links; paths are the PC's.
pub(crate) fn is_document(source: &str) -> bool {
    source.starts_with("content://")
}

/// Shows the system document picker for EPUBs and keeps the read permission of each document
/// picked; `None` when the reader closed it.
pub(crate) async fn pick_books(multiple: bool) -> Result<Option<Vec<Document>>, String> {
    let picked: Picked = plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async("pick", json!({ "multiple": multiple }))
        .await
        .map_err(|error| format!("The document picker could not open: {error}"))?;
    Ok((!picked.canceled).then_some(picked.documents))
}

#[derive(Deserialize)]
struct Opened {
    fd: i32,
}

/// Opens a granted document read-only.
pub(crate) fn open_document(uri: &str) -> io::Result<File> {
    match plugin()?.run_mobile_plugin::<Opened>("open", json!({ "uri": uri })) {
        // SAFETY: the plugin detached this descriptor from its own wrapper, so the file is its
        // only owner.
        Ok(opened) => Ok(unsafe { File::from_raw_fd(opened.fd) }),
        Err(PluginInvokeError::InvokeRejected(error)) => {
            let kind = match error.code.as_deref() {
                Some("missing") => io::ErrorKind::NotFound,
                Some("denied") => io::ErrorKind::PermissionDenied,
                _ => io::ErrorKind::Other,
            };
            Err(io::Error::new(kind, error.message.unwrap_or_default()))
        }
        Err(error) => Err(io::Error::other(error.to_string())),
    }
}

/// The document's size, kind and modification time, from its open descriptor.
pub(crate) fn document_metadata(uri: &str) -> io::Result<Metadata> {
    let recent = || {
        RECENT_METADATA
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    };
    let now = Instant::now();
    {
        let mut recent = recent();
        let recent = recent.get_or_insert_with(HashMap::new);
        recent.retain(|_, (seen, _)| now.duration_since(*seen) < RECENT);
        if let Some((_, metadata)) = recent.get(uri) {
            return Ok(metadata.clone());
        }
    }
    let metadata = open_document(uri)?.metadata()?;
    recent()
        .get_or_insert_with(HashMap::new)
        .insert(uri.to_owned(), (now, metadata.clone()));
    Ok(metadata)
}

#[derive(Deserialize)]
struct Asset {
    fd: i32,
    offset: u64,
    length: u64,
}

/// Reads a file the APK keeps uncompressed among its assets, when it is at most `limit` bytes.
pub(crate) fn read_asset(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let asset: Asset = plugin()?
        .run_mobile_plugin("openAsset", json!({ "path": path }))
        .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error.to_string()))?;
    // SAFETY: as for `open_document`, the descriptor is this file's alone.
    let file = unsafe { File::from_raw_fd(asset.fd) };
    if asset.length > limit as u64 {
        return Err(io::Error::other("The asset is too large."));
    }
    // The descriptor is the whole APK's, so the asset is read at its place in it.
    let mut bytes = vec![0; asset.length as usize];
    file.read_exact_at(&mut bytes, asset.offset)?;
    Ok(bytes)
}

/// Gives back the read permission of every document the catalog no longer links, so removed
/// and relinked books do not hold a grant of Android's limited number.
pub(crate) fn keep_only(sources: &[String]) {
    let kept: Vec<&str> = sources
        .iter()
        .map(String::as_str)
        .filter(|source| is_document(source))
        .collect();
    if let Ok(plugin) = plugin() {
        let _ = plugin.run_mobile_plugin::<Value>("keepOnly", json!({ "uris": kept }));
    }
}

/// The status bar, display cutout and gesture bar insets, in CSS pixels.
#[tauri::command]
pub async fn window_insets() -> Result<Value, String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async("insets", json!({}))
        .await
        .map_err(|error| error.to_string())
}

/// Shows or hides the status and navigation bars; the Reader hides them while reading.
#[tauri::command]
pub async fn show_system_bars(shown: bool) -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("systemBars", json!({ "shown": shown }))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Sends Komori to the background, as Back does from an Android app's first page.
#[tauri::command]
pub async fn leave_app() -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("leave", json!({}))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}
