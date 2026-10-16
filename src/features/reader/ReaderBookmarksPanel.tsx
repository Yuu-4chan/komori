import { useI18n } from "../../i18n/i18n";
import { ReaderPanelHeading } from "./ReaderPanelHeading";
import { BookmarkSimpleIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { TextField } from "../../components/ui/TextField";
import type { ReaderBookmark } from "./bookmarks";
import type { useBookmarks } from "./useBookmarks";

export interface ReaderBookmarksPanelProps {
  bookmarks: ReturnType<typeof useBookmarks>;
  canCreate: boolean;
  navigationBusy: boolean;
  onCreate: (label: string) => Promise<boolean>;
  onJump: (bookmark: ReaderBookmark, settled: (success: boolean) => void) => boolean;
}

export function ReaderBookmarksPanel({
  bookmarks,
  canCreate,
  navigationBusy,
  onCreate,
  onJump,
}: ReaderBookmarksPanelProps) {
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const busy = bookmarks.busy || navigationBusy;
  const { t } = useI18n();
  return (
    <section className="reader-bookmarks" aria-labelledby="reader-bookmarks-heading">
      <ReaderPanelHeading
        id="reader-bookmarks-heading"
        eyebrow={t("bookmarks.eyebrow")}
        title={t("sidebar.bookmarks")}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate || busy || bookmarks.status !== "ready") return;
          void onCreate(label).then((saved) => {
            if (saved) setLabel("");
          });
        }}
      >
        <TextField label={t("bookmarks.title")} value={label} onChange={setLabel} />
        <Button
          ref={addRef}
          type="submit"
          icon={<BookmarkSimpleIcon aria-hidden="true" />}
          disabled={!canCreate || busy || bookmarks.status !== "ready"}
        >
          {t("bookmarks.save")}
        </Button>
      </form>
      {bookmarks.status === "empty" && <p>{t("bookmarks.needsBook")}</p>}
      {bookmarks.status === "loading" && <p role="status">{t("bookmarks.loading")}</p>}
      {bookmarks.error && (
        <p className="reader-sidebar__error" role="alert">
          {bookmarks.error}
        </p>
      )}
      {(bookmarks.status === "error" || bookmarks.error) && (
        <Button disabled={bookmarks.busy} onClick={bookmarks.retry}>
          {t("bookmarks.reload")}
        </Button>
      )}
      <p role="status" aria-live="polite">
        {bookmarks.busy ? t("bookmarks.saving") : bookmarks.notice}
      </p>
      {bookmarks.status === "ready" && !bookmarks.items.length && <p>{t("bookmarks.empty")}</p>}
      <ul className="reader-bookmarks__list" ref={listRef}>
        {bookmarks.items.map((bookmark, index) => {
          const name = bookmark.label || t("bookmarks.untitled", { index: index + 1 });
          return (
            <li key={bookmark.id} className="reader-bookmarks__item">
              <button
                type="button"
                className="reader-bookmarks__jump"
                aria-label={t("bookmarks.jump", { name })}
                aria-disabled={busy || !canCreate || undefined}
                onClick={() => {
                  if (busy || !canCreate) return;
                  onJump(bookmark, (success) =>
                    setUnavailable((current) => {
                      const next = new Set(current);
                      if (success) next.delete(bookmark.id);
                      else next.add(bookmark.id);
                      return next;
                    }),
                  );
                }}
              >
                <span className="reader-bookmarks__icon">
                  <BookmarkSimpleIcon aria-hidden="true" />
                </span>
                <span className="reader-bookmarks__copy">
                  <strong>{name}</strong>
                  {bookmark.excerpt && <small>{bookmark.excerpt}</small>}
                  <em>
                    {t("reader.section", { number: bookmark.locator.spineIndex + 1 })} ·{" "}
                    {Math.round(bookmark.locator.progress * 100)}%
                  </em>
                </span>
              </button>
              {unavailable.has(bookmark.id) && (
                <p role="alert" className="reader-sidebar__error">
                  {t("bookmarks.placeUnavailable")}
                </p>
              )}
              {editing === bookmark.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    void bookmarks.rename(bookmark.id, draft).then((saved) => {
                      if (saved) {
                        setEditing(null);
                        requestAnimationFrame(() =>
                          listRef.current
                            ?.querySelector<HTMLButtonElement>(`[data-rename="${bookmark.id}"]`)
                            ?.focus(),
                        );
                      }
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(null);
                      requestAnimationFrame(() =>
                        listRef.current
                          ?.querySelector<HTMLButtonElement>(`[data-rename="${bookmark.id}"]`)
                          ?.focus(),
                      );
                    }
                  }}
                >
                  <TextField
                    autoFocus
                    label={t("bookmarks.labelFor", { name })}
                    value={draft}
                    onChange={setDraft}
                  />
                  <div className="reader-bookmarks__actions">
                    <Button type="submit" disabled={busy}>
                      {t("bookmarks.saveLabel")}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setEditing(null);
                        requestAnimationFrame(() =>
                          listRef.current
                            ?.querySelector<HTMLButtonElement>(`[data-rename="${bookmark.id}"]`)
                            ?.focus(),
                        );
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="reader-bookmarks__actions">
                  <IconButton
                    data-rename={bookmark.id}
                    label={t("bookmarks.rename", { name })}
                    disabled={busy}
                    onClick={() => {
                      setDraft(bookmark.label);
                      setEditing(bookmark.id);
                    }}
                  >
                    <PencilSimpleIcon aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t("dictionarySources.remove", { title: name })}
                    disabled={busy}
                    onClick={() => {
                      void bookmarks.remove(bookmark.id).then((removed) => {
                        if (removed)
                          requestAnimationFrame(() =>
                            (
                              listRef.current?.querySelector<HTMLButtonElement>("button") ??
                              addRef.current
                            )?.focus(),
                          );
                      });
                    }}
                  >
                    <TrashIcon aria-hidden="true" />
                  </IconButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
