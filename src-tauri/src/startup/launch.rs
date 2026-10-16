//! Only Komori's current-user Run value and its StartupApproved value are touched.

#[cfg(windows)]
mod windows {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::*,
    };

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const NAME: &str = "Komori";

    #[derive(Clone, Debug, PartialEq)]
    struct Value {
        kind: u32,
        bytes: Vec<u8>,
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn error(code: u32) -> String {
        format!("Windows startup entry could not be changed or read ({code})")
    }

    fn read(key: &str, name: &str) -> Result<Option<Value>, String> {
        let key = wide(key);
        let name = wide(name);
        let mut kind = 0;
        let mut size = 0;
        let flags = RRF_RT_ANY | RRF_NOEXPAND;
        // Both buffers are bounded native registry values, never caller paths.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                ptr::null_mut(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(error(status));
        }
        if size > 65_536 {
            return Err("Windows startup entry is too large".into());
        }
        let mut bytes = vec![0; size as usize];
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                bytes.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(error(status));
        }
        bytes.truncate(size as usize);
        Ok(Some(Value { kind, bytes }))
    }

    fn write(key: &str, name: &str, value: Option<&Value>) -> Result<(), String> {
        let key = wide(key);
        let name = wide(name);
        let status = unsafe {
            match value {
                Some(value) => RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    name.as_ptr(),
                    value.kind,
                    value.bytes.as_ptr().cast(),
                    value.bytes.len() as u32,
                ),
                None => RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()),
            }
        };
        if status == ERROR_SUCCESS || (value.is_none() && status == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(error(status))
        }
    }

    fn is_enabled(run: Option<&Value>, approved: Option<&Value>) -> bool {
        run.is_some_and(|value| {
            (value.kind == REG_SZ || value.kind == REG_EXPAND_SZ) && value.bytes.len() > 2
        }) && !approved.is_some_and(|value| {
            value.kind == REG_BINARY
                && value
                    .bytes
                    .first()
                    .is_some_and(|state| matches!(state, 3 | 7))
        })
    }

    pub fn enabled() -> Result<bool, String> {
        Ok(is_enabled(
            read(RUN, NAME)?.as_ref(),
            read(APPROVED, NAME)?.as_ref(),
        ))
    }

    pub fn with_update<T>(
        enabled: Option<bool>,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let command = format!(
            "\"{}\"",
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                .display()
        );
        update_at(RUN, APPROVED, NAME, &command, enabled, operation)
    }

    fn update_at<T>(
        run_key: &str,
        approved_key: &str,
        name: &str,
        command: &str,
        enabled: Option<bool>,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let Some(enabled) = enabled else {
            return operation();
        };
        let previous = read(run_key, name)?;
        let approved = read(approved_key, name)?;
        let value = enabled.then(|| Value {
            kind: REG_SZ,
            bytes: wide(command)
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect(),
        });
        let result = write(run_key, name, value.as_ref())
            .and_then(|_| write(approved_key, name, None))
            .and_then(|_| operation());
        if result.is_err() {
            let run_result = write(run_key, name, previous.as_ref());
            let approved_result = write(approved_key, name, approved.as_ref());
            if run_result.is_err() || approved_result.is_err() {
                return Err("Startup change failed and Windows could not restore its previous entry. Check Windows Startup apps.".into());
            }
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn native_entry_quotes_executable_reflects_disabled_state_and_rolls_back_exactly() {
            let key = format!(r"Software\KomoriTest-{}", uuid::Uuid::new_v4());
            let approved_key = format!(r"{key}\Approved");
            let command = r#""C:\Program Files\Komori\Komori.exe""#;
            let old = Value {
                kind: REG_EXPAND_SZ,
                bytes: wide(r#""%LOCALAPPDATA%\Old Komori.exe""#)
                    .iter()
                    .flat_map(|unit| unit.to_le_bytes())
                    .collect(),
            };
            let disabled = Value {
                kind: REG_BINARY,
                bytes: vec![3, 0, 0, 0, 11, 12, 13, 14, 0, 0, 0, 0],
            };
            write(&key, "entry", Some(&old)).unwrap();
            write(&approved_key, "entry", Some(&disabled)).unwrap();
            assert!(!is_enabled(Some(&old), Some(&disabled)));
            let failure: Result<(), String> =
                update_at(&key, &approved_key, "entry", command, Some(true), || {
                    Err("database failed".into())
                });
            assert!(failure.is_err());
            assert_eq!(read(&key, "entry").unwrap(), Some(old));
            assert_eq!(read(&approved_key, "entry").unwrap(), Some(disabled));
            update_at(&key, &approved_key, "entry", command, Some(true), || Ok(())).unwrap();
            let value = read(&key, "entry").unwrap().unwrap();
            assert!(is_enabled(Some(&value), None));
            assert_eq!(
                value.bytes,
                wide(command)
                    .iter()
                    .flat_map(|unit| unit.to_le_bytes())
                    .collect::<Vec<_>>()
            );
            update_at(
                &key,
                &approved_key,
                "entry",
                command,
                Some(false),
                || Ok(()),
            )
            .unwrap();
            assert_eq!(read(&key, "entry").unwrap(), None);
            let key = wide(&key);
            unsafe {
                RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr());
            }
        }
    }
}

#[cfg(windows)]
pub(super) use windows::{enabled, with_update};

#[cfg(not(windows))]
pub(super) fn enabled() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(windows))]
pub(super) fn with_update<T>(
    enabled: Option<bool>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if enabled == Some(true) {
        Err("Launching with Windows needs Windows".into())
    } else {
        operation()
    }
}
