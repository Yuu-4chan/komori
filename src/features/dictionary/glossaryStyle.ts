/**
 * The inline styles imported structured content may keep: an allowlist of layout and text
 * properties whose values are checked against inert value shapes (lengths, keywords, colors,
 * quoted list markers). No URL, image, or arbitrary function value passes. Native Anki export
 * applies the same rules again before writing a card.
 */
export type GlossaryStyle = Record<string, string>;

type Check = (value: string) => boolean;

const NUMBER = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
const LENGTH = new RegExp(`^${NUMBER}(em|rem|px|%|ex|ch)?$`);
// Bounds keep imported boxes from pushing results out of the popup.
const LIMITS: Record<string, number> = { em: 8, rem: 8, ex: 16, ch: 16, px: 96, "%": 400, "": 8 };

function length(token: string, negative: boolean): boolean {
  if (token === "0" || token === "auto") return true;
  const match = LENGTH.exec(token);
  if (!match) return false;
  const amount = Number.parseFloat(token);
  return (negative || amount >= 0) && Math.abs(amount) <= LIMITS[match[1] ?? ""];
}

const lengths =
  (negative = false, auto = false): Check =>
  (value) => {
    const tokens = value.trim().split(/\s+/u);
    return (
      tokens.length >= 1 &&
      tokens.length <= 4 &&
      tokens.every((token) => (token === "auto" ? auto : length(token, negative)))
    );
  };

const keywords =
  (allowed: string[], count = 1): Check =>
  (value) => {
    const tokens = value.trim().split(/\s+/u);
    return tokens.length <= count && tokens.every((token) => allowed.includes(token));
  };

// Colors: hex, named, and the color functions dictionaries use, with no other punctuation.
const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "var", "color-mix"]);
function color(value: string): boolean {
  if (value.length > 160 || !/^[-a-zA-Z0-9#%.,\s()]+$/u.test(value)) return false;
  let depth = 0;
  for (const match of value.matchAll(/([-a-zA-Z]*)\(|\)/gu)) {
    if (match[0] === ")") depth--;
    else {
      if (!COLOR_FUNCTIONS.has(match[1].toLowerCase())) return false;
      depth++;
    }
    if (depth < 0) return false;
  }
  return depth === 0 && !/url|image|expression/iu.test(value);
}

const fontSize: Check = (value) =>
  keywords(["xx-small", "x-small", "small", "medium", "large", "x-large", "smaller", "larger"])(
    value,
  ) ||
  (length(value, false) &&
    // A headline-sized glossary would hide the headword.
    Number.parseFloat(value) <= (value.endsWith("%") ? 250 : value.endsWith("px") ? 40 : 2.5));

const listMarker: Check = (value) =>
  /^[a-z-]{1,32}$/u.test(value) || /^(['"])[^'"\\<>]{1,8}\1$/u.test(value);

const checks: Record<string, Check> = {
  fontStyle: keywords(["normal", "italic", "oblique"]),
  fontWeight: keywords([
    "normal",
    "bold",
    "bolder",
    "lighter",
    "100",
    "200",
    "300",
    "400",
    "500",
    "600",
    "700",
    "800",
    "900",
  ]),
  fontSize,
  color,
  backgroundColor: color,
  borderColor: color,
  textDecorationLine: keywords(["none", "underline", "overline", "line-through"], 3),
  textDecorationStyle: keywords(["solid", "double", "dotted", "dashed", "wavy"]),
  verticalAlign: (value) =>
    keywords(["baseline", "sub", "super", "text-top", "text-bottom", "middle", "top", "bottom"])(
      value,
    ) || length(value, true),
  textAlign: keywords(["start", "end", "left", "right", "center", "justify"]),
  whiteSpace: keywords(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"]),
  wordBreak: keywords(["normal", "break-all", "keep-all", "break-word"]),
  listStyleType: listMarker,
  borderStyle: keywords(["none", "solid", "dashed", "dotted", "double", "hidden"], 4),
  borderWidth: (value) => keywords(["thin", "medium", "thick"])(value) || lengths()(value),
  borderRadius: lengths(),
  margin: lengths(true, true),
  marginTop: lengths(true, true),
  marginRight: lengths(true, true),
  marginBottom: lengths(true, true),
  marginLeft: lengths(true, true),
  padding: lengths(),
  paddingTop: lengths(),
  paddingRight: lengths(),
  paddingBottom: lengths(),
  paddingLeft: lengths(),
};

// Margins and paddings given as bare numbers are in em, as dictionaries write them.
const EM_DEFAULT = /^(margin|padding)/u;

/** The allowed declarations of an imported `style` object, or undefined when none remain. */
export function glossaryStyle(value: unknown): GlossaryStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const style: GlossaryStyle = {};
  for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(checks, property)) continue;
    const check = checks[property];
    if (typeof check !== "function") continue;
    let text =
      typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : typeof raw === "string"
          ? raw.trim()
          : "";
    if (!text || text.length > 160) continue;
    if (EM_DEFAULT.test(property))
      text = text
        .split(/\s+/u)
        .map((token) =>
          new RegExp(`^${NUMBER}$`).test(token) && token !== "0" ? `${token}em` : token,
        )
        .join(" ");
    if (check(text)) style[property] = text;
  }
  return Object.keys(style).length ? style : undefined;
}

const attributeNames = new Map<string, string | null>();

/** The `data-sc-*` attribute name Komori writes for an imported data key, or null. */
export function dataAttributeName(key: string): string | null {
  const known = attributeNames.get(key);
  if (known !== undefined) return known;
  let name: string | null = null;
  if (key && [...key].length <= 64 && !/[\s"'<>/=`\p{Cc}]/u.test(key)) {
    const camel = `sc${key[0].toUpperCase()}${key.slice(1)}`;
    name = `data-${camel.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
  }
  // Dictionaries use a few dozen keys; the bound only guards against unusual imports.
  if (attributeNames.size >= 1024) attributeNames.clear();
  attributeNames.set(key, name);
  return name;
}

/** Imported `data` as attribute strings, keeping only safe keys and short scalar values. */
export function glossaryData(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (!dataAttributeName(key)) continue;
    const text =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : null;
    // eslint-disable-next-line no-control-regex -- Match native text validation.
    if (text === null || text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text)) continue;
    data[key] = text;
  }
  return Object.keys(data).length ? data : undefined;
}

/** A web address a glossary link may open in the browser: http(s) only, without credentials. */
export function externalUrl(href: string): string | null {
  href = href.trim();
  if (href.length > 2048 || !/^https?:\/\//iu.test(href) || /["'<>`\\\p{Cc}]/u.test(href))
    return null;
  try {
    // Normalized, so spaces and non-ASCII paths are percent-encoded.
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      url.hostname &&
      url.href.length <= 2048
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The search a dictionary-internal link names (`?query=…`), or null. */
export function internalQuery(href: string): string | null {
  if (!href.startsWith("?")) return null;
  try {
    const query = new URLSearchParams(href.slice(1)).get("query")?.trim();
    return query || null;
  } catch {
    return null;
  }
}
