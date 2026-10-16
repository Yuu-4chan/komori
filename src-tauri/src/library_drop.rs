//! OS-selected EPUB paths stay native; the Library receives a short-lived, single-use ID.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow, WindowEvent};
use uuid::Uuid;

use crate::bulk_progress::BatchProgress;
use crate::library::{import_paths_with_progress, open_catalog, CatalogState, ImportBatch};

const MAX_FILES: usize = 2_000;
const LIFETIME: Duration = Duration::from_secs(30);

struct PendingDrop {
    id: String,
    paths: Vec<PathBuf>,
    received: Instant,
}

#[derive(Default)]
pub struct LibraryDropState(Mutex<Option<PendingDrop>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragNotice {
    phase: &'static str,
    accepted: bool,
    drop_id: Option<String>,
}

fn epub_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    if paths.len() > MAX_FILES {
        return Vec::new();
    }
    paths
        .iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
        })
        .cloned()
        .collect()
}

impl LibraryDropState {
    fn stage(&self, paths: Vec<PathBuf>) -> Option<String> {
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *pending = None;
        if paths.is_empty() {
            return None;
        }
        let id = Uuid::new_v4().to_string();
        *pending = Some(PendingDrop {
            id: id.clone(),
            paths,
            received: Instant::now(),
        });
        Some(id)
    }

    fn take(&self, id: &str) -> Option<Vec<PathBuf>> {
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let selected = pending.as_ref()?;
        if selected.received.elapsed() > LIFETIME {
            *pending = None;
            return None;
        }
        if selected.id != id {
            return None;
        }
        pending.take().map(|selected| selected.paths)
    }
}

pub fn install(window: &WebviewWindow) {
    let handle = window.app_handle().clone();
    // Tauri routes the window's main webview drops as WindowEvent, unlike child webviews.
    window.on_window_event(move |event| {
        let state = handle.state::<LibraryDropState>();
        if let Some(notice) = drag_notice(event, &state) {
            let _ = handle.emit_to("main", "library-file-drag", notice);
        }
    });
    #[cfg(windows)]
    install_windows_files(window);
}

#[cfg(windows)]
fn library_drop_source(source: &str, message: &str, dev_url: Option<&tauri::Url>) -> bool {
    message == "komori-library-epub-drop"
        && tauri::Url::parse(source).is_ok_and(|url| {
            ((url.scheme() == "http"
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none())
                || dev_url.is_some_and(|dev| url.origin() == dev.origin()))
                && url.username().is_empty()
                && url.password().is_none()
                && (url.path() == "/library" || url.path().starts_with("/library/"))
        })
}

#[cfg(windows)]
fn install_windows_files(window: &WebviewWindow) {
    use webview2_com::{
        CoTaskMemPWSTR,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        },
        WebMessageReceivedEventHandler,
    };
    use windows::core::{Interface, PWSTR};

    let app = window.app_handle().clone();
    let dev_url = tauri::is_dev()
        .then(|| app.config().build.dev_url.clone())
        .flatten();
    let result = window.with_webview(move |webview| unsafe {
        let install = || -> windows::core::Result<()> {
            let core = webview.controller().CoreWebView2()?;
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut message = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut message).is_err() {
                    return Ok(());
                }
                let message = CoTaskMemPWSTR::from(message).to_string();
                let mut source = PWSTR::null();
                args.Source(&mut source)?;
                let source = CoTaskMemPWSTR::from(source).to_string();
                if !library_drop_source(&source, &message, dev_url.as_ref()) {
                    return Ok(());
                }
                let objects = args
                    .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
                    .AdditionalObjects()?;
                let mut count = 0;
                objects.Count(&mut count)?;
                if count > MAX_FILES as u32 {
                    return Ok(());
                }
                let mut paths = Vec::new();
                for index in 0..count {
                    let object = objects.GetValueAtIndex(index)?;
                    let Ok(file) = object.cast::<ICoreWebView2File>() else {
                        continue;
                    };
                    let mut path = PWSTR::null();
                    file.Path(&mut path)?;
                    let path = PathBuf::from(CoTaskMemPWSTR::from(path).to_string());
                    if path.is_absolute() && path.is_file() {
                        paths.push(path);
                    }
                }
                let state = app.state::<LibraryDropState>();
                let drop_id = state.stage(epub_paths(&paths));
                let _ = app.emit_to(
                    "main",
                    "library-file-drag",
                    DragNotice {
                        phase: "drop",
                        accepted: drop_id.is_some(),
                        drop_id,
                    },
                );
                Ok(())
            }));
            let mut token = 0;
            core.add_WebMessageReceived(&handler, &mut token)?;
            Ok(())
        };
        if install().is_err() {
            eprintln!("Komori file-drop receiver could not be installed");
        }
    });
    if result.is_err() {
        eprintln!("Komori file-drop receiver could not be scheduled");
    }
}

