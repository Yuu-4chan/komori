import { invoke, isTauri } from "@tauri-apps/api/core";

/** The renderer adapter may consume this URL; Reader UI keeps only catalog identity. */
export type ReaderContentAccess =
  | { status: "ready"; url: string }
  | { status: "unknown" | "missing" | "unreadable" | "invalid" | "tooLarge" | "failed"; url: null };

export async function prepareReaderContent(catalogId: string): Promise<ReaderContentAccess> {
  if (!isTauri()) return { status: "failed", url: null };
  try {
    const result = await invoke<ReaderContentAccess>("prepare_book_content", { id: catalogId });
    if (result.status !== "ready") {
      return ["unknown", "missing", "unreadable", "invalid", "tooLarge", "failed"].includes(
        result.status,
      )
        ? { status: result.status, url: null }
        : { status: "failed", url: null };
    }
    const validId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(catalogId);
    const safeUrl =
      result.url === `http://komori-book.localhost/${catalogId}` ||
      result.url === `komori-book://localhost/${catalogId}`;
    return validId && safeUrl ? result : { status: "failed", url: null };
  } catch {
    // Native diagnostics stay native; invoke errors may include private details.
    return { status: "failed", url: null };
  }
}
