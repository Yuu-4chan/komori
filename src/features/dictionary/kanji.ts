import ranges from "./kanjiRanges.json";

// The format's kanji ranges (the CJK unified ideographs with extensions A through I, and the
// compatibility ideographs), as hex code points: the Unicode block endpoints of Yomitan's
// `isCodePointKanji` (ext/js/language/ja/japanese.js, GPL-3.0-or-later). The native kanji lookup
// reads the same file, so a character offered here as a kanji is one it accepts.
const kanjiRanges = ranges.map(([first, last]) => [parseInt(first, 16), parseInt(last, 16)]);

/** Whether `character` is exactly one kanji the native kanji lookup accepts (not `々`). */
export function isKanji(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined || [...character].length !== 1) return false;
  return kanjiRanges.some(([first, last]) => code >= first && code <= last);
}
