//! A single managed, inert Reader background. Source paths never cross the IPC boundary.
use crate::interface_text::{self, Text};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use image::{ImageFormat, ImageReader, Limits};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, State, UriSchemeContext, UriSchemeResponder, Wry,
};
use uuid::Uuid;

use crate::library::{open_catalog, CatalogState};

const MAX_SOURCE: u64 = 32 * 1024 * 1024;
const MAX_MANAGED: usize = 28 * 1024 * 1024;
const MAX_DIMENSION: u32 = 8192;
const MAX_PIXELS: u64 = 32 * 1024 * 1024;
const OUTPUT_DIMENSION: u32 = 2560;
const FAILURE: &str = "Could not use this background image. Choose a readable PNG, JPEG, WebP, GIF or BMP up to 32 MiB and 32 megapixels.";
static CHANGING: AtomicBool = AtomicBool::new(false);
struct Changing;
impl Changing {
    fn begin() -> Result<Self, String> {
        CHANGING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "A background change is already pending.".into())
    }
}
impl Drop for Changing {
    fn drop(&mut self) {
        CHANGING.store(false, Ordering::Release);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    revision: String,
    url: String,
}
fn descriptor(revision: String) -> Background {
    let base = if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://komori-background.localhost"
    } else {
        "komori-background://localhost"
    };
    Background {
        url: format!("{base}/{revision}"),
        revision,
    }
}
pub(crate) fn create_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS reader_background (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision TEXT NOT NULL,
        bytes BLOB NOT NULL);",
        )
        .map_err(|_| "Could not initialize Reader background storage.".into())
}
fn current(connection: &Connection) -> Result<Option<Background>, String> {
    let revision: Option<(String, i64)> = connection
        .query_row(
            "SELECT revision, length(bytes) FROM reader_background WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| "Could not load Reader background.".to_string())?;
    revision
        .map(|(revision, length)| {
            if valid_revision(&revision) && (1..=MAX_MANAGED as i64).contains(&length) {
                Ok(descriptor(revision))
            } else {
                Err("Could not load Reader background.".into())
            }
        })
        .transpose()
}
fn normalized(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| FAILURE)?;
    let metadata = file.metadata().map_err(|_| FAILURE)?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE {
        return Err(FAILURE.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FAILURE)?;
    if bytes.len() as u64 > MAX_SOURCE {
        return Err(FAILURE.into());
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| FAILURE)?;
    if !matches!(
        reader.format(),
        Some(
            ImageFormat::Png
                | ImageFormat::Jpeg
                | ImageFormat::WebP
                | ImageFormat::Gif
                | ImageFormat::Bmp
        )
    ) {
        return Err(FAILURE.into());
    }
    let (width, height) = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| FAILURE)?
        .into_dimensions()
        .map_err(|_| FAILURE)?;
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(FAILURE.into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| FAILURE)?;
    let image = if width > OUTPUT_DIMENSION || height > OUTPUT_DIMENSION {
        image.thumbnail(OUTPUT_DIMENSION, OUTPUT_DIMENSION)
    } else {
        image
    };
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| FAILURE)?;
    let output = output.into_inner();
    if output.len() > MAX_MANAGED {
        return Err(FAILURE.into());
    }
    Ok(output)
}
fn replace(connection: &Connection, path: &Path) -> Result<Background, String> {
    // Finish bounded decoding before the single atomic replacement; failure retains the old row.
    let bytes = normalized(path)?;
    let revision = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO reader_background VALUES (1, ?1, ?2)
        ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, bytes = excluded.bytes",
            params![revision, bytes],
        )
        .map_err(|_| "Could not save Reader background.".to_string())?;
    Ok(descriptor(revision))
}
#[tauri::command]
pub async fn get_reader_background(
    catalog: State<'_, CatalogState>,
) -> Result<Option<Background>, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || current(&open_catalog(&database)?))
        .await
        .map_err(|_| "Could not load Reader background.".to_string())?
}
#[tauri::command]
pub async fn choose_reader_background(
    catalog: State<'_, CatalogState>,
) -> Result<Option<Background>, String> {
    let changing = Changing::begin()?;
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::ChooseReaderBackground))
        .add_filter(
            interface_text::text(language, Text::BackgroundImages),
            &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        )
        .pick_file()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let database = catalog.database.clone();
    let lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _changing = changing;
        let _writing = lock.lock().unwrap_or_else(|p| p.into_inner());
        replace(&open_catalog(&database)?, selected.path()).map(Some)
    })
    .await
    .map_err(|_| FAILURE.to_string())?
}
#[tauri::command]
pub async fn remove_reader_background(catalog: State<'_, CatalogState>) -> Result<(), String> {
    let changing = Changing::begin()?;
    let database = catalog.database.clone();
    let lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _changing = changing;
        let _writing = lock.lock().unwrap_or_else(|p| p.into_inner());
        open_catalog(&database)?
            .execute("DELETE FROM reader_background", [])
            .map(|_| ())
            .map_err(|_| "Could not remove Reader background.".to_string())
    })
    .await
    .map_err(|_| "Could not remove Reader background.".to_string())?
}
fn valid_revision(revision: &str) -> bool {
    Uuid::parse_str(revision).is_ok_and(|id| id.to_string() == revision)
}
pub fn serve_background(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(response(StatusCode::FORBIDDEN, Vec::new()));
        return;
    }
    let database = context
        .app_handle()
        .state::<CatalogState>()
        .database
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(handle_request(&database, &request))
    });
}
fn handle_request(database: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return response(StatusCode::METHOD_NOT_ALLOWED, Vec::new());
    }
    for name in [header::ORIGIN, header::REFERER] {
        if let Some(value) = request.headers().get(name) {
            let allowed = value.to_str().is_ok_and(|value| {
                ["http://tauri.localhost", "tauri://localhost"]
                    .iter()
                    .any(|origin| value == *origin || value.starts_with(&format!("{origin}/")))
                    || (cfg!(debug_assertions)
                        && (value == "http://127.0.0.1:1420"
                            || value.starts_with("http://127.0.0.1:1420/")))
            });
            if !allowed {
                return response(StatusCode::FORBIDDEN, Vec::new());
            }
        }
    }
    let revision = request.uri().path().strip_prefix('/').unwrap_or("");
    if !valid_revision(revision) || request.uri().query().is_some() {
        return response(StatusCode::NOT_FOUND, Vec::new());
    }
    let loaded = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|connection| connection.query_row(
            "SELECT bytes FROM reader_background WHERE singleton = 1 AND revision = ?1 AND length(bytes) BETWEEN 1 AND ?2",
            params![revision, MAX_MANAGED], |row| row.get::<_, Vec<u8>>(0)).optional());
    match loaded {
        Ok(Some(bytes)) if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {
            response(StatusCode::OK, bytes)
        }
        Ok(_) => response(StatusCode::NOT_FOUND, Vec::new()),
        Err(_) => response(StatusCode::INTERNAL_SERVER_ERROR, Vec::new()),
    }
}
fn response(status: StatusCode, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(bytes)
        .expect("static headers")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgba, RgbaImage};
    use tempfile::tempdir;

    fn source(path: &Path, width: u32, height: u32) {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            Rgba([50, 120, 200, 100]),
        ))
        .save_with_format(path, ImageFormat::Png)
        .unwrap();
    }
    fn request(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("http://komori-background.localhost{path}"))
            .body(Vec::new())
            .unwrap()
    }
    #[test]
    fn replacement_is_bounded_atomic_read_only_and_persistent_and_removal_revokes_urls() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("library.sqlite3");
        let image = dir.path().join("source.png");
        source(&image, 2800, 1400);
        let original = std::fs::read(&image).unwrap();
        let modified = std::fs::metadata(&image).unwrap().modified().unwrap();
        let connection = open_catalog(&database).unwrap();
        assert!(current(&connection).unwrap().is_none());
        let first = replace(&connection, &image).unwrap();
        drop(connection);
        let connection = open_catalog(&database).unwrap();
        assert_eq!(
            current(&connection).unwrap().unwrap().revision,
            first.revision
        );
        let served = handle_request(&database, &request(&format!("/{}", first.revision)));
        assert_eq!(served.status(), StatusCode::OK);
        let decoded = image::load_from_memory(served.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2560, 1280));
        assert!(decoded.color().has_alpha());
        assert_eq!(served.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(std::fs::read(&image).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&image).unwrap().modified().unwrap(),
            modified
        );
        let invalid = dir.path().join("bad.png");
        std::fs::write(&invalid, b"<svg onload='alert(1)'/>").unwrap();
        assert!(replace(&connection, &invalid).is_err());
        assert_eq!(
            current(&connection).unwrap().unwrap().revision,
            first.revision
        );
        let second = replace(&connection, &image).unwrap();
        assert_ne!(first.revision, second.revision);
        assert_eq!(
            handle_request(&database, &request(&format!("/{}", first.revision))).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM reader_background", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        connection
            .execute("DELETE FROM reader_background", [])
            .unwrap();
        assert!(current(&open_catalog(&database).unwrap())
            .unwrap()
            .is_none());
        assert_eq!(
            handle_request(&database, &request(&format!("/{}", second.revision))).status(),
            StatusCode::NOT_FOUND
        );
    }
    #[test]
    fn refuses_large_sources_dimensions_and_invalid_images_without_changes() {
        let dir = tempdir().unwrap();
        let image = dir.path().join("image.png");
        source(&image, MAX_DIMENSION + 1, 1);
        assert!(normalized(&image).is_err());
        let huge = dir.path().join("huge.png");
        let file = File::create(&huge).unwrap();
        file.set_len(MAX_SOURCE + 1).unwrap();
        assert!(normalized(&huge).is_err());
        assert!(normalized(dir.path()).is_err());
        std::fs::write(&image, b"not an image").unwrap();
        assert!(normalized(&image).is_err());
        assert_eq!(std::fs::read(&image).unwrap(), b"not an image");
    }
    #[test]
    fn protocol_refuses_foreign_origins_methods_queries_paths_and_obsolete_ids() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("library.sqlite3");
        open_catalog(&database).unwrap();
        let id = Uuid::new_v4().to_string();
        for path in [
            "/".to_string(),
            "/../private.png".into(),
            format!("/{id}/extra"),
            format!("/{id}?file=private"),
            format!("/{}", id.to_uppercase()),
        ] {
            assert_eq!(
                handle_request(&database, &request(&path)).status(),
                StatusCode::NOT_FOUND
            );
        }
        for header in [header::ORIGIN, header::REFERER] {
            let request = Request::builder()
                .uri(format!("/{id}"))
                .header(header, "http://tauri.localhost.evil/")
                .body(Vec::new())
                .unwrap();
            assert_eq!(
                handle_request(&database, &request).status(),
                StatusCode::FORBIDDEN
            );
        }
        let post = Request::builder()
            .uri(format!("/{id}"))
            .method(Method::POST)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            handle_request(&database, &post).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            handle_request(&database, &request(&format!("/{id}"))).status(),
            StatusCode::NOT_FOUND
        );
    }
}
