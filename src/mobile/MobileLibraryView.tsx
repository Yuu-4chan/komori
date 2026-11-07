import {
  CaretRightIcon,
  CheckIcon,
  DownloadSimpleIcon,
  ListIcon,
  SortDescendingIcon,
  SquaresFourIcon,
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
  groupPageLink,
  languageName,
  lastReadLabel,
  progressLabel,
  readCounts,
  readTotalLabel,
  type LibraryFilter,
  type LibraryGroup,
  type LibraryPlace,
  type LibrarySort,
  type LibraryView,
} from "../features/library/libraryView";
import { useI18n, type MessageKey } from "../i18n/i18n";
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
/** The place labels, as the Library's heading names them. */
export const PLACE_LABELS = {
  all: "sync.placeAll",
  phone: "sync.placePhone",
  pc: "sync.placePc",
} as const satisfies Record<LibraryPlace, MessageKey>;

/** Whether the Library shows other than all its books, ungrouped: the view button marks it. */
export function narrowed(display: LibraryDisplay, paired: boolean, groupPage = false): boolean {
  return (
    display.filter !== "all" ||
    (!groupPage && display.group !== "none") ||
    (paired && display.place !== "all")
  );
}

/**
 * The Library's view on the phone, the PC's toolbar as chips: where the books are (paired with a
 * PC, with each place's count), their reading status, grouping, sort and its direction, and grid
 * or list. Each choice saves at once with the Library's other choices. On a group's page, as on
 * the PC, there is no grouping and the sort is the group pages' own.
 */
