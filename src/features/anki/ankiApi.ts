import { i18n } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GlossaryCardNode } from "../dictionary/GlossaryText";

export interface AnkiMapping {
  modelId?: number | null;
  fields: string[];
  templates: Record<string, string>;
  tags?: string[];
  tagDictionaries?: number[];
}
export interface AnkiPreferences {
  port: number;
  key: string;
  deckId?: number | null;
  deck: string;
  model: string;
  mappings: Record<string, AnkiMapping>;
  duplicatePolicy?: "prevent" | "overwrite" | "allow";
  duplicateScope?: "deck" | "collection";
  checkChildren?: boolean;
}
export interface AnkiDiscovery {
  deckIds: Record<string, number>;
  modelIds: Record<string, number>;
  decks: string[];
  models: string[];
  fields: string[];
  lapis: "missing" | "compatible" | "incompatible";
}
export type NoteOutcome =
  | { status: "created" | "updated"; id: number }
  | { status: "duplicate"; id?: number | null }
  | { status: "uncertain" | "failed" };
interface DefinitionContent {
  source: string;
  text: string;
  /** Legacy original glossary retained for interrupted request replay. */
  glossary?: unknown;
  presentation?: GlossaryCardNode[][];
}
export interface DictionaryTagSource {
  id: number;
  title: string;
  /** Frequency/tier labels; definition-only sources use their title. */
  values?: string[];
}
export type NoteStatus =
  | { status: "missing" }
  | { status: "existing"; id: number; count: number }
  | { status: "pending"; requestId: string };
export type FieldPart =
  | { type: "text"; text: string }
  | { type: "frequencies"; text: string }
  | { type: "sentence"; text: string; expression: string }
  | { type: "definitions"; entries: DefinitionContent[] }
  | { type: "cover" }
  /** The headword's recording, fetched by native code from the word audio sources. */
  | { type: "audio"; term: string; reading: string };
export interface CardContent {
  fieldParts: Record<string, FieldPart[]>;
  bookId?: string;
  dictionarySources?: DictionaryTagSource[];
  /** The headword's reading: a note with another reading is not a duplicate. */
  reading?: string;
}
export const defaultDuplicateScope = "collection" as const;
export const emptyAnki: AnkiPreferences = {
  port: 8765,
  key: "",
  deck: "",
  model: "",
  mappings: {},
  duplicateScope: defaultDuplicateScope,
};
export const ankiChanged = "komori-anki-changed";
export const ankiNoteChanged = "komori-anki-note-changed";
export function lowercaseAnkiTags(preferences: AnkiPreferences): AnkiPreferences {
  return {
    ...preferences,
    mappings: Object.fromEntries(
      Object.entries(preferences.mappings).map(([model, mapping]) => [
        model,
        {
          ...mapping,
          ...(mapping.tags
            ? { tags: [...new Set(mapping.tags.map((tag) => tag.toLowerCase()))] }
            : {}),
        },
      ]),
    ),
  };
}
async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw "unavailable";
  return invoke<T>(name, args);
}
export const loadAnki = async () =>
  lowercaseAnkiTags(await command<AnkiPreferences>("get_anki_preferences"));
// Every Anki action reads the same saved preferences; one read serves them until they change.
let savedPreferences: Promise<AnkiPreferences> | null = null;
export function cachedAnki(): Promise<AnkiPreferences> {
  savedPreferences ??= loadAnki().catch((error: unknown) => {
    savedPreferences = null;
    throw error;
  });
  return savedPreferences;
}
export async function saveAnki(preferences: AnkiPreferences) {
  await command<void>("save_anki_preferences", { preferences: lowercaseAnkiTags(preferences) });
  savedPreferences = null;
  statusCache.clear();
  window.dispatchEvent(new Event(ankiChanged));
}
export const discoverAnki = (preferences: AnkiPreferences) =>
  command<AnkiDiscovery>("discover_anki", { preferences });
export const createLapis = (preferences: AnkiPreferences) =>
  command<"created" | "existing" | "uncertain">("create_anki_lapis", { preferences });
