import { describe, expect, it } from "vitest";

import { pitchMarks, pitchPatterns, readingMoras, type PitchPattern } from "./pitchAccent";

const pattern = (position: number, marks: Partial<PitchPattern> = {}): PitchPattern => ({
  position,
  nasal: [],
  devoice: [],
  tags: [],
  sources: [],
  ...marks,
});

describe("pitch marks", () => {
  it("draws a flat word high after its first mora, with no fall", () => {
    expect(pitchMarks("はし", pattern(0))).toEqual([undefined, "pitch-kana--high"]);
  });

  it("draws a head-high word high on its first mora, falling after it", () => {
    expect(pitchMarks("はし", pattern(1))).toEqual([
      "pitch-kana--high pitch-kana--drop",
      undefined,
    ]);
  });

  it("draws a middle-high word high from its second mora to the fall", () => {
    expect(pitchMarks("あつりょく", pattern(2))).toEqual([
      undefined,
      "pitch-kana--high pitch-kana--drop",
      undefined,
      undefined,
      undefined,
    ]);
    expect(pitchMarks("おとうと", pattern(4))).toEqual([
      undefined,
      "pitch-kana--high",
      "pitch-kana--high",
      "pitch-kana--high pitch-kana--drop",
    ]);
  });

  it("keeps a joined kana with its mora and steps down after the whole mora", () => {
    expect(readingMoras("きょう")).toEqual(["きょ", "う"]);
    expect(pitchMarks("きょう", pattern(1))).toEqual([
      "pitch-kana--high",
      "pitch-kana--high pitch-kana--drop",
      undefined,
    ]);
  });

  it("rings devoiced morae and marks nasal ones after their last kana", () => {
    expect(pitchMarks("きがく", pattern(0, { devoice: [1], nasal: [2] }))).toEqual([
      "pitch-kana--devoiced",
      "pitch-kana--high pitch-kana--nasal",
      "pitch-kana--high",
    ]);
  });

  it("draws nothing without a pattern, for a reading that is not kana, or past its morae", () => {
    expect(pitchMarks("はし", undefined)).toEqual([]);
    expect(pitchMarks("今日", pattern(1))).toEqual([]);
    expect(pitchMarks("はし", pattern(3))).toEqual([]);
  });
});

describe("pitch patterns", () => {
  it("collapses agreeing sources, keeps differing marks and tags apart, and skips bad rows", () => {
    const row = (dictionaryTitle: string, data: unknown) => ({
      dictionaryId: 1,
      dictionaryTitle,
      data,
    });
    const patterns = pitchPatterns(
      [
        row("A", {
          reading: "きがく",
          pitches: [{ position: 1, tags: [" n ", "n", 3] }, { position: 0 }],
        }),
        row("B", {
          reading: "きがく",
          pitches: [
            { position: 1, tags: ["n"] },
            { position: 1, nasal: [2, 9] },
          ],
        }),
        row("Other", { reading: "ほか", pitches: [{ position: 2 }] }),
        row("Bad", { reading: "きがく", pitches: [{ position: -1 }, { position: "1" }, null] }),
        row("Empty", null),
      ],
      "きがく",
    );
    expect(
      patterns.map(({ position, nasal, tags, sources }) => [
        position,
        nasal,
        tags,
        sources.map((source) => source.title),
      ]),
    ).toEqual([
      [1, [], ["n"], ["A", "B"]],
      [0, [], [], ["A"]],
      [1, [2], [], ["B"]],
    ]);
  });
});
