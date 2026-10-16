import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { safeCoverUrl } from "../features/library/coverUrl";
import { getLibraryBook } from "../features/library/libraryApi";
import { ReaderShell } from "../features/reader/ReaderShell";
import { epubRendererFactory } from "../features/reader/epubRenderer";
import type { ReaderIdentity } from "../features/reader/readerIdentity";
import { readerPositionStore } from "../features/reader/readingPosition";
import { bookmarkStore, type BookmarkStore } from "../features/reader/bookmarks";
import { noteStore, type NoteStore } from "../features/reader/notes";
import type { ReaderPositionStore, ReaderRendererFactory } from "../features/reader/renderer";

interface ReaderPageProps {
  rendererFactory?: ReaderRendererFactory;
  positionStore?: ReaderPositionStore;
  bookmarkStore?: BookmarkStore;
  noteStore?: NoteStore;
}

export function ReaderPage({
  rendererFactory,
  positionStore,
  bookmarkStore: injectedBookmarks,
  noteStore: injectedNotes,
}: ReaderPageProps) {
  const { catalogId } = useParams();
  const [resolved, setResolved] = useState<{ id: string; identity: ReaderIdentity } | null>(null);

  useEffect(() => {
    if (!catalogId) return;
    let active = true;
    void getLibraryBook(catalogId)
      .then((found) => {
        if (!found || found.id !== catalogId) {
          if (active) setResolved({ id: catalogId, identity: { status: "unknown" } });
          return;
        }
        const book = {
          id: found.id,
          title: found.title,
          author: found.author,
          availability: found.availability,
          hasCover: found.hasCover,
          series: found.series ?? null,
          seriesIndex: found.seriesIndex ?? null,
        };
        // The sidebar shows the Library's cover thumbnail; an unsafe value shows no cover.
        const cover = book.hasCover ? safeCoverUrl(found.coverUrl) : null;
        if (active) setResolved({ id: catalogId, identity: { status: "book", book, cover } });
      })
      .catch(() => {
        if (active) setResolved({ id: catalogId, identity: { status: "error" } });
      });
    return () => {
      active = false;
    };
  }, [catalogId]);

  const identity: ReaderIdentity = catalogId
    ? resolved?.id === catalogId
      ? resolved.identity
      : { status: "loading" }
    : { status: "empty" };

  const selectedId =
    identity.status === "book" && identity.book.availability === "available"
      ? identity.book.id
      : null;
  const production = useMemo(
    () =>
      selectedId
        ? { factory: epubRendererFactory(selectedId), store: readerPositionStore(selectedId) }
        : undefined,
    [selectedId],
  );
  const catalogBookId = identity.status === "book" ? identity.book.id : undefined;
  const bookmarks = useMemo(
    () => (catalogBookId ? bookmarkStore(catalogBookId) : undefined),
    [catalogBookId],
  );
  const notes = useMemo(
    () => (catalogBookId ? noteStore(catalogBookId) : undefined),
    [catalogBookId],
  );

  return (
    <ReaderShell
      identity={identity}
      rendererFactory={rendererFactory ?? production?.factory}
      positionStore={positionStore ?? (rendererFactory ? undefined : production?.store)}
      bookmarkStore={injectedBookmarks ?? bookmarks}
      noteStore={injectedNotes ?? notes}
    />
  );
}
