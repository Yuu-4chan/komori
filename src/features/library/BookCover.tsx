import { i18n } from "../../i18n/i18n";
import { BookOpenIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import { safeCoverUrl } from "./coverUrl";
import type { LibraryBook } from "./libraryApi";

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
 * cover revision, so a cover shown once appears at once when its card renders again.
 */
export function BookCover({ book, size = "full", children }: BookCoverProps) {
  const url = book.hasCover ? safeCoverUrl(book.coverUrl) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const title = book.title ?? i18n().t("library.untitled");
  return (
    <div
      className={["library-book__cover", size === "small" ? "library-book__cover--small" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {url && failed !== url ? (
        <img alt="" decoding="async" draggable={false} onError={() => setFailed(url)} src={url} />
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
