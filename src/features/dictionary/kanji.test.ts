import { describe, expect, it } from "vitest";

import { isKanji } from "./kanji";
import ranges from "./kanjiRanges.json";

describe("isKanji", () => {
  it("accepts one character from each of the kanji ranges", () => {
    expect(ranges).toHaveLength(12);
    for (const [first, last] of ranges) {
      for (const hex of [first, last]) {
        expect(isKanji(String.fromCodePoint(parseInt(hex, 16))), hex).toBe(true);
      }
    }
    for (const character of ["読", "本", "㐀", "𠀋", "豈"]) {
      expect(isKanji(character), character).toBe(true);
    }
  });

  it("rejects kana, the iteration mark, other scripts, and more or fewer than one character", () => {
    for (const character of ["む", "ヨ", "々", "〇", "ー", "A", "1", "", "本本", "読む", " 本"]) {
      expect(isKanji(character), character).toBe(false);
    }
    // Just outside the unified and compatibility ranges.
    for (const code of [0x33ff, 0x4dc0, 0xf8ff, 0xfb00, 0x2fa20]) {
      expect(isKanji(String.fromCodePoint(code)), code.toString(16)).toBe(false);
    }
  });
});
