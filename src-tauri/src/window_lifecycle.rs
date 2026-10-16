//! A close first lets the renderer flush Reader state. Closing to tray keeps the same webview;
//! Quit bypasses the tray choice and exits. A native deadline also handles an unavailable webview.
use std::{path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

use crate::interface_text::{self, Text};

/// What happens to the main window, decided apart from Tauri so it can be tested.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Event {
    /// The window was asked to close; `keep_in_tray` when closing to tray is on and the tray
    /// exists.
    CloseRequested {
        token: String,
        keep_in_tray: bool,
    },
    /// The frontend flushed its state for this close.
    Acknowledged(String),
    /// The native deadline for this close passed.
    DeadlineElapsed(String),
    TrayShow,
    TrayQuit,
    SecondLaunch,
}

#[derive(Debug, PartialEq, Eq)]
enum Effect {
    /// Ask the frontend to flush under this token and start the native deadline.
    Flush(String),
    /// Close the window, which comes back as `CloseRequested`.
    Close,
    Hide,
    ShowAndFocus,
    Exit,
}

#[derive(Debug, Default)]
struct Decisions {
    quitting: bool,
    /// The close in flight: its token, and whether it ends in an exit rather than the tray.
    pending: Option<(String, bool)>,
}

impl Decisions {
    fn handle(&mut self, event: Event) -> Option<Effect> {
        match event {
            Event::CloseRequested {
                token,
                keep_in_tray,
            } => {
                let quit = self.quitting || !keep_in_tray;
                // A second close upgrades an in-flight hide when Quit was chosen.
                if let Some((_, action)) = self.pending.as_mut() {
                    *action |= quit;
                    return None;
                }
                self.pending = Some((token.clone(), quit));
                Some(Effect::Flush(token))
            }
            Event::Acknowledged(token) | Event::DeadlineElapsed(token) => {
                if !self
                    .pending
                    .as_ref()
                    .is_some_and(|(held, _)| *held == token)
                {
                    return None;
                }
                let (_, quit) = self.pending.take()?;
                Some(if quit { Effect::Exit } else { Effect::Hide })
            }
            Event::TrayShow | Event::SecondLaunch => Some(Effect::ShowAndFocus),
            Event::TrayQuit => {
                self.quitting = true;
                Some(Effect::Close)
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Lifecycle {
    decisions: Mutex<Decisions>,
    /// The catalog, whose appearance record names the tray menu's language.
    database: Mutex<Option<PathBuf>>,
    /// The tray menu's Show and Quit items, renamed when the interface language changes.
    tray_items: Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>>,
}

/// Names the tray menu's items in `language`; nothing happens without a tray.
pub(crate) fn relabel_tray(app: &AppHandle, language: &str) {
    let Some(lifecycle) = app.try_state::<Lifecycle>() else {
        return;
    };
    let items = lifecycle
        .tray_items
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some((show, quit)) = items {
        let _ = show.set_text(interface_text::text(language, Text::ShowKomori));
        let _ = quit.set_text(interface_text::text(language, Text::Quit));
    }
}

/// Decides `event` and carries out its effect; returns whether there was one.
fn apply(app: &AppHandle, event: Event) -> bool {
    let effect = match app.try_state::<Lifecycle>() {
        Some(lifecycle) => lifecycle
            .decisions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .handle(event),
        None => Decisions::default().handle(event),
    };
    let Some(effect) = effect else {
        return false;
    };
    match effect {
        Effect::Flush(token) => {
            let _ = app.emit_to("main", "komori-window-closing", &token);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                apply(&app, Event::DeadlineElapsed(token));
            });
        }
        Effect::Close => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        Effect::Hide => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                let _ = window.emit("komori-window-visible", false);
            }
        }
        Effect::ShowAndFocus => show(app),
        Effect::Exit => {
            // Destroying the last window ends the process, so the window only hides until a
            // running store rewrite has rolled back.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            let app = app.clone();
            std::thread::spawn(move || {
                let maintenance = crate::bulk_progress::finish_maintenance();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.destroy();
                }
                app.exit(0);
                std::mem::forget(maintenance);
            });
        }
    }
    true
}

/// A second Komori launch shows this one's window instead.
pub(crate) fn second_launch(app: &AppHandle) {
    apply(app, Event::SecondLaunch);
}

pub(crate) fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("komori-window-visible", true);
    }
}

