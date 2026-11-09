import { i18n } from "../../i18n/i18n";
import { BookOpenIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { safeCoverUrl } from "./coverUrl";
import type { LibraryBook } from "./libraryApi";
import { onPcCoverArrival, pcCoverArrived, pcCoverKey } from "./pcCoverArrivals";

interface BookCoverProps {
  book: LibraryBook;
  /** A size modifier: the grid's full cover by default. */
  size?: "full" | "small";
  /** Drawn over the cover, such as the grid's hover hint. */
  children?: ReactNode;
}

/**
 * A book's cover thumbnail, loaded straight from Komori's cover protocol as an ordinary image,
 * or its title on a plain cover when it has none (or the image fails). The webview caches each
 * cover revision, so a cover shown once appears at once when its card renders again. A PC
 * book's cover the phone does not have yet shows the title until it arrives.
 */
export function BookCover({ book, size = "full", children }: BookCoverProps) {
  const url = book.hasCover ? safeCoverUrl(book.coverUrl) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef<string | null>(null);
  const pcCover = url ? pcCoverKey(url) : null;
  const title = book.title ?? i18n().t("library.untitled");

  useEffect(() => {
    if (!pcCover) return undefined;
    return onPcCoverArrival(pcCover, () =>
      setFailed((current) => (current === url ? null : current)),
    );
  }, [pcCover, url]);

  const onError = () => {
    // A PC cover that arrived while its miss was still on the way loads again, once.
    if (pcCover && pcCoverArrived(pcCover) && retried.current !== url) {
      retried.current = url;
      setAttempt((count) => count + 1);
      return;
    }
    setFailed(url);
  };
  return (
    <div
      className={["library-book__cover", size === "small" ? "library-book__cover--small" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {url && failed !== url ? (
        <img alt="" decoding="async" draggable={false} key={attempt} onError={onError} src={url} />
      ) : (
        <div className="library-book__cover-fallback">
          <BookOpenIcon aria-hidden="true" weight="duotone" />
          <span>{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}
