//! The PC's native file pickers. Android has no path-based pickers: there every picker answers
//! as if the reader closed it, and the phone shell offers none of these actions. Books on the
//! phone come through the Android document picker in `android_documents` instead.

#[cfg(desktop)]
pub(crate) use rfd::{AsyncFileDialog, FileDialog};

#[cfg(mobile)]
pub(crate) use unavailable::{AsyncFileDialog, FileDialog};

#[cfg(mobile)]
mod unavailable {
    use std::path::{Path, PathBuf};

    /// No picker opens on Android, so no file is ever picked.
    pub(crate) enum FileHandle {}

    impl FileHandle {
        pub(crate) fn path(&self) -> &Path {
            match *self {}
        }
    }

    pub(crate) struct AsyncFileDialog;

    impl AsyncFileDialog {
        pub(crate) fn new() -> Self {
            Self
        }

        pub(crate) fn set_title(self, _title: impl Into<String>) -> Self {
            self
        }

        pub(crate) fn add_filter(
            self,
            _name: impl Into<String>,
            _extensions: &[impl ToString],
        ) -> Self {
            self
        }

        pub(crate) fn set_file_name(self, _name: impl Into<String>) -> Self {
            self
        }

        pub(crate) fn set_parent<W>(self, _parent: &W) -> Self {
            self
        }

        pub(crate) async fn pick_file(self) -> Option<FileHandle> {
            None
        }

        pub(crate) async fn pick_files(self) -> Option<Vec<FileHandle>> {
            None
        }

        pub(crate) async fn pick_folder(self) -> Option<FileHandle> {
            None
        }

        pub(crate) async fn save_file(self) -> Option<FileHandle> {
            None
        }
    }

    pub(crate) struct FileDialog;

    impl FileDialog {
        pub(crate) fn new() -> Self {
            Self
        }

        pub(crate) fn set_title(self, _title: impl Into<String>) -> Self {
            self
        }

        pub(crate) fn add_filter(
            self,
            _name: impl Into<String>,
            _extensions: &[impl ToString],
        ) -> Self {
            self
        }

        pub(crate) fn pick_files(self) -> Option<Vec<PathBuf>> {
            None
        }
    }
}
