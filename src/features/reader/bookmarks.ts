import { i18n } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";

import { normalizeReaderLocator } from "./readingPosition";
import type { ReaderBookmarkLocator, ReaderBookmarkPlace } from "./renderer";

export interface ReaderBookmark extends ReaderBookmarkPlace {
  id: string;
  label: string;
}

export interface BookmarkStore {
  load(): Promise<ReaderBookmark[]>;
  create(
    place: ReaderBookmarkPlace,
    label: string,
  ): Promise<{ duplicate: boolean; bookmark: ReaderBookmark }>;
  rename(id: string, label: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function normalizeBookmarkLocator(value: unknown): ReaderBookmarkLocator | null {
  const locator = normalizeReaderLocator(value);
  const contentKey = (value as Record<string, unknown> | null)?.contentKey;
  if (!locator?.sectionKey || typeof contentKey !== "string" || !/^[\da-f]{64}$/.test(contentKey))
    return null;
  return { ...locator, sectionKey: locator.sectionKey, contentKey };
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function bookmarkTextValid(text: string, max: number): boolean {
  return [...text].length <= max && text.trim() === text && !/\p{Cc}/u.test(text);
}

export function normalizeBookmark(value: unknown): ReaderBookmark | null {
  if (!value || typeof value !== "object") return null;
  const { id, locator: raw, label, excerpt } = value as Record<string, unknown>;
  const locator = normalizeBookmarkLocator(raw);
  if (
    typeof id !== "string" ||
    !uuid.test(id) ||
    !locator ||
    typeof label !== "string" ||
    !bookmarkTextValid(label, 80) ||
    typeof excerpt !== "string" ||
    !bookmarkTextValid(excerpt, 160)
  )
    return null;
  return { id, locator, label, excerpt };
}

/** Every request is bound to this catalog ID. Native error details never reach the UI. */
export function bookmarkStore(catalogId: string): BookmarkStore {
  async function request(command: string, args?: Record<string, unknown>) {
    if (!isTauri()) throw Error(i18n().t("bookmarks.desktopOnly"));
    try {
      return await invoke<unknown>(command, { id: catalogId, ...args });
    } catch {
      throw Error(i18n().t("bookmarks.saveFailed"));
    }
  }
  return {
    async load() {
      const value = await request("list_bookmarks");
      if (!Array.isArray(value) || value.length > 1000)
        throw Error(i18n().t("bookmarks.loadFailedShort"));
      return value
        .map(normalizeBookmark)
        .filter((bookmark): bookmark is ReaderBookmark => bookmark !== null);
    },
    async create(place, label) {
      const locator = normalizeBookmarkLocator(place.locator);
      if (!locator || !bookmarkTextValid(label, 80) || !bookmarkTextValid(place.excerpt, 160))
        throw Error(i18n().t("bookmarks.invalid"));
      const value = (await request("create_bookmark", {
        locator,
        label,
        excerpt: place.excerpt,
      })) as { status?: string; bookmark?: unknown } | null;
      const bookmark = normalizeBookmark(value?.bookmark);
      if (bookmark && (value?.status === "created" || value?.status === "duplicate"))
        return { bookmark, duplicate: value.status === "duplicate" };
      throw Error(
        value?.status === "limit"
          ? i18n().t("bookmarks.limit")
          : i18n().t("bookmarks.saveOneFailed"),
      );
    },
    async rename(bookmarkId, label) {
      if (!uuid.test(bookmarkId) || !bookmarkTextValid(label, 80))
        throw Error(i18n().t("bookmarks.labelTooLong"));
      if ((await request("rename_bookmark", { bookmarkId, label })) !== true)
        throw Error(i18n().t("bookmarks.gone"));
    },
    async remove(bookmarkId) {
      if (!uuid.test(bookmarkId) || (await request("remove_bookmark", { bookmarkId })) !== true)
        throw Error(i18n().t("bookmarks.gone"));
    },
  };
}
