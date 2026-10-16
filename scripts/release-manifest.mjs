// Writes `latest.json`, the update manifest Komori's updater reads from the latest GitHub
// release, beside the signed NSIS installer, after checking that the installer's signature
// verifies against the public key installed copies trust. Run after `pnpm tauri:release`;
// upload the installer, its `.sig` and `latest.json` to the release tagged `v<version>`.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = "https://github.com/Yuu-4chan/komori";

/** The changelog section for one version, without its heading, or null when there is none. */
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && line.slice(3).trim() === version,
  );
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return notes || null;
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow.
const ed25519Spki = Buffer.from("302a300506032b6570032100", "hex");

/** The lines of a base64-wrapped minisign key or signature file. */
const minisignLines = (wrapped) =>
  Buffer.from(String(wrapped).trim(), "base64").toString("utf8").split(/\r?\n/u);

/**
 * Throws unless `signature` (a Tauri `.sig`, base64-wrapped minisign) is a valid signature of
 * `data` by `pubkey` (base64-wrapped minisign public key) for `version`: the checks the updater
 * makes with `requireSignedVersion` before it runs an installer.
 */
export function verifySignature({ pubkey, signature, data, version }) {
  const [keyComment = "", keyLine = ""] = minisignLines(pubkey);
  const key = Buffer.from(keyLine, "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed")
    throw Error("The configured updater public key is not a minisign Ed25519 key.");
  const [, signatureLine = "", trustedLine = "", globalLine = ""] = minisignLines(signature);
  const signed = Buffer.from(signatureLine, "base64");
  const algorithm = signed.subarray(0, 2).toString();
  if (signed.length !== 74 || !["Ed", "ED"].includes(algorithm))
    throw Error("The installer signature is not a minisign signature.");
  if (!signed.subarray(2, 10).equals(key.subarray(2, 10)))
    throw Error(
      `The installer was signed with another key than the one installed copies trust (${keyComment.replace(/^untrusted comment: /u, "")}).`,
    );
  const publicKey = createPublicKey({
    key: Buffer.concat([ed25519Spki, key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, signed.subarray(10)))
    throw Error("The installer signature does not match the installer.");
  if (!trustedLine.startsWith("trusted comment: "))
    throw Error("The installer signature has no trusted comment.");
  const trusted = trustedLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([signed.subarray(10), Buffer.from(trusted)]), publicKey, global))
    throw Error("The installer signature's trusted comment was altered.");
  const signedVersion = trusted
    .split("\t")
    .find((field) => field.startsWith("version:"))
    ?.slice("version:".length);
  if (signedVersion !== version)
    throw Error(
      `The installer was signed for version ${signedVersion ?? "(none)"}, not ${version}.`,
    );
}

/** The manifest for one signed Windows installer. */
export function updateManifest({ version, notes, signature, date = new Date() }) {
  const installer = `Komori_${version}_x64-setup.exe`;
  return {
    version,
    notes,
    pub_date: date.toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `${repository}/releases/download/v${version}/${installer}`,
      },
    },
  };
}

function main(root = process.cwd()) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const { version } = JSON.parse(read("package.json"));
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  if (config.version !== version)
    throw Error(`tauri.conf.json is at ${config.version}, package.json at ${version}.`);
  const cargoVersion = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/mu)?.[1];
  if (cargoVersion !== version)
    throw Error(`Cargo.toml is at ${cargoVersion}, package.json at ${version}.`);
  if (!config.plugins?.updater?.pubkey)
    throw Error("Set plugins.updater.pubkey in tauri.conf.json to the release public key.");
  const notes = releaseNotes(read("CHANGELOG.md"), version);
  if (!notes) throw Error(`CHANGELOG.md has no "## ${version}" section.`);
  const folder = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const installerPath = join(folder, `Komori_${version}_x64-setup.exe`);
  const signaturePath = `${installerPath}.sig`;
  if (!existsSync(signaturePath))
    throw Error(`No signed installer for ${version}; run pnpm tauri:release first.`);
  const signature = readFileSync(signaturePath, "utf8");
  verifySignature({
    pubkey: config.plugins.updater.pubkey,
    signature,
    data: readFileSync(installerPath),
    version,
  });
  const manifest = updateManifest({ version, notes, signature });
  const output = join(folder, "latest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${output}`);
  console.log(
    `Upload Komori_${version}_x64-setup.exe, its .sig and latest.json to the v${version} release.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
