//! What the PC and a paired phone say to each other, and the cryptography both sides share.
//!
//! Pairing is SPAKE2 over the six-digit code the PC shows: each side derives the same key only
//! when both used the same code, and neither sends the code. Each then proves the key over the
//! fingerprint of the certificate the phone saw, so a phone that met another certificate (someone
//! between the two) fails, and a wrong guess costs a try. After pairing the phone keeps that
//! fingerprint and accepts no other certificate; the PC keeps only its token's hash.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};

/// The protocol version; a phone and a PC that disagree refuse each other. 2 added syncing.
pub(crate) const PROTOCOL: u32 = 2;
/// The port the PC listens on unless the reader changes it.
pub(crate) const DEFAULT_PORT: u16 = 7461;
/// Wrong codes before the PC stops pairing until it makes a new code.
pub(crate) const PAIRING_ATTEMPTS: u32 = 5;

const PHONE: &[u8] = b"komori-phone";
const PC: &[u8] = b"komori-pc";

/// What the PC answers anyone: the protocol it speaks, and its name to a paired phone only.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello {
    pub(crate) protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairStart {
    /// The phone's SPAKE2 message.
    pub(crate) message: String,
    /// The phone's name, as the PC lists it.
    pub(crate) device: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairStarted {
    pub(crate) message: String,
    pub(crate) session: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairFinish {
    pub(crate) session: String,
    pub(crate) proof: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Paired {
    pub(crate) proof: String,
    pub(crate) token: String,
    pub(crate) device: String,
    /// The PC's name, told only once the phone has proven the code.
    pub(crate) name: String,
}

/// A book in the PC's Library, as a phone sees it: no path, only its catalog ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteBook {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) file_name: String,
    pub(crate) size: u64,
    /// The cover's revision, when the book has one.
    pub(crate) cover: Option<i64>,
    pub(crate) progress: Option<crate::library::BookProgress>,
    pub(crate) last_read_at: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_index: Option<f64>,
    pub(crate) language: Option<String>,
    /// The book's characters and words, as its Library card counts them; none before the PC
    /// counted them, or from a PC that does not send them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) characters: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) words: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteLibrary {
    pub(crate) books: Vec<RemoteBook>,
}

/// The most books one change names; the phone sends more in several.
pub(crate) const MAX_CHANGED_BOOKS: usize = 1_000;

/// What the paired phone does to books in the PC's Library, as the PC's Library does it:
/// marking them completed or unread, or removing them from the Library (their files stay).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookChange {
    Completed,
    Unread,
    Remove,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangeBooks {
    pub(crate) change: BookChange,
    pub(crate) ids: Vec<String>,
}

/// The books the change applied to; a book not in the Library, or not counted for Completed,
/// is left out.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedBooks {
    pub(crate) changed: Vec<String>,
}

/// A dictionary on the PC, by its store ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDictionary {
    pub(crate) id: i64,
    pub(crate) title: String,
    pub(crate) revision: String,
    pub(crate) term_count: i64,
    pub(crate) term_meta_count: i64,
    pub(crate) kanji_count: i64,
    pub(crate) kanji_meta_count: i64,
    pub(crate) has_definitions: bool,
    pub(crate) has_frequency: bool,
    pub(crate) has_pitch: bool,
    /// The size of its pack, when the PC knows it.
    #[serde(default)]
    pub(crate) size: Option<u64>,
}

pub(crate) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

/// The SHA-256 of a certificate's DER bytes.
pub(crate) fn fingerprint(certificate: &[u8]) -> [u8; 32] {
    Sha256::digest(certificate).into()
}

pub(crate) fn hash_token(token: &[u8]) -> String {
    hex(&Sha256::digest(token))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random source");
    bytes
}

/// Six digits, every value equally likely.
pub(crate) fn pairing_code() -> String {
    loop {
        let value = u32::from_le_bytes(random_bytes::<4>());
        // The largest multiple of a million below 2^32 keeps the digits uniform.
        if value < 4_294_000_000 {
            return format!("{:06}", value % 1_000_000);
        }
    }
}

