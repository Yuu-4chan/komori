import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { safeCoverUrl } from "../features/library/coverUrl";
import { getLibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { ReaderShell } from "../features/reader/ReaderShell";
import { epubRendererFactory } from "../features/reader/epubRenderer";
import type { ReaderIdentity } from "../features/reader/readerIdentity";
import { readerPositionStore } from "../features/reader/readingPosition";
import { bookmarkStore, type BookmarkStore } from "../features/reader/bookmarks";
import { noteStore, type NoteStore } from "../features/reader/notes";
import { getOpenedFile } from "../features/reader/openedFiles";
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
  const { catalogId: libraryId, fileId } = useParams();
  // A book opened from a folder has an ID for this run, outside the Library.
  const routeId = fileId ?? libraryId;
  const [resolved, setResolved] = useState<{ id: string; identity: ReaderIdentity } | null>(null);

  useEffect(() => {
    if (!fileId) return;
    let active = true;
    void getOpenedFile(fileId)
      .then((found) => {
        if (!active) return;
        if (!found) {
          setResolved({ id: fileId, identity: { status: "unknown" } });
          return;
        }
        const book = {
          id: found.id,
          title: found.title,
          author: found.author,
          availability: "available" as const,
          hasCover: false,
          language: found.language,
          series: null,
          seriesIndex: null,
        };
        setResolved({ id: fileId, identity: { status: "book", book, cover: null, opened: true } });
      })
      .catch(() => {
        if (active) setResolved({ id: fileId, identity: { status: "error" } });
      });
    return () => {
      active = false;
    };
  }, [fileId]);

  useEffect(() => {
    if (!libraryId) return;
    const catalogId = libraryId;
    // The Library reads this book again on its return, where it was read to.
    libraryCache.touch(catalogId);
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
          language: found.language,
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
  }, [libraryId]);

  const identity: ReaderIdentity = routeId
    ? resolved?.id === routeId
      ? resolved.identity
      : { status: "loading" }
    : { status: "empty" };

  const selectedId =
    identity.status === "book" && identity.book.availability === "available"
      ? identity.book.id
      : null;
  // A book opened from a folder opens at its start and keeps no place, bookmarks or notes.
  const opened = identity.status === "book" && identity.opened === true;
  const production = useMemo(
    () =>
      selectedId
        ? {
            factory: epubRendererFactory(selectedId),
            store: opened ? undefined : readerPositionStore(selectedId),
          }
        : undefined,
    [selectedId, opened],
  );
  const catalogBookId = identity.status === "book" && !opened ? identity.book.id : undefined;
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
