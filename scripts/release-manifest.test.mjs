import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseNotes, updateManifest, verifySignature } from "./release-manifest.mjs";

// The updater shows a release's changelog section, read from CHANGELOG.md at release time.
describe("release manifest", () => {
  const changelog = "# Changelog\r\n\r\n## 1.1.0\r\n\r\n- New.\r\n\r\n## 1.0.0\r\n\r\n- First.\r\n";

  it("takes only the version's own changelog section", () => {
    expect(releaseNotes(changelog, "1.1.0")).toBe("- New.");
    expect(releaseNotes(changelog, "1.0.0")).toBe("- First.");
    expect(releaseNotes(changelog, "1.0")).toBeNull();
    expect(releaseNotes("## 2.0.0\n\n", "2.0.0")).toBeNull();
  });

  it("points the Windows platform at the tagged release's installer", () => {
    const manifest = updateManifest({
      version: "1.1.0",
      notes: "- New.",
      signature: "c2lnbmF0dXJl\n",
      date: new Date("2026-10-16T00:00:00Z"),
    });
    expect(manifest).toEqual({
      version: "1.1.0",
      notes: "- New.",
      pub_date: "2026-10-16T00:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: "c2lnbmF0dXJl",
          url: "https://github.com/Yuu-4chan/komori/releases/download/v1.1.0/Komori_1.1.0_x64-setup.exe",
        },
      },
    });
  });
});

// A release is published only when its installer verifies against the key installed copies
// trust, for the version it announces.
describe("installer signature", () => {
  const fixture = JSON.parse(readFileSync("scripts/fixtures/update-signature.json", "utf8"));
  const releaseKey = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins.updater
    .pubkey;
  const signed = {
    pubkey: fixture.pubkey,
    signature: fixture.signature,
    data: Buffer.from(fixture.payload),
    version: fixture.version,
  };

  it("accepts an installer signed by the trusted key for its version", () => {
    expect(() => verifySignature(signed)).not.toThrow();
  });

  it("refuses an installer signed with another key", () => {
    expect(() => verifySignature({ ...signed, pubkey: releaseKey })).toThrow(/another key/u);
  });

  it("refuses a modified installer", () => {
    expect(() => verifySignature({ ...signed, data: Buffer.from(`${fixture.payload}!`) })).toThrow(
      /does not match/u,
    );
  });

  it("refuses a signature for another version", () => {
    expect(() => verifySignature({ ...signed, version: "9.9.10" })).toThrow(
      /9\.9\.9, not 9\.9\.10/u,
    );
  });

  it("refuses a missing or altered signature", () => {
    expect(() => verifySignature({ ...signed, signature: "" })).toThrow();
    const lines = Buffer.from(fixture.signature, "base64").toString().split("\n");
    lines[2] = lines[2].replace("version:9.9.9", "version:9.9.10");
    const altered = Buffer.from(lines.join("\n")).toString("base64");
    expect(() => verifySignature({ ...signed, signature: altered, version: "9.9.10" })).toThrow(
      /trusted comment was altered/u,
    );
  });
});
