/** A piece of a headword with the reading it takes when it is not kana itself. */
export interface FuriganaSegment {
  text: string;
  reading?: string;
}

const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;

function hiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * Splits a headword so each run that is not kana carries its own part of the reading, aligned on
 * the kana the headword shares with it (読み込む よみこむ → 読[よ]み込[こ]む). A headword that
 * cannot be aligned keeps the whole reading over the whole word.
 */
export function furiganaSegments(expression: string, reading: string): FuriganaSegment[] {
  if (!reading || hiragana(reading) === hiragana(expression)) return [{ text: expression }];
  // Alignment tries each split; very long headwords keep the whole reading.
  if (expression.length > 24 || reading.length > 48) return [{ text: expression, reading }];
  const runs: { text: string; kana: boolean }[] = [];
  for (const character of expression) {
    const kana = KANA.test(character);
    const last = runs[runs.length - 1];
    if (last && last.kana === kana) last.text += character;
    else runs.push({ text: character, kana });
  }
  const sound = Array.from(reading);
  const match = (run: number, position: number): FuriganaSegment[] | null => {
    if (run === runs.length) return position === sound.length ? [] : null;
    const { text, kana } = runs[run];
    if (kana) {
      const length = Array.from(text).length;
      if (hiragana(sound.slice(position, position + length).join("")) !== hiragana(text))
        return null;
      const rest = match(run + 1, position + length);
      return rest && [{ text }, ...rest];
    }
    for (let end = position + 1; end <= sound.length; end++) {
      const rest = match(run + 1, end);
      if (rest) return [{ text, reading: sound.slice(position, end).join("") }, ...rest];
    }
    return null;
  };
  return match(0, 0) ?? [{ text: expression, reading }];
}
