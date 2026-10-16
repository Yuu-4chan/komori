//! Komori-owned main window size and place: the window reopens where it last was, at the
//! size it last had, and maximized if it was maximized.
//!
//! The record is one JSON value in the catalog's `preferences` table, holding the
//! window's inner size in logical pixels, its outer position in physical pixels and
//! whether it is maximized. While the window is maximized the record keeps the size and
//! position from before, so un-maximizing after a restart returns to them. Native code
//! saves the record shortly after the window settles and again when it closes, and applies
//! it before the window is shown. A position no longer on any screen opens centered.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, LogicalSize, PhysicalPosition, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::library::{open_catalog, storage_error};

const RECORD_NAME: &str = "window";
/// How long the size must stay unchanged before it is saved, so a drag writes once.
const SAVE_DELAY: Duration = Duration::from_millis(500);

/// A window size in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Size {
    width: f64,
    height: f64,
}

impl Size {
    fn fits_within(self, area: Size) -> bool {
        self.width <= area.width && self.height <= area.height
    }

    /// This size, made no larger than `area` when one is known.
    fn within(self, area: Option<Size>) -> Size {
        match area {
            Some(area) => Size {
                width: self.width.min(area.width),
                height: self.height.min(area.height),
            },
            None => self,
        }
    }
}

/// A window's outer top-left corner in physical pixels on the virtual screen.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Position {
    x: i32,
    y: i32,
}

/// A screen area in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// How much of the window's top edge must show on one screen for its place to be kept.
const VISIBLE_WIDTH: i32 = 120;
const VISIBLE_HEIGHT: i32 = 40;

