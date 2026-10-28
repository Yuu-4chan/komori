import { useI18n } from "../../i18n/i18n";
import {
  ArrowCounterClockwiseIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  LinkSimpleIcon,
  StackIcon,
  TranslateIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { memo, useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { IconButton } from "../../components/ui/IconButton";
import { SelectionCheckbox } from "../../components/ui/SelectionBox";
import { BookCover } from "./BookCover";
import { useCardTabStop } from "./cardRoving";
import type { LibraryBook } from "./libraryApi";
import {
  canMarkCompleted,
  languageName,
  lastReadLabel,
  progressLabel,
  progressPercent,
  readingStatus,
  readTotalLabel,
  type LibraryView,
} from "./libraryView";

/** Optional details a card shows, from the Library's Cards menu. */
export interface CardDetails {
  series: boolean;
  language: boolean;
  kanji: boolean;
  lastRead: boolean;
}

/**
 * How a click selects: `toggle` flips one book (a plain click while selecting, or Ctrl/Cmd+click),
 * `range` adds every book from the last one clicked (Shift+click).
 */
export type SelectGesture = "toggle" | "range";

interface LibraryBookCardProps {
  busy?: boolean;
  book: LibraryBook;
  view: LibraryView;
  details: CardDetails;
  onRelink: (book: LibraryBook) => void;
  onRemove: (book: LibraryBook) => void;
  /** Asks to reset an opened book's progress and position. */
  onMarkUnread?: (book: LibraryBook) => void;
  /** Moves an unfinished book's progress to its end. */
  onMarkCompleted?: (book: LibraryBook) => void;
  relinkDisabled: boolean;
  relinking: boolean;
  onSelect: (id: string, gesture: SelectGesture) => void;
  selected: boolean;
  selectionMode: boolean;
}

const openHint = {
  "not-started": "libraryCard.start",
  reading: "libraryCard.continue",
  completed: "libraryCard.again",
} as const;

/** The progress bar with its percentage, and the units read below it. */
function BookProgressBar({ book }: { book: LibraryBook }) {
  const { t } = useI18n();
  const percent = progressPercent(book);
  const total = readTotalLabel(book);
  return (
    <div className="library-progress">
      <div className="library-progress__row">
        <span
          aria-label={t("libraryCard.percentRead", { percent })}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="library-progress__bar"
          role="progressbar"
        >
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="library-progress__percent">
          {book.progress || !book.lastReadAt ? progressLabel(book) : "—"}
        </span>
      </div>
      <span className="library-progress__count">
        {total ?? t(book.lastReadAt ? "libraryCard.countedNextOpen" : "libraryCard.notStarted")}
      </span>
    </div>
  );
}

// Memoized so selection, notice, or scroll changes do not re-render every card shown.
export const LibraryBookCard = memo(function LibraryBookCard({
  busy = false,
  book,
  view,
  details,
  onRelink,
  onRemove,
  onMarkUnread,
  onMarkCompleted,
  relinkDisabled,
  relinking,
  onSelect,
  selected,
  selectionMode,
}: LibraryBookCardProps) {
  const navigate = useNavigate();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const { t, number } = useI18n();

  const title = book.title ?? t("library.untitled");
  const author = book.author ?? t("libraryCard.unknownAuthor");
  const status = readingStatus(book);
  const tabStop = useCardTabStop(book.id);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef<HTMLInputElement>(null);
  // A menu opened from the keyboard stays where it opened when the context-menu key's own
  // contextmenu event follows.
  const keyboardMenu = useRef(false);
  const closeMenu = useCallback(() => {
    keyboardMenu.current = false;
    setMenuPosition(null);
  }, []);
  const lastRead = details.lastRead ? lastReadLabel(book) : null;
  const series = details.series ? book.series : null;
  const language = details.language && book.language ? languageName(book.language) : null;
  const kanji = details.kanji ? (book.uniqueKanji ?? null) : null;
  const hasChips = Boolean(series || language || kanji !== null || lastRead);

  function openContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    if (selectionMode || keyboardMenu.current) return;
    setMenuPosition({ x: event.clientX, y: event.clientY });
  }

  // The card is one Tab stop, its open link: Space selects it and Shift+F10 or the context-menu
  // key opens its actions, which the pointer reaches from its corners.
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (selectionMode || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!(event.target as Element).closest(".library-book__open")) return;
    if (event.key === " " && !event.shiftKey) {
      event.preventDefault();
      if (busy) return;
      selectionRef.current?.focus();
      onSelect(book.id, "toggle");
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const bounds = actionsRef.current?.getBoundingClientRect();
      if (!bounds) return;
      keyboardMenu.current = true;
      setMenuPosition({ x: bounds.right, y: bounds.bottom + 4 });
    }
  }

  // While selecting the whole card selects; otherwise only its corner box does (and starts
  // selecting). The box's own checkbox takes the keyboard.
  function toggleFromCard(event: MouseEvent<HTMLElement>) {
    if (busy) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a")) return;
    if (!selectionMode && !target.closest(".library-book__selection")) return;
    onSelect(book.id, event.shiftKey ? "range" : "toggle");
  }

  // Ctrl/Cmd+click or Shift+click selects instead of opening the book.
  function selectFromLink(event: MouseEvent<HTMLAnchorElement>) {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
    event.preventDefault();
    onSelect(book.id, event.shiftKey ? "range" : "toggle");
  }

  function toggleActions(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (menuPosition) {
      closeMenu();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenuPosition({ x: bounds.right, y: bounds.bottom + 4 });
  }

  return (
    <Card
      as="article"
      className={[
        "library-book",
        `library-book--${view}`,
        selectionMode ? "library-book--selectable" : "",
        selected ? "library-book--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-catalog-id={book.id}
      onClick={toggleFromCard}
      onContextMenu={openContextMenu}
      onKeyDown={handleKeyDown}
      // Keeps Shift+click from selecting the page's text.
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
    >
      {!selectionMode ? (
        <Link
          aria-label={t("libraryCard.open", { title })}
          className="library-book__open"
          aria-keyshortcuts="Space Shift+F10"
          onClick={selectFromLink}
          tabIndex={tabStop ? 0 : -1}
          to={`/reader/${encodeURIComponent(book.id)}`}
        />
      ) : null}
      {/* The card takes pointer clicks; the box takes the keyboard. */}
      <SelectionCheckbox
        className="library-book__selection"
        aria-label={t("libraryCard.select", { title })}
        checked={selected}
        disabled={busy}
        onChange={() => onSelect(book.id, "toggle")}
        ref={selectionRef}
        tabIndex={selectionMode && tabStop ? 0 : -1}
      />
      {selectionMode ? null : (
        <IconButton
          aria-expanded={menuPosition !== null}
          aria-haspopup="menu"
          className="library-book__actions"
          label={t("libraryCard.moreActions", { title })}
          onClick={toggleActions}
          ref={actionsRef}
          tabIndex={-1}
        >
          <DotsThreeIcon aria-hidden="true" weight="bold" />
        </IconButton>
      )}
      <BookCover book={book} size={view === "list" ? "small" : "full"}>
        {view === "grid" && !selectionMode && book.availability === "available" ? (
          <span aria-hidden="true" className="library-book__open-hint">
            <BookOpenIcon weight="bold" />
            {t(openHint[status])}
          </span>
        ) : null}
      </BookCover>
      <div className="library-book__details">
        <div className="library-book__identity">
          <h3 title={title}>{title}</h3>
          <p title={author}>{author}</p>
          {book.title === null ? <small>{book.fileName}</small> : null}
        </div>
        {hasChips ? (
          <div className="library-book__chips">
            {series ? (
              <span className="library-book__chip" title={t("libraryCard.seriesTitle", { series })}>
                <StackIcon aria-hidden="true" />
                <span className="library-book__chip-text">{series}</span>
              </span>
            ) : null}
            {language ? (
              <span
                className="library-book__chip"
                title={t("libraryCard.languageTitle", { language })}
              >
                <TranslateIcon aria-hidden="true" />
                {language}
              </span>
            ) : null}
            {kanji !== null ? (
              <span
                className="library-book__chip"
                title={t("libraryCard.uniqueKanji", { count: kanji })}
              >
                <span aria-hidden="true" className="library-book__chip-glyph" lang="ja">
                  漢
                </span>
                {number(kanji)}
                <span className="visually-hidden"> {t("libraryCard.uniqueKanjiHidden")}</span>
              </span>
            ) : null}
            {lastRead ? (
              <span
                className="library-book__chip"
                title={t("libraryCard.lastRead", { time: lastRead })}
              >
                <ClockCounterClockwiseIcon aria-hidden="true" />
                {t("libraryCard.lastRead", { time: lastRead })}
              </span>
            ) : null}
          </div>
        ) : null}
        {book.availability !== "available" ? (
          <div className="library-book__source-warning">
            <span className="library-book__missing">
              <WarningCircleIcon aria-hidden="true" />
              {t(
                book.availability === "missing" ? "libraryCard.missing" : "libraryCard.unreadable",
              )}
            </span>
            {!selectionMode ? (
              <Button
                className="library-book__relink"
                disabled={relinkDisabled}
                tabIndex={-1}
                icon={<LinkSimpleIcon aria-hidden="true" />}
                onClick={(event) => {
                  event.stopPropagation();
                  onRelink(book);
                }}
                tone="quiet"
              >
                {relinking ? t("libraryCard.choosing") : t("libraryCard.relink")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <BookProgressBar book={book} />
      {!selectionMode ? (
        <ContextMenu
          items={[
            {
              label: t("libraryCard.openInReader"),
              icon: <BookOpenIcon aria-hidden="true" />,
              onSelect: () => navigate(`/reader/${encodeURIComponent(book.id)}`),
            },
            {
              label: relinking ? t("libraryCard.choosingReplacement") : t("libraryCard.relinkMenu"),
              icon: <LinkSimpleIcon aria-hidden="true" />,
              disabled: relinkDisabled || busy,
              onSelect: () => onRelink(book),
            },
            ...(onMarkCompleted && canMarkCompleted(book)
              ? [
                  {
                    label: t("library.markCompleted"),
                    icon: <CheckCircleIcon aria-hidden="true" />,
                    disabled: busy,
                    onSelect: () => onMarkCompleted(book),
                  },
                ]
              : []),
            ...(onMarkUnread && (book.progress || book.lastReadAt)
              ? [
                  {
                    label: t("library.markUnread"),
                    icon: <ArrowCounterClockwiseIcon aria-hidden="true" />,
                    disabled: busy,
                    onSelect: () => onMarkUnread(book),
                  },
                ]
              : []),
            {
              label: t("library.removeConfirm"),
              icon: <TrashIcon aria-hidden="true" />,
              tone: "danger",
              disabled: busy,
              onSelect: () => onRemove(book),
            },
          ]}
          label={t("libraryCard.actions", { title })}
          onClose={closeMenu}
          position={menuPosition}
        />
      ) : null}
    </Card>
  );
});
