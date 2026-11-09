import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import type { LibraryBook, LibraryBookProgress } from "../features/library/libraryApi";
import type { ReaderLocator } from "../features/reader/renderer";
import type { MessageKey } from "../i18n/i18n";
import { pcSession } from "./pcLibrarySession";

/** The phone's pairing with Komori PC, as native code keeps it. */
export interface PcLink {
  address: string;
  port: number;
  paired: boolean;
  pcName: string | null;
  syncOn: boolean;
  /** When the phone last synced its reading with the PC. */
  lastSynced: string | null;
}

/** What one sync did on the phone. */
export interface PcSync extends PcLink {
  /** Whether the phone's books changed. */
  changed: boolean;
  /** Whether the phone sent the PC anything, so the PC's Library lists differently now. */
  sent: boolean;
  /** The phone's books whose place the PC's moved. */
  moved: string[];
}

/** A book's place, as each side last saved it. */
export interface PcReading {
  position: ReaderLocator | null;
  progress: LibraryBookProgress | null;
}

/** A book read apart on the PC and here since they last synced. */
export interface PcConflict {
  pc: PcReading;
  pcAt: string | null;
  phone: PcReading;
  phoneAt: string | null;
}

/** Why the PC did not answer, or `connected`. */
export type PcProblem = "unreachable" | "notThePc" | "notPaired" | "otherVersion" | "notFound";

export interface PcStatus {
  status: "connected" | PcProblem | string;
  name: string | null;
}

/** A book in the PC's Library, with its copy on this phone. */
export interface PcBook {
  id: string;
  title: string | null;
  author: string | null;
  fileName: string;
  size: number;
  cover: number | null;
  coverUrl: string | null;
  progress: LibraryBook["progress"];
  lastReadAt: string | null;
  series: string | null;
  seriesIndex: number | null;
  language: string | null;
  /** Its characters and words, when the PC sends them. */
  characters?: number | null;
  words?: number | null;
  /** The copy's catalog ID on this phone, once it was opened here. */
  localId: string | null;
  /** Whether the copy's file is on this phone now. */
  onPhone: boolean;
  /** Whether it is kept on this phone, not only cached. */
  kept: boolean;
}

export interface PcDictionary {
  id: number;
  title: string;
  revision: string;
  termCount: number;
  termMetaCount: number;
  kanjiCount: number;
  kanjiMetaCount: number;
  hasDefinitions: boolean;
  hasFrequency: boolean;
  hasPitch: boolean;
  size?: number | null;
  onPhone: boolean;
}

/** A download from the PC under way. */
export interface PcTransfer {
  kind: "book" | "dictionary";
  id: string;
  received: number;
  total: number;
}

/** Sent on the window when the pairing or Sync with PC changes. */
export const pcLinkChanged = "komori:pc-link-changed";
/** Sent on the window after each sync, with what it did as its detail. */
export const pcSynced = "komori:pc-synced";

const changed = <T>(value: T) => {
  window.dispatchEvent(new Event(pcLinkChanged));
  return value;
};

export const getPcLink = () => invoke<PcLink>("get_pc_link");
export const pairPc = (address: string, port: number, code: string) =>
  invoke<PcLink>("pair_pc", { address, port, code }).then(changed);
export const setPcAddress = (address: string, port: number) =>
  invoke<PcLink>("set_pc_address", { address, port }).then(changed);
export const setPcSync = (on: boolean) => invoke<PcLink>("set_pc_sync", { on }).then(changed);
export const unpairPc = () =>
  invoke<PcLink>("unpair_pc").then((link) => {
    pcSession.reset();
    return changed(link);
  });
export const checkPc = () => invoke<PcStatus>("check_pc");
/** Lists the PC's Library, which the phone saves, and fetches its new covers behind it. */
export const listPcLibrary = () => invoke<PcBook[]>("list_pc_library");
/** The PC's Library as last listed, from the phone alone; null before the first listing. */
export const cachedPcLibrary = () => invoke<PcBook[] | null>("cached_pc_library");

/** What the PC's books take on this phone, in bytes. */
export interface PcStorage {
  kept: number;
  cached: number;
  covers: number;
}
export const pcStorage = () => invoke<PcStorage>("pc_storage");
/** Removes the PC's covers here; they download again when shown. */
export const clearPcCovers = () => invoke<PcStorage>("clear_pc_covers");
/** Downloads the book unless it is here, and returns its catalog ID on this phone. */
export const openPcBook = (book: PcBook) =>
  invoke<string>("open_pc_book", { id: book.id, fileName: book.fileName });
