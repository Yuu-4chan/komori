import { i18n } from "../../i18n/i18n";
import type { SourcePolicy } from "./sourcePolicy";
import { dictionariesChanged } from "./sourcePolicy";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { runBulkOperation, type RemovalBatch } from "../operations/bulkOperation";

export interface DictionarySummary {
  id: number;
  title: string;
  revision: string;
  /** Legacy flag, always true after migration; popup roles govern source choices. */
  enabled: boolean;
  termCount: number;
  termMetaCount: number;
  kanjiCount: number;
  kanjiMetaCount: number;
  /** Imported definitions, forms or tags; empty term-bank placeholders do not qualify. */
  hasDefinitions: boolean;
  hasFrequency: boolean;
  hasPitch: boolean;
}

export interface DictionaryImportResult {
  /** The archive's file name only, never its path. */
  fileName: string;
  status: "imported" | "alreadyImported" | "invalid" | "unreadable" | "failed";
  /** The dictionary's title once its index was read. */
  title: string | null;
}

export interface DictionaryImportBatch {
  canceled: boolean;
  results: DictionaryImportResult[];
}

/** `notFound`: no dictionary has that ID any more. `failed`: nothing was removed. */
export type DictionaryRemovalStatus = "removed" | "notFound" | "failed";

/** One requested ID's outcome in a bulk removal. */
export interface DictionaryRemovalResult {
  id: number;
  status: DictionaryRemovalStatus;
}

/** `notFound`: no dictionary has that ID any more. `failed`: the order is unchanged. */
export type DictionaryMoveStatus = "moved" | "notFound" | "failed";

export interface TermMatch {
  dictionaryId: number;
  dictionaryTitle: string;
  definitionTags: string;
  rules: string;
  score: number;
  sequence: number;
  termTags: string;
  /** Each name in `definitionTags`, then `termTags`, once, with its own dictionary's definition. */
  tags: TermTag[];
  glossary: unknown;
}

/**
 * A tag name (of a term, a kanji, or a kanji stat); the other fields are present only when its
 * dictionary imported a definition.
 */
export interface TermTag {
  name: string;
  category?: string;
  order?: number;
  notes?: string;
  score?: number;
}

export interface FrequencyMatch {
  dictionaryId: number;
  dictionaryTitle: string;
  data: unknown;
  /** The source's declared `frequencyMode`, when it has one. */
  frequencyMode?: string;
}

export interface PitchMatch {
  dictionaryId: number;
  dictionaryTitle: string;
  data: unknown;
}

export interface TermGroup {
  expression: string;
  reading: string;
  /** The start of the query the group matched, exactly or as an inflection. */
  text: string;
  /** Set when the group was reached as an inflection of the matched text. */
  deinflection: Deinflection | null;
  terms: TermMatch[];
  frequencies: FrequencyMatch[];
  pitches: PitchMatch[];
}

/**
 * The groups for a query, or for its longest start that an enabled dictionary matches, exactly or
 * as inflected forms: the exact groups first, then each dictionary form's groups. Unless the whole
 * query matched exactly, each shorter matching start's groups follow, longest start first. `text`
 * is the text the first groups match: the trimmed query, or that start; with no groups, the
 * trimmed query.
 */
export interface TermLookup {
  text: string;
  groups: TermGroup[];
}

/** The dictionary form an inflected text was looked up as. */
export interface Deinflection {
  form: string;
  /** The inflections applied, from the dictionary form outward (読みました: polite, past). */
  inflections: string[];
}

/** One imported kanji row. `tags` and `stats` are the original values. */
export interface KanjiMatch {
  dictionaryId: number;
  dictionaryTitle: string;
  character: string;
  onyomi: string;
  kunyomi: string;
  tags: string;
  meanings: string[];
  stats: unknown;
  /** Each name in `tags` once, with its own dictionary's definition. */
  resolvedTags: TermTag[];
  /** Each stat name in `stats`, with its own dictionary's definition. */
  statTags: TermTag[];
}

/** A kanji's rows and kanji frequency rows, in the reader's dictionary order. */
export interface KanjiLookup {
  entries: KanjiMatch[];
  frequencies: FrequencyMatch[];
}

async function mutate<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await invoke<T>(command, args);
  window.dispatchEvent(new Event(dictionariesChanged));
  return result;
}

function requireDesktop() {
  if (!isTauri()) {
    throw new Error(i18n().t("dictionary.desktopOnly"));
  }
}

export async function listDictionaries(): Promise<DictionarySummary[]> {
  requireDesktop();
  return invoke<DictionarySummary[]>("list_dictionaries");
}

/** Opens the native picker and imports each chosen dictionary archive. */
export async function importDictionaries(): Promise<DictionaryImportBatch> {
  requireDesktop();
  const result = await runBulkOperation<DictionaryImportBatch>(
    "dictionaries",
    "import_dictionaries",
  );
  window.dispatchEvent(new Event(dictionariesChanged));
  return result;
}

/** Removes one imported dictionary and all its rows; its archive is never touched. */
export async function removeDictionary(id: number): Promise<DictionaryRemovalStatus> {
  requireDesktop();
  const result = await runBulkOperation<RemovalBatch<DictionaryRemovalStatus>>(
    "dictionaries",
    "remove_dictionary",
    { id },
  );
  window.dispatchEvent(new Event(dictionariesChanged));
  return result.results;
}

/**
 * Removes several imported dictionaries, each on its own, so a failure keeps the other removals.
 * Returns one result per requested ID in request order; their archives are never touched.
 */
export async function removeDictionaries(ids: number[]): Promise<DictionaryRemovalResult[]> {
  requireDesktop();
  const result = await runBulkOperation<RemovalBatch<DictionaryRemovalResult[]>>(
    "dictionaries",
    "remove_dictionaries",
    { ids },
  );
  window.dispatchEvent(new Event(dictionariesChanged));
  return result.results;
}

/**
 * Moves one imported dictionary to `position` (zero-based; past the end means last) in the order
 * that the list and lookups follow.
 */
export async function moveDictionary(id: number, position: number): Promise<DictionaryMoveStatus> {
  requireDesktop();
  return mutate<DictionaryMoveStatus>("move_dictionary", { id, position });
}

/** The dictionary store's size on disk in bytes. */
export async function getDictionaryStoreSize(): Promise<number> {
  requireDesktop();
  return invoke<number>("get_dictionary_store_size");
}

/**
 * Exact expression or reading lookup of the query, or else of its longest matching start; the
 * native command also enforces the query bound.
 */
export async function lookupTerms(
  query: string,
  sources?: SourcePolicy,
  maxResults?: number,
): Promise<TermLookup> {
  requireDesktop();
  return invoke<TermLookup>("lookup_terms", {
    query,
    ...(sources ? { sources } : {}),
    ...(maxResults === undefined ? {} : { maxResults }),
  });
}

/**
 * Exact lookup of one kanji in the kanji dictionaries; any other query matches nothing. The
 * native command also enforces the query bound.
 */
export async function lookupKanji(query: string, sources?: SourcePolicy): Promise<KanjiLookup> {
  requireDesktop();
  return invoke<KanjiLookup>("lookup_kanji", sources ? { query, sources } : { query });
}

/** Opens a dictionary's http(s) link in the default browser; native code checks the address. */
export async function openExternalLink(url: string): Promise<void> {
  requireDesktop();
  await invoke<void>("open_external_link", { url });
}
