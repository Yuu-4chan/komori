import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n/i18n";
import { openExternalLink } from "../dictionary/dictionaryApi";
import { getWikipediaSummary, type WikipediaSummary } from "./wikipedia";

/**
 * The Wikipedia page a selection names, in a card where the text menu opened: its title,
 * description and introduction, with a button that opens the page in the browser. Escape, a
 * press outside or leaving the window closes it.
 */
export function ReaderWikipediaPopup({
  text,
  language,
  position,
  onClose,
}: {
  text: string;
  /** The book's language, or else the interface's. */
  language: string | null;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<WikipediaSummary | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let active = true;
    void getWikipediaSummary(text, language).then(
      (found) => {
        if (active) setSummary(found);
      },
      () => {
        if (active) setSummary({ status: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [text, language]);

  // Kept inside the window as its content arrives.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const gutter = 8;
    element.style.left = `${Math.max(gutter, Math.min(position.x, window.innerWidth - bounds.width - gutter))}px`;
    element.style.top = `${Math.max(gutter, Math.min(position.y, window.innerHeight - bounds.height - gutter))}px`;
  }, [position, summary]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    card.current?.focus({ preventScroll: true });
    const pointer = (event: MouseEvent) => {
      if (!card.current?.contains(event.target as Node)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    const blur = () => close.current();
    document.addEventListener("mousedown", pointer);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", pointer);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
      returnFocus?.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      aria-busy={summary === null}
      aria-label={t("wikipedia.label")}
      className="reader-wikipedia"
      ref={card}
      role="dialog"
      tabIndex={-1}
    >
      {summary === null ? (
        <p className="reader-wikipedia__status" role="status">
          {t("wikipedia.searching")}
        </p>
      ) : summary.status === "found" ? (
        <>
          <div className="reader-wikipedia__header">
            <div>
              <h2>{summary.title}</h2>
              {summary.description ? <p>{summary.description}</p> : null}
            </div>
            <button
              aria-label={t("wikipedia.open")}
              className="icon-button"
              onClick={() => {
                void openExternalLink(summary.url).catch(() => {});
                close.current();
              }}
              title={t("wikipedia.open")}
              type="button"
            >
              <ArrowSquareOutIcon aria-hidden="true" size={18} />
            </button>
          </div>
          {summary.extract ? (
            <div className="reader-wikipedia__extract">
              {summary.extract
                .split(/\n+/)
                .filter((paragraph) => paragraph.trim())
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="reader-wikipedia__status" role="status">
          {t(summary.status === "missing" ? "wikipedia.missing" : "wikipedia.failed")}
        </p>
      )}
    </div>,
    document.body,
  );
}
