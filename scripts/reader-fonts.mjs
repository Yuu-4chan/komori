// Fetches the Reader fonts the installer includes into src-tauri/fonts/<id>/font.ttf, beside
// their committed OFL.txt, verifying each against the pinned catalog. Files already there and
// verified are kept, so only a first build downloads.
// Usage: node scripts/reader-fonts.mjs [--optional] (--optional only warns when offline)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const bundledFontsDirectory = join("src-tauri", "fonts");
const catalog = JSON.parse(readFileSync("src/features/reader/googleFontCatalog.json", "utf8"));
export const bundledFonts = catalog.fonts.filter((font) => font.bundled);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verified = (path, expected) => existsSync(path) && hash(readFileSync(path)) === expected;

/** The included fonts whose files are missing or fail verification, as catalog entries. */
export function missingBundledFonts(root = process.cwd()) {
  return bundledFonts.filter(
    (font) =>
      !verified(join(root, bundledFontsDirectory, font.id, "font.ttf"), font.hash) ||
      !verified(join(root, bundledFontsDirectory, font.id, "OFL.txt"), font.licenseHash),
  );
}

async function fetchBundledFonts() {
  const expected = new Set(bundledFonts.map((font) => font.id));
  await mkdir(bundledFontsDirectory, { recursive: true });
  const stray = readdirSync(bundledFontsDirectory).filter((name) => !expected.has(name));
  if (stray.length)
    throw Error(`${bundledFontsDirectory} holds fonts no longer included: ${stray}`);
  for (const font of missingBundledFonts()) {
    const directory = join(bundledFontsDirectory, font.id);
    await mkdir(directory, { recursive: true });
    for (const [name, path, expectedHash] of [
      ["OFL.txt", `${font.path.slice(0, font.path.lastIndexOf("/"))}/OFL.txt`, font.licenseHash],
      ["font.ttf", font.path, font.hash],
    ]) {
      const target = join(directory, name);
      if (verified(target, expectedHash)) continue;
      const response = await fetch(
        `https://raw.githubusercontent.com/google/fonts/${catalog.commit}/${path}`,
      );
      if (!response.ok) throw Error(`${font.family} ${name}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== expectedHash) throw Error(`${font.family} ${name} failed verification`);
      await writeFile(`${target}.partial`, bytes);
      await rename(`${target}.partial`, target);
    }
    console.log(`Included Reader font: ${font.family}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await fetchBundledFonts();
  } catch (error) {
    if (!process.argv.includes("--optional")) {
      console.error(`Could not fetch the included Reader fonts: ${error.message}`);
      process.exit(1);
    }
    console.warn(`The included Reader fonts are unavailable: ${error.message}`);
  }
}
