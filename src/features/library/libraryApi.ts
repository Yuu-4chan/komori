import { i18n } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runBulkOperation, type RemovalBatch } from "../operations/bulkOperation";

export interface LibraryBook {
  id: string;
  title: string | null;
  author: string | null;
  fileName: string;
  importedAt: string;
  availability: "available" | "missing" | "unreadable";
  hasCover: boolean;
  /** The cover thumbnail on Komori's cover protocol; it changes whenever the cover does. */
  coverUrl?: string | null;
  /** How far the Reader last counted the book; null before it was opened since this was saved. */
  progress?: LibraryBookProgress | null;
  /** When the Reader last saved the book's position or progress. */
  lastReadAt?: string | null;
  /** A language tag such as `ja`, `zh-Hant`, or `en`, when known: the language, and Chinese's script. */
  language?: string | null;
  /** The series set by hand, or else the book's own metadata's. */
  series?: string | null;
  seriesIndex?: number | null;
  /** Whether the series (or having none) was set by hand. */
  seriesManual?: boolean;
  /** Letters and numbers in a Chinese, Japanese, or Korean book, as the Reader counts them. */
  characters?: number | null;
  /** Distinct kanji in a Chinese, Japanese, or Korean book. */
  uniqueKanji?: number | null;
  /** Words in any other book, as the Reader counts them. */
  words?: number | null;
}

/** Whole-book progress as the Reader's footer counts it. */
interface LibraryBookProgress {
  /** Characters for Chinese, Japanese, and Korean books, words for the rest. */
  unit: "characters" | "words";
  current: number;
  total: number;
}

export interface ImportResult {
  fileName: string;
  status: "imported" | "alreadyImported" | "failed";
  message: string | null;
}

export interface ImportBatch {
  canceled: boolean;
  results: ImportResult[];
}

export interface RelinkResult {
  status: "relinked" | "canceled" | "invalid" | "duplicate" | "readFailed" | "failed";
  message: string | null;
}

export interface RemoveResult {
  id: string;
  status: "removed" | "failed";
  message: string | null;
}

function requireDesktop() {
  if (!isTauri()) {
    throw new Error(i18n().t("library.desktopOnly"));
  }
}

export async function listLibrary(): Promise<LibraryBook[]> {
  requireDesktop();
  return invoke<LibraryBook[]>("list_library");
}

/**
 * Marks a book unread: its saved position and progress are removed and its reading sessions
 * no longer count as finishing it. Resolves false for a book no longer in the catalog.
 */
export async function markBookUnread(id: string): Promise<boolean> {
  requireDesktop();
  return invoke<boolean>("mark_book_unread", { id });
}

/** Moves each book's progress to its end, returning the IDs marked; uncounted books stay. */
export async function markBooksCompleted(ids: string[]): Promise<string[]> {
  requireDesktop();
  return invoke<string[]>("mark_books_completed", { ids });
}

/** Resolves one catalog record by ID without loading or checking the whole Library. */
export async function getLibraryBook(id: string): Promise<LibraryBook | null> {
  requireDesktop();
  return invoke<LibraryBook | null>("get_library_book", { id });
}

export async function importBooks(): Promise<ImportBatch> {
  requireDesktop();
  return runBulkOperation<ImportBatch>("library", "import_books");
}

/** Consumes an OS-selected drop once; private file paths never enter the request. */
export async function importDroppedBooks(dropId: string): Promise<ImportBatch> {
  requireDesktop();
  return runBulkOperation<ImportBatch>("library", "import_dropped_books", { dropId });
}

export interface LibraryFileDrag {
  phase: "enter" | "leave" | "drop";
  accepted: boolean;
  dropId: string | null;
}

/** WebView2 transfers native File objects; no path string or archive bytes cross IPC. */
export function postLibraryFiles(files: File[]): boolean {
  const webview = (
    window as Window & {
      chrome?: {
        webview?: { postMessageWithAdditionalObjects?: (message: string, files: File[]) => void };
      };
    }
  ).chrome?.webview;
  if (!isTauri() || !webview?.postMessageWithAdditionalObjects) return false;
  webview.postMessageWithAdditionalObjects("komori-library-epub-drop", files);
  return true;
}

