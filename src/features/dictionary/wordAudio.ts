import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Where recorded word audio comes from, tried in order: JapanesePod101, a URL answering with the
 * audio itself, or a URL answering with an audio list
 * (`{"audioSources":[{"url":…}]}`). URLs may use `{term}`, `{reading}`
 * and `{language}`. Native code makes every request; keep in step with `word_audio.rs`.
 */
export type WordAudioSource =
  { kind: "jpod101" } | { kind: "url"; url: string } | { kind: "list"; url: string };

export const defaultWordAudioSources: WordAudioSource[] = [{ kind: "jpod101" }];
export const maxWordAudioSources = 8;
const maxUrl = 2048;

/** An http(s) URL with a host once its placeholders are filled, as native code checks it. */
export function validWordAudioUrl(url: string): boolean {
  if (!url || url.length > maxUrl) return false;
  // eslint-disable-next-line no-control-regex -- Match native validation.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(url)) return false;
  try {
    const parsed = new URL(url.replace(/\{(?:term|reading|language)\}/gu, "x"));
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export const sameWordAudioSource = (a: WordAudioSource, b: WordAudioSource): boolean =>
  a.kind === b.kind && (a.kind === "jpod101" || a.url === (b as { url: string }).url);

/** Saved sources, when every one is valid and none repeats; otherwise undefined. */
export function normalizeWordAudioSources(value: unknown): WordAudioSource[] | undefined {
  if (!Array.isArray(value) || value.length > maxWordAudioSources) return undefined;
  const sources: WordAudioSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const { kind, url } = entry as { kind?: unknown; url?: unknown };
    const keys = Object.keys(entry).length;
    let source: WordAudioSource;
    if (kind === "jpod101" && keys === 1) source = { kind };
    else if (
      (kind === "url" || kind === "list") &&
      keys === 2 &&
      typeof url === "string" &&
      validWordAudioUrl(url)
    )
      source = { kind, url };
    else return undefined;
    if (sources.some((other) => sameWordAudioSource(other, source))) return undefined;
    sources.push(source);
  }
  return sources;
}

/** The first recording of the word the saved sources have, or null. */
export async function getWordAudio(term: string, reading: string): Promise<Blob | null> {
  if (!isTauri()) return null;
  const found = await invoke<{ mime: string; data: string } | null>("get_word_audio", {
    term,
    reading,
  });
  if (!found) return null;
  const bytes = Uint8Array.from(atob(found.data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: found.mime });
}
