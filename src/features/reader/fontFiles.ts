import { isAndroid } from "../../app/platform";

/** A Reader font file Komori serves, named by its hash or uploaded id. */
const FONT_FILE = /http:\/\/komori-font\.localhost\/[^"')\s]+/g;

/** Every font file fetched so far, as a blob URL; undefined when it could not be fetched. */
const fetching = new Map<string, Promise<string | undefined>>();
const kept = new Map<string, string>();

/**
 * Android's WebView neither caches Komori's own responses nor shares them between a book's
 * sections, and copies each one through the app's small Java heap: every section asking for
 * a 10 MB Japanese font again ran the phone out of memory when a layout change showed many
 * sections at once. On the phone each font file is fetched once and kept as a blob URL,
 * which the sections share.
 *
 * Starts fetching the font files named in `css` that are not kept yet; resolves once each
 * is kept or could not be fetched. Undefined when there is nothing to wait for, which is
 * always so off Android.
 */
export function keepFontFiles(css: string): Promise<void> | undefined {
  if (!isAndroid) return undefined;
  const waiting: Promise<unknown>[] = [];
  for (const url of new Set(css.match(FONT_FILE) ?? [])) {
    if (kept.has(url)) continue;
    let fetched = fetching.get(url);
    if (!fetched) {
      fetched = fetch(url)
        .then((response) => (response.ok ? response.blob() : undefined))
        .then((blob) => {
          if (!blob) return undefined;
          const local = URL.createObjectURL(blob);
          kept.set(url, local);
          return local;
        })
        .catch(() => undefined)
        .finally(() => fetching.delete(url));
      fetching.set(url, fetched);
    }
    waiting.push(fetched);
  }
  return waiting.length ? Promise.all(waiting).then(() => undefined) : undefined;
}

/** `css` with each kept font file's blob URL in place of Komori's URL for it. */
export function keptFontFiles(css: string): string {
  if (!isAndroid || !kept.size) return css;
  return css.replace(FONT_FILE, (url) => kept.get(url) ?? url);
}
