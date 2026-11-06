import {
  CheckIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  ListIcon,
  SortDescendingIcon,
  SquaresFourIcon,
  StackIcon,
  TranslateIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { LibraryDisplay } from "../features/appearance/AppearanceProvider";
import { BookCover } from "../features/library/BookCover";
import type { LibraryBook } from "../features/library/libraryApi";
import { useVirtualRows } from "../features/library/useVirtualRows";
import {
  languageName,
  lastReadLabel,
  type LibraryFilter,
  type LibraryGroup,
  type LibraryPlace,
  type LibrarySort,
  type LibraryView,
} from "../features/library/libraryView";
import { i18n, useI18n, type MessageKey } from "../i18n/i18n";
import { useLongPress } from "./longPress";
import { Progress, type PcEntry } from "./MobilePcLibrary";
import { MobileSheet } from "./MobileSheet";
import type { MergedBook } from "./pcLibraryMerge";

/** The selection's key of a book the Library lists, the phone's own or the PC's. */
export const itemKey = (item: MergedBook) => `${item.kind}:${item.book.id}`;

/** The PC's saved Library choices, as the phone's Library view sheet offers them. */
const statusChoices: { value: LibraryFilter; label: MessageKey }[] = [
  { value: "all", label: "libraryToolbar.filter.all" },
  { value: "reading", label: "libraryToolbar.filter.reading" },
  { value: "completed", label: "libraryToolbar.filter.completed" },
  { value: "not-started", label: "libraryToolbar.filter.not-started" },
];
const groupChoices: { value: LibraryGroup; label: MessageKey }[] = [
  { value: "none", label: "libraryToolbar.group.none" },
  { value: "series", label: "libraryToolbar.group.series" },
  { value: "language", label: "libraryToolbar.group.language" },
  { value: "author", label: "libraryToolbar.group.author" },
];
const sortChoices: { value: LibrarySort; label: MessageKey }[] = [
  { value: "recent", label: "libraryToolbar.sort.recent" },
  { value: "added", label: "libraryToolbar.sort.added" },
  { value: "title", label: "libraryToolbar.sort.title" },
  { value: "author", label: "libraryToolbar.sort.author" },
  { value: "progress", label: "libraryToolbar.sort.progress" },
  { value: "characters", label: "libraryToolbar.sort.characters" },
  { value: "words", label: "libraryToolbar.sort.words" },
];
const viewChoices: { value: LibraryView; label: MessageKey; icon: ReactNode }[] = [
  { value: "grid", label: "libraryToolbar.grid", icon: <SquaresFourIcon aria-hidden="true" /> },
  { value: "list", label: "libraryToolbar.list", icon: <ListIcon aria-hidden="true" /> },
];
const cardChoices: {
  key: "cardSeries" | "cardLanguage" | "cardKanji" | "cardLastRead";
  label: MessageKey;
}[] = [
  { key: "cardSeries", label: "libraryToolbar.cardSeries" },
  { key: "cardLanguage", label: "libraryToolbar.cardLanguage" },
  { key: "cardKanji", label: "libraryToolbar.cardKanji" },
  { key: "cardLastRead", label: "libraryToolbar.cardLastRead" },
];

/** The place labels, as the Library's heading names them. */
export const PLACE_LABELS = {
  all: "sync.placeAll",
  phone: "sync.placePhone",
  pc: "sync.placePc",
} as const satisfies Record<LibraryPlace, MessageKey>;

/** Whether the Library shows other than all its books, ungrouped: the view button marks it. */
export function narrowed(display: LibraryDisplay, paired: boolean): boolean {
  return (
    display.filter !== "all" || display.group !== "none" || (paired && display.place !== "all")
  );
}

/**
 * The Library's view on the phone, the PC's toolbar as chips: where the books are (paired with a
 * PC, with each place's count), their reading status, grouping, sort and its direction, grid or
 * list, and what their cards show. Each choice saves at once with the Library's other choices.
 */
export function LibraryViewSheet({
  open,
  onClose,
  display,
  onChange,
  places,
}: {
  open: boolean;
  onClose: () => void;
  display: LibraryDisplay;
  onChange: (patch: Partial<LibraryDisplay>) => void;
  /** Each place with its count, while paired with a PC. */
  places: readonly (readonly [LibraryPlace, number])[] | null;
}) {
  const { number, t } = useI18n();
  return (
    <MobileSheet label={t("libraryToolbar.view")} onClose={onClose} open={open}>
      <div className="mobile-view-sheet">
        {places ? (
          <ChoiceGroup label={t("sync.show")}>
            {places.map(([value, count]) => (
              <Choice
                key={value}
                onClick={() => onChange({ place: value })}
                pressed={display.place === value}
              >
                {t(PLACE_LABELS[value])}
                <small>{number(count)}</small>
              </Choice>
            ))}
          </ChoiceGroup>
        ) : null}
        <ChoiceGroup label={t("libraryToolbar.statusFilter")}>
          {statusChoices.map(({ value, label }) => (
            <Choice
              key={value}
              onClick={() => onChange({ filter: value })}
              pressed={display.filter === value}
            >
              {t(label)}
            </Choice>
          ))}
        </ChoiceGroup>
        <ChoiceGroup label={t("libraryToolbar.groupBooks")}>
          {groupChoices.map(({ value, label }) => (
            <Choice
              key={value}
              onClick={() => onChange({ group: value })}
              pressed={display.group === value}
            >
              {t(label)}
            </Choice>
          ))}
        </ChoiceGroup>
        <ChoiceGroup label={t("libraryToolbar.sortBooks")}>
          {sortChoices.map(({ value, label }) => (
            <Choice
              key={value}
              onClick={() => onChange({ sort: value })}
              pressed={display.sort === value}
            >
              {t(label)}
            </Choice>
          ))}
          <Choice
            onClick={() => onChange({ sortReversed: !display.sortReversed })}
            pressed={display.sortReversed}
          >
            <SortDescendingIcon aria-hidden="true" />
            {t("libraryToolbar.reverseOrder")}
          </Choice>
        </ChoiceGroup>
        <ChoiceGroup label={t("libraryToolbar.layout")}>
          {viewChoices.map(({ value, label, icon }) => (
            <Choice
              key={value}
              onClick={() => onChange({ view: value })}
              pressed={display.view === value}
            >
              {icon}
              {t(label)}
            </Choice>
          ))}
        </ChoiceGroup>
        <ChoiceGroup label={t("libraryToolbar.visibleOnCards")}>
          {cardChoices.map(({ key, label }) => (
            <Choice
              key={key}
              onClick={() => onChange({ [key]: !display[key] })}
              pressed={display[key]}
            >
              {display[key] ? <CheckIcon aria-hidden="true" weight="bold" /> : null}
              {t(label)}
            </Choice>
          ))}
        </ChoiceGroup>
      </div>
    </MobileSheet>
  );
}

function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="mobile-view-sheet__group">
      <h3>{label}</h3>
      <div className="mobile-view-sheet__choices" role="group">
        {children}
      </div>
    </section>
  );
}

