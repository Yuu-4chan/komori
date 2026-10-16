/**
 * Komori's app icons: the logo on a rounded tile, the book, cat and sakura tinted to the tile.
 * `scripts/app-icons.ts` renders them into the native window and tray icons; Settings shows them.
 */
export const appIcons = [
  { id: "navy", tile: ["#1E2A4A"], light: "#FFFFFF", deep: "#8EA4D8" },
  { id: "plum", tile: ["#3E2445"], light: "#FFF6FB", deep: "#B98BC4" },
  { id: "charcoal", tile: ["#26262B"], light: "#FFFFFF", deep: "#9A9AA8" },
  { id: "teal", tile: ["#1F6F74"], light: "#FFFFFF", deep: "#A6DAD6" },
  { id: "forest", tile: ["#264D3B"], light: "#FFFFFF", deep: "#9CC8A4" },
  { id: "twilight", tile: ["#2E3C78", "#6B3D86"], light: "#FFFFFF", deep: "#B9B2F0" },
  { id: "ocean", tile: ["#1C5D7A", "#3BA3A6"], light: "#FFFFFF", deep: "#A9DDE0" },
  { id: "midnight", tile: ["#111114"], light: "#FFFFFF", deep: "#7C7C88" },
  { id: "beige", tile: ["#F4E7D4"], light: "#A7836A", deep: "#3E2A22" },
  { id: "white", tile: ["#FFFFFF"], light: "#6E80A6", deep: "#1E2A4A" },
  { id: "butter", tile: ["#FFE29A"], light: "#A9763A", deep: "#4A2E12" },
  { id: "sky", tile: ["#BFE3F7"], light: "#5A8BB5", deep: "#1B3550" },
  { id: "lavender", tile: ["#DCCFF5"], light: "#8A74B8", deep: "#33244F" },
  { id: "mint", tile: ["#C9EBD9"], light: "#5A9A7A", deep: "#1D3D2E" },
  { id: "peach", tile: ["#FFE3C4", "#FFC2C9"], light: "#9A6A8E", deep: "#3E2445" },
  { id: "sunrise", tile: ["#FFD27A", "#FF9A8B"], light: "#9A5A3A", deep: "#3B1E14" },
] as const;

export type AppIconId = (typeof appIcons)[number]["id"];
/** The executable's own icon, which shortcuts and a closed pinned button keep. */
export const defaultAppIcon: AppIconId = "beige";
export const isAppIcon = (value: unknown): value is AppIconId =>
  appIcons.some(({ id }) => id === value);

/** Each logo gradient's shade, from the light end (0) to the deep end (1). */
const shades: Record<string, number> = {
  "cream-page": 0,
  "cream-fold": 0.06,
  "peach-ear": 0.32,
  "coral-page": 0.45,
  "coral-cover": 0.55,
  "rose-ear": 0.68,
  "mauve-tail": 0.85,
  "pink-petal": 0.85,
};

function mix(from: string, to: string, amount: number) {
  const t = Math.min(1, Math.max(0, amount));
  const channel = (color: string, index: number) =>
    parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

function recolor(svg: string, id: string, colors: (index: number, count: number) => string) {
  const pattern = new RegExp(`<linearGradient id="${id}"[\\s\\S]*?</linearGradient>`, "u");
  return svg.replace(pattern, (gradient) => {
    const count = gradient.match(/stop-color="#[\da-f]{6}"/giu)?.length ?? 0;
    let index = 0;
    return gradient.replace(
      /stop-color="#[\da-f]{6}"/giu,
      () => `stop-color="${colors(index++, count)}"`,
    );
  });
}

/** Half the tile; the drawing's optical centre sits between the book's and the tail's. */
const half = 940;
const centre = { x: 620, y: 475 };

/** The icon as SVG, made from Komori's logo (`src/brand/komori.svg`). */
export function appIconSvg(logo: string, id: AppIconId): string {
  const icon = appIcons.find((candidate) => candidate.id === id) ?? appIcons[0];
  const [first, last = first] = icon.tile;
  let svg = logo.replace(/^<\?xml[^>]*>\s*/u, "");
  for (const [gradient, shade] of Object.entries(shades))
    svg = recolor(svg, gradient, (index, count) =>
      mix(icon.light, icon.deep, shade + (count > 1 ? 0.06 * (index / (count - 1) - 0.5) : 0)),
    );
  // The sakura is cut out of the page in the tile's colours.
  svg = recolor(svg, "sakura-pink", (index) => (index === 0 ? first : last));
  const x = centre.x - half;
  const y = centre.y - half;
  return svg
    .replace(
      /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/u,
      `<svg$1width="1024" height="1024" viewBox="${x} ${y} ${half * 2} ${half * 2}"`,
    )
    .replace(
      "<defs>",
      `<defs><linearGradient id="tile-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${first}"/><stop offset="1" stop-color="${last}"/></linearGradient>`,
    )
    .replace(
      '<g id="komori-logo"',
      `<rect id="tile" x="${x}" y="${y}" width="${half * 2}" height="${half * 2}" rx="420" fill="url(#tile-fill)"/><g id="komori-logo"`,
    );
}
