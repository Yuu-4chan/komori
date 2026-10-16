// Finds a Tauri updater signing key (a minisign secret key, as `tauri signer generate` writes it
// and as TAURI_SIGNING_PRIVATE_KEY holds it) in files that must never contain one: the tracked
// source tree and the release output. The markers are assembled at run time so this file does
// not match itself.
const comment = ["untrusted comment: rsign", "encrypted secret key"].join(" ");

/** Every form a secret key file starts with: its text and its base64 wrapping. */
export const signingKeyMarkers = [comment, Buffer.from(comment).toString("base64")];

/** Whether `bytes` contain a signing key in any of its forms. */
export function containsSigningKey(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  return signingKeyMarkers.some((marker) => text.includes(marker));
}
