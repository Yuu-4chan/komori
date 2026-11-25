import { invoke, isTauri } from "@tauri-apps/api/core";

/** The introduction of the Wikipedia page a selection names, as native code read it. */
export type WikipediaSummary =
  | { status: "found"; title: string; description: string | null; extract: string; url: string }
  | { status: "missing" }
  | { status: "failed" };

/**
 * The summary of the page `text` names in the Wikipedia of `language` (a tag such as `ja`).
 * Native code makes the request; an unexpected answer reads as failed.
 */
export async function getWikipediaSummary(
  text: string,
  language: string | null,
): Promise<WikipediaSummary> {
  if (!isTauri()) return { status: "failed" };
  const summary = await invoke<WikipediaSummary>("wikipedia_summary", { text, language });
  if (
    summary?.status === "found" &&
    typeof summary.title === "string" &&
    typeof summary.extract === "string" &&
    typeof summary.url === "string" &&
    /^https:\/\/[a-z]{2,3}(?:-[a-z]+)*\.wikipedia\.org\//.test(summary.url)
  )
    return summary;
  return summary?.status === "missing" ? { status: "missing" } : { status: "failed" };
}
