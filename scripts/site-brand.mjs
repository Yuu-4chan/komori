// Draws the website's logo and app icon in each application theme's accent, from src/brand:
// site/assets/logo/<theme>.svg for the top bar and site/assets/icon/<theme>.svg for the hero.
// Run after changing the logo or the application themes: node scripts/site-brand.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tileIconSvg } from "../src/brand/appIcons.ts";
import { appPresetThemes } from "../src/features/appearance/appThemes.ts";

const root = join(import.meta.dirname, "..");
const logo = readFileSync(join(root, "src", "brand", "komori.svg"), "utf8");
const assets = join(root, "site", "assets");

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const channels = (hex) => [0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255);

function toOklab(hex) {
  const [r, g, b] = channels(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return hex(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(toGamma),
  );
}

function hex(rgb) {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** CSS color-mix(in oklab, color <amount>, other). */
const mix = (color, amount, other) => {
  const [from, to] = [toOklab(color), toOklab(other)];
  return fromOklab(from.map((value, i) => value * amount + to[i] * (1 - amount)));
};

function recolor(svg, id, color) {
  const pattern = new RegExp(`<linearGradient id="${id}"[\\s\\S]*?</linearGradient>`, "u");
  if (!pattern.test(svg)) throw new Error(`The logo has no gradient ${id}`);
  return svg.replace(pattern, (gradient) =>
    gradient.replace(/stop-color="#[\da-f]{6}"/giu, `stop-color="${color}"`),
  );
}

/** The logo mixed from one color, as `.brand-mark` mixes it in src/styles/shell.css. */
function tintedLogo(base) {
  const colors = {
    "coral-page": mix(base, 0.86, "#ffffff"),
    "coral-cover": mix(base, 0.86, "#ffffff"),
    "rose-ear": mix(base, 0.9, "#000000"),
    "peach-ear": mix(base, 0.58, "#ffffff"),
    "cream-page": mix(base, 0.13, "#ffffff"),
    "cream-fold": mix(base, 0.13, "#ffffff"),
    "mauve-tail": mix(base, 0.55, "#8a5c8f"),
    "pink-petal": mix(base, 0.7, "#ffffff"),
    "sakura-pink": base,
  };
  let svg = logo;
  for (const [id, color] of Object.entries(colors)) svg = recolor(svg, id, color);
  return svg;
}

/** A light theme's icon is a pale accent tile with a deep drawing; a dark theme's the reverse. */
function palette({ base, surface, text, accent }) {
  return base === "light"
    ? {
        tile: [mix(accent, 0.16, surface)],
        light: mix(accent, 0.9, "#ffffff"),
        deep: mix(accent, 0.3, text),
      }
    : { tile: [mix(accent, 0.3, surface)], light: "#ffffff", deep: mix(accent, 0.75, "#ffffff") };
}

const describe = (svg, title, description) =>
  svg
    .replace(/<title id="title">[^<]*<\/title>/u, `<title id="title">${title}</title>`)
    .replace(
      /<desc id="description">[^<]*<\/desc>/u,
      `<desc id="description">${description}</desc>`,
    );

mkdirSync(join(assets, "logo"), { recursive: true });
mkdirSync(join(assets, "icon"), { recursive: true });
for (const theme of appPresetThemes) {
  writeFileSync(
    join(assets, "logo", `${theme.id}.svg`),
    describe(
      tintedLogo(theme.accent),
      "Komori logo",
      "An open book with rounded cat ears, a flowing tail, a floating petal and a sakura blossom.",
    ),
  );
  writeFileSync(
    join(assets, "icon", `${theme.id}.svg`),
    describe(
      tileIconSvg(logo, palette(theme)),
      "Komori app icon",
      "The Komori logo on a rounded tile.",
    ),
  );
}
console.log(`Wrote ${appPresetThemes.length} logos and icons under site/assets.`);
