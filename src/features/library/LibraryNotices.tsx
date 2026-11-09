import { CheckCircleIcon, LinkSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";

import { NoticeClose, useNoticeTimeout } from "../../components/ui/NoticeClose";
import { failureText } from "../../i18n/failure";
import { i18n, useI18n } from "../../i18n/i18n";
import type { ImportBatch, RelinkResult } from "./libraryApi";

export interface RelinkNoticeState {
  kind: "success" | "canceled" | "invalid" | "duplicate" | "error";
  title: string;
  message: string;
}

/** What a relink that did not finish says, by how it ended. */
export function relinkNoticeFor(result: RelinkResult): RelinkNoticeState {
  const { t } = i18n();
  switch (result.status) {
    case "canceled":
      return {
        kind: "canceled",
        title: t("library.relinkCanceled"),
        message: t("library.relinkCanceledMessage"),
      };
    case "invalid":
      return {
        kind: "invalid",
        title: t("library.relinkInvalid"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkInvalidMessage"),
      };
    case "duplicate":
      return {
        kind: "duplicate",
        title: t("library.relinkDuplicate"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkDuplicateMessage"),
      };
    case "readFailed":
      return {
        kind: "error",
        title: t("library.relinkUnreadable"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkUnreadableMessage"),
      };
    case "failed":
    default:
      return {
        kind: "error",
        title: t("library.relinkFailed"),
        message: result.message ? failureText(result.message, t) : t("library.relinkFailedMessage"),
      };
  }
}

export function RelinkNotice({
  notice,
  onClose,
}: {
  notice: RelinkNoticeState;
  onClose: () => void;
}) {
  const isError = ["invalid", "duplicate", "error"].includes(notice.kind);
  useNoticeTimeout(notice.kind === "success", onClose);
  return (
    <div
      className={`library-notice${isError ? " library-notice--error" : ""}`}
      role={isError ? "alert" : "status"}
    >
      {notice.kind === "success" ? (
        <CheckCircleIcon aria-hidden="true" />
      ) : notice.kind === "canceled" ? (
        <LinkSimpleIcon aria-hidden="true" />
      ) : (
        <WarningCircleIcon aria-hidden="true" />
      )}
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <NoticeClose onClose={onClose} />
    </div>
  );
}

export function ImportNotice({ result, onClose }: { result: ImportBatch; onClose: () => void }) {
  const imported = result.results.filter((item) => item.status === "imported").length;
  const existing = result.results.filter((item) => item.status === "alreadyImported").length;
  const failures = result.results.filter((item) => item.status === "failed");
  const { t } = useI18n();
  useNoticeTimeout(failures.length === 0, onClose);
  return (
    <div className="library-notice" role="status">
      <div>
        <strong>
          {t("library.imported", { count: imported })}
          {existing > 0 ? ` · ${t("library.alreadyImported", { count: existing })}` : ""}
          {failures.length > 0
            ? ` · ${t("library.importFailures", { count: failures.length })}`
            : ""}
        </strong>
        {failures.length > 0 ? (
          <ul>
            {failures.map((item, index) => (
              <li key={`${item.fileName}-${index}`}>
                <strong>{item.fileName}:</strong> {item.message && failureText(item.message, t)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <NoticeClose onClose={onClose} />
    </div>
  );
}
