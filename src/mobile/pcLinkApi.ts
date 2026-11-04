import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import type { LibraryBook } from "../features/library/libraryApi";
import type { MessageKey } from "../i18n/i18n";

/** The phone's pairing with Komori PC, as native code keeps it. */
export interface PcLink {
  address: string;
  port: number;
  paired: boolean;
  pcName: string | null;
  syncOn: boolean;
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
export const unpairPc = () => invoke<PcLink>("unpair_pc").then(changed);
export const checkPc = () => invoke<PcStatus>("check_pc");
export const listPcLibrary = () => invoke<PcBook[]>("list_pc_library");
/** Downloads the book unless it is here, and returns its catalog ID on this phone. */
export const openPcBook = (book: PcBook) =>
  invoke<string>("open_pc_book", { id: book.id, fileName: book.fileName });
export const keepPcBook = (book: PcBook) =>
  invoke<string>("keep_pc_book", { id: book.id, fileName: book.fileName });
export const removePcBook = (book: PcBook) => invoke<void>("remove_pc_book", { id: book.id });
export const listPcDictionaries = () => invoke<PcDictionary[]>("list_pc_dictionaries");
export const copyPcDictionary = (id: number) =>
  invoke<"imported" | "alreadyImported">("copy_pc_dictionary", { id });

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
  };
}

/** The pairing as saved, kept current when it changes; null until read. */
export function usePcLink(): PcLink | null {
  const [link, setLink] = useState<PcLink | null>(null);
  useEffect(() => {
    let active = true;
    const read = () =>
      void getPcLink().then(
        (saved) => {
          if (active) setLink(saved);
        },
        () => {},
      );
    read();
    window.addEventListener(pcLinkChanged, read);
    return () => {
      active = false;
      window.removeEventListener(pcLinkChanged, read);
    };
  }, []);
  return link;
}
