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

/// The book folder a phone document was granted through: `…/tree/<folder>` of
/// `…/tree/<folder>/document/<document>`, the link whose permission reads it.
#[cfg(any(mobile, test))]
pub(crate) fn folder_of(document: &str) -> Option<&str> {
    let tree = document.find("/tree/")?;
    let at = document[tree..].find("/document/")? + tree;
    Some(&document[..at])
}

#[cfg(test)]
mod tests {
    use super::folder_of;

    #[test]
    fn a_folder_document_is_read_through_its_folder() {
        let folder = "content://com.android.externalstorage.documents/tree/primary%3ABooks";
        assert_eq!(
            folder_of(&format!("{folder}/document/primary%3ABooks%2Fone.epub")),
            Some(folder)
        );
        assert_eq!(
            folder_of("content://com.android.providers.downloads.documents/document/msf%3A12"),
            None
        );
        assert_eq!(folder_of(folder), None);
    }
}