export const keepPcBook = (book: PcBook) =>
  invoke<string>("keep_pc_book", { id: book.id, fileName: book.fileName });
export const removePcBook = (book: PcBook) => invoke<void>("remove_pc_book", { id: book.id });
export const listPcDictionaries = () => invoke<PcDictionary[]>("list_pc_dictionaries");
export const copyPcDictionary = (id: number) =>
  invoke<"imported" | "alreadyImported">("copy_pc_dictionary", { id });

/** Whether a sync changed what listing the PC shows: it sent, took or moved something. */
export const changesPcListing = (sync: PcSync) =>
  sync.sent || sync.changed || sync.moved.length > 0;

/** Syncs places, bookmarks, notes and reading sessions with the PC. */
export async function syncPc(): Promise<PcSync> {
  const result = await invoke<PcSync>("sync_pc");
  if (changesPcListing(result)) pcSession.markStale();
  window.dispatchEvent(new Event(pcLinkChanged));
  window.dispatchEvent(new CustomEvent<PcSync>(pcSynced, { detail: result }));
  return result;
}

/**
 * Syncs when the phone is paired and Sync with PC is on, as on starting, returning, pulling
 * the Library down and leaving the Reader; a PC that does not answer is tried the next time.
 */
export async function autoSync(): Promise<PcSync | null> {
  try {
    const link = await getPcLink();
    if (!link.paired || !link.syncOn) return null;
    return await syncPc();
  } catch {
    return null;
  }
}

/** Calls back after each sync with what it did. */
export function onPcSynced(handler: (result: PcSync) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<PcSync>).detail);
  window.addEventListener(pcSynced, listener);
  return () => window.removeEventListener(pcSynced, listener);
}

export const getPcConflict = (id: string) => invoke<PcConflict | null>("get_pc_conflict", { id });
/** Continues the book from the PC's place or this phone's. */
export const resolvePcConflict = (id: string, keep: "pc" | "phone") =>
  invoke<boolean>("resolve_pc_conflict", { id, keep });

export const onPcTransfer = (handler: (transfer: PcTransfer) => void) =>
  listen<PcTransfer>("pc-transfer", ({ payload }) => handler(payload));

export const transferPercent = ({ received, total }: PcTransfer) =>
  total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;

const problems: Record<PcProblem, MessageKey> = {
  unreachable: "sync.error.unreachable",
  notThePc: "sync.error.notThePc",
  notPaired: "sync.error.notPaired",
  otherVersion: "sync.error.otherVersion",
  notFound: "sync.error.notFound",
};

/** The message for a failed request to the PC. */
export function pcErrorKey(error: unknown): MessageKey {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "wrongCode") return "sync.error.wrongCode";
  if (code === "pairingLocked") return "sync.error.pairingLocked";
  return problems[code as PcProblem] ?? "sync.error.failed";
}

/** A PC book in the shape the Library's covers and progress read. */
export function asLibraryBook(book: PcBook): LibraryBook {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    fileName: book.fileName,
    importedAt: "",
    availability: "available",
    hasCover: book.cover !== null,
    coverUrl: book.coverUrl,
    progress: book.progress,
    lastReadAt: book.lastReadAt,
    language: book.language,
    series: book.series,
    seriesIndex: book.seriesIndex,
    characters: book.characters ?? null,
    words: book.words ?? null,
  };
}

let lastLink: PcLink | null = null;

/** The pairing as saved, kept current when it changes; null until first read. */
export function usePcLink(): PcLink | null {
  return usePcLinkState().link;
}

/** The pairing as `usePcLink` gives it, and whether reading it has ended, even in failure. */
export function usePcLinkState(): { link: PcLink | null; settled: boolean } {
  // The pairing read last this session, so a page shown again starts from it.
  const [link, setLink] = useState<PcLink | null>(lastLink);
  const [settled, setSettled] = useState(lastLink !== null);
  useEffect(() => {
    let active = true;
    const read = () =>
      void getPcLink().then(
        (saved) => {
          lastLink = saved;
          if (active) {
            setLink(saved);
            setSettled(true);
          }
        },
        () => {
          if (active) setSettled(true);
        },
      );
    read();
    window.addEventListener(pcLinkChanged, read);
    return () => {
      active = false;
      window.removeEventListener(pcLinkChanged, read);
    };
  }, []);
  return { link, settled };
}
