//! Komori's Android plugin (`gen/android/.../KomoriPlugin.kt`): the system document picker for
//! books and dictionary archives, the folder picker and listing for book folders, read-only
//! descriptors for the documents it granted and the
//! APK's assets, AnkiDroid's notes, installing Komori's updates, and leaving the app from the
//! Library.
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
    pick(json!({ "multiple": multiple })).await
}

/// Shows the system document picker for dictionary archives, several at once. Their grant
/// lasts while Komori runs, long enough to import them; none is kept.
pub(crate) async fn pick_dictionaries() -> Result<Option<Vec<Document>>, String> {
    pick(json!({ "multiple": true, "dictionaries": true })).await
}

async fn pick(args: Value) -> Result<Option<Vec<Document>>, String> {
    let picked: Picked = plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async("pick", args)
        .await
        .map_err(|error| format!("The document picker could not open: {error}"))?;
    Ok((!picked.canceled).then_some(picked.documents))
}

#[derive(Deserialize)]
struct PickedFolder {
    canceled: bool,
    #[serde(default)]
    uri: Option<String>,
}

/// Shows Android's folder picker and keeps the read permission of the folder picked; its link,
/// or `None` when the reader closed the picker.
pub(crate) async fn pick_folder() -> Result<Option<String>, String> {
    let picked: PickedFolder = plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async("pickFolder", json!({}))
        .await
        .map_err(|error| match error {
            PluginInvokeError::InvokeRejected(_) => crate::failure::FOLDER_UNOPENABLE.to_owned(),
            error => format!("The folder picker could not open: {error}"),
        })?;
    Ok(picked.uri.filter(|_| !picked.canceled))
}

#[derive(Deserialize)]
struct FolderInfo {
    label: String,
    availability: String,
}

/// A book folder's name as the reader knows it, and whether it can be read: `available`,
/// `missing` or `unreadable`.
pub(crate) fn folder_info(tree: &str) -> (String, &'static str) {
    let info = plugin().ok().and_then(|plugin| {
        plugin
            .run_mobile_plugin::<FolderInfo>("folderInfo", json!({ "uri": tree }))
            .ok()
    });
    match info {
        Some(info) => (
            info.label,
            match info.availability.as_str() {
                "available" => "available",
                "missing" => "missing",
                _ => "unreadable",
            },
        ),
        None => (tree.to_owned(), "unreadable"),
    }
}

/// An EPUB in a book folder: its document link, name, size and modification time (ms).
#[derive(Deserialize)]
pub(crate) struct FolderFile {
    pub(crate) uri: String,
    pub(crate) name: String,
    pub(crate) size: i64,
    pub(crate) modified: i64,
}

#[derive(Deserialize)]
struct Listed {
    files: Vec<FolderFile>,
}

/// Every EPUB in the book folder and its subfolders, at most `max_depth` folders deep and
/// `max_files` in all.
pub(crate) fn list_folder(
    tree: &str,
    max_depth: usize,
    max_files: usize,
) -> io::Result<Vec<FolderFile>> {
    plugin()?
        .run_mobile_plugin::<Listed>(
            "listFolder",
            json!({ "uri": tree, "maxDepth": max_depth, "maxFiles": max_files }),
        )
        .map(|listed| listed.files)
        .map_err(|error| io::Error::other(error.to_string()))
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
/// and relinked books do not hold a grant of Android's limited number. A book read through a
/// folder's permission keeps that folder's.
pub(crate) fn keep_only(sources: &[String]) {
    let kept: Vec<&str> = sources
        .iter()
        .map(String::as_str)
        .filter(|source| is_document(source))
        .flat_map(|source| [Some(source), crate::book_source::folder_of(source)])
        .flatten()
        .collect();
    if let Ok(plugin) = plugin() {
        let _ = plugin.run_mobile_plugin::<Value>("keepOnly", json!({ "uris": kept }));
    }
}

#[derive(Deserialize)]
struct Answered {
    #[serde(default)]
    result: Value,
}

/// An AnkiConnect action's result, answered from AnkiDroid by the plugin, or why it has none:
/// `notInstalled`, `notAllowed`, `notReady` (AnkiDroid not set up yet), `duplicate`, `rejected`
/// or `unavailable`.
pub(crate) fn anki(action: &str, params: Value) -> Result<Value, String> {
    let plugin = plugin().map_err(|_| "unavailable".to_owned())?;
    match plugin
        .run_mobile_plugin::<Answered>("anki", json!({ "action": action, "params": params }))
    {
        Ok(answered) => Ok(answered.result),
        Err(PluginInvokeError::InvokeRejected(error)) => {
            Err(error.code.unwrap_or_else(|| "unavailable".into()))
        }
        Err(_) => Err("unavailable".into()),
    }
}

#[derive(Deserialize)]
struct Allowed {
    allowed: bool,
}

/// Asks the reader to let Komori use AnkiDroid; whether it now may. Fails as `notInstalled`
/// without AnkiDroid.
#[tauri::command]
pub async fn allow_ankidroid() -> Result<bool, String> {
    let plugin = plugin().map_err(|_| "unavailable".to_owned())?;
    match plugin
        .run_mobile_plugin_async::<Allowed>("ankiAllow", json!({}))
        .await
    {
        Ok(answer) => Ok(answer.allowed),
        Err(PluginInvokeError::InvokeRejected(error)) => {
            Err(error.code.unwrap_or_else(|| "unavailable".into()))
        }
        Err(_) => Err("unavailable".into()),
    }
}

/// Opens AnkiDroid's page in the Play Store.
#[tauri::command]
pub async fn open_ankidroid_store() -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("ankiStore", json!({}))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
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

/// Draws the status and navigation bars' icons `dark`, over a light page, or light.
#[tauri::command]
pub async fn system_bar_icons(dark: bool) -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("systemBarIcons", json!({ "dark": dark }))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Puts plain text on Android's clipboard: the WebView's clipboard API is refused writing.
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("copyText", json!({ "text": text }))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Whether a selection made now is the book's: Komori shows its own toolbar for it.
#[tauri::command]
pub async fn book_selection(own: bool) -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("bookSelection", json!({ "own": own }))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Opens a web link, already checked as plain http(s), in the phone's browser.
pub(crate) async fn open_link(url: &str) -> Result<(), String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Value>("openLink", json!({ "url": url }))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct Installing {
    allowed: bool,
}

/// Hands a checked update APK in the cache's `updates` folder to Android's installer; false
/// when Komori may not install apps yet, after opening the setting that allows it.
pub(crate) async fn install_apk(path: &Path) -> Result<bool, String> {
    plugin()
        .map_err(|error| error.to_string())?
        .run_mobile_plugin_async::<Installing>(
            "installApk",
            json!({ "path": path.to_string_lossy() }),
        )
        .await
        .map(|answer| answer.allowed)
        .map_err(|_| crate::failure::UPDATE_INSTALL.to_string())
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

/// The phone's name as its owner set it, for the PC's list of paired devices.
pub(crate) async fn device_name() -> String {
    #[derive(Deserialize)]
    struct Named {
        name: String,
    }
    let named = match plugin() {
        Ok(plugin) => plugin
            .run_mobile_plugin_async::<Named>("deviceName", json!({}))
            .await
            .ok(),
        Err(_) => None,
    };
    named
        .map(|named| named.name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Phone".into())
}