fn drag_notice(event: &WindowEvent, state: &LibraryDropState) -> Option<DragNotice> {
    let WindowEvent::DragDrop(event) = event else {
        return None;
    };
    Some(match event {
        DragDropEvent::Enter { paths, .. } => {
            state.stage(Vec::new());
            DragNotice {
                phase: "enter",
                accepted: !epub_paths(paths).is_empty(),
                drop_id: None,
            }
        }
        DragDropEvent::Drop { paths, .. } => {
            let paths = epub_paths(paths)
                .into_iter()
                .filter(|path| path.is_file())
                .collect();
            let drop_id = state.stage(paths);
            DragNotice {
                phase: "drop",
                accepted: drop_id.is_some(),
                drop_id,
            }
        }
        DragDropEvent::Leave => DragNotice {
            phase: "leave",
            accepted: false,
            drop_id: None,
        },
        _ => return None,
    })
}

#[tauri::command]
pub async fn import_dropped_books(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    drops: State<'_, LibraryDropState>,
    drop_id: String,
    operation_id: Option<String>,
) -> Result<ImportBatch, String> {
    let mut progress = BatchProgress::for_app(app, operation_id)?;
    let paths = drops.take(&drop_id).ok_or("EPUB drop expired")?;
    let database = catalog.database.clone();
    let write_lock = Arc::clone(&catalog.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = open_catalog(&database)?;
        Ok(ImportBatch {
            canceled: false,
            results: import_paths_with_progress(&mut connection, &paths, &mut progress),
        })
    })
    .await
    .map_err(|error| format!("Import task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn file_object_bridge_accepts_only_komori_library_messages() {
        let message = "komori-library-epub-drop";
        assert!(library_drop_source(
            "http://tauri.localhost/library",
            message,
            None
        ));
        assert!(library_drop_source(
            "http://tauri.localhost/library/series/one",
            message,
            None
        ));
        for source in [
            "https://foreign.example/library",
            "http://tauri.localhost.attacker/library",
            "file:///library",
            "http://tauri.localhost/reader/id",
            "http://user@tauri.localhost/library",
            "http://tauri.localhost:1420/library",
        ] {
            assert!(!library_drop_source(source, message, None), "{source}");
        }
        assert!(!library_drop_source(
            "http://tauri.localhost/library",
            "C:/arbitrary.epub",
            None
        ));
        let dev_url = tauri::Url::parse("http://127.0.0.1:1420").unwrap();
        assert!(library_drop_source(
            "http://127.0.0.1:1420/library",
            message,
            Some(&dev_url)
        ));
        for source in [
            "http://127.0.0.1:1421/library",
            "http://127.0.0.1:1420/reader/id",
            "http://user@127.0.0.1:1420/library",
        ] {
            assert!(!library_drop_source(source, message, Some(&dev_url)));
        }
    }

    #[test]
    fn main_window_drag_events_reach_feedback_and_the_import_slot() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("book.EPUB");
        std::fs::write(&source, b"selected file").unwrap();
        let paths = vec![source.clone(), directory.path().join("ignored.png")];
        let state = LibraryDropState::default();
        let position = tauri::PhysicalPosition::new(50.0, 60.0);
        let enter = drag_notice(
            &WindowEvent::DragDrop(DragDropEvent::Enter {
                paths: paths.clone(),
                position,
            }),
            &state,
        )
        .unwrap();
        assert_eq!(enter.phase, "enter");
        assert!(enter.accepted);
        assert!(enter.drop_id.is_none());
        let drop = drag_notice(
            &WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }),
            &state,
        )
        .unwrap();
        assert_eq!(drop.phase, "drop");
        assert!(drop.accepted);
        assert_eq!(state.take(&drop.drop_id.unwrap()), Some(vec![source]));
        let leave = drag_notice(&WindowEvent::DragDrop(DragDropEvent::Leave), &state).unwrap();
        assert_eq!(leave.phase, "leave");
        assert!(!leave.accepted);
        assert!(drag_notice(&WindowEvent::Focused(true), &state).is_none());
        assert!(drag_notice(
            &WindowEvent::DragDrop(DragDropEvent::Over { position }),
            &state
        )
        .is_none());
    }

    #[test]
    fn selects_epubs_and_refuses_oversized_drops() {
        let paths = [
            "one.epub",
            "TWO.EPUB",
            "not.epub.zip",
            "folder",
            "image.png",
        ]
        .map(PathBuf::from);
        assert_eq!(epub_paths(&paths), paths[..2]);
        assert!(epub_paths(&vec![PathBuf::from("one.epub"); MAX_FILES + 1]).is_empty());
    }

    #[test]
    fn drop_ids_are_single_use_bounded_and_cannot_supply_paths() {
        let state = LibraryDropState::default();
        let paths = vec![PathBuf::from("one.epub")];
        let first = state.stage(paths.clone()).unwrap();
        assert!(state.take("C:/anything.epub").is_none());
        let second = state.stage(paths.clone()).unwrap();
        assert!(state.take(&first).is_none());
        assert_eq!(state.take(&second), Some(paths.clone()));
        assert!(state.take(&second).is_none());
        let third = state.stage(paths.clone()).unwrap();
        state.0.lock().unwrap().as_mut().unwrap().received = Instant::now() - LIFETIME;
        assert!(state.take(&third).is_none());
        let fourth = state.stage(paths).unwrap();
        state.stage(Vec::new());
        assert!(state.take(&fourth).is_none());
    }

    #[test]
    fn staged_batch_uses_catalog_import_progress_duplicates_failures_and_read_only_sources() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("valid.EPUB");
        crate::library::tests::fixture(&source, Some("Dropped book"), None, false);
        let invalid = directory.path().join("invalid.epub");
        std::fs::write(&invalid, b"invalid archive").unwrap();
        let original = std::fs::read(&source).unwrap();
        let modified = std::fs::metadata(&source).unwrap().modified().unwrap();
        let state = LibraryDropState::default();
        let paths = epub_paths(&[
            source.clone(),
            invalid,
            source.clone(),
            directory.path().join("ignored.zip"),
        ]);
        let id = state.stage(paths).unwrap();
        let mut catalog = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        let (mut progress, events) = crate::bulk_progress::recording();
        let results =
            import_paths_with_progress(&mut catalog, &state.take(&id).unwrap(), &mut progress);
        assert_eq!(
            results.iter().map(|item| item.status).collect::<Vec<_>>(),
            ["imported", "failed", "alreadyImported"]
        );
        assert_eq!(events.lock().unwrap().last().unwrap().completed, 3);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&source).unwrap().modified().unwrap(),
            modified
        );
        let notice = serde_json::to_string(&DragNotice {
            phase: "drop",
            accepted: true,
            drop_id: Some(id),
        })
        .unwrap();
        assert!(!notice.contains("valid.EPUB"));
        assert!(!notice.contains("paths"));
        let result = serde_json::to_string(&results).unwrap();
        assert!(!result.contains(&directory.path().display().to_string()));
    }
}
