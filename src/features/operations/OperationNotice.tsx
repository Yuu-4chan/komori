import { useEffect } from "react";

import { XIcon } from "@phosphor-icons/react";

import type { BulkOperation, RemovalBatch } from "./bulkOperation";
import {
  dismissBulkOperation,
  libraryImportCommands,
  operationLabel,
  stopBulkOperation,
  viewBulkOperation,
} from "./bulkOperation";
import { IconButton } from "../../components/ui/IconButton";
import { NoticeClose, useNoticeTimeout } from "../../components/ui/NoticeClose";
import { useI18n } from "../../i18n/i18n";

/**
 * Shared progress and retained removal outcomes in the existing Library/Settings notice surface.
 * Nothing shows before there is progress to tell, as for the file picker of the system's own. A
 * finished outcome can be closed, and closes itself when all went well.
 */
export function OperationNotice({
  operation,
  items = [],
}: {
  operation: BulkOperation | null;
  items?: { id: string | number; title: string }[];
}) {
  const { t } = useI18n();
  // A finished outcome stays until the page showing it is left.
  useEffect(
    () => (operation && !operation.active ? viewBulkOperation(operation) : undefined),
    [operation],
  );
  const batch = operation?.result as RemovalBatch<unknown> | undefined;
  const maintenanceFailed = batch?.maintenance?.status === "failed";
  const error =
    (operation?.error && t("operation.failed")) ??
    (maintenanceFailed ? t("operation.reclaimFailed") : null);
  const results = batch?.results;
  const unsuccessful = Array.isArray(results)
    ? results.filter((item) => item.status !== "removed")
    : [];
  const failed = Array.isArray(results)
    ? results.filter((item) => item.status === "failed").length
    : results === "failed"
      ? 1
      : 0;
  const close = () => {
    if (operation) dismissBulkOperation(operation);
  };
  useNoticeTimeout(
    Boolean(
      operation &&
      !operation.active &&
      operation.command.startsWith("remove_") &&
      !error &&
      !failed &&
      unsuccessful.length === 0,
    ),
    close,
  );
  if (!operation) return null;
  if (operation.active) {
    if (operation.total === null && !operation.command.startsWith("compact_")) return null;
    return (
      <div className="library-notice operation-notice" role="status">
        <div>
          <strong>{operationLabel(operation)}</strong>
          {operation.total !== null && operation.total > 0 ? (
            <progress
              aria-label={t("operation.progress")}
              max={operation.total}
              value={operation.completed}
            />
          ) : null}
        </div>
        {libraryImportCommands.includes(operation.command) ? (
          <IconButton
            className="library-notice__close"
            compact
            disabled={operation.stopping}
            label={t("operation.stop")}
            onClick={() => stopBulkOperation(operation)}
            quiet
          >
            <XIcon aria-hidden="true" weight="bold" />
          </IconButton>
        ) : null}
      </div>
    );
  }
  if (error && !operation.command.startsWith("remove_"))
    return (
      <div className="library-notice library-notice--error" role="alert">
        <span>{error}</span>
        <NoticeClose onClose={close} />
      </div>
    );
  // A removal completed while another route was open still has its item outcomes here.
  if (operation.command.startsWith("remove_")) {
    return (
      <div
        className={`library-notice${error ? " library-notice--error" : ""}`}
        role={error ? "alert" : "status"}
      >
        <div>
          {t("operation.processed", {
            completed: operation.completed,
            total: operation.total ?? 0,
          })}
          {failed > 0 ? ` ${t("operation.removeFailures", { failed })}` : ""}
          {error ? <p>{error}</p> : null}
          {unsuccessful.length > 0 ? (
            <ul>
              {unsuccessful.map((item, index) => (
                <li key={index}>
                  <strong>
                    {items.find((entry) => entry.id === item.id)?.title ??
                      t("operation.entry", { id: String(item.id) })}
                    :
                  </strong>{" "}
                  {t(
                    item.status === "notFound"
                      ? "operation.alreadyRemoved"
                      : "operation.couldNotRemove",
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <NoticeClose onClose={close} />
      </div>
    );
  }
  return null;
}
