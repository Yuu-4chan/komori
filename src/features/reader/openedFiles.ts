import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A book Windows asked Komori to open from a folder, outside the Library. */
export interface OpenedBook {
  /** Its ID for this run of Komori. */
  id: string;
  title: string | null;
  author: string | null;
  language: string | null;
}

// Books open from folders on the PC; the phone opens its books from its Library.
const available = () => isTauri() && import.meta.env.TAURI_ENV_PLATFORM !== "android";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Reader's route for a book opened from a folder. */
export const openedFileRoute = (id: string) => `/reader/file/${id}`;

/** The book opened from a folder that no window has opened yet, once. */
export async function takeOpenedFile(): Promise<string | null> {
  if (!available()) return null;
  const id = await invoke<unknown>("take_opened_file");
  return typeof id === "string" && uuid.test(id) ? id : null;
}

/** The title, author and language of a book opened from a folder in this run. */
export async function getOpenedFile(id: string): Promise<OpenedBook | null> {
  if (!available() || !uuid.test(id)) return null;
  const book = await invoke<OpenedBook | null>("get_opened_file", { id });
  return book && book.id === id ? book : null;
}

/** Calls `open` with each book opened from a folder while Komori runs. */
export function onOpenedFile(open: (id: string) => void): () => void {
  if (!available()) return () => {};
  let active = true;
  const stop = listen("komori-open-file", () => {
    void takeOpenedFile()
      .then((id) => {
        if (active && id) open(id);
      })
      .catch(() => {});
  });
  void stop.catch(() => {});
  return () => {
    active = false;
    void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}
