import { i18n } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { normalizeBookmarkLocator } from "./bookmarks";
import type { ReaderBookmarkLocator } from "./renderer";

export const noteTextLimit = 4096;
export interface NotePassage {
  locator: ReaderBookmarkLocator;
  passage: string;
}
export interface ReaderNote extends NotePassage {
  id: string;
  body: string;
}
export interface NoteStore {
  load(): Promise<ReaderNote[]>;
  create(place: NotePassage, body: string): Promise<ReaderNote>;
  edit(id: string, body: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export type NoteOrder = "creation" | "reading";

/** The store lists oldest creations first (native creation time, then UUID). */
export function visibleNotes(items: readonly ReaderNote[], query: string, order: NoteOrder) {
  const needle = query.trim().toLowerCase();
  const results = items.filter(
    (note) =>
      note.body.toLowerCase().includes(needle) || note.passage.toLowerCase().includes(needle),
  );
  if (order === "reading")
    results.sort(
      (a, b) =>
        a.locator.spineIndex - b.locator.spineIndex ||
        a.locator.progress - b.locator.progress ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return results;
}
export function noteTextValid(text: string): boolean {
  return (
    !!text &&
    text.trim() === text &&
    [...text].length <= noteTextLimit &&
    !/[\p{Cc}]/u.test(text.replace(/[\n\t]/g, ""))
  );
}
/** A note's own text; empty for a highlight, which marks the passage without a note. */
export const noteBodyValid = (body: string) => body === "" || noteTextValid(body);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function normalizeNote(value: unknown): ReaderNote | null {
  if (!value || typeof value !== "object") return null;
  const { id, locator: raw, passage, body } = value as Record<string, unknown>;
  const locator = normalizeBookmarkLocator(raw);
  if (
    typeof id !== "string" ||
    !uuid.test(id) ||
    !locator ||
    typeof passage !== "string" ||
    !noteTextValid(passage) ||
    typeof body !== "string" ||
    !noteBodyValid(body)
  )
    return null;
  return { id, locator, passage, body };
}
export function noteStore(catalogId: string): NoteStore {
  async function request(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!isTauri()) throw Error(i18n().t("notes.desktopOnly"));
    try {
      return await invoke(command, { id: catalogId, ...args });
    } catch {
      throw Error(i18n().t("notes.saveFailed"));
    }
  }
  return {
    async load() {
      const values = await request("list_reader_notes");
      if (!Array.isArray(values) || values.length > 1000)
        throw Error(i18n().t("notes.loadFailedShort"));
      return values.map(normalizeNote).filter((item): item is ReaderNote => item !== null);
    },
    async create(place, body) {
      const locator = normalizeBookmarkLocator(place.locator);
      if (!locator || !noteTextValid(place.passage) || !noteBodyValid(body))
        throw Error(i18n().t("notes.invalidPassage"));
      const result = (await request("create_reader_note", {
        locator,
        passage: place.passage,
        body,
      })) as { status?: string; note?: unknown } | null;
      const note = normalizeNote(result?.note);
      if (result?.status === "created" && note) return note;
      throw Error(
        result?.status === "limit"
          ? i18n().t("notes.limit")
          : result?.status === "unknown"
            ? i18n().t("library.notInLibrary")
            : i18n().t("notes.saveOneFailed"),
      );
    },
    async edit(noteId, body) {
      if (!uuid.test(noteId) || !noteBodyValid(body)) throw Error(i18n().t("notes.invalidBody"));
      if ((await request("edit_reader_note", { noteId, body })) !== true)
        throw Error(i18n().t("notes.gone"));
    },
    async remove(noteId) {
      if (!uuid.test(noteId) || (await request("remove_reader_note", { noteId })) !== true)
        throw Error(i18n().t("notes.gone"));
    },
  };
}
