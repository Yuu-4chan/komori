//! Where a book's EPUB is read from. On the PC a source is a file path. On Android it is the link
//! the system document picker granted, whose read permission Komori keeps; the original is read
//! in place, never copied. Sources stay native-only, and neither kind is ever written.

use std::{
    fs::{File, Metadata},
    io,
};

/// Opens `source` read-only.
pub(crate) fn open(source: &str) -> io::Result<File> {
    #[cfg(mobile)]
    if crate::android::is_document(source) {
        return crate::android::open_document(source);
    }
    File::open(source)
}

/// The size, kind and modification time of `source`.
pub(crate) fn metadata(source: &str) -> io::Result<Metadata> {
    #[cfg(mobile)]
    if crate::android::is_document(source) {
        return crate::android::document_metadata(source);
    }
    std::fs::metadata(source)
}
