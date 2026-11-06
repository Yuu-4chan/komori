import type { PitchMatch } from "./dictionaryApi";

const JOINING_KANA = new Set("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ");
const MAX_MORAS = 32;

/** A kana reading's morae (a small kana joins the one before it); null for any other text. */
export function readingMoras(reading: string): string[] | null {
  if (!/^[ぁ-ゖァ-ヺー]+$/u.test(reading)) return null;
  const moras: string[] = [];
  for (const kana of reading) {
    if (JOINING_KANA.has(kana)) {
      if (moras.length === 0 || JOINING_KANA.has(moras[moras.length - 1].slice(-1))) return null;
      moras[moras.length - 1] += kana;
    } else {
      if (kana === "ー" && moras.length === 0) return null;
      moras.push(kana);
    }
    if (moras.length > MAX_MORAS) return null;
  }
  return moras.length ? moras : null;
}

/** One pitch pattern of a reading, with every source row that returned it. */
export interface PitchPattern {
  position: number;
  nasal: number[];
  devoice: number[];
  tags: string[];
  sources: { key: number; title: string }[];
}

// Dictionaries store nasal and devoiced morae as one one-based index or an array of them. Invalid
// or out-of-range values are ignored; without a representable reading no mark can be placed.
function moraMarks(value: unknown, moraCount: number): number[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const marks = values.filter(
    (mora): mora is number =>
      typeof mora === "number" && Number.isSafeInteger(mora) && mora >= 1 && mora <= moraCount,
  );
  return [...new Set(marks)].sort((a, b) => a - b);
}

// Pitch entries may tag a position with a string array (for example a part of speech). Only
// nonblank strings are kept, trimmed and once each, in their imported order.
function pitchTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

/**
 * The reading's pitch patterns: one per distinct position, mora marks and tags, in first-returned
 * order, naming every source row that returned it, so agreement collapses and disagreement
 * stands out. Rows for another reading and malformed entries are left out.
 */
export function pitchPatterns(pitches: PitchMatch[], reading: string): PitchPattern[] {
  const moraCount = readingMoras(reading)?.length ?? 0;
  const patterns: PitchPattern[] = [];
  pitches.forEach((pitch, index) => {
    if (!pitch.data || typeof pitch.data !== "object" || Array.isArray(pitch.data)) return;
    const data = pitch.data as Record<string, unknown>;
    if (data.reading !== reading || !Array.isArray(data.pitches)) return;
    const rowPatterns = new Set<PitchPattern>();
    for (const entry of data.pitches as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const fields = entry as Record<string, unknown>;
      const position = fields.position;
      if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) continue;
      const nasal = moraMarks(fields.nasal, moraCount);
      const devoice = moraMarks(fields.devoice, moraCount);
      const tags = pitchTags(fields.tags);
      const tagKey = JSON.stringify([...tags].sort());
      let pattern = patterns.find(
        (candidate) =>
          candidate.position === position &&
          candidate.nasal.join() === nasal.join() &&
          candidate.devoice.join() === devoice.join() &&
          JSON.stringify([...candidate.tags].sort()) === tagKey,
      );
      if (!pattern) {
        pattern = { position, nasal, devoice, tags, sources: [] };
        patterns.push(pattern);
      }
      rowPatterns.add(pattern);
    }
    for (const pattern of rowPatterns) {
      pattern.sources.push({ key: index, title: pitch.dictionaryTitle });
    }
  });
  return patterns;
}

/**
 * The class names that draw `pattern` on each character of `reading`, as accent dictionaries mark
 * it: a line over each high mora, a step down after the mora where the pitch falls, a ring around
 * a devoiced mora and a small circle after a nasal one. No marks when there is no pattern, the
 * reading is not kana, or the position is past its morae.
 */
export function pitchMarks(
  reading: string,
  pattern: PitchPattern | undefined,
): (string | undefined)[] {
  const moras = pattern ? readingMoras(reading) : null;
  if (!pattern || !moras || pattern.position > moras.length) return [];
  const { position, nasal, devoice } = pattern;
  const high = (mora: number) =>
    position === 0 ? mora > 0 : position === 1 ? mora === 0 : mora > 0 && mora < position;
  return moras.flatMap((mora, index) => {
    const kana = Array.from(mora);
    return kana.map((_, place) => {
      const last = place === kana.length - 1;
      const names = [
        high(index) && "pitch-kana--high",
        last && position > 0 && index === position - 1 && "pitch-kana--drop",
        devoice.includes(index + 1) && "pitch-kana--devoiced",
        last && nasal.includes(index + 1) && "pitch-kana--nasal",
      ].filter(Boolean);
      return names.length ? names.join(" ") : undefined;
    });
  });
}
