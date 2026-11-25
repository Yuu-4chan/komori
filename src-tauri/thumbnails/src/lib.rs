//! Komori's Explorer thumbnail handler: a COM DLL that shows an EPUB's cover as its thumbnail in
//! Windows folders. It finds the cover with the Library's own code (`src/epub`), so a book shows
//! the cover Komori shows. Explorer runs it in its own thumbnail process and hands it the file as
//! a stream; any book it cannot read gets no thumbnail and keeps its icon.

mod epub;
#[cfg(windows)]
mod handler;
mod picture;

// The Library's error codes, which the shared package reader names.
#[allow(dead_code)]
#[path = "../../src/failure.rs"]
mod failure;

/// The Library caches a cover past its size limit re-encoded; a thumbnail decodes it as found.
mod covers {
    pub(crate) fn fit_large_cover(bytes: &[u8], _max_bytes: usize) -> Option<Vec<u8>> {
        Some(bytes.to_vec())
    }
}

#[cfg(windows)]
pub use handler::{DllCanUnloadNow, DllGetClassObject, CLSID};

/// The cover of the EPUB `source` holds, fitted within `size` pixels and drawn on white, as rows
/// of RGB pixels; `None` when the book or its cover cannot be read.
pub fn cover_thumbnail<R: std::io::Read + std::io::Seek>(
    source: R,
    size: u32,
) -> Option<picture::Thumbnail> {
    let bytes = epub::cover_image(source)?;
    picture::render(&bytes, size)
}

pub use picture::Thumbnail;
