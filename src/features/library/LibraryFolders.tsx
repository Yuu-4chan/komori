import {
  ArrowClockwiseIcon,
  FolderPlusIcon,
  SquaresFourIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { useBulkOperation, operationLabel } from "../operations/bulkOperation";
import { OperationNotice } from "../operations/OperationNotice";
import { failureText } from "../../i18n/failure";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  addLibraryFolder,
  listLibraryFolders,
  removeLibraryFolder,
  scanLibraryFolders,
  type ImportResult,
  type AddFolderResult,
  type LibraryFolder,
} from "./libraryApi";

const availability: Record<LibraryFolder["availability"], MessageKey | null> = {
  available: null,
  missing: "folders.missing",
  unreadable: "folders.unreadable",
};

interface Outcome {
  kind: "status" | "error";
  /** Written when shown, so it follows the interface language. */
  text: () => string;
  failures?: ImportResult[];
}

/** What one scan found: the books it added and the files it could not import. */
function scanOutcome(results: ImportResult[], nothing: MessageKey): Outcome {
  const imported = results.filter((item) => item.status === "imported").length;
  const failures = results.filter((item) => item.status === "failed");
  if (imported === 0 && failures.length === 0)
    return { kind: "status", text: () => i18n().t(nothing) };
  return {
    kind: failures.length > 0 ? "error" : "status",
    text: () => {
      const { tp } = i18n();
      const parts = [tp("folders.booksAdded", imported)];
      if (failures.length > 0) parts.push(tp("folders.importFailures", failures.length));
      return parts.join(" · ");
    },
    failures,
  };
}

const errorOutcome = (text: string): Outcome => ({
  kind: "error",
  text: () => failureText(text, i18n().t),
});

/**
 * Settings > Library: the folders whose new EPUBs Komori imports when it starts and whenever
 * the Library opens. Removing a folder keeps its books.
 */
export function LibraryFolders({ children }: { children?: ReactNode }) {
  const operation = useBulkOperation("library");
  const { t, tp } = useI18n();
  const [folders, setFolders] = useState<LibraryFolder[] | null>(null);
  const [busy, setBusy] = useState<"add" | "scan" | number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const loadSequence = useRef(0);
  useEffect(
    () => () => {
      loadSequence.current += 1;
    },
    [],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const folders = await listLibraryFolders();
      if (sequence === loadSequence.current) setFolders(folders);
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setFolders([]);
      setOutcome(errorOutcome(message(caught)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, operation?.active]);

  async function act(kind: "add" | "scan" | number, task: () => Promise<Outcome | null>) {
    if (busy !== null || operation?.active) return;
    setBusy(kind);
    setOutcome(null);
    try {
      setOutcome(await task());
      await load();
    } catch (caught) {
      setOutcome(errorOutcome(message(caught)));
    } finally {
      setBusy(null);
    }
  }

  const add = () =>
    act("add", async () => {
      const result = await addLibraryFolder();
      if (result.status === "canceled") return null;
      if (result.status !== "added") {
        return result.message
          ? errorOutcome(result.message)
          : { kind: "error", text: () => i18n().t("folders.addFailed") };
      }
      return scanOutcome(result.results, "folders.addedEmpty");
    });
  const scan = () =>
    act("scan", async () => scanOutcome(await scanLibraryFolders(), "folders.noNewBooks"));
  const remove = (folder: LibraryFolder) =>
    act(folder.id, async () => {
      await removeLibraryFolder(folder.id);
      return {
        kind: "status",
        text: () => i18n().t("folders.removed", { path: folder.path }),
      };
    });

  const tracked = !operation?.active ? operation?.result : undefined;
  const trackedOutcome: Outcome | null =
    operation?.command === "scan_library_folders" && Array.isArray(tracked)
      ? scanOutcome(tracked, "folders.noNewBooks")
      : operation?.command === "add_library_folder" && tracked
        ? (tracked as AddFolderResult).status === "added"
          ? scanOutcome((tracked as AddFolderResult).results, "folders.addedEmpty")
          : errorOutcome((tracked as AddFolderResult).message ?? t("folders.addFailed"))
        : null;
  const shownOutcome = outcome ?? trackedOutcome;

  return (
    <Card className="settings-card settings-card--wide" aria-labelledby="library-settings-title">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <SquaresFourIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2 id="library-settings-title">{t("folders.cardTitle")}</h2>
          <p>{t("folders.cardDescription")}</p>
        </div>
      </div>
      <div className="settings-list">
        {children}
        <div className="settings-row">
          <div>
            <strong id="library-folders-title">{t("folders.title")}</strong>
            <span>{t("folders.description")}</span>
          </div>
          <div className="library-folders__actions">
            <Button
              disabled={busy !== null || Boolean(operation?.active)}
              icon={<FolderPlusIcon aria-hidden="true" weight="bold" />}
              onClick={() => void add()}
              tone="secondary"
            >
              {operation?.active && operation.command === "add_library_folder"
                ? operationLabel(operation)
                : busy === "add"
                  ? t("folders.adding")
                  : t("folders.add")}
            </Button>
            {folders && folders.length > 0 ? (
              <Button
                disabled={busy !== null || Boolean(operation?.active)}
                icon={<ArrowClockwiseIcon aria-hidden="true" weight="bold" />}
                onClick={() => void scan()}
                tone="secondary"
              >
                {operation?.active && operation.command === "scan_library_folders"
                  ? operationLabel(operation)
                  : busy === "scan"
                    ? t("folders.checking")
                    : t("folders.check")}
              </Button>
            ) : null}
          </div>
        </div>
        {folders && folders.length > 0 ? (
          <ul className="settings-rows library-folders" aria-labelledby="library-folders-title">
            {folders.map((folder) => (
              <li key={folder.id}>
                <div>
                  <strong title={folder.path}>{folder.path}</strong>
                  <span>
                    {tp("folders.booksInLibrary", folder.books)}
                    {availability[folder.availability]
                      ? ` · ${t(availability[folder.availability]!)}`
                      : ""}
                  </span>
                </div>
                <Button
                  aria-label={t("folders.removeFolder", { path: folder.path })}
                  disabled={busy !== null || Boolean(operation?.active)}
                  icon={<TrashIcon aria-hidden="true" weight="bold" />}
                  onClick={() => void remove(folder)}
                  tone="quiet"
                >
                  {t("common.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : folders ? (
          <p className="settings-rows__empty">{t("folders.empty")}</p>
        ) : null}
      </div>
      <OperationNotice operation={operation} />
      {shownOutcome ? (
        <div
          className={`library-notice${shownOutcome.kind === "error" ? " library-notice--error" : ""}`}
          role={shownOutcome.kind === "error" ? "alert" : "status"}
        >
          {shownOutcome.kind === "error" ? <WarningCircleIcon aria-hidden="true" /> : null}
          <div>
            <strong>{shownOutcome.text()}</strong>
            {shownOutcome.failures && shownOutcome.failures.length > 0 ? (
              <ul>
                {shownOutcome.failures.map((item, index) => (
                  <li key={`${item.fileName}-${index}`}>
                    <strong>{item.fileName}:</strong> {item.message && failureText(item.message, t)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