export function onLibraryFileDrag(callback: (notice: LibraryFileDrag) => void): () => void {
  if (!isTauri()) return () => {};
  let active = true;
  let stop: (() => void) | undefined;
  void listen<LibraryFileDrag>("library-file-drag", ({ payload }) => {
    if (active) callback(payload);
  }).then(
    (unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    },
    () => {},
  );
  return () => {
    active = false;
    stop?.();
  };
}

/** A book folder: Komori imports the new EPUBs in it and its subfolders. */
export interface LibraryFolder {
  id: number;
  /** The folder as the reader chose it, for showing only. */
  path: string;
  availability: "available" | "missing" | "unreadable";
  /** Library books whose source is in the folder. */
  books: number;
}

export interface AddFolderResult {
  status: "added" | "canceled" | "duplicate" | "tooMany" | "failed";
  message: string | null;
  /** The new folder's first scan. */
  results: ImportResult[];
}

export async function listLibraryFolders(): Promise<LibraryFolder[]> {
  requireDesktop();
  return invoke<LibraryFolder[]>("list_library_folders");
}

/** Opens the native folder picker, adds the folder, and imports its EPUBs. */
export async function addLibraryFolder(): Promise<AddFolderResult> {
  requireDesktop();
  return runBulkOperation<AddFolderResult>("library", "add_library_folder");
}

/** Stops scanning a folder; its books stay in the Library. */
export async function removeLibraryFolder(id: number): Promise<boolean> {
  requireDesktop();
  return invoke<boolean>("remove_library_folder", { id });
}

/**
 * Imports the EPUBs in every book folder that no scan has met before. A book removed from the
 * Library is not imported again. Outside the desktop app there are no folders.
 */
export async function scanLibraryFolders(): Promise<ImportResult[]> {
  if (!isTauri()) return [];
  return runBulkOperation<ImportResult[]>("library", "scan_library_folders");
}

export async function relinkBook(id: string): Promise<RelinkResult> {
  requireDesktop();
  return invoke<RelinkResult>("relink_book", { id });
}

export async function removeBook(id: string): Promise<boolean> {
  requireDesktop();
  return (await runBulkOperation<RemovalBatch<boolean>>("library", "remove_book", { id })).results;
}

/** The Library catalog's size on disk in bytes. */
export async function getLibraryStoreSize(): Promise<number> {
  requireDesktop();
  return invoke<number>("get_library_store_size");
}

export async function removeBooks(ids: string[]): Promise<RemoveResult[]> {
  requireDesktop();
  return (await runBulkOperation<RemovalBatch<RemoveResult[]>>("library", "remove_books", { ids }))
    .results;
}

/**
 * Puts the books, in this order (numbered from 1), in one series by hand; null puts them in
 * none, whatever their metadata says. Returns how many books changed.
 */
export async function setBookSeries(ids: string[], series: string | null): Promise<number> {
  requireDesktop();
  const result = await invoke<{ updated: number }>("set_book_series", { ids, series });
  return result.updated;
}

/** Lets the books follow their own metadata's series again. */
export async function resetBookSeries(ids: string[]): Promise<number> {
  requireDesktop();
  const result = await invoke<{ updated: number }>("reset_book_series", { ids });
  return result.updated;
}

/**
 * Calls back whenever Komori has read the language, series, and text counts of more books in
 * the background. Returns the unsubscribe function; nothing happens outside the desktop app.
 */
export function onLibraryDetailsUpdated(callback: () => void): () => void {
  if (!isTauri()) return () => {};
  let active = true;
  let stop: (() => void) | null = null;
  void listen("library-details-updated", () => {
    if (active) callback();
  }).then(
    (unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    },
    () => {},
  );
  return () => {
    active = false;
    stop?.();
  };
}
