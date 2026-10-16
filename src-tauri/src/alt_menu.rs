//! Bare Alt must not put the frameless Reader into Windows' invisible menu mode.
//! DefWindowProc turns an Alt release into SC_KEYMENU even though Komori has no
//! menu bar. The menu loop then consumes ordinary wheel input until another Alt.

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_NCDESTROY, WM_SYSCOMMAND};

const SUBCLASS_ID: usize = 0x4b6f_6d70;

pub fn guard(window: &WebviewWindow) {
    if let Ok(window) = window.hwnd() {
        install(window.0);
    }
}

fn install(window: HWND) -> bool {
    unsafe { SetWindowSubclass(window, Some(on_message), SUBCLASS_ID, 0) != 0 }
}

unsafe extern "system" fn on_message(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_SYSCOMMAND && wparam & 0xfff0 == SC_KEYMENU as usize && lparam == 0 {
        // Keep Alt+Space (lparam = ' ') and all other window commands native.
        return 0;
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(window, Some(on_message), SUBCLASS_ID);
    }
    DefSubclassProc(window, message, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SendMessageW, SC_CLOSE,
        SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, WNDCLASSW, WS_OVERLAPPED,
    };

    thread_local! {
        static COMMANDS: RefCell<Vec<(WPARAM, LPARAM)>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn recording(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_SYSCOMMAND {
            COMMANDS.with(|commands| commands.borrow_mut().push((wparam, lparam)));
            return 17;
        }
        DefWindowProcW(window, message, wparam, lparam)
    }

    #[test]
    fn blocks_bare_alt_menu_activation_but_preserves_window_commands() {
        unsafe {
            let class: Vec<u16> = "Komori Test Alt Menu".encode_utf16().chain([0]).collect();
            let instance = GetModuleHandleW(std::ptr::null());
            let mut definition: WNDCLASSW = std::mem::zeroed();
            definition.lpfnWndProc = Some(recording);
            definition.hInstance = instance;
            definition.lpszClassName = class.as_ptr();
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
            assert!(install(window));
            COMMANDS.with(|commands| commands.borrow_mut().clear());
            for command in [SC_KEYMENU, SC_KEYMENU | 3] {
                assert_eq!(SendMessageW(window, WM_SYSCOMMAND, command as usize, 0), 0);
            }
            assert!(COMMANDS.with(|commands| commands.borrow().is_empty()));
            let commands = [
                (SC_KEYMENU, 32),
                (SC_CLOSE, 0),
                (SC_MAXIMIZE, 0),
                (SC_MINIMIZE, 0),
                (SC_RESTORE, 0),
            ];
            for (command, parameter) in commands {
                assert_eq!(
                    SendMessageW(window, WM_SYSCOMMAND, command as usize, parameter),
                    17
                );
            }
            assert_eq!(
                COMMANDS.with(|commands| commands.borrow().clone()),
                commands.map(|(command, parameter)| (command as usize, parameter))
            );
            assert_ne!(DestroyWindow(window), 0);
        }
    }
}
