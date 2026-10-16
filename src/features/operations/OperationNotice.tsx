import { useEffect } from "react";

import type { BulkOperation, RemovalBatch } from "./bulkOperation";
import { operationLabel, viewBulkOperation } from "./bulkOperation";
import { useI18n } from "../../i18n/i18n";

/** Shared progress and retained removal outcomes in the existing Library/Settings notice surface. */
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
  if (!operation) return null;
  const batch = operation.result as RemovalBatch<unknown> | undefined;
  const maintenanceFailed = batch?.maintenance?.status === "failed";
  const error =
    (operation.error && t("operation.failed")) ??
    (maintenanceFailed ? t("operation.reclaimFailed") : null);
  if (operation.active)
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
      </div>
    );
  if (error && !operation.command.startsWith("remove_"))
    return (
      <div className="library-notice library-notice--error" role="alert">
        {error}
      </div>
    );
  // A removal completed while another route was open still has its item outcomes here.
  if (operation.command.startsWith("remove_")) {
    const results = batch?.results;
    const failed = Array.isArray(results)
      ? results.filter((item) => item.status === "failed").length
      : results === "failed"
        ? 1
        : 0;
    const unsuccessful = Array.isArray(results)
      ? results.filter((item) => item.status !== "removed")
      : [];
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
          {batch?.maintenance?.status === "compacted" ? ` ${t("operation.reclaimed")}` : ""}
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
      </div>
    );
  }
  return null;
}
