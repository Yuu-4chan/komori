import { i18n } from "../../i18n/i18n";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { bulkOperationActive, useBulkOperation, operationLabel } from "../operations/bulkOperation";

import {
  importBooks,
  importDroppedBooks,
  scanLibraryFolders,
  type ImportBatch,
} from "./libraryApi";

export interface LibraryImport {
  importing: boolean;
  busy: boolean;
  label: string;
  /** The last finished import's per-file results, until another import starts. */
  result: ImportBatch | null;
  error: string | null;
  /** Counts finished imports that added to the catalog, so the Library lists it again. */
  version: number;
  /** Opens the native EPUB picker and imports the chosen books. */
  run: () => Promise<void>;
  drop: (dropId: string) => Promise<void>;
  failDrop: () => void;
  /**
   * Imports the new EPUBs in the book folders; calls made while one runs share it. Its results
   * show only when it added books or some failed.
   */
  scanFolders: () => Promise<void>;
  /**
   * Marks the result and error as shown; the returned function ends that showing. Once nothing
   * shows them any more (the Library was left), they are cleared, so they never return later.
   */
  view: () => () => void;
  /** Closes the shown result and error until the next import. */
  dismiss: () => void;
}

/**
 * One import at a time for the whole shell: the top bar's Add books button and the Library's
 * own actions share it, and the Library shows its results.
 */
export function useLibraryImportController(): LibraryImport {
  const operation = useBulkOperation("library");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // A folder action's result is the operation's own; closing it remembers which one was closed.
  const [dismissedOperation, setDismissedOperation] = useState<string | null>(null);
  const running = useRef(false);
  const viewers = useRef(0);
  const view = useCallback(() => {
    viewers.current++;
    return () => {
      viewers.current--;
      // Waits a task, so a notice that is only remounted (React's development check) keeps it.
      setTimeout(() => {
        if (viewers.current > 0) return;
        setResult(null);
        setError(null);
      }, 0);
    };
  }, []);

  const performImport = useCallback(async (dropId?: string) => {
    if (running.current || bulkOperationActive("library")) return;
    running.current = true;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const batch = await (dropId ? importDroppedBooks(dropId) : importBooks());
      if (!batch.canceled) {
        setResult(batch);
        setVersion((value) => value + 1);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      running.current = false;
      setImporting(false);
    }
  }, []);
  const run = useCallback(() => performImport(), [performImport]);
  const drop = useCallback((dropId: string) => performImport(dropId), [performImport]);

  const scanning = useRef<Promise<void> | null>(null);
  const scanFolders = useCallback(() => {
    if (running.current || bulkOperationActive("library")) return Promise.resolve();
    scanning.current ??= (async () => {
      try {
        const results = await scanLibraryFolders();
        if (results.some((item) => item.status !== "alreadyImported")) {
          setResult({ canceled: false, results });
        }
        if (results.some((item) => item.status === "imported")) setVersion((value) => value + 1);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        scanning.current = null;
      }
    })();
    return scanning.current;
  }, []);

  const importingCommand =
    operation &&
    ["import_books", "import_dropped_books", "scan_library_folders", "add_library_folder"].includes(
      operation.command,
    );
  const trackedResult =
    importingCommand && !operation.active && operation.operationId !== dismissedOperation
      ? operation.result
      : null;
  const batch = Array.isArray(trackedResult)
    ? { canceled: false, results: trackedResult }
    : (trackedResult as ImportBatch | null);
  // A folder action can finish while this controller is on another route (or unmounted).
  useEffect(() => {
    if (operation && !operation.active && operation.result) setVersion((value) => value + 1);
  }, [operation?.active, operation?.operationId, operation?.result]);
  return {
    importing: importing || Boolean(importingCommand && operation.active),
    busy: importing || Boolean(operation?.active),
    label: operation?.active ? operationLabel(operation) : i18n().t("folders.adding"),
    result: batch ?? result,
    error,
    version,
    run,
    drop,
    failDrop: () => setError(i18n().t("library.dropFailed")),
    scanFolders,
    view,
    dismiss: () => {
      setResult(null);
      setError(null);
      if (operation) setDismissedOperation(operation.operationId);
    },
  };
}

export const LibraryImportContext = createContext<LibraryImport | null>(null);

/** The shell's shared import, or this page's own outside the shell (as in tests). */
export function useLibraryImport(): LibraryImport {
  const shared = useContext(LibraryImportContext);
  const local = useLibraryImportController();
  return shared ?? local;
}
