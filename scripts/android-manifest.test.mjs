import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Android recreates an activity for a configuration change it does not handle itself, and
// Tauri keeps its Back handler on the first activity, so Back would then close Komori.
const main = "src-tauri/gen/android/app/src/main";

describe("Android activity", () => {
  it("handles font, display size and layout direction changes itself", () => {
    const manifest = readFileSync(`${main}/AndroidManifest.xml`, "utf8");
    const changes = manifest.match(/android:configChanges="([^"]+)"/u)?.[1]?.split("|") ?? [];
    expect(changes).toEqual(
      expect.arrayContaining([
        "orientation",
        "screenSize",
        "smallestScreenSize",
        "screenLayout",
        "locale",
        "uiMode",
        "fontScale",
        "density",
        "fontWeightAdjustment",
        "layoutDirection",
      ]),
    );
  });

  it("keeps Komori's data out of Android backup and device transfer", () => {
    const manifest = readFileSync(`${main}/AndroidManifest.xml`, "utf8");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const rules = readFileSync(`${main}/res/xml/data_extraction_rules.xml`, "utf8");
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = rules.split(`<${section}>`)[1]?.split(`</${section}>`)[0] ?? "";
      expect(body).not.toContain("<include");
      for (const domain of ["root", "file", "database", "sharedpref", "external"])
        expect(body).toContain(`<exclude domain="${domain}" path="." />`);
    }
  });

  it("shares only AnkiDroid's media folder through its file provider", () => {
    const paths = readFileSync(`${main}/res/xml/file_paths.xml`, "utf8");
    expect(
      [...paths.matchAll(/<([\w-]+-path)\s[^>]*path="([^"]*)"/gu)].map((m) => [m[1], m[2]]),
    ).toEqual([["cache-path", "ankidroid/"]]);
  });
});
