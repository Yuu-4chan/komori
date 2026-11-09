// Renders Komori's app icons from src/brand: each choice's window and tray icon into
// src-tauri/icons/app/, the default choice as the executable's full icon set, and its Android
// launcher icons (legacy and adaptive) into src-tauri/icons/android/ and the Android project.
// Run after changing the logo or the icon palette: node scripts/app-icons.mjs
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptiveIconLayers, appIconSvg, appIcons, defaultAppIcon } from "../src/brand/appIcons.ts";

const root = join(import.meta.dirname, "..");
const icons = join(root, "src-tauri", "icons");
const logo = readFileSync(join(root, "src", "brand", "komori.svg"), "utf8");
const work = mkdtempSync(join(tmpdir(), "komori-icons-"));
mkdirSync(join(icons, "app"), { recursive: true });
const render = (name, source) => {
  const svg = join(work, `${name}.svg`);
  const out = join(work, name);
  writeFileSync(svg, source);
  execFileSync(process.execPath, [join(root, "scripts", "tauri.mjs"), "icon", svg, "-o", out], {
    stdio: "ignore",
  });
  return { svg, out };
};

// Android draws an adaptive icon from two full-bleed layers; Tauri renders a layer as the
// foreground of its own icon set.
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@mipmap/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
function renderAndroid() {
  const android = join(icons, "android");
  const layers = adaptiveIconLayers(logo, defaultAppIcon);
  const foreground = render("android-foreground", layers.foreground).out;
  const background = render("android-background", layers.background).out;
  rmSync(join(android, "values"), { recursive: true, force: true });
  for (const folder of readdirSync(android).filter((name) => /^mipmap-.+dpi$/u.test(name))) {
    const from = (out) => join(out, "android", folder, "ic_launcher_foreground.png");
    cpSync(from(foreground), join(android, folder, "ic_launcher_foreground.png"));
    cpSync(from(background), join(android, folder, "ic_launcher_background.png"));
  }
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"])
    writeFileSync(join(android, "mipmap-anydpi-v26", name), adaptive);
  cpSync(android, join(root, "src-tauri", "gen", "android", "app", "src", "main", "res"), {
    recursive: true,
  });
}

try {
  for (const { id } of appIcons) {
    const { svg, out } = render(id, appIconSvg(logo, id));
    cpSync(join(out, "128x128.png"), join(icons, "app", `${id}.png`));
    if (id === defaultAppIcon) {
      cpSync(svg, join(icons, "icon.svg"));
      cpSync(out, icons, { recursive: true });
      renderAndroid();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Rendered ${appIcons.length} app icons; ${defaultAppIcon} is the executable's.`);
