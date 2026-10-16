// Renders Komori's app icons from src/brand: each choice's window and tray icon into
// src-tauri/icons/app/, and the default choice as the executable's full icon set.
// Run after changing the logo or the icon palette: node scripts/app-icons.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appIconSvg, appIcons, defaultAppIcon } from "../src/brand/appIcons.ts";

const root = join(import.meta.dirname, "..");
const icons = join(root, "src-tauri", "icons");
const logo = readFileSync(join(root, "src", "brand", "komori.svg"), "utf8");
const work = mkdtempSync(join(tmpdir(), "komori-icons-"));
mkdirSync(join(icons, "app"), { recursive: true });
try {
  for (const { id } of appIcons) {
    const svg = join(work, `${id}.svg`);
    const out = join(work, id);
    writeFileSync(svg, appIconSvg(logo, id));
    execFileSync(process.execPath, [join(root, "scripts", "tauri.mjs"), "icon", svg, "-o", out], {
      stdio: "ignore",
    });
    cpSync(join(out, "128x128.png"), join(icons, "app", `${id}.png`));
    if (id === defaultAppIcon) {
      cpSync(svg, join(icons, "icon.svg"));
      cpSync(out, icons, { recursive: true });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Rendered ${appIcons.length} app icons; ${defaultAppIcon} is the executable's.`);