/// The phone's side of the exchange: its state and the message it sends.
#[cfg_attr(desktop, allow(dead_code))]
pub(crate) fn start_phone(code: &str) -> (Spake2<Ed25519Group>, Vec<u8>) {
    Spake2::<Ed25519Group>::start_a(
        &Password::new(code.as_bytes()),
        &Identity::new(PHONE),
        &Identity::new(PC),
    )
}

/// The PC's side: its state and the message it answers with.
pub(crate) fn start_pc(code: &str) -> (Spake2<Ed25519Group>, Vec<u8>) {
    Spake2::<Ed25519Group>::start_b(
        &Password::new(code.as_bytes()),
        &Identity::new(PHONE),
        &Identity::new(PC),
    )
}

fn proof(key: &[u8], side: &[u8], certificate: &[u8; 32]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(side);
    mac.update(certificate);
    mac.finalize().into_bytes().to_vec()
}

fn proof_matches(key: &[u8], side: &[u8], certificate: &[u8; 32], proof: &[u8]) -> bool {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(side);
    mac.update(certificate);
    mac.verify_slice(proof).is_ok()
}

/// What the phone sends to show it holds the key, over the certificate it saw.
#[cfg_attr(desktop, allow(dead_code))]
pub(crate) fn phone_proof(key: &[u8], certificate: &[u8; 32]) -> Vec<u8> {
    proof(key, PHONE, certificate)
}

pub(crate) fn phone_proof_matches(key: &[u8], certificate: &[u8; 32], given: &[u8]) -> bool {
    proof_matches(key, PHONE, certificate, given)
}

/// What the PC answers to show the same, so the phone knows it paired with the PC itself.
pub(crate) fn pc_proof(key: &[u8], certificate: &[u8; 32]) -> Vec<u8> {
    proof(key, PC, certificate)
}

#[cfg_attr(desktop, allow(dead_code))]
pub(crate) fn pc_proof_matches(key: &[u8], certificate: &[u8; 32], given: &[u8]) -> bool {
    proof_matches(key, PC, certificate, given)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_code_gives_both_sides_the_same_key_and_proofs() {
        let (phone, to_pc) = start_phone("482913");
        let (pc, to_phone) = start_pc("482913");
        let phone_key = phone.finish(&to_phone).unwrap();
        let pc_key = pc.finish(&to_pc).unwrap();
        assert_eq!(phone_key, pc_key);
        let certificate = fingerprint(b"certificate");
        assert!(phone_proof_matches(
            &pc_key,
            &certificate,
            &phone_proof(&phone_key, &certificate)
        ));
        assert!(pc_proof_matches(
            &phone_key,
            &certificate,
            &pc_proof(&pc_key, &certificate)
        ));
        // Each side's proof is its own: one cannot be sent back as the other.
        assert!(!pc_proof_matches(
            &phone_key,
            &certificate,
            &phone_proof(&phone_key, &certificate)
        ));
    }

    #[test]
    fn a_wrong_code_or_another_certificate_fails_the_proof() {
        let (phone, to_pc) = start_phone("482913");
        let (pc, to_phone) = start_pc("482914");
        let phone_key = phone.finish(&to_phone).unwrap();
        let pc_key = pc.finish(&to_pc).unwrap();
        let certificate = fingerprint(b"certificate");
        assert!(!phone_proof_matches(
            &pc_key,
            &certificate,
            &phone_proof(&phone_key, &certificate)
        ));
        let (phone, to_pc) = start_phone("482913");
        let (pc, to_phone) = start_pc("482913");
        let phone_key = phone.finish(&to_phone).unwrap();
        let pc_key = pc.finish(&to_pc).unwrap();
        assert!(!phone_proof_matches(
            &pc_key,
            &certificate,
            &phone_proof(&phone_key, &fingerprint(b"another"))
        ));
    }

    #[test]
    fn pairing_codes_are_six_digits() {
        for _ in 0..200 {
            let code = pairing_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }
}
