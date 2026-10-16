import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { containsSigningKey, signingKeyMarkers } from "./signing-key-scan.mjs";

// A release is one version everywhere: the installer name, the update manifest, the version the
// updater compares and the version backups record all come from these files.
describe("release version", () => {
  it("is the same in package.json, tauri.conf.json, Cargo.toml and Cargo.lock", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "([^"]+)"/mu);
    const lock = readFileSync("src-tauri/Cargo.lock", "utf8").match(
      /^name = "komori"\r?\nversion = "([^"]+)"/mu,
    );
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(tauri.version).toBe(version);
    expect(cargo?.[1]).toBe(version);
    expect(lock?.[1]).toBe(version);
  });

  it("has a changelog section", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(readFileSync("CHANGELOG.md", "utf8")).toMatch(new RegExp(`^## ${version}$`, "mu"));
  });
});

// The updater signing key lives only in the owner's environment and the release workflow's
// secrets.
describe("signing key", () => {
  it("is recognized in its text and base64 forms", () => {
    for (const marker of signingKeyMarkers)
      expect(containsSigningKey(Buffer.from(`x${marker}y`))).toBe(true);
    expect(containsSigningKey(Buffer.from("untrusted comment: minisign public key"))).toBe(false);
  });

  it("is in no tracked file", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((file) => {
      try {
        return containsSigningKey(readFileSync(file));
      } catch {
        return false; // Deleted in the working tree.
      }
    });
    expect(found).toEqual([]);
  });

  it("files are ignored by Git", () => {
    const ignored = execFileSync(
      "git",
      ["check-ignore", "--no-index", "komori.key", "keys/a.key"],
      {
        encoding: "utf8",
      },
    );
    expect(ignored.trim().split(/\r?\n/u)).toEqual(["komori.key", "keys/a.key"]);
  });
});
