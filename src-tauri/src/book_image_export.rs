//! Saves a book image the reader chose to a file they pick. The page sends the image it already
//! shows; Komori checks that the bytes are one bounded raster image before asking where to save
//! it, and writes nothing else.

use crate::interface_text::{self, Text};
use crate::library::CatalogState;
use image::ImageFormat;
use tauri::{ipc::InvokeBody, State};

/// The viewer's images are bounded well below this.
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;

/// The image's file extension, or None when the bytes are not a raster Komori saves.
fn extension(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        ImageFormat::Png => Some("png"),
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::WebP => Some("webp"),
        ImageFormat::Gif => Some("gif"),
        _ => None,
    }
}

/// A suggested file name Windows accepts, from the page's (percent-encoded) suggestion.
fn file_stem(encoded: Option<&str>) -> String {
    let decoded = encoded.and_then(percent_decode).unwrap_or_default();
    let cleaned: String = decoded
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "image".into()
    } else {
        trimmed.into()
    }
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// "saved", "canceled" or "failed"; the image bytes are the request's raw body.
#[tauri::command]
pub async fn save_book_image(
    request: tauri::ipc::Request<'_>,
    catalog: State<'_, CatalogState>,
) -> Result<&'static str, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Ok("failed");
    };
    if bytes.len() > MAX_BYTES {
        return Ok("failed");
    }
    let Some(extension) = extension(bytes) else {
        return Ok("failed");
    };
    let stem = file_stem(
        request
            .headers()
            .get("x-komori-file-name")
            .and_then(|value| value.to_str().ok()),
    );
    let language = interface_text::language(&catalog.database);
    let selected = rfd::AsyncFileDialog::new()
        .set_title(interface_text::text(language, Text::SaveImage))
        .add_filter(interface_text::text(language, Text::Images), &[extension])
        .set_file_name(format!("{stem}.{extension}"))
        .save_file()
        .await
        .map(|file| file.path().to_path_buf());
    let Some(mut path) = selected else {
        return Ok("canceled");
    };
    if path.extension().is_none() {
        path.set_extension(extension);
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, bytes))
        .await
        .map_err(|error| format!("Image save failed: {error}"))?
        .map_or(Ok("failed"), |_| Ok("saved"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_only_known_rasters_under_a_name_windows_accepts() {
        assert_eq!(extension(b"\x89PNG\r\n\x1a\n0000"), Some("png"));
        assert_eq!(extension(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(
            extension(b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
            None
        );
        assert_eq!(extension(b""), None);
        assert_eq!(
            file_stem(Some("A%20Quiet%20Book%3A%20image%203")),
            "A Quiet Book image 3"
        );
        assert_eq!(file_stem(Some("..%2F..%2Fsecret")), "....secret");
        assert_eq!(file_stem(Some("%E6%9C%AC%E6%96%87")), "本文");
        assert_eq!(file_stem(Some("%ZZ")), "image");
        assert_eq!(file_stem(None), "image");
        assert_eq!(
            file_stem(Some(&"x".repeat(500))).chars().count(),
            MAX_NAME_CHARS
        );
    }
}
