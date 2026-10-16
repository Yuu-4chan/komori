//! The app icon chosen in Settings, shown on the window (taskbar, Alt+Tab) and the tray. The
//! executable, its shortcuts and a pinned button while Komori is closed keep the built-in
//! default, `beige`. `scripts/app-icons.mjs` renders these from `src/brand/appIcons.ts`.
use std::path::Path;

use tauri::{image::Image, AppHandle, Manager};

macro_rules! icons {
    ($($id:literal),* $(,)?) => {
        pub(crate) const APP_ICONS: [&str; [$($id),*].len()] = [$($id),*];
        const IMAGES: [&[u8]; APP_ICONS.len()] =
            [$(include_bytes!(concat!("../icons/app/", $id, ".png"))),*];
    };
}
icons!(
    "navy", "plum", "charcoal", "teal", "forest", "twilight", "ocean", "midnight", "beige",
    "white", "butter", "sky", "lavender", "mint", "peach", "sunrise",
);
pub(crate) const DEFAULT_APP_ICON: &str = "beige";

/// The icon named `id`, or the default for any other name.
pub(crate) fn image(id: Option<&str>) -> Option<Image<'static>> {
    let index = APP_ICONS
        .iter()
        .position(|candidate| Some(*candidate) == id)
        .or_else(|| APP_ICONS.iter().position(|id| *id == DEFAULT_APP_ICON))?;
    let decoded = image::load_from_memory_with_format(IMAGES[index], image::ImageFormat::Png)
        .ok()?
        .into_rgba8();
    let (width, height) = decoded.dimensions();
    Some(Image::new_owned(decoded.into_raw(), width, height))
}

/// The saved choice in the catalog's appearance record, if any.
pub(crate) fn saved(database: &Path) -> Option<String> {
    crate::appearance_preferences::app_icon(database)
}

/// Shows `id` (or the default) on the main window and the tray, when there is one.
pub(crate) fn apply(app: &AppHandle, id: Option<&str>) {
    let Some(icon) = image(id) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_icon(icon.clone());
        #[cfg(windows)]
        set_taskbar_icon(&window, &icon);
    }
    if let Some(tray) = app.tray_by_id("komori") {
        let _ = tray.set_icon(Some(icon));
    }
}

/// Tauri sets only the window's small icon; the taskbar and Alt+Tab show the big one, which
/// would otherwise stay the executable's.
#[cfg(windows)]
fn set_taskbar_icon(window: &tauri::WebviewWindow, icon: &Image<'_>) {
    use std::sync::atomic::{AtomicPtr, Ordering};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIcon, DestroyIcon, SendMessageW, ICON_BIG, WM_SETICON,
    };
    /// The big icon Komori made last, destroyed once the window shows the next.
    static SHOWN: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let (width, height) = (icon.width(), icon.height());
    let mut bgra = icon.rgba().to_vec();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    // Alpha decides transparency; the monochrome mask's word-aligned rows stay empty.
    let mask = vec![0u8; (width.div_ceil(16) * 2 * height) as usize];
    // SAFETY: both buffers outlive the call and match the size and depth given.
    let created = unsafe {
        CreateIcon(
            std::ptr::null_mut(),
            width as i32,
            height as i32,
            1,
            32,
            mask.as_ptr(),
            bgra.as_ptr(),
        )
    };
    if created.is_null() {
        return;
    }
    // SAFETY: the window handle is live while Tauri owns the window; the icon is Komori's own.
    unsafe {
        SendMessageW(hwnd.0, WM_SETICON, ICON_BIG as usize, created as isize);
        let previous = SHOWN.swap(created, Ordering::SeqCst);
        if !previous.is_null() {
            DestroyIcon(previous);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_choice_decodes_and_unknown_names_fall_back_to_the_default() {
        for id in APP_ICONS {
            let icon = image(Some(id)).unwrap();
            assert_eq!((icon.width(), icon.height()), (128, 128), "{id}");
        }
        let default = image(Some(DEFAULT_APP_ICON)).unwrap();
        for other in [None, Some("pink"), Some("")] {
            assert_eq!(image(other).unwrap().rgba(), default.rgba());
        }
        assert!(APP_ICONS.contains(&DEFAULT_APP_ICON));
    }

    #[test]
    fn the_frontend_offers_exactly_the_native_choices() {
        let source = include_str!("../../src/brand/appIcons.ts");
        let offered: Vec<&str> = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix("{ id: \""))
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert_eq!(offered, APP_ICONS);
        assert!(source.contains(&format!(
            "defaultAppIcon: AppIconId = \"{DEFAULT_APP_ICON}\""
        )));
    }
}
