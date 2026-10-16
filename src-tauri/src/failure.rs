//! Failures the user can act on, as stable codes. Each is a message key (`failure.…`) the
//! frontend shows in the interface language. Unexpected I/O and storage errors keep their
//! English detail instead.

pub(crate) const EPUB_NOT_ARCHIVE: &str = "failure.epubNotArchive";
pub(crate) const EPUB_NO_CONTAINER: &str = "failure.epubNoContainer";
pub(crate) const EPUB_BAD_CONTAINER: &str = "failure.epubBadContainer";
pub(crate) const EPUB_NO_PACKAGE: &str = "failure.epubNoPackage";
pub(crate) const EPUB_UNREADABLE_PACKAGE: &str = "failure.epubUnreadablePackage";
pub(crate) const EPUB_INVALID_PACKAGE: &str = "failure.epubInvalidPackage";
/// A package that is not XML at all, which another copy or an EPUB editor may fix.
pub(crate) const EPUB_BROKEN_PACKAGE: &str = "failure.epubBrokenPackage";

pub(crate) const CHOOSE_EPUB: &str = "failure.chooseEpub";
pub(crate) const CHOOSE_EPUB_NOT_FOLDER: &str = "failure.chooseEpubNotFolder";
pub(crate) const NOT_A_FILE: &str = "failure.notAFile";
pub(crate) const INVALID_EPUB: &str = "failure.invalidEpub";
pub(crate) const BOOK_GONE: &str = "failure.bookGone";
pub(crate) const EPUB_LINKED_ELSEWHERE: &str = "failure.epubLinkedElsewhere";
pub(crate) const FILE_UNREADABLE: &str = "failure.fileUnreadable";

pub(crate) const FOLDER_UNOPENABLE: &str = "failure.folderUnopenable";
pub(crate) const FOLDER_DUPLICATE: &str = "failure.folderDuplicate";
pub(crate) const FOLDER_LIMIT: &str = "failure.folderLimit";

pub(crate) const LIBRARY_NEWER: &str = "failure.libraryNewer";
pub(crate) const DICTIONARY_NEWER: &str = "failure.dictionaryNewer";

pub(crate) const UPDATE_CHECK: &str = "failure.updateCheck";
pub(crate) const UPDATE_INSTALL: &str = "failure.updateInstall";
pub(crate) const UPDATE_GONE: &str = "failure.updateGone";
