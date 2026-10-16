//! Small cached cover thumbnails and the read-only protocol that serves them.
//!
//! A book's full cover stays in `books.cover_bytes`. Its thumbnail, sized for Library cards, is
//! Komori-derived data in `book_thumbnails`, built for the book's current `cover_revision`. The
//! webview loads thumbnails as ordinary images from `komori-cover`, so a large Library needs no
//! per-cover IPC or base64 copies, and an unchanged revision can be cached for good.

use std::{io::Cursor, path::Path};

use image::{
    codecs::jpeg::JpegEncoder, DynamicImage, ImageError, ImageReader, ImageResult, Limits,
};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, UriSchemeContext, UriSchemeResponder, Wry,
};
use uuid::Uuid;

use crate::library::{storage_error, CatalogState};

const SCHEME: &str = "komori-cover";
// About twice the largest Library card, so covers stay sharp on high-DPI displays.
const MAX_WIDTH: u32 = 400;
const MAX_HEIGHT: u32 = 600;
const JPEG_QUALITY: u8 = 85;
// Cached covers are at most 4 MiB, but compressed pixels can claim far larger images.
const MAX_DIMENSION: u32 = 12_000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CoverImage {
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

/// The URL the webview loads a book's thumbnail from; the revision changes with the cover.
pub(crate) fn cover_url(id: &str, revision: i64) -> String {
    // WebView2 maps custom schemes to a localhost origin on Windows and Android.
    if cfg!(any(target_os = "windows", target_os = "android")) {
        format!("http://{SCHEME}.localhost/{id}/{revision}")
    } else {
        format!("{SCHEME}://localhost/{id}/{revision}")
    }
}

/// A card-sized JPEG of a cached cover. A cover already within the bounds in a format every
/// webview shows is kept as it is, and so is one in a format not decoded here (such as AVIF),
/// which the webview may still show. A cover refused by the decode limits, or one that does not
/// decode, gets no thumbnail, so its card shows the placeholder instead of handing the webview
/// pixels Komori itself refused to decode.
pub(crate) fn thumbnail(mime: &str, bytes: &[u8]) -> Option<CoverImage> {
    let original = || CoverImage {
        mime: mime.to_string(),
        bytes: bytes.to_vec(),
    };
    match shrink(mime, bytes) {
        Ok(Some(cover)) => Some(cover),
        Ok(None) | Err(ImageError::Unsupported(_)) => Some(original()),
        Err(_) => None,
    }
}

/// The shrunken cover, `None` when the original is already fit to show, or why it cannot be read.
fn shrink(mime: &str, bytes: &[u8]) -> ImageResult<Option<CoverImage>> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader.decode()?;
    let fits = image.width() <= MAX_WIDTH && image.height() <= MAX_HEIGHT;
    if fits
        && matches!(
            mime,
            "image/jpeg" | "image/png" | "image/webp" | "image/gif"
        )
    {
        return Ok(None);
    }
    let image = if fits {
        image
    } else {
        image.thumbnail(MAX_WIDTH, MAX_HEIGHT)
    };
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, JPEG_QUALITY).encode_image(&flatten(image))?;
    Ok(Some(CoverImage {
        mime: "image/jpeg".into(),
        bytes: output,
    }))
}

/// JPEG has no transparency; a transparent cover is drawn on white, as a page would show it.
fn flatten(image: DynamicImage) -> image::RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let blend = |channel: u8| {
            ((u16::from(channel) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8
        };
        image::Rgb([blend(r), blend(g), blend(b)])
    })
}

/// Stores the thumbnail of a book's cover for its revision. Callers inside a transaction pass
/// it; a book removed meanwhile simply gets no thumbnail.
pub(crate) fn store_thumbnail(
    connection: &Connection,
    id: &str,
    revision: i64,
    cover: &CoverImage,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO book_thumbnails (book_id, cover_revision, mime, bytes)
             SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM books WHERE id = ?1)
             ON CONFLICT(book_id) DO UPDATE
                SET cover_revision = excluded.cover_revision,
                    mime = excluded.mime,
                    bytes = excluded.bytes",
            params![id, revision, cover.mime, cover.bytes],
        )
        .map(|_| ())
        .map_err(storage_error)
}

