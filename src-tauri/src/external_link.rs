//! Opens a dictionary's web link (such as a "search on Google" or source-page link) in the
//! user's default browser. Only plain http(s) addresses without credentials pass; Komori itself
//! never fetches them.

const MAX_URL_BYTES: usize = 2048;

#[tauri::command]
pub async fn open_external_link(url: String) -> Result<(), String> {
    let url = checked_url(&url).ok_or_else(|| "This link cannot be opened.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || open(&url))
        .await
        .map_err(|error| format!("Opening the link failed: {error}"))?
}

/// The address to hand to the browser: http(s), a host, no user info, and none of the characters
/// that could leave a quoted command-line argument (the frontend percent-encodes spaces).
fn checked_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > MAX_URL_BYTES
        || url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "\"'<>`\\".contains(c))
    {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(url.to_owned())
}

#[cfg(windows)]
fn open(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(url));
    // SAFETY: both strings are NUL-terminated and outlive the call; no window owns the request.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value greater than 32.
    if result as isize > 32 {
        Ok(())
    } else {
        Err("The link could not be opened.".into())
    }
}

#[cfg(not(windows))]
fn open(_url: &str) -> Result<(), String> {
    Err("Opening links is supported on Windows only.".into())
}

#[cfg(test)]
mod tests {
    use super::checked_url;

    #[test]
    fn only_plain_web_addresses_open() {
        for url in [
            "https://www.google.com/search?q=%E8%AA%B0",
            "http://www.edewakaru.com/archives/27132850.html",
            "HTTPS://ja.wikipedia.org/wiki/%E8%A8%98%E5%8F%B7#top",
        ] {
            assert_eq!(checked_url(url).as_deref(), Some(url));
        }
        for url in [
            "",
            "javascript:alert(1)",
            "file:///C:/Windows/notepad.exe",
            "ms-settings:privacy",
            "https://",
            "https:///path",
            "https://user:secret@example.com/",
            "https://example.com/a b",
            "https://example.com/\"--flag",
            "https://example.com/'x'",
            "https://example.com/<x>",
            "https://example.com/\\..\\x",
            "https://example.com/\nnext",
        ] {
            assert_eq!(checked_url(url), None, "{url:?}");
        }
        assert_eq!(
            checked_url(&format!("https://e.com/{}", "a".repeat(2048))),
            None
        );
    }
}
