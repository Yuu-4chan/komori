import { useI18n } from "../../i18n/i18n";
import { ReaderPanelHeading } from "./ReaderPanelHeading";
import {
  MagnifyingGlassIcon,
  XIcon,
  HighlighterIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Select } from "../../components/ui/Select";
import { searchEscape } from "../../components/ui/searchEscape";
import { noteBodyValid, noteTextLimit, type ReaderNote } from "./notes";
import type { useNotes } from "./useNotes";

export interface ReaderNotesPanelProps {
  notes: ReturnType<typeof useNotes>;
  ready: boolean;
  navigationBusy: boolean;
  onJump: (note: ReaderNote, settled: (success: boolean) => void) => boolean;
  /** A note to bring into view and focus, such as one clicked in the book. */
  focus?: { id: string };
}

export function NoteEditor({
  passage,
  initial = "",
  title,
  busy,
  error,
  onSave,
  onCancel,
}: {
  passage: string;
  initial?: string;
  title: string;
  busy: boolean;
  error: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open
      dialogRole="dialog"
      title={title}
      description={t("notes.editorDescription")}
      confirmLabel={t("notes.save")}
      confirmTone="primary"
      confirmDisabled={!noteBodyValid(body.trim())}
      busy={busy}
      busyLabel={t("notes.saving")}
      error={error}
      onCancel={onCancel}
      onConfirm={() => onSave(body)}
    >
      <blockquote className="reader-note-passage">{passage}</blockquote>
      <label className="reader-note-field">
        {t("notes.note")}
        <textarea
          aria-label={t("notes.note")}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          disabled={busy}
        />
      </label>
      <p className="reader-bookmarks__hint">
        {t("notes.characters", { count: [...body].length, limit: noteTextLimit })}
      </p>
    </ConfirmDialog>
  );
}

export function ReaderNotesPanel({
  notes,
  ready,
  navigationBusy,
  onJump,
  focus,
}: ReaderNotesPanelProps) {
  const [editing, setEditing] = useState<ReaderNote | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const busy = notes.busy || navigationBusy;
  // Each request focuses its note once; a search that hides the note gives way to it.
  const focused = useRef<{ id: string }>(undefined);
  const pending = focus && focused.current !== focus ? focus : undefined;
  const hidden = !!pending && !notes.visibleItems.some((note) => note.id === pending.id);
  const { setQuery } = notes;
  useEffect(() => {
    if (!pending) return;
    if (hidden) {
      setQuery("");
      return;
    }
    focused.current = pending;
    const item = list.current?.querySelector<HTMLElement>(`[data-note-id="${pending.id}"]`);
    item?.scrollIntoView?.({ block: "nearest" });
    item?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [pending, hidden, setQuery]);
  const { t } = useI18n();
  return (
    <section className="reader-bookmarks" aria-labelledby="reader-notes-heading">
      <ReaderPanelHeading
        id="reader-notes-heading"
        eyebrow={t("notes.eyebrow")}
        title={t("sidebar.notes")}
      />
      <div className="reader-notes-controls">
        <div className="reader-search-box">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input
            ref={search}
            type="search"
            aria-label={t("notes.search")}
            placeholder={t("notes.searchPlaceholder")}
            spellCheck={false}
            value={notes.query}
            onChange={(event) => notes.setQuery(event.target.value)}
            onKeyDown={searchEscape}
          />
          {notes.query && (
            <IconButton
              label={t("notes.clearSearch")}
              onClick={() => {
                notes.setQuery("");
                search.current?.focus();
              }}
            >
              <XIcon aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <Select
          label={t("notes.order")}
          value={notes.order}
          options={[
            { value: "creation", label: t("notes.creationOrder") },
            { value: "reading", label: t("notes.readingOrder") },
          ]}
          onChange={notes.setOrder}
        />
      </div>
      {notes.status === "empty" && <p>{t("notes.needsBook")}</p>}
      {notes.status === "loading" && <p role="status">{t("notes.loading")}</p>}
      {notes.error && (
        <p role="alert" className="reader-sidebar__error">
          {notes.error}
        </p>
      )}
      {(notes.status === "error" || notes.error) && (
        <Button disabled={notes.busy} onClick={notes.retry}>
          {t("notes.reload")}
        </Button>
      )}
      <p role="status">{notes.busy ? t("notes.savingNotes") : notes.notice}</p>
      {notes.status === "ready" && !notes.items.length && <p>{t("notes.empty")}</p>}
      {notes.status === "ready" && (
        <p role="status" className="reader-search-summary">
          {t("notes.count", { shown: notes.visibleItems.length, count: notes.items.length })}
        </p>
      )}
      {notes.status === "ready" && !!notes.items.length && !notes.visibleItems.length && (
        <p>{t("notes.noMatches")}</p>
      )}
      <ul ref={list} className="reader-bookmarks__list">
        {notes.visibleItems.map((note, index) => (
          <li key={note.id} data-note-id={note.id} className="reader-bookmarks__item">
            <button
              type="button"
              className="reader-bookmarks__jump"
              aria-label={t("notes.jump", { index: index + 1 })}
              aria-disabled={busy || !ready || undefined}
              onClick={() => {
                if (busy || !ready) return;
                if (!onJump(note, (success) => setUnavailable(success ? null : note.id)))
                  setUnavailable(note.id);
              }}
            >
              <span className="reader-bookmarks__icon">
                {note.body ? (
                  <NotePencilIcon aria-hidden="true" />
                ) : (
                  <HighlighterIcon aria-hidden="true" />
                )}
              </span>
              <span className="reader-bookmarks__copy">
                {note.body ? (
                  <>
                    <strong className="reader-note-body">{note.body}</strong>
                    <small className="reader-note-passage">{note.passage}</small>
                  </>
                ) : (
                  <strong className="reader-note-passage">{note.passage}</strong>
                )}
                <em>
                  {t("reader.section", { number: note.locator.spineIndex + 1 })} ·{" "}
                  {Math.round(note.locator.progress * 100)}%
                </em>
              </span>
            </button>
            {unavailable === note.id && (
              <p role="alert" className="reader-sidebar__error">
                {t("bookmarks.placeUnavailable")}
              </p>
            )}
            <div className="reader-bookmarks__actions">
              <IconButton
                label={t("notes.edit", { index: index + 1 })}
                disabled={busy}
                onClick={() => setEditing(note)}
              >
                <PencilSimpleIcon aria-hidden="true" />
              </IconButton>
              <IconButton
                label={t("notes.remove", { index: index + 1 })}
                disabled={busy}
                onClick={() => {
                  void notes.remove(note.id).then((removed) => {
                    if (removed)
                      requestAnimationFrame(() =>
                        (
                          list.current?.querySelector<HTMLButtonElement>("button") ?? search.current
                        )?.focus(),
                      );
                  });
                }}
              >
                <TrashIcon aria-hidden="true" />
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <NoteEditor
          key={editing.id}
          title={t("notes.editTitle")}
          passage={editing.passage}
          initial={editing.body}
          busy={notes.busy}
          error={notes.error}
          onCancel={() => setEditing(null)}
          onSave={(body) => {
            void notes.edit(editing.id, body).then((saved) => {
              if (saved) {
                setEditing(null);
                requestAnimationFrame(() => {
                  if (!list.current?.querySelector(`[data-note-id="${editing.id}"]`))
                    search.current?.focus();
                });
              }
            });
          }}
        />
      )}
    </section>
  );
}
