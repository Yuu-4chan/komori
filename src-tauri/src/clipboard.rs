//! Reads the clipboard's text for Komori's own Paste menu item. The web clipboard API would
//! show WebView2's permission prompt, so Komori reads the text natively, only when the reader
//! chooses Paste. Writing (Cut and Copy) stays with the page's own editing commands.

/// Clipboard text longer than this is cut, as a text field holds no more.
const MAX_CHARS: usize = 1 << 20;

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    read()
}

/// Decodes UTF-16 text up to its first NUL or `max_chars` characters, whichever comes first,
/// without looking further. A surrogate pair is one character and is never split; a lone
/// surrogate becomes U+FFFD, as `String::from_utf16_lossy` makes it.
fn decode_prefix(units: &[u16], max_chars: usize) -> String {
    char::decode_utf16(units.iter().copied().take_while(|&unit| unit != 0))
        .take(max_chars)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

#[cfg(windows)]
fn read() -> Result<String, String> {
    use windows_sys::Win32::Foundation::HGLOBAL;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// Closes the clipboard when dropped.
    struct Opened;
    impl Drop for Opened {
        fn drop(&mut self) {
            // SAFETY: only constructed after OpenClipboard succeeded on this thread.
            unsafe { CloseClipboard() };
        }
    }

    /// Unlocks a locked global memory handle when dropped.
    struct Locked(HGLOBAL);
    impl Drop for Locked {
        fn drop(&mut self) {
            // SAFETY: only constructed after GlobalLock succeeded on this handle.
            unsafe { GlobalUnlock(self.0) };
        }
    }

    const CF_UNICODETEXT: u32 = 13;
    // SAFETY: the clipboard is opened and closed on this thread, and the locked buffer is read
    // only within its reported size, up to its terminating NUL or MAX_CHARS characters.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            return Ok(String::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("The clipboard is in use. Try again.".into());
        }
        let _opened = Opened;
        let handle = GetClipboardData(CF_UNICODETEXT) as HGLOBAL;
        if handle.is_null() {
            return Ok(String::new());
        }
        let data = GlobalLock(handle) as *const u16;
        if data.is_null() {
            return Ok(String::new());
        }
        let _locked = Locked(handle);
        let units = std::slice::from_raw_parts(data, GlobalSize(handle) / 2);
        Ok(decode_prefix(units, MAX_CHARS))
    }
}

#[cfg(not(windows))]
fn read() -> Result<String, String> {
    Err("Paste is not available here.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn long_text_is_cut_by_characters() {
        let text = utf16(&"語".repeat(MAX_CHARS + 5));
        assert_eq!(decode_prefix(&text, MAX_CHARS).chars().count(), MAX_CHARS);
        assert_eq!(decode_prefix(&utf16("short"), MAX_CHARS), "short");
    }

    #[test]
    fn an_oversized_buffer_is_read_only_up_to_the_limit_or_its_nul() {
        // Past the limit the buffer holds only unpaired surrogates, which would decode as
        // U+FFFD if they were reached.
        let mut units = utf16(&"a".repeat(8));
        units.extend(std::iter::repeat_n(0xDC00, 1 << 22));
        assert_eq!(decode_prefix(&units, 8), "a".repeat(8));
        let mut units = utf16("before");
        units.push(0);
        units.extend(utf16("after"));
        assert_eq!(decode_prefix(&units, MAX_CHARS), "before");
    }

    #[test]
    fn a_surrogate_pair_at_the_limit_counts_once_and_is_never_split() {
        // 𠮷 is a surrogate pair: three characters fill the limit with four units.
        let units = utf16("ab𠮷c");
        assert_eq!(decode_prefix(&units, 3), "ab𠮷");
        assert_eq!(decode_prefix(&units, 2), "ab");
        let lone = [0x61, 0xD842, 0x62, 0xDFB7];
        assert_eq!(
            decode_prefix(&lone, MAX_CHARS),
            String::from_utf16_lossy(&lone)
        );
    }
}