/// Whether a window at `position` and `size` shows enough of its top edge on one of the
/// screens' work areas to be found and moved.
fn on_screen(position: Position, size: (i32, i32), areas: &[Area]) -> bool {
    let top_height = VISIBLE_HEIGHT.min(size.1);
    areas.iter().any(|area| {
        let width = (position.x + size.0).min(area.x + area.width) - position.x.max(area.x);
        let height = (position.y + top_height).min(area.y + area.height) - position.y.max(area.y);
        width >= VISIBLE_WIDTH.min(size.0) && height >= top_height
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct WindowSize {
    width: f64,
    height: f64,
    maximized: bool,
    /// Missing in records from before Komori kept the place; such a window opens centered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
}

impl WindowSize {
    fn size(self) -> Size {
        Size {
            width: self.width,
            height: self.height,
        }
    }

    fn is_readable(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }
}

/// The size to open the window at: the saved one within the minimum size, or the default
/// size when nothing readable is saved or the saved size is larger than the work area.
/// The default and the minimum are made no larger than the work area, so the window and
/// its title bar fit on a small or highly scaled screen. Maximized is kept even when the
/// size falls back.
fn restored(
    saved: Option<WindowSize>,
    default: Size,
    minimum: Size,
    work_area: Option<Size>,
) -> WindowSize {
    let default = default.within(work_area);
    let minimum = minimum.within(work_area);
    let unsaved = WindowSize {
        width: default.width,
        height: default.height,
        maximized: false,
        position: None,
    };
    let Some(saved) = saved.filter(|saved| saved.is_readable()) else {
        return unsaved;
    };
    if !work_area.is_some_and(|area| saved.size().fits_within(area)) {
        return WindowSize {
            maximized: saved.maximized,
            ..unsaved
        };
    }
    WindowSize {
        width: saved.width.max(minimum.width),
        height: saved.height.max(minimum.height),
        maximized: saved.maximized,
        position: saved.position,
    }
}

/// The record after the window's inner size changed. A minimized window keeps the
/// record, and a maximized one keeps the size from before it was maximized.
fn after_resize(current: WindowSize, size: Size, maximized: bool, minimized: bool) -> WindowSize {
    if minimized || size.width <= 0.0 || size.height <= 0.0 {
        return current;
    }
    if maximized {
        return WindowSize {
            maximized: true,
            ..current
        };
    }
    WindowSize {
        width: size.width.round(),
        height: size.height.round(),
        maximized: false,
        ..current
    }
}

/// The record after the window moved. A minimized or maximized window keeps the position
/// from before.
fn after_move(
    current: WindowSize,
    position: Position,
    maximized: bool,
    minimized: bool,
) -> WindowSize {
    if minimized || maximized {
        return current;
    }
    WindowSize {
        position: Some(position),
        ..current
    }
}

/// Creates the main window from the app configuration at the restored size and keeps its
/// record up to date.
pub fn create_main_window(app: &AppHandle, database: &Path) -> Result<WebviewWindow, String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("Komori has no main window configuration")?;
    // Windows drops use WebView2's native File objects; allow the DOM feedback/drop path.
    #[cfg(windows)]
    {
        config.drag_drop_enabled = false;
    }
    let default = Size {
        width: config.width,
        height: config.height,
    };
    let minimum = Size {
        width: config.min_width.unwrap_or(0.0),
        height: config.min_height.unwrap_or(0.0),
    };
    // The configured window is centered on the primary monitor.
    let work_area = app.primary_monitor().ok().flatten().map(|monitor| {
        let area = monitor
            .work_area()
            .size
            .to_logical::<f64>(monitor.scale_factor());
        Size {
            width: area.width,
            height: area.height,
        }
    });
    // A record that cannot be read is the same as nothing saved.
    let saved = crate::startup::load(database)
        .unwrap_or_default()
        .remember_window_size
        .then(|| load(database).ok().flatten())
        .flatten();
    let size = restored(saved, default, minimum, work_area);
    config.width = size.width;
    config.height = size.height;
    config.maximized = size.maximized;
    let fitted_minimum = minimum.within(work_area);
    config.min_width = Some(fitted_minimum.width);
    config.min_height = Some(fitted_minimum.height);
    // A kept place is applied to the hidden window, which is then shown there.
    let shown = config.visible;
    if size.position.is_some() {
        config.center = false;
        config.visible = false;
        config.maximized = false;
    }

    // WebView2's own suggestions list under text fields is browser chrome, not Komori's.
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.general_autofill_enabled(false).build())
        .map_err(|error| format!("Komori window could not be created: {error}"))?;
    if let Some(position) = size.position {
        let areas: Vec<Area> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|monitor| {
                let area = monitor.work_area();
                Area {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width as i32,
                    height: area.size.height as i32,
                }
            })
            .collect();
        let outer = window.outer_size().unwrap_or_default();
        if on_screen(position, (outer.width as i32, outer.height as i32), &areas) {
            let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
        } else {
            let _ = window.center();
        }
        if size.maximized {
            let _ = window.maximize();
        }
        if shown {
            let _ = window.show();
        }
    }

    // The kept place may be on another monitor than the primary one.
    let fitted_minimum = Arc::new(Mutex::new(fitted_minimum));
    fit_minimum(&window, minimum, &fitted_minimum);

    let current = Arc::new(Mutex::new(size));
    let saver = spawn_saver(database.to_path_buf());
    let events_window = window.clone();
    let database = database.to_path_buf();
    window.on_window_event(move |event| match event {
        WindowEvent::ScaleFactorChanged { .. } => {
            fit_minimum(&events_window, minimum, &fitted_minimum);
        }
        WindowEvent::Resized(physical) => {
            let scale = events_window.scale_factor().unwrap_or(1.0);
            let logical = physical.to_logical::<f64>(scale);
            let mut current = current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let next = after_resize(
                *current,
                Size {
                    width: logical.width,
                    height: logical.height,
                },
                events_window.is_maximized().unwrap_or(false),
                events_window.is_minimized().unwrap_or(false),
            );
            if next != *current {
                *current = next;
                let _ = saver.send(next);
            }
        }
        WindowEvent::Moved(physical) => {
            fit_minimum(&events_window, minimum, &fitted_minimum);
            let mut current = current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let next = after_move(
                *current,
                Position {
                    x: physical.x,
                    y: physical.y,
                },
                events_window.is_maximized().unwrap_or(false),
                events_window.is_minimized().unwrap_or(false),
            );
            if next != *current {
                *current = next;
                let _ = saver.send(next);
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let current = *current
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = save(&database, current);
        }
        _ => {}
    });
    Ok(window)
}

/// Lowers the window's minimum size to the work area of the monitor it is on, and raises
/// it back to the configured minimum where that fits, so the whole window can always be
/// shown after it moves to a smaller or more scaled monitor.
fn fit_minimum(window: &WebviewWindow, minimum: Size, fitted: &Mutex<Size>) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    let next = minimum.within(Some(Size {
        width: area.width,
        height: area.height,
    }));
    let mut fitted = fitted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *fitted != next {
        *fitted = next;
        let _ = window.set_min_size(Some(LogicalSize::new(next.width, next.height)));
    }
}

