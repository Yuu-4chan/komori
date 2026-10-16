import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fallbackText, licenseChoices, thirdPartyNotices } from "./third-party-notices.mjs";

// Binaries must carry the notices of everything they bundle; the release build generates them.
describe("third-party notices", () => {
  it("reads SPDX alternatives in both the current and the older slash form", () => {
    expect(licenseChoices("MIT OR Apache-2.0")).toEqual(["MIT", "Apache-2.0"]);
    expect(licenseChoices("MIT/Apache-2.0")).toEqual(["MIT", "Apache-2.0"]);
    expect(licenseChoices("(MIT OR GPL-3.0-or-later)")).toEqual(["MIT", "GPL-3.0-or-later"]);
  });

  it("gives a package without a license file its declared license with a copyright line", () => {
    expect(fallbackText("MIT/Apache-2.0", "Ada", process.cwd())).toMatch(
      /^Copyright \(c\) Ada\n\nPermission is hereby granted/u,
    );
    expect(fallbackText("MPL-2.0", "Ada", process.cwd())).toMatch(/^Mozilla Public License/u);
    expect(fallbackText("LicenseRef-Unknown", "Ada", process.cwd())).toBeNull();
  });

  it("covers the bundled packages, crates and vendored material", () => {
    const notices = thirdPartyNotices(process.cwd());
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    for (const name of Object.keys(manifest.dependencies)) {
      expect(notices).toMatch(
        new RegExp(`^${name.replace(/[/.]/gu, "\\$&")} \\S+ \\(npm\\)`, "mu"),
      );
    }
    expect(notices).toMatch(/^epubjs 0\.3\.93 \(npm\) — BSD-2-Clause\n {2}modified by Komori/mu);
    expect(notices).toContain("Copyright (c) 2013, FuturePress");
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(notices).toMatch(/^tauri \S+ \(crate\)/mu);
    expect(notices).toMatch(/^Lapis f4eb29b \(vendored\) — GPL-3\.0$/mu);
    expect(notices).toMatch(/^Yomitan Japanese transforms 67db60d \(adapted\)/mu);
    expect(notices).toContain("Copyright (C) Microsoft Corporation. All rights reserved.");
    expect(notices).toContain("GNU GENERAL PUBLIC LICENSE");
    // cargo metadata downloads every crate's source when none is cached, which takes minutes.
  }, 300_000);

  it("is written by the production build and shipped with the installer", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts.build).toMatch(/vite build && node scripts\/third-party-notices\.mjs$/u);
    expect(scripts["tauri:build"]).toContain("--config src-tauri/tauri.release.conf.json");
    const release = JSON.parse(readFileSync("src-tauri/tauri.release.conf.json", "utf8"));
    expect(release.bundle.licenseFile).toBe("../LICENSE");
    expect(Object.values(release.bundle.resources).sort()).toEqual([
      "LICENSE",
      "NOTICE",
      "THIRD-PARTY-NOTICES.txt",
    ]);
  });
});
