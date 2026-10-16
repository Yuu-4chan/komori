//! Updates from the project's GitHub releases, owned natively. The endpoint and the public key
//! that verifies every installer are fixed in the Tauri configuration; the frontend supplies no
//! URL and receives only the new version and its release notes.

use crate::failure;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Release notes longer than this are cut; the full changelog stays on the release page.
const NOTES_LIMIT: usize = 20_000;

/// The update the last check found, kept so installing never trusts a frontend-supplied version.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: String,
}

fn notes(body: Option<&str>) -> String {
    let body = body.unwrap_or_default().trim();
    match body.char_indices().nth(NOTES_LIMIT) {
        Some((end, _)) => format!("{}…", body[..end].trim_end()),
        None => body.to_owned(),
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<AvailableUpdate>, String> {
    let updater = app.updater().map_err(|_| failure::UPDATE_CHECK)?;
    let update = updater.check().await.map_err(|_| failure::UPDATE_CHECK)?;
    let available = update.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: notes(update.body.as_deref()),
    });
    *state.0.lock().map_err(|_| failure::UPDATE_CHECK)? = update;
    Ok(available)
}

/// Downloads the update the last check found, verifies its signature and starts its installer.
/// On Windows the installer replaces Komori, so the process exits once it starts.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let update = state
        .0
        .lock()
        .map_err(|_| failure::UPDATE_INSTALL)?
        .clone()
        .ok_or(failure::UPDATE_GONE)?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| failure::UPDATE_INSTALL)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::notes;

    #[test]
    fn release_notes_are_trimmed_and_bounded() {
        assert_eq!(notes(None), "");
        assert_eq!(notes(Some("\n- Fixed it.\n")), "- Fixed it.");
        let long = "あ".repeat(super::NOTES_LIMIT + 10);
        let cut = notes(Some(&long));
        assert_eq!(cut.chars().count(), super::NOTES_LIMIT + 1);
        assert!(cut.ends_with('…'));
    }
}

/// The shipped updater configuration. Refusal of wrongly signed, unsigned, modified and
/// mismatched-version installers by the built app is checked by the real-engine smoke test.
#[cfg(test)]
mod config_tests {
    use base64::Engine;
    use serde_json::{json, Value};

    #[test]
    fn updates_come_signed_from_the_public_releases() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            json!(["https://github.com/Yuu-4chan/komori/releases/latest/download/latest.json"])
        );
        // The signature must name the version the manifest announces, so a manifest cannot
        // pair a new version number with an older signed installer.
        assert_eq!(updater["requireSignedVersion"], json!(true));
        for relaxed in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
        ] {
            assert!(updater.get(relaxed).is_none(), "{relaxed} is set");
        }
        let pubkey = base64::engine::general_purpose::STANDARD
            .decode(updater["pubkey"].as_str().unwrap())
            .unwrap();
        assert!(String::from_utf8(pubkey)
            .unwrap()
            .starts_with("untrusted comment: minisign public key: C0F8C5BF2FD0BB7F\n"));
    }
}