export const createNote = (
  requestId: string,
  preferences: AnkiPreferences,
  fields: Record<string, string>,
  content?: CardContent,
) =>
  command<NoteOutcome>("create_anki_note", {
    request: { requestId, preferences, fields, ...content },
  });
export const browseNote = (id: number) => command<void>("browse_anki_note", { id });
function withCheckTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject("timeout"), 6000);
    work.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}
/**
 * Existence checks: every check asked for in the same moment (a popup's entries) goes to Anki as
 * one native batch, and answers are kept until a card or the configuration changes, or Komori
 * regains focus. Only each note's first field and reading are sent.
 */
interface StatusRequest {
  preferences: AnkiPreferences;
  first: FieldPart[];
  reading?: string;
  resolve: (status: NoteStatus) => void;
  reject: (error: unknown) => void;
}
const statusCache = new Map<string, Promise<NoteStatus>>();
let queued: StatusRequest[] = [];
const BATCH_LIMIT = 64;
function sendQueued() {
  const batch = queued;
  queued = [];
  const groups = new Map<string, StatusRequest[]>();
  for (const request of batch) {
    const key = JSON.stringify(request.preferences);
    groups.set(key, [...(groups.get(key) ?? []), request]);
  }
  for (const requests of groups.values())
    for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
      const chunk = requests.slice(start, start + BATCH_LIMIT);
      withCheckTimeout(
        command<NoteStatus[]>("get_anki_note_statuses", {
          batch: {
            preferences: chunk[0].preferences,
            notes: chunk.map(({ first, reading }) => ({
              first,
              ...(reading ? { reading } : {}),
            })),
          },
        }),
      ).then(
        (statuses) =>
          chunk.forEach((request, index) =>
            statuses[index] ? request.resolve(statuses[index]) : request.reject("protocol"),
          ),
        (error) => chunk.forEach((request) => request.reject(error)),
      );
    }
}
export function noteStatus(
  preferences: AnkiPreferences,
  first: FieldPart[],
  reading?: string,
): Promise<NoteStatus> {
  const key = JSON.stringify([preferences, first, reading ?? null]);
  const cached = statusCache.get(key);
  if (cached) return cached;
  const status = new Promise<NoteStatus>((resolve, reject) => {
    if (!queued.length) window.setTimeout(sendQueued, 0);
    queued.push({ preferences, first, reading, resolve, reject });
  });
  statusCache.set(key, status);
  // A failed check is asked again next time; a pending one is never cached as final.
  status.then(
    (result) => {
      if (result.status === "pending" && statusCache.get(key) === status) statusCache.delete(key);
    },
    () => {
      if (statusCache.get(key) === status) statusCache.delete(key);
    },
  );
  return status;
}
/** Forget answered checks; components keep showing theirs while asking again. */
export function forgetNoteStatuses() {
  statusCache.clear();
}
if (typeof window !== "undefined") {
  window.addEventListener(ankiNoteChanged, forgetNoteStatuses);
  window.addEventListener(ankiChanged, () => {
    savedPreferences = null;
    forgetNoteStatuses();
  });
  window.addEventListener("focus", forgetNoteStatuses);
}
export const checkNote = (requestId: string) =>
  command<NoteOutcome>("check_anki_note", { requestId });
export interface PendingRequest {
  requestId: string;
  model: string;
  expression: string;
}
export const pendingRequests = () => command<PendingRequest[]>("get_anki_pending_requests");
export function ankiError(error: unknown): string {
  const { t } = i18n();
  switch (error) {
    case "timeout":
      return t("ankiError.timeout");
    case "pending":
      return t("ankiError.pending");
    case "changed":
      return t("ankiError.changed");
    case "invalid":
      return t("ankiError.invalid");
    case "contentTooLarge":
      return t("ankiError.contentTooLarge");
    case "storage":
      return t("ankiError.storage");
    case "incompatible":
      return t("ankiError.incompatible");
    case "rejected":
      return t("ankiError.rejected");
    case "protocol":
      return t("ankiError.protocol");
    case "busy":
      return t("ankiError.busy");
    default:
      return t("ankiError.unreachable");
  }
}
