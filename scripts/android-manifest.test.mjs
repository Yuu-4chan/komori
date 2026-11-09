import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  it("launches with Komori's icon, not the Android project's placeholder", () => {
    const manifest = readFileSync(`${main}/AndroidManifest.xml`, "utf8");
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    expect(manifest).toContain('android:roundIcon="@mipmap/ic_launcher_round"');
    // scripts/app-icons.mjs renders them into src-tauri/icons/android and copies them here.
    const rendered = "src-tauri/icons/android";
    const files = readdirSync(rendered, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(rendered.length + 1));
    expect(files).toEqual(
      expect.arrayContaining([
        join("mipmap-anydpi-v26", "ic_launcher.xml"),
        join("mipmap-xxxhdpi", "ic_launcher_foreground.png"),
        join("mipmap-xxxhdpi", "ic_launcher_background.png"),
      ]),
    );
    for (const file of files)
      expect(
        readFileSync(join(`${main}/res`, file)).equals(readFileSync(join(rendered, file))),
        file,
      ).toBe(true);
  });
});
