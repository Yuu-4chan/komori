//! Decoding a cover image into the thumbnail Explorer shows, within the Library's limits.

use std::io::Cursor;

use image::{imageops::FilterType, DynamicImage, ImageReader, Limits};

/// The largest width or height decoded, as in the Library.
const MAX_DIMENSION: u32 = 12_000;
/// The most memory one decode may take.
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
/// The largest thumbnail made, whatever Explorer asks for.
const MAX_SIZE: u32 = 2_560;

/// A cover fitted within the requested size: `pixels` holds `width * height` RGB triples, row by
/// row from the top.
#[derive(Debug)]
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// The image `bytes` hold, fitted within `size` by `size` pixels keeping its shape, with any
/// transparency drawn on white as a page would show it.
pub(crate) fn render(bytes: &[u8], size: u32) -> Option<Thumbnail> {
    let size = size.clamp(1, MAX_SIZE);
    let image = decode(bytes)?;
    let image = if image.width() > size || image.height() > size {
        image.thumbnail(size, size)
    } else if image.width() < size && image.height() < size {
        image.resize(size, size, FilterType::Triangle)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let mut pixels = Vec::with_capacity(rgba.as_raw().len() / 4 * 3);
    for [r, g, b, a] in rgba.pixels().map(|pixel| pixel.0) {
        let blend = |channel: u8| {
            ((u16::from(channel) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8
        };
        pixels.extend([blend(r), blend(g), blend(b)]);
    }
    Some(Thumbnail {
        width: rgba.width(),
        height: rgba.height(),
        pixels,
    })
}

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    reader.decode().ok()
}
