import { useI18n } from "../../i18n/i18n";
import { BookOpenTextIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { RefObject } from "react";

import type { ReaderStatus } from "./renderer";
import type { ReaderIdentity } from "./readerIdentity";

interface ReaderViewportProps {
  hostRef: RefObject<HTMLDivElement | null>;
  viewportRef?: RefObject<HTMLElement | null>;
  identity: ReaderIdentity;
  status: ReaderStatus;
}

export function ReaderViewport({ hostRef, viewportRef, identity, status }: ReaderViewportProps) {
  const { t } = useI18n();
  const book = identity.status === "book" ? identity.book : null;
  const selected = identity.status !== "empty";
  const unavailable = book && book.availability !== "available";
  const rendererProblem = !["empty", "loading", "ready"].includes(status);
  const problem =
    identity.status === "unknown" || identity.status === "error" || unavailable || rendererProblem;
  return (
    <main ref={viewportRef} className="reader-viewport" id="reader-main" tabIndex={-1}>
      <div
        className="reader-viewport__page"
        aria-busy={identity.status === "loading" || status === "loading"}
      >
        <div ref={hostRef} className="reader-viewport__host" aria-hidden={status !== "ready"} />
        {status !== "ready" && (
          <div
            className="reader-viewport__message"
            role={problem || (!selected && status === "error") ? "alert" : "status"}
          >
            {problem || (!selected && status === "error") ? (
              <WarningCircleIcon aria-hidden="true" weight="duotone" />
            ) : (
              <BookOpenTextIcon aria-hidden="true" weight="duotone" />
            )}
            <span className="reader-viewport__eyebrow">{t("reader.title")}</span>
            <h2>
              {book &&
                (status === "loading"
                  ? t("viewport.preparingBook")
                  : (book.title ?? t("library.untitled")))}
              {identity.status === "loading" && t("viewport.findingBook")}
              {identity.status === "unknown" && t("readerStatus.notFound")}
              {identity.status === "error" && t("library.unavailable")}
              {!selected && status === "empty" && t("viewport.spaceReady")}
              {!selected && status === "loading" && t("viewport.preparingSpace")}
              {!selected && status === "error" && t("viewport.couldNotStart")}
            </h2>
            {book ? (
              <p className="reader-viewport__author">
                {book.author ?? t("libraryCard.unknownAuthor")}
              </p>
            ) : null}
            <p>
              {book &&
                t(
                  unavailable
                    ? book.availability === "missing"
                      ? "viewport.missing"
                      : "viewport.unreadable"
                    : status === "loading"
                      ? "viewport.loadingFirst"
                      : status === "missing"
                        ? "viewport.missing"
                        : status === "unreadable"
                          ? "viewport.unreadable"
                          : status === "invalid"
                            ? "viewport.invalid"
                            : status === "tooLarge"
                              ? "viewport.tooLarge"
                              : "viewport.renderFailed",
                )}
              {identity.status === "loading" && t("viewport.findingWait")}
              {identity.status === "unknown" && t("viewport.notInLibrary")}
              {identity.status === "error" && t("viewport.libraryFailed")}
              {!selected && status === "empty" && t("viewport.openFromLibrary")}
              {!selected && status === "loading" && t("viewport.startingWait")}
              {!selected && status === "error" && t("viewport.tryLater")}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