/// Builds the thumbnail for a book's current cover, or removes a stale one when it has none.
fn refresh_thumbnail(connection: &Connection, id: &str) -> Result<Option<CoverImage>, String> {
    let cover: Option<(i64, Option<String>, Option<Vec<u8>>)> = connection
        .query_row(
            "SELECT cover_revision, cover_mime, cover_bytes FROM books WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((revision, Some(mime), Some(bytes))) = cover else {
        connection
            .execute("DELETE FROM book_thumbnails WHERE book_id = ?1", [id])
            .map_err(storage_error)?;
        return Ok(None);
    };
    // A cover refused a thumbnail is tried again on request; its decode stops at the header.
    let Some(thumbnail) = thumbnail(&mime, &bytes) else {
        connection
            .execute("DELETE FROM book_thumbnails WHERE book_id = ?1", [id])
            .map_err(storage_error)?;
        return Ok(None);
    };
    store_thumbnail(connection, id, revision, &thumbnail)?;
    Ok(Some(thumbnail))
}

/// The thumbnail for a book's current cover, built now when it is missing or stale.
pub(crate) fn load_thumbnail(
    connection: &Connection,
    id: &str,
) -> Result<Option<(i64, CoverImage)>, String> {
    type Row = (i64, bool, Option<i64>, Option<String>, Option<Vec<u8>>);
    let row: Option<Row> = connection
        .query_row(
            "SELECT books.cover_revision, length(books.cover_bytes) IS NOT NULL,
                    thumb.cover_revision, thumb.mime, thumb.bytes
               FROM books
               LEFT JOIN book_thumbnails AS thumb ON thumb.book_id = books.id
              WHERE books.id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    let Some((revision, has_cover, built_for, mime, bytes)) = row else {
        return Ok(None);
    };
    if !has_cover {
        return Ok(None);
    }
    if let (Some(built_for), Some(mime), Some(bytes)) = (built_for, mime, bytes) {
        if built_for == revision {
            return Ok(Some((revision, CoverImage { mime, bytes })));
        }
    }
    Ok(refresh_thumbnail(connection, id)?.map(|cover| (revision, cover)))
}

/// Builds every missing or stale thumbnail, such as those of a Library from before thumbnails.
/// Runs once in the background at startup; cards that need a cover sooner build their own.
pub(crate) fn build_missing_thumbnails(database: &Path) -> Result<usize, String> {
    let connection = open(database)?;
    let pending: Vec<String> = {
        let mut statement = connection
            .prepare(
                "SELECT books.id FROM books
                   LEFT JOIN book_thumbnails AS thumb ON thumb.book_id = books.id
                  WHERE length(books.cover_bytes) IS NOT NULL
                    AND (thumb.book_id IS NULL OR thumb.cover_revision <> books.cover_revision)
                  ORDER BY books.imported_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?;
        rows.collect::<Result<_, _>>().map_err(storage_error)?
    };
    let mut built = 0;
    for id in pending {
        if refresh_thumbnail(&connection, &id)?.is_some() {
            built += 1;
        }
    }
    Ok(built)
}

fn open(database: &Path) -> Result<Connection, String> {
    let connection = Connection::open(database).map_err(storage_error)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(storage_error)?;
    Ok(connection)
}

pub fn serve_cover(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // The only current webview is the app-owned main window.
    if context.webview_label() != "main" {
        responder.respond(response(StatusCode::FORBIDDEN, None, false));
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
        return response(StatusCode::METHOD_NOT_ALLOWED, None, false);
    }
    let Some((id, revision)) = parse_path(request.uri().path()) else {
        return response(StatusCode::NOT_FOUND, None, false);
    };
    if request.uri().query().is_some() {
        return response(StatusCode::NOT_FOUND, None, false);
    }
    let loaded = open(database).and_then(|connection| load_thumbnail(&connection, &id));
    match loaded {
        Ok(Some((current, cover))) => response(StatusCode::OK, Some(cover), current == revision),
        Ok(None) => response(StatusCode::NOT_FOUND, None, false),
        Err(error) => {
            eprintln!("Komori cover lookup failed: {error}");
            response(StatusCode::INTERNAL_SERVER_ERROR, None, false)
        }
    }
}

/// `/<catalog UUID>/<revision>`, and nothing else; no path ever names a file.
fn parse_path(path: &str) -> Option<(String, i64)> {
    let (id, revision) = path.strip_prefix('/')?.split_once('/')?;
    let id = Uuid::parse_str(id).ok()?.to_string();
    if revision.is_empty() || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((id, revision.parse().ok()?))
}

fn response(status: StatusCode, cover: Option<CoverImage>, current: bool) -> Response<Vec<u8>> {
    let (mime, bytes) = cover.map_or_else(
        || ("text/plain".to_string(), Vec::new()),
        |cover| (cover.mime, cover.bytes),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // A URL names one cover revision, so its image never changes; anything else is fetched
        // again rather than cached.
        .header(
            header::CACHE_CONTROL,
            if current {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(bytes)
        .expect("static response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    fn encoded(width: u32, height: u32, format: ImageFormat, alpha: u8) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, Rgba([200, 40, 40, alpha]));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    fn dimensions(cover: &CoverImage) -> (u32, u32) {
        let image = image::load_from_memory(&cover.bytes).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn large_covers_shrink_to_card_sized_jpegs_keeping_their_proportions() {
        let cover = thumbnail("image/png", &encoded(1200, 1800, ImageFormat::Png, 255)).unwrap();
        assert_eq!(cover.mime, "image/jpeg");
        assert_eq!(dimensions(&cover), (400, 600));

        let wide = thumbnail("image/png", &encoded(2000, 1000, ImageFormat::Png, 255)).unwrap();
        assert_eq!(dimensions(&wide), (400, 200));
    }

    #[test]
    fn small_web_covers_are_kept_and_transparency_is_drawn_on_white() {
        let small = encoded(300, 450, ImageFormat::Png, 255);
        assert_eq!(
            thumbnail("image/png", &small),
            Some(CoverImage {
                mime: "image/png".into(),
                bytes: small
            })
        );

        let transparent = thumbnail("image/png", &encoded(800, 1200, ImageFormat::Png, 0)).unwrap();
        let image = image::load_from_memory(&transparent.bytes)
            .unwrap()
            .to_rgb8();
        let [r, g, b] = image.get_pixel(10, 10).0;
        assert!(r > 245 && g > 245 && b > 245, "{r} {g} {b}");
    }

    /// A PNG that declares its size and pixel format but carries only a sliver of image data.
    fn png_header(width: u32, height: u32, bit_depth: u8, color_type: u8) -> Vec<u8> {
        fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
            png.extend_from_slice(&(data.len() as u32).to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(data);
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(data);
            png.extend_from_slice(&crc.sum().to_be_bytes());
        }
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[bit_depth, color_type, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut png, b"IHDR", &ihdr);
        chunk(
            &mut png,
            b"IDAT",
            &[0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01],
        );
        chunk(&mut png, b"IEND", &[]);
        png
    }

    #[test]
    fn covers_in_formats_not_decoded_here_keep_their_original_bytes() {
        let unknown = thumbnail("image/avif", b"not an image we decode").unwrap();
        assert_eq!(unknown.mime, "image/avif");
        assert_eq!(unknown.bytes, b"not an image we decode");

        let avif = b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf".to_vec();
        assert_eq!(thumbnail("image/avif", &avif).unwrap().bytes, avif);
    }

    #[test]
    fn covers_refused_by_the_decode_limits_get_no_thumbnail() {
        let wide = encoded(MAX_DIMENSION + 1, 1, ImageFormat::Png, 255);
        assert_eq!(thumbnail("image/png", &wide), None);

        // A few hundred bytes can claim a 13,000-pixel square, or a surface past the memory limit.
        assert_eq!(
            thumbnail("image/png", &png_header(13_000, 13_000, 8, 6)),
            None
        );
        assert_eq!(
            thumbnail(
                "image/png",
                &png_header(MAX_DIMENSION, MAX_DIMENSION, 16, 6)
            ),
            None
        );

        // Within the limits, a cover whose pixels do not decode gets none either.
        assert_eq!(thumbnail("image/png", &png_header(400, 600, 8, 6)), None);
    }

    #[test]
    fn protocol_paths_accept_only_a_catalog_uuid_and_revision() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(parse_path(&format!("/{id}/3")), Some((id.clone(), 3)));
        for path in [
            format!("/{id}"),
            format!("/{id}/"),
            format!("/{id}/-1"),
            format!("/{id}/1/2"),
            format!("/{id}/x"),
            "/C:/books/a.epub/1".into(),
            "/../library.sqlite3/1".into(),
        ] {
            assert_eq!(parse_path(&path), None, "{path}");
        }
    }

    #[test]
    fn responses_cache_only_the_current_revision() {
        let cover = CoverImage {
            mime: "image/jpeg".into(),
            bytes: vec![1, 2, 3],
        };
        let current = response(StatusCode::OK, Some(cover), true);
        assert_eq!(current.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert!(current.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable"));
        assert_eq!(current.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let stale = response(StatusCode::NOT_FOUND, None, false);
        assert_eq!(stale.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