function Choice({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button aria-pressed={pressed} className="mobile-choice" onClick={onClick} type="button">
      {children}
    </button>
  );
}

/** Which details the Library's cards show, as the PC's Cards menu chooses them. */
export interface CardDetails {
  series: boolean;
  language: boolean;
  kanji: boolean;
  lastRead: boolean;
}

/** What a card does: open its book, or while selecting, choose it. */
export interface ItemActions {
  selecting: boolean;
  isSelected: (key: string) => boolean;
  /** A long press, or a tap while selecting. */
  onSelect: (key: string) => void;
  onOpenPc: (entry: PcEntry) => void;
  onKeepPc: (entry: PcEntry) => void;
  onMissing: (book: LibraryBook) => void;
  /** PC books downloading, by PC book ID, with how much has arrived. */
  saving: Record<string, number>;
}

/**
 * A book the Library lists, as a grid tile or a list row: its cover, title, author, the details
 * chosen for cards and its progress. A tap opens it (a PC book downloads first unless it is here;
 * a missing one offers Relink and Remove), and a long press selects it; while selecting, a tap
 * selects or leaves it. A PC book has a badge for whether it is kept here, which keeps it.
 */
export function LibraryItem({
  item,
  view,
  details,
  actions,
}: {
  item: MergedBook;
  view: LibraryView;
  details: CardDetails;
  actions: ItemActions;
}) {
  const { t } = useI18n();
  const key = itemKey(item);
  const { book } = item;
  const { selecting, onSelect } = actions;
  const selected = selecting && actions.isSelected(key);
  const longPress = useLongPress(() => onSelect(key));
  const available = item.kind === "pc" || book.availability === "available";
  const className = [
    view === "grid" ? "mobile-tile" : "mobile-book-row",
    available ? "" : "mobile-tile--missing",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const chips = cardChips(book, details, view);
  const content = (
    <>
      <BookCover book={book} size={view === "list" ? "small" : undefined}>
        {available ? null : (
          <span className="mobile-tile__missing">
            <WarningCircleIcon aria-hidden="true" weight="fill" />
          </span>
        )}
        {selecting ? (
          <span aria-hidden="true" className="mobile-select-mark">
            {selected ? <CheckIcon weight="bold" /> : null}
          </span>
        ) : null}
      </BookCover>
      <span className="mobile-book-copy">
        <strong className="mobile-tile__title">{book.title ?? t("library.untitled")}</strong>
        <span className="mobile-tile__author">
          {available
            ? (book.author ?? t("libraryCard.unknownAuthor"))
            : t(book.availability === "missing" ? "libraryCard.missing" : "libraryCard.unreadable")}
        </span>
        {chips.length ? <span className="mobile-chips mobile-book-chips">{chips}</span> : null}
        <Progress book={book} />
      </span>
    </>
  );

  let card: ReactNode;
  if (selecting)
    card = (
      <button
        aria-pressed={selected}
        className={className}
        onClick={() => onSelect(key)}
        type="button"
        {...longPress}
      >
        {content}
      </button>
    );
  else if (item.kind === "pc")
    card = (
      <button
        className={className}
        onClick={() => actions.onOpenPc(item.entry)}
        type="button"
        {...longPress}
      >
        {content}
      </button>
    );
  else if (available)
    card = (
      <Link className={className} to={`/reader/${book.id}`} {...longPress}>
        {content}
      </Link>
    );
  else
    card = (
      <button
        className={className}
        onClick={() => actions.onMissing(book)}
        type="button"
        {...longPress}
      >
        {content}
      </button>
    );

  if (item.kind !== "pc") return card;
  const { entry } = item;
  const saving = actions.saving[entry.pc.id];
  return (
    <div className={`mobile-pc-tile mobile-pc-tile--${view}`}>
      {card}
      {selecting ? null : saving !== undefined ? (
        <span
          aria-label={t("sync.saving", { percent: saving })}
          className="mobile-pc-tile__badge mobile-pc-tile__badge--saving"
          role="img"
          style={{ "--saved": `${saving}%` } as CSSProperties}
        />
      ) : entry.pc.kept ? (
        <span
          aria-label={t("sync.onPhone")}
          className="mobile-pc-tile__badge mobile-pc-tile__badge--kept"
          role="img"
        >
          <CheckIcon aria-hidden="true" weight="bold" />
        </span>
      ) : (
        <button
          aria-label={t("sync.keep")}
          className="mobile-pc-tile__badge"
          onClick={() => actions.onKeepPc(entry)}
          type="button"
        >
          <DownloadSimpleIcon aria-hidden="true" weight="bold" />
        </button>
      )}
    </div>
  );
}

/** The chosen details of a book: its series, language, distinct kanji and when it was read. */
function cardChips(book: LibraryBook, details: CardDetails, view: LibraryView): ReactNode[] {
  const { number, t } = i18n();
  const chips: ReactNode[] = [];
  if (details.series && book.series)
    chips.push(
      <span key="series" title={t("libraryCard.seriesTitle", { series: book.series })}>
        <StackIcon aria-hidden="true" />
        <span className="mobile-book-chips__text">{book.series}</span>
      </span>,
    );
  if (details.language && book.language)
    chips.push(
      <span key="language">
        {view === "list" ? <TranslateIcon aria-hidden="true" /> : null}
        {languageName(book.language)}
      </span>,
    );
  if (details.kanji && typeof book.uniqueKanji === "number")
    chips.push(
      <span key="kanji" title={t("libraryCard.uniqueKanji", { count: book.uniqueKanji })}>
        <span aria-hidden="true" lang="ja">
          漢
        </span>
        {number(book.uniqueKanji)}
        <span className="visually-hidden"> {t("libraryCard.uniqueKanjiHidden")}</span>
      </span>,
    );
  const lastRead = details.lastRead ? lastReadLabel(book, Date.now(), "narrow") : null;
  if (lastRead)
    chips.push(
      <span key="lastRead">
        {view === "list" ? <ClockCounterClockwiseIcon aria-hidden="true" /> : null}
        {lastRead}
      </span>,
    );
  return chips;
}

/** Books under one heading: a group's, or the whole Library's without one. */
export interface ItemSection {
  key: string;
  /** Null for the ungrouped Library. */
  title: string | null;
  items: MergedBook[];
}

type Row =
  { kind: "heading"; section: ItemSection } | { kind: "books"; key: string; items: MergedBook[] };

const GRID_COLUMNS = 3;

/**
 * The Library's books, under their groups' headings when grouped: three to a row in the grid, one
 * to a row in the list. Only the rows within about a screen of the view are rendered, so a
 * Library of thousands of the PC's books shows and scrolls as fast as a small one.
 */
export function LibraryBooks({
  sections,
  view,
  renderItem,
  renderHeading,
}: {
  sections: readonly ItemSection[];
  view: LibraryView;
  renderItem: (item: MergedBook) => ReactNode;
  renderHeading: (section: ItemSection) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const columns = view === "grid" ? GRID_COLUMNS : 1;
  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const section of sections) {
      if (section.title !== null) result.push({ kind: "heading", section });
      for (let index = 0; index < section.items.length; index += columns) {
        const items = section.items.slice(index, index + columns);
        result.push({ kind: "books", key: itemKey(items[0]!), items });
      }
    }
    return result;
  }, [columns, sections]);
  const list = useVirtualRows(listRef, {
    count: rows.length,
    estimate: view === "grid" ? 270 : 104,
    gap: 0,
    kindOf: (index) => (rows[index]?.kind === "heading" ? "heading" : view),
    kindEstimates: { heading: 48 },
    layoutKey: `mobile-${view}`,
  });
  return (
    <div
      className={[
        "mobile-library__grid",
        `mobile-library__grid--${view}`,
        list.virtual ? "mobile-library__grid--virtual" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={listRef}
      role="list"
      style={list.virtual ? { height: list.total } : undefined}
    >
      {list.rows.map(({ index, start }) => {
        const row = rows[index];
        if (!row) return null;
        const style = list.virtual ? { transform: `translateY(${start}px)` } : undefined;
        return row.kind === "heading" ? (
          <div
            className="mobile-library__row mobile-library__row--heading"
            data-index={index}
            key={`heading:${row.section.key}`}
            ref={list.measureRef}
            role="presentation"
            style={style}
          >
            {renderHeading(row.section)}
          </div>
        ) : (
          <div
            className="mobile-library__row"
            data-index={index}
            key={row.key}
            ref={list.measureRef}
            role="presentation"
            style={style}
          >
            {row.items.map((item) => (
              <div key={itemKey(item)} role="listitem">
                {renderItem(item)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A group's heading with its count. A long press selects its books; while selecting, a tap
 * selects them all or, when they all are, leaves them.
 */
export function GroupHeading({
  section,
  selecting,
  allSelected,
  onSelect,
}: {
  section: ItemSection;
  selecting: boolean;
  allSelected: boolean;
  onSelect: (section: ItemSection) => void;
}) {
  const { tp } = useI18n();
  const longPress = useLongPress(() => onSelect(section));
  const content = (
    <>
      <span className="mobile-group-heading__title">{section.title}</span>
      <small>{tp("librarySummary.books", section.items.length)}</small>
    </>
  );
  return selecting ? (
    <button
      aria-pressed={allSelected}
      className="mobile-group-heading"
      onClick={() => onSelect(section)}
      type="button"
      {...longPress}
    >
      <span aria-hidden="true" className="mobile-select-mark">
        {allSelected ? <CheckIcon weight="bold" /> : null}
      </span>
      {content}
    </button>
  ) : (
    <h3 className="mobile-group-heading" {...longPress}>
      {content}
    </h3>
  );
}

/** The header while selecting: Done, how many are selected, and Select all or Clear. */
export function SelectionHeader({
  count,
  allSelected,
  onDone,
  onSelectAll,
  onClear,
}: {
  count: number;
  allSelected: boolean;
  onDone: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const { t, tp } = useI18n();
  return (
    <header className="mobile-header mobile-selection-header">
      <div className="mobile-header__row">
        <button
          aria-label={t("library.doneSelecting")}
          className="mobile-round-button"
          onClick={onDone}
          type="button"
        >
          <XIcon aria-hidden="true" weight="bold" />
        </button>
        <div className="mobile-header__title">
          <h1 aria-live="polite">{tp("library.selected", count)}</h1>
        </div>
        <button
          className="mobile-selection-header__all"
          onClick={allSelected ? onClear : onSelectAll}
          type="button"
        >
          {t(allSelected ? "library.clear" : "library.selectAll")}
        </button>
      </div>
    </header>
  );
}

export interface SelectionAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** What can be done with the books selected, in a bar over the dock; only what applies shows. */
export function SelectionBar({ actions }: { actions: readonly SelectionAction[] }) {
  const { t } = useI18n();
  return (
    <div aria-label={t("library.selection")} className="mobile-selection-bar" role="toolbar">
      {actions.map((action) => (
        <button
          className={`mobile-selection-bar__action${action.danger ? " mobile-selection-bar__action--danger" : ""}`}
          disabled={action.disabled}
          key={action.key}
          onClick={action.onClick}
          type="button"
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