pub(crate) fn ensure_tray(app: &AppHandle, visible: bool) -> Result<(), String> {
    if app.tray_by_id("komori").is_none() && visible {
        let lifecycle = app.state::<Lifecycle>();
        let database = lifecycle
            .database
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let language = database
            .as_deref()
            .map(interface_text::language)
            .unwrap_or("en");
        let show_item = MenuItem::with_id(
            app,
            "show",
            interface_text::text(language, Text::ShowKomori),
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        let quit_item = MenuItem::with_id(
            app,
            "quit",
            interface_text::text(language, Text::Quit),
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        let menu = Menu::with_items(app, &[&show_item, &quit_item]).map_err(|e| e.to_string())?;
        *lifecycle
            .tray_items
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some((show_item.clone(), quit_item.clone()));
        let icon = crate::app_icon::image(
            database
                .as_deref()
                .and_then(crate::app_icon::saved)
                .as_deref(),
        )
        .ok_or("Komori tray icon unavailable")?;
        TrayIconBuilder::with_id("komori")
            .icon(icon)
            .tooltip("Komori")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    apply(app, Event::TrayShow);
                }
                "quit" => {
                    apply(app, Event::TrayQuit);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    }
                ) {
                    apply(tray.app_handle(), Event::TrayShow);
                }
            })
            .build(app)
            .map_err(|e| format!("Komori tray could not be created: {e}"))?;
    }
    if let Some(tray) = app.tray_by_id("komori") {
        tray.set_visible(visible).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn install(app: &AppHandle, database: &std::path::Path) {
    app.manage(Lifecycle {
        database: Mutex::new(Some(database.to_path_buf())),
        ..Lifecycle::default()
    });
    let _ = ensure_tray(
        app,
        crate::startup::load(database)
            .unwrap_or_default()
            .minimize_to_tray,
    );
    let window = app.get_webview_window("main").expect("main window created");
    let handle = app.clone();
    let database = database.to_path_buf();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let keep_in_tray = crate::startup::load(&database)
                .unwrap_or_default()
                .minimize_to_tray
                && handle.tray_by_id("komori").is_some();
            let token = uuid::Uuid::new_v4().to_string();
            apply(
                &handle,
                Event::CloseRequested {
                    token,
                    keep_in_tray,
                },
            );
        }
    });
}

#[tauri::command]
pub fn finish_window_close(app: AppHandle, _state: State<'_, Lifecycle>, token: String) -> bool {
    apply(&app, Event::Acknowledged(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(token: &str, keep_in_tray: bool) -> Event {
        Event::CloseRequested {
            token: token.into(),
            keep_in_tray,
        }
    }

    fn acknowledged(token: &str) -> Event {
        Event::Acknowledged(token.into())
    }

    fn deadline(token: &str) -> Event {
        Event::DeadlineElapsed(token.into())
    }

    fn flush(token: &str) -> Option<Effect> {
        Some(Effect::Flush(token.into()))
    }

    #[test]
    fn a_close_waits_for_the_frontend_and_hides_to_tray_or_exits() {
        let mut decisions = Decisions::default();
        assert_eq!(decisions.handle(close("a", true)), flush("a"));
        // Nothing happens until the matching acknowledgment.
        assert_eq!(decisions.handle(acknowledged("other")), None);
        assert_eq!(decisions.handle(acknowledged("a")), Some(Effect::Hide));
        // The deadline of a finished close does nothing.
        assert_eq!(decisions.handle(deadline("a")), None);

        assert_eq!(decisions.handle(close("b", false)), flush("b"));
        assert_eq!(decisions.handle(acknowledged("b")), Some(Effect::Exit));
    }

    #[test]
    fn the_deadline_finishes_a_close_without_an_acknowledgment() {
        let mut decisions = Decisions::default();
        decisions.handle(close("a", false));
        assert_eq!(decisions.handle(deadline("a")), Some(Effect::Exit));
        assert_eq!(decisions.handle(acknowledged("a")), None);
        decisions.handle(close("b", true));
        assert_eq!(decisions.handle(deadline("b")), Some(Effect::Hide));
    }

    #[test]
    fn the_tray_shows_the_window_and_quit_exits_after_the_flush() {
        let mut decisions = Decisions::default();
        decisions.handle(close("a", true));
        decisions.handle(acknowledged("a"));
        assert_eq!(
            decisions.handle(Event::TrayShow),
            Some(Effect::ShowAndFocus)
        );
        assert_eq!(decisions.handle(Event::TrayQuit), Some(Effect::Close));
        // Quit closes through the same flush, then exits even with closing to tray on.
        assert_eq!(decisions.handle(close("b", true)), flush("b"));
        assert_eq!(decisions.handle(acknowledged("b")), Some(Effect::Exit));
    }

    #[test]
    fn quit_during_a_close_to_tray_upgrades_it_to_an_exit() {
        let mut decisions = Decisions::default();
        decisions.handle(close("a", true));
        assert_eq!(decisions.handle(Event::TrayQuit), Some(Effect::Close));
        // The second close joins the one in flight instead of asking again.
        assert_eq!(decisions.handle(close("b", true)), None);
        assert_eq!(decisions.handle(acknowledged("b")), None);
        assert_eq!(decisions.handle(acknowledged("a")), Some(Effect::Exit));
    }

    #[test]
    fn a_second_launch_shows_and_focuses_the_existing_window() {
        let mut decisions = Decisions::default();
        assert_eq!(
            decisions.handle(Event::SecondLaunch),
            Some(Effect::ShowAndFocus)
        );
        // Also while a close to tray is in flight, which it leaves alone.
        decisions.handle(close("a", true));
        assert_eq!(
            decisions.handle(Event::SecondLaunch),
            Some(Effect::ShowAndFocus)
        );
        assert_eq!(decisions.handle(acknowledged("a")), Some(Effect::Hide));
    }
}
