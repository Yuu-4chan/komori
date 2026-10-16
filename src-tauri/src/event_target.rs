//! Keeps tao's hidden event window alive when something closes it, so Komori can exit.
//!
//! Tao runs the event loop through a hidden, technically visible top-level window on the
//! main thread. While Komori's window is minimized, Windows' main-window heuristics (used
//! by `taskkill` without `/F` and `Process.CloseMainWindow`) pick that hidden window, and
//! its default `WM_CLOSE` handling destroys it. The event loop then never wakes to exit:
//! closing Komori's window afterwards leaves the process running without a window.
//! Native code therefore subclasses the hidden window so a `WM_CLOSE` sent to it closes
//! Komori's main window instead, through the normal close path.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GetClassNameW, GetWindowThreadProcessId, IsWindow, PostMessageW, WM_CLOSE,
    WM_NCDESTROY,
};

const EVENT_TARGET_CLASS: &str = "Tao Thread Event Target";
const SUBCLASS_ID: usize = 0x4b6f_6d6f;

/// Makes a close sent to the event loop's hidden window close `window` instead.
pub fn forward_close_to(window: &WebviewWindow) {
    let Ok(main) = window.hwnd() else {
        return;
    };
    let main = main.0;
    let thread = unsafe { GetWindowThreadProcessId(main, std::ptr::null_mut()) };
    if let Some(target) = find_thread_window(thread, EVENT_TARGET_CLASS) {
        forward_close(target, main);
    }
}

/// The first top-level window of `thread` with the class `class`.
fn find_thread_window(thread: u32, class: &str) -> Option<HWND> {
    struct Search {
        class: Vec<u16>,
        found: HWND,
    }
    unsafe extern "system" fn visit(window: HWND, search: LPARAM) -> windows_sys::core::BOOL {
        let search = &mut *(search as *mut Search);
        let mut name = [0u16; 64];
        let length = GetClassNameW(window, name.as_mut_ptr(), name.len() as i32);
        if length > 0 && name[..length as usize] == search.class[..] {
            search.found = window;
            return 0;
        }
        1
    }
    let mut search = Search {
        class: class.encode_utf16().collect(),
        found: std::ptr::null_mut(),
    };
    unsafe { EnumThreadWindows(thread, Some(visit), &mut search as *mut Search as LPARAM) };
    (!search.found.is_null()).then_some(search.found)
}

/// Subclasses `target` so a `WM_CLOSE` it receives is posted to `main` instead of
/// destroying it.
fn forward_close(target: HWND, main: HWND) -> bool {
    unsafe { SetWindowSubclass(target, Some(on_message), SUBCLASS_ID, main as usize) != 0 }
}

unsafe extern "system" fn on_message(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    main: usize,
) -> LRESULT {
    match message {
        WM_CLOSE => {
            let main = main as *mut c_void;
            if IsWindow(main) != 0 {
                PostMessageW(main, WM_CLOSE, 0, 0);
            }
            0
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(window, Some(on_message), SUBCLASS_ID);
            DefSubclassProc(window, message, wparam, lparam)
        }
        _ => DefSubclassProc(window, message, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
        RegisterClassW, SendMessageW, MSG, PM_REMOVE, WNDCLASSW, WS_OVERLAPPED,
    };

    const TARGET_CLASS: &str = "Komori Test Event Target";
    const MAIN_CLASS: &str = "Komori Test Main Window";

    thread_local! {
        static MAIN_CLOSES: Cell<u32> = const { Cell::new(0) };
    }

    unsafe extern "system" fn main_procedure(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_CLOSE {
            MAIN_CLOSES.with(|closes| closes.set(closes.get() + 1));
            return 0;
        }
        DefWindowProcW(window, message, wparam, lparam)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// A hidden top-level window of this thread; the event target uses the default
    /// procedure, like tao's.
    fn create_window(class: &str, recording: bool) -> HWND {
        let class = wide(class);
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let mut definition: WNDCLASSW = std::mem::zeroed();
            definition.lpfnWndProc = Some(if recording {
                main_procedure
            } else {
                DefWindowProcW
            });
            definition.hInstance = instance;
            definition.lpszClassName = class.as_ptr();
            // Another test may have registered the class already.
            RegisterClassW(&definition);
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            assert!(!window.is_null());
            window
        }
    }

    fn pump_messages() {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&message);
            }
        }
    }

    #[test]
    fn a_close_destroys_an_unforwarded_event_target() {
        let target = create_window(TARGET_CLASS, false);
        unsafe {
            SendMessageW(target, WM_CLOSE, 0, 0);
            assert_eq!(IsWindow(target), 0);
        }
    }

    #[test]
    fn a_close_sent_to_the_event_target_closes_the_main_window_instead() {
        let target = create_window(TARGET_CLASS, false);
        let main = create_window(MAIN_CLASS, true);
        let thread = unsafe { GetCurrentThreadId() };
        assert_eq!(find_thread_window(thread, TARGET_CLASS), Some(target));
        assert!(forward_close(target, main));

        unsafe { SendMessageW(target, WM_CLOSE, 0, 0) };
        pump_messages();
        assert_ne!(unsafe { IsWindow(target) }, 0);
        assert_eq!(MAIN_CLOSES.with(Cell::get), 1);

        // Other messages still reach the window, which can still be destroyed.
        unsafe {
            assert!(DestroyWindow(target) != 0);
            assert_eq!(IsWindow(target), 0);
            DestroyWindow(main);
        }
    }

    #[test]
    fn finds_nothing_without_a_window_of_the_class() {
        let thread = unsafe { GetCurrentThreadId() };
        assert_eq!(
            find_thread_window(thread, "Komori Test Missing Class"),
            None
        );
    }
}
