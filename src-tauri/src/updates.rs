//! Updates from the project's GitHub releases, owned natively. The endpoint and the public key
//! that verifies every installer are fixed in the Tauri configuration; the frontend supplies no
//! URL and receives only the new version and its release notes.

use crate::failure;
#[cfg(mobile)]
use crate::phone_update;
use serde::Serialize;
use std::sync::Mutex;
#[cfg(mobile)]
use std::time::Duration;
#[cfg(mobile)]
use tauri::Manager;
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};

/// Release notes longer than this are cut; the full changelog stays on the release page.
const NOTES_LIMIT: usize = 20_000;

/// The update the last check found, kept so installing never trusts a frontend-supplied version:
/// the PC's updater's, or the version of the release the phone's APK comes from.
#[derive(Default)]
pub struct UpdateState(
    #[cfg(desktop)] Mutex<Option<Update>>,
    #[cfg(mobile)] Mutex<Option<semver::Version>>,
);

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

#[cfg(desktop)]
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
#[cfg(desktop)]
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

/// The phone's update check: the release `latest.json` announces, when it is newer.
#[cfg(mobile)]
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<AvailableUpdate>, String> {
    let endpoint = updater_setting("endpoint")?;
    let client = phone_client(Duration::from_secs(30))?;
    let manifest = fetch(&client, &endpoint)
        .await
        .and_then(|body| serde_json::from_slice::<phone_update::Manifest>(&body).ok())
        .ok_or(failure::UPDATE_CHECK)?;
    let current = app.package_info().version.to_string();
    let found = phone_update::newer(&manifest, &current);
    let available = found.as_ref().map(|version| AvailableUpdate {
        version: version.to_string(),
        current_version: current,
        notes: notes(manifest.notes.as_deref()),
    });
    *state.0.lock().map_err(|_| failure::UPDATE_CHECK)? = found;
    Ok(available)
}

/// Downloads the APK of the release the last check found, checks its signature, and hands it to
/// Android's installer, which asks before replacing Komori. A checked APK is kept until Komori
/// starts again, so allowing Komori to install apps and trying again does not download it twice.
#[cfg(mobile)]
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let version = state
        .0
        .lock()
        .map_err(|_| failure::UPDATE_INSTALL)?
        .clone()
        .ok_or(failure::UPDATE_GONE)?;
    let name = phone_update::apk_name(&version);
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|_| failure::UPDATE_INSTALL)?
        .join(DOWNLOADS);
    let apk = folder.join(&name);
    if !apk.is_file() {
        let url = phone_update::apk_url(&updater_setting("endpoint")?, &version)
            .ok_or(failure::UPDATE_INSTALL)?;
        let client = phone_client(Duration::from_secs(15 * 60))?;
        let signature = fetch(&client, &format!("{url}.sig"))
            .await
            .and_then(|body| String::from_utf8(body).ok())
            .ok_or(failure::UPDATE_INSTALL)?;
        let data = fetch(&client, &url).await.ok_or(failure::UPDATE_INSTALL)?;
        let key = updater_setting("pubkey")?;
        if !phone_update::verified(&key, &signature, &data, &name) {
            return Err(failure::UPDATE_INSTALL.into());
        }
        let _ = std::fs::remove_dir_all(&folder);
        let partial = folder.join(format!("{name}.part"));
        std::fs::create_dir_all(&folder)
            .and_then(|()| std::fs::write(&partial, &data))
            .and_then(|()| std::fs::rename(&partial, &apk))
            .map_err(|_| failure::UPDATE_INSTALL)?;
    }
    if crate::android::install_apk(&apk).await? {
        Ok(())
    } else {
        Err(failure::UPDATE_ALLOW.into())
    }
}

/// The folder in the cache that holds a downloaded update.
#[cfg(mobile)]
const DOWNLOADS: &str = "updates";

/// Removes a downloaded update, at startup.
#[cfg(mobile)]
pub(crate) fn remove_downloads(cache: &std::path::Path) {
    let _ = std::fs::remove_dir_all(cache.join(DOWNLOADS));
}

/// The updater's endpoint or public key, as the PC's updater has them.
#[cfg(mobile)]
fn updater_setting(name: &str) -> Result<String, String> {
    phone_update::shipped_setting(name).ok_or_else(|| failure::UPDATE_CHECK.into())
}

#[cfg(mobile)]
fn phone_client(timeout: Duration) -> Result<reqwest::Client, String> {
    crate::http::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .build()
        .map_err(|_| failure::UPDATE_CHECK.into())
}

/// A release file's body; GitHub redirects release downloads to its file host.
#[cfg(mobile)]
async fn fetch(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    Some(response.bytes().await.ok()?.to_vec())
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
