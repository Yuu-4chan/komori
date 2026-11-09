//! Updates for the Android app from the project's GitHub releases. The phone reads the same
//! `latest.json` the PC's updater does, and a newer release's APK sits beside it under a fixed
//! name. The APK is used only when its signature verifies with the updater's public key and
//! names that very file; Android then installs it only over an APK signed with the same key.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

/// The updater's endpoint (`"endpoint"`) or public key (`"pubkey"`) from the shipped
/// `tauri.conf.json`. The phone's own configuration drops the PC updater's block, as the phone
/// has no updater plugin, so the base file is compiled in and read here.
pub(crate) fn shipped_setting(name: &str) -> Option<String> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).ok()?;
    let updater = &config["plugins"]["updater"];
    let value = match name {
        "endpoint" => &updater["endpoints"][0],
        _ => &updater[name],
    };
    value.as_str().map(str::to_owned)
}

/// The release `latest.json` announces.
#[derive(Debug, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) version: String,
    #[serde(default)]
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub(crate) notes: Option<String>,
}

/// The announced version when it is newer than `current`.
pub(crate) fn newer(manifest: &Manifest, current: &str) -> Option<semver::Version> {
    let found = semver::Version::parse(manifest.version.trim().trim_start_matches('v')).ok()?;
    let current = semver::Version::parse(current).ok()?;
    (found > current).then_some(found)
}

/// The APK's file name in a release.
pub(crate) fn apk_name(version: &semver::Version) -> String {
    format!("Komori_{version}_android-arm64.apk")
}

/// The release's APK address, from the updater's `…/releases/latest/download/latest.json`.
pub(crate) fn apk_url(endpoint: &str, version: &semver::Version) -> Option<String> {
    let releases = endpoint.strip_suffix("/latest/download/latest.json")?;
    releases
        .starts_with("https://")
        .then(|| format!("{releases}/download/v{version}/{}", apk_name(version)))
}

/// Whether `signature` (a `.sig` file as the release holds it) signs `data` with `public_key`
/// (the updater's, base64 as in the configuration) and names the file `name` in its trusted
/// comment, so an older signed APK cannot stand in for the one announced.
pub(crate) fn verified(public_key: &str, signature: &str, data: &[u8], name: &str) -> bool {
    let text = |encoded: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let (Some(key), Some(signature)) = (text(public_key), text(signature)) else {
        return false;
    };
    let (Ok(key), Ok(signature)) = (PublicKey::decode(&key), Signature::decode(&signature)) else {
        return false;
    };
    let file = format!("file:{name}");
    key.verify(data, &signature, true).is_ok()
        && signature
            .trusted_comment()
            .split('\t')
            .any(|field| field == file)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway key, and its signature of `Komori test APK` as `tauri signer sign` writes it.
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk3NDUzMDZGM0EwQkQyMkEKUldRcTBnczZiekJGbDlQK2Z6c01BWDc2UGRKVkUzdXE1TGZMRncxVmlwUzNNRklWTXNWY2lWTkMK";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRcTBnczZiekJGbCtKT0NKakZDU1NGUStEUTNqT1ZBMWlKMWw1YkV0blZBOVZTMEc3OWFGS1hTVkIrUjQ5OC9LanZJTW5YcVJtWm1nS3ZHYVRkZU5NWjlKeHdWaEhDWEE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MjYyOTQ3CWZpbGU6S29tb3JpXzkuOS45X2FuZHJvaWQtYXJtNjQuYXBrCmhnSDJ4bU1OU2Z1NHQ3Nzg4WHUwdDJpZXc5WTNVM09abjEvVGRtNHJ0WWcxU3FiWnVFOE1xcEhkcDQxSkk0WWJOMkgyWHJLOWh6UTJOSFFWcC90UkNRPT0K";
    const NAME: &str = "Komori_9.9.9_android-arm64.apk";

    #[test]
    fn only_a_newer_release_is_offered() {
        let manifest = |version: &str| Manifest {
            version: version.into(),
            notes: None,
        };
        assert_eq!(
            newer(&manifest("2.2.0"), "2.1.0"),
            Some(semver::Version::new(2, 2, 0))
        );
        assert_eq!(
            newer(&manifest("v2.1.1"), "2.1.0"),
            Some(semver::Version::new(2, 1, 1))
        );
        assert_eq!(newer(&manifest("2.1.0"), "2.1.0"), None);
        assert_eq!(newer(&manifest("2.0.9"), "2.1.0"), None);
        assert_eq!(newer(&manifest("next"), "2.1.0"), None);
    }

    #[test]
    fn the_apk_sits_in_the_announced_release() {
        let version = semver::Version::new(2, 2, 0);
        assert_eq!(
            apk_url(
                "https://github.com/Yuu-4chan/komori/releases/latest/download/latest.json",
                &version
            )
            .as_deref(),
            Some("https://github.com/Yuu-4chan/komori/releases/download/v2.2.0/Komori_2.2.0_android-arm64.apk")
        );
        assert_eq!(
            apk_url(
                "http://example.com/releases/latest/download/latest.json",
                &version
            ),
            None
        );
        assert_eq!(apk_url("https://example.com/latest.json", &version), None);
    }

    #[test]
    fn the_apk_must_be_signed_and_named_by_the_signature() {
        let apk = b"Komori test APK";
        assert!(verified(KEY, SIGNATURE, apk, NAME));
        assert!(!verified(KEY, SIGNATURE, b"Komori test APL", NAME));
        assert!(!verified(
            KEY,
            SIGNATURE,
            apk,
            "Komori_9.9.8_android-arm64.apk"
        ));
        assert!(!verified(KEY, "not a signature", apk, NAME));
        // The shipped key did not make this signature.
        let shipped = shipped_setting("pubkey").unwrap();
        assert!(!verified(&shipped, SIGNATURE, apk, NAME));
    }

    #[test]
    fn the_phone_reads_the_shipped_updater_settings() {
        let endpoint = shipped_setting("endpoint").unwrap();
        assert!(apk_url(&endpoint, &semver::Version::new(2, 2, 0)).is_some());
        let key = shipped_setting("pubkey").unwrap();
        assert!(PublicKey::decode(
            &String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(key)
                    .unwrap()
            )
            .unwrap()
        )
        .is_ok());
        assert_eq!(shipped_setting("missing"), None);
    }
}