/// Saves the latest size once no newer one has arrived for `SAVE_DELAY`.
fn spawn_saver(database: PathBuf) -> Sender<WindowSize> {
    let (sender, receiver) = mpsc::channel::<WindowSize>();
    thread::spawn(move || {
        while let Ok(mut latest) = receiver.recv() {
            loop {
                match receiver.recv_timeout(SAVE_DELAY) {
                    Ok(next) => latest = next,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        let _ = save(&database, latest);
                        return;
                    }
                }
            }
            let _ = save(&database, latest);
        }
    });
    sender
}

fn load(database: &Path) -> Result<Option<WindowSize>, String> {
    load_from(&open_catalog(database)?)
}

fn save(database: &Path, size: WindowSize) -> Result<bool, String> {
    save_to(&open_catalog(database)?, size)
}

fn load_from(connection: &Connection) -> Result<Option<WindowSize>, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [RECORD_NAME],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(stored
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .and_then(|value| serde_json::from_value::<WindowSize>(value).ok())
        .filter(|size| size.is_readable()))
}

fn save_to(connection: &Connection, size: WindowSize) -> Result<bool, String> {
    // Serializes with preference changes: even a queued resize must stop saving once off.
    let _guard = crate::startup::CHANGING
        .lock()
        .map_err(|_| "Window settings unavailable")?;
    if !crate::startup::load_from(connection)?.remember_window_size {
        return Ok(false);
    }
    if !size.is_readable() {
        return Ok(false);
    }
    let value = serde_json::to_string(&size)
        .map_err(|error| format!("Window size could not be encoded: {error}"))?;
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET
               value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![RECORD_NAME, value],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const DEFAULT: Size = Size {
        width: 1440.0,
        height: 900.0,
    };
    const MINIMUM: Size = Size {
        width: 960.0,
        height: 640.0,
    };
    const WORK_AREA: Option<Size> = Some(Size {
        width: 1920.0,
        height: 1032.0,
    });

    fn window(width: f64, height: f64, maximized: bool) -> WindowSize {
        WindowSize {
            width,
            height,
            maximized,
            position: None,
        }
    }

    fn at(x: i32, y: i32) -> Option<Position> {
        Some(Position { x, y })
    }

    fn size(width: f64, height: f64) -> Size {
        Size { width, height }
    }

    #[test]
    fn saves_and_restores_the_latest_size_across_reopen() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(load(&database).unwrap(), None);

        assert!(save(&database, window(1000.0, 1000.0, false)).unwrap());
        assert!(save(&database, window(1100.0, 700.0, true)).unwrap());
        assert_eq!(load(&database).unwrap(), Some(window(1100.0, 700.0, true)));
        assert_eq!(
            restored(load(&database).unwrap(), DEFAULT, MINIMUM, WORK_AREA),
            window(1100.0, 700.0, true)
        );
    }

    #[test]
    fn opens_at_the_default_size_when_nothing_is_saved() {
        assert_eq!(
            restored(None, DEFAULT, MINIMUM, WORK_AREA),
            window(1440.0, 900.0, false)
        );
    }

    #[test]
    fn unreadable_records_load_as_nothing_saved() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        for stored in [
            "not json",
            "{\"width\":1000,\"height\":800}",
            "{\"width\":\"1000\",\"height\":800,\"maximized\":false}",
            "{\"width\":0,\"height\":800,\"maximized\":false}",
            "{\"width\":-1000,\"height\":800,\"maximized\":true}",
            "[1000,800,false]",
        ] {
            connection
                .execute(
                    "INSERT INTO preferences (name, value) VALUES (?1, ?2)
                     ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    params![RECORD_NAME, stored],
                )
                .unwrap();
            assert_eq!(load_from(&connection).unwrap(), None, "{stored}");
        }
        assert!(!save_to(&connection, window(f64::NAN, 800.0, false)).unwrap());
        assert!(!save_to(&connection, window(1000.0, 0.0, false)).unwrap());
    }

    #[test]
    fn a_size_larger_than_the_work_area_opens_at_the_default_size() {
        assert_eq!(
            restored(
                Some(window(2560.0, 900.0, false)),
                DEFAULT,
                MINIMUM,
                WORK_AREA
            ),
            window(1440.0, 900.0, false)
        );
        assert_eq!(
            restored(
                Some(window(1200.0, 1080.0, true)),
                DEFAULT,
                MINIMUM,
                WORK_AREA
            ),
            window(1440.0, 900.0, true)
        );
        // A size exactly filling the work area still fits.
        assert_eq!(
            restored(
                Some(window(1920.0, 1032.0, false)),
                DEFAULT,
                MINIMUM,
                WORK_AREA
            ),
            window(1920.0, 1032.0, false)
        );
        // Without a known work area the saved size cannot be checked.
        assert_eq!(
            restored(Some(window(1000.0, 800.0, false)), DEFAULT, MINIMUM, None),
            window(1440.0, 900.0, false)
        );
    }

    #[test]
    fn the_default_and_minimum_sizes_fit_a_small_work_area() {
        // 1920x1080 at 150%: the default is taller and wider than the screen.
        let laptop = Some(size(1280.0, 688.0));
        assert_eq!(
            restored(None, DEFAULT, MINIMUM, laptop),
            window(1280.0, 688.0, false)
        );
        assert_eq!(
            restored(Some(window(1400.0, 800.0, true)), DEFAULT, MINIMUM, laptop),
            window(1280.0, 688.0, true)
        );
        // 1920x1080 at 200%: even the minimum is taller than the screen.
        let scaled = Some(size(960.0, 516.0));
        assert_eq!(
            restored(None, DEFAULT, MINIMUM, scaled),
            window(960.0, 516.0, false)
        );
        assert_eq!(
            restored(Some(window(900.0, 500.0, false)), DEFAULT, MINIMUM, scaled),
            window(960.0, 516.0, false)
        );
        assert_eq!(MINIMUM.within(scaled), size(960.0, 516.0));
        assert_eq!(MINIMUM.within(WORK_AREA), MINIMUM);
        assert_eq!(MINIMUM.within(None), MINIMUM);
    }

    #[test]
    fn a_saved_size_is_kept_within_the_minimum_size() {
        assert_eq!(
            restored(
                Some(window(700.0, 900.0, false)),
                DEFAULT,
                MINIMUM,
                WORK_AREA
            ),
            window(960.0, 900.0, false)
        );
        assert_eq!(
            restored(
                Some(window(1000.0, 300.0, false)),
                DEFAULT,
                MINIMUM,
                WORK_AREA
            ),
            window(1000.0, 640.0, false)
        );
    }

    #[test]
    fn resizing_records_the_size_and_maximized_state() {
        let start = window(1440.0, 900.0, false);
        let resized = after_resize(start, size(1000.4, 1011.6), false, false);
        assert_eq!(resized, window(1000.0, 1012.0, false));

        // Maximizing keeps the size from before, and restoring records the new size.
        let maximized = after_resize(resized, size(1920.0, 1009.0), true, false);
        assert_eq!(maximized, window(1000.0, 1012.0, true));
        assert_eq!(
            after_resize(maximized, size(1000.0, 1012.0), false, false),
            window(1000.0, 1012.0, false)
        );
    }

    #[test]
    fn minimizing_keeps_the_record() {
        let maximized = window(1000.0, 800.0, true);
        // Windows reports a minimized window as zero-sized and not maximized.
        assert_eq!(
            after_resize(maximized, size(0.0, 0.0), false, true),
            maximized
        );
        assert_eq!(
            after_resize(maximized, size(0.0, 0.0), false, false),
            maximized
        );
        assert_eq!(
            after_resize(maximized, size(160.0, 28.0), false, true),
            maximized
        );
    }

    #[test]
    fn moving_records_the_place_and_reopens_there() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let moved = after_move(
            window(1200.0, 800.0, false),
            Position { x: 310, y: 95 },
            false,
            false,
        );
        assert_eq!(moved.position, at(310, 95));
        // Resizing keeps the place; maximizing or minimizing keeps the place from before.
        let resized = after_resize(moved, size(1000.0, 700.0), false, false);
        assert_eq!(resized.position, at(310, 95));
        assert_eq!(
            after_move(resized, Position { x: -8, y: -8 }, true, false),
            resized
        );
        assert_eq!(
            after_move(
                resized,
                Position {
                    x: -32000,
                    y: -32000
                },
                false,
                true
            ),
            resized
        );
        save(&database, resized).unwrap();
        let reopened = restored(load(&database).unwrap(), DEFAULT, MINIMUM, WORK_AREA);
        assert_eq!(reopened.position, at(310, 95));
        assert_eq!(reopened.size(), size(1000.0, 700.0));
        // A size that no longer fits opens at the default size, centered.
        let too_large = WindowSize {
            position: at(310, 95),
            ..window(2560.0, 900.0, false)
        };
        assert_eq!(
            restored(Some(too_large), DEFAULT, MINIMUM, WORK_AREA).position,
            None
        );
    }

    #[test]
    fn records_without_a_place_still_load() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES (?1, ?2)",
                params![
                    RECORD_NAME,
                    r#"{"width":1000,"height":800,"maximized":false}"#
                ],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            Some(window(1000.0, 800.0, false))
        );
    }

    #[test]
    fn a_place_off_every_screen_is_not_kept() {
        let screens = [
            Area {
                x: 0,
                y: 0,
                width: 1920,
                height: 1032,
            },
            Area {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1400,
            },
        ];
        let size = (1440, 900);
        assert!(on_screen(Position { x: 240, y: 66 }, size, &screens));
        assert!(on_screen(Position { x: 2100, y: 300 }, size, &screens));
        // Mostly past the second screen's right edge, with its left part still showing.
        assert!(on_screen(Position { x: 4300, y: 100 }, size, &screens));
        assert!(!on_screen(Position { x: 4440, y: 100 }, size, &screens));
        // Its top edge above every screen, or below the work area.
        assert!(!on_screen(Position { x: 200, y: -300 }, size, &screens));
        assert!(!on_screen(Position { x: 200, y: 1010 }, size, &screens));
        assert!(!on_screen(Position { x: 200, y: 100 }, size, &[]));
    }

    #[test]
    fn disabled_size_memory_keeps_the_record_unchanged_even_for_a_pending_save() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        save(&database, window(1100.0, 700.0, true)).unwrap();
        let connection = open_catalog(&database).unwrap();
        crate::startup::save_to(
            &connection,
            crate::startup::Preferences {
                remember_window_size: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!save_to(&connection, window(1300.0, 800.0, false)).unwrap());
        assert_eq!(load(&database).unwrap(), Some(window(1100.0, 700.0, true)));
        crate::startup::save_to(&connection, crate::startup::Preferences::default()).unwrap();
        assert!(save_to(&connection, window(1300.0, 800.0, false)).unwrap());
    }
}
