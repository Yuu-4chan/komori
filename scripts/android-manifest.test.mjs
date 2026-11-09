import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Android recreates an activity for a configuration change it does not handle itself, and
// Tauri keeps its Back handler on the first activity, so Back would then close Komori.
describe("Android activity", () => {
  it("handles font, display size and layout direction changes itself", () => {
    const manifest = readFileSync("src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8");
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
});