export function LibraryViewSheet({
  open,
  onClose,
  display,
  onChange,
  places,
  groupPage = false,
}: {
  open: boolean;
  onClose: () => void;
  display: LibraryDisplay;
  onChange: (patch: Partial<LibraryDisplay>) => void;
  /** Each place with its count, while paired with a PC. */
  places: readonly (readonly [LibraryPlace, number])[] | null;
  /** On a group's page: no grouping, and the group pages' sort. */
  groupPage?: boolean;
}) {
  const { number, t } = useI18n();
  const sort = groupPage ? display.groupSort : display.sort;
  const reversed = groupPage ? display.groupSortReversed : display.sortReversed;
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
        {groupPage ? null : (
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
        )}
        <ChoiceGroup label={t("libraryToolbar.sortBooks")}>
          {sortChoices.map(({ value, label }) => (
            <Choice
              key={value}
              onClick={() => onChange(groupPage ? { groupSort: value } : { sort: value })}
              pressed={sort === value}
            >
              {t(label)}
            </Choice>
          ))}
          <Choice
            onClick={() =>
              onChange(groupPage ? { groupSortReversed: !reversed } : { sortReversed: !reversed })
            }
            pressed={reversed}
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
 * A book the Library lists, as a grid tile or a list row: its cover, title, author and progress,
 * with the characters or words read and in all. A tap opens it (a PC book downloads first unless it is here;
 * a missing one offers Relink and Remove), and a long press selects it; while selecting, a tap
 * selects or leaves it. A PC book has a badge for whether it is kept here, which keeps it.
 */
export function LibraryItem({
  item,
  view,
  actions,
}: {
  item: MergedBook;
  view: LibraryView;
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
        <Progress book={book} count={view === "grid" ? "short" : "full"} />
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

/** Books under one heading: a group's, or the whole Library's without one. */
export interface ItemSection {
  key: string;
  /** Null for the ungrouped Library. */
  title: string | null;
  items: MergedBook[];
}

const GRID_COLUMNS = 3;
/** A carousel shows this many books; See all at its end shows the rest on the group's page. */
export const CAROUSEL_BOOKS = 20;

type Row =
  { kind: "carousel"; section: ItemSection } | { kind: "books"; key: string; items: MergedBook[] };

/**
 * The Library's books: grouped, each group's heading above its books in a row that scrolls
 * sideways (as the PC's carousels); otherwise three to a row in the grid, one to a row in the
 * list. Only the rows within about a screen of the view are rendered, so a Library of thousands
 * of the PC's books shows and scrolls as fast as a small one.
 */
export function LibraryBooks({
  sections,
  grouped,
  view,
  renderItem,
  renderHeading,
}: {
  sections: readonly ItemSection[];
  /** Whether the sections are groups, each a carousel under its heading. */
  grouped: boolean;
  view: LibraryView;
  renderItem: (item: MergedBook, view: LibraryView) => ReactNode;
  renderHeading: (section: ItemSection) => ReactNode;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const columns = view === "grid" ? GRID_COLUMNS : 1;
  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const section of sections) {
      if (grouped) {
        if (section.items.length) result.push({ kind: "carousel", section });
        continue;
      }
      for (let index = 0; index < section.items.length; index += columns) {
        const items = section.items.slice(index, index + columns);
        result.push({ kind: "books", key: itemKey(items[0]!), items });
      }
    }
    return result;
  }, [columns, grouped, sections]);
  const list = useVirtualRows(listRef, {
    count: rows.length,
    estimate: grouped ? 300 : view === "grid" ? 290 : 104,
    gap: 0,
    kindOf: () => (grouped ? "carousel" : view),
    layoutKey: `mobile-${grouped ? "carousel" : view}`,
  });
  return (
    <div
      className={[
        "mobile-library__grid",
        `mobile-library__grid--${grouped ? "carousels" : view}`,
        list.virtual ? "mobile-library__grid--virtual" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={listRef}
      role={grouped ? undefined : "list"}
      style={list.virtual ? { height: list.total } : undefined}
    >
      {list.rows.map(({ index, start }) => {
        const row = rows[index];
        if (!row) return null;
        const style = list.virtual ? { transform: `translateY(${start}px)` } : undefined;
        if (row.kind === "carousel") {
          const { section } = row;
          const more = section.items.length > CAROUSEL_BOOKS;
          return (
            <section
              aria-label={section.title ?? undefined}
              className="mobile-library__row mobile-carousel"
              data-index={index}
              key={`group:${section.key}`}
              ref={list.measureRef}
              style={style}
            >
              {renderHeading(section)}
              <div className="mobile-carousel__track" role="list">
                {section.items.slice(0, CAROUSEL_BOOKS).map((item) => (
                  <div className="mobile-carousel__item" key={itemKey(item)} role="listitem">
                    {renderItem(item, "grid")}
                  </div>
                ))}
                {more ? (
                  <Link
                    aria-label={t("libraryCarousel.seeAllOf", { title: section.title ?? "" })}
                    className="mobile-carousel__more"
                    to={groupPageLink(section.key)}
                  >
                    <CaretRightIcon aria-hidden="true" weight="bold" />
                    {t("libraryCarousel.seeAll")}
                  </Link>
                ) : null}
              </div>
            </section>
          );
        }
        return (
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
                {renderItem(item, view)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A group's heading with its count: a tap opens the group's page and a long press selects its
 * books; while selecting, a tap selects them all or, when they all are, leaves them.
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
    <h3 className="mobile-group-heading">
      <Link className="mobile-group-heading__link" to={groupPageLink(section.key)} {...longPress}>
        {content}
        <CaretRightIcon aria-hidden="true" className="mobile-group-heading__caret" weight="bold" />
      </Link>
    </h3>
  );
}

/**
 * What the Library knows of a book, from Information while it alone is selected: its author,
 * series (which opens the series), language, length, kanji, progress, when it was last read and
 * when it was added.
 */
export function BookInfoSheet({
  book,
  onClose,
  onOpenSeries,
}: {
  book: LibraryBook | null;
  onClose: () => void;
  onOpenSeries: (series: string) => void;
}) {
  const { t, number, date } = useI18n();
  const rows: { key: string; label: string; value: ReactNode }[] = [];
  if (book) {
    rows.push({
      key: "author",
      label: t("libraryToolbar.sort.author"),
      value: book.author ?? t("libraryCard.unknownAuthor"),
    });
    if (book.series) {
      const series = book.series;
      rows.push({
        key: "series",
        label: t("libraryToolbar.group.series"),
        value: (
          <button
            className="mobile-book-info__link"
            onClick={() => onOpenSeries(series)}
            type="button"
          >
            {series}
            <CaretRightIcon aria-hidden="true" weight="bold" />
          </button>
        ),
      });
    }
    if (book.language)
      rows.push({
        key: "language",
        label: t("libraryToolbar.group.language"),
        value: languageName(book.language),
      });
    // Its length as its progress counts it, else as the import counted it.
    const counts = readCounts(book);
    const length = counts
      ? { unit: counts.unit, total: counts.total }
      : typeof book.characters === "number"
        ? { unit: "characters" as const, total: book.characters }
        : typeof book.words === "number"
          ? { unit: "words" as const, total: book.words }
          : null;
    if (length)
      rows.push({
        key: length.unit,
        label: t(
          length.unit === "characters"
            ? "libraryToolbar.sort.characters"
            : "libraryToolbar.sort.words",
        ),
        value: number(length.total),
      });
    if (typeof book.uniqueKanji === "number")
      rows.push({
        key: "kanji",
        label: t("libraryToolbar.cardKanji"),
        value: number(book.uniqueKanji),
      });
    const read = readTotalLabel(book);
    rows.push({
      key: "progress",
      label: t("libraryToolbar.sort.progress"),
      value: read ? `${progressLabel(book)} · ${read}` : progressLabel(book),
    });
    const lastRead = lastReadLabel(book, Date.now());
    if (lastRead)
      rows.push({ key: "lastRead", label: t("libraryToolbar.cardLastRead"), value: lastRead });
    const added = book.importedAt ? new Date(book.importedAt) : null;
    if (added && !Number.isNaN(added.getTime()))
      rows.push({
        key: "added",
        label: t("libraryToolbar.sort.added"),
        value: date(added, { dateStyle: "medium" }),
      });
  }
  return (
    <MobileSheet label={t("library.information")} onClose={onClose} open={book !== null}>
      {book ? (
        <div className="mobile-book-info">
          <div className="mobile-book-info__book">
            <BookCover book={book} size="small" />
            <strong>{book.title ?? t("library.untitled")}</strong>
          </div>
          <dl className="mobile-book-info__rows">
            {rows.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </MobileSheet>
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
