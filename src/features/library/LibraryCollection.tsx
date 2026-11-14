import { i18n, useI18n } from "../../i18n/i18n";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CardTabStop, useCardRoving } from "./cardRoving";
import type { LibraryBook } from "./libraryApi";
import type { ScrollPlace } from "./libraryCache";
import { LibraryCarousel } from "./LibraryCarousel";
import {
  ALL_BOOKS,
  groupAmounts,
  READING_GROUP,
  type LibrarySection,
  type LibraryView,
} from "./libraryView";
import { useVirtualRows } from "./useVirtualRows";

interface LibraryCollectionProps {
  /** The books under their headings; one untitled section when the Library is not grouped. */
  sections: readonly LibrarySection[];
  view: LibraryView;
  renderBook: (book: LibraryBook) => ReactNode;
  restore?: ScrollPlace;
  onScroll?: (place: ScrollPlace) => void;
  /** Where a group's See all leads; groups show as carousels when given. */
  groupLink?: (section: LibrarySection) => string;
  /** Draws Continue reading's cards, whose selection ranges over its own books. */
  renderReadingBook?: (book: LibraryBook) => ReactNode;
  /** How far each group's carousel was scrolled sideways, by the group's key. */
  rowOffset?: (key: string) => number | undefined;
  onRowOffset?: (key: string, offset: number) => void;
}

interface GridLayout {
  columns: number;
  columnWidth: number;
  gap: number;
}

type Row =
  | { kind: "heading"; section: LibrarySection }
  | { kind: "group"; section: LibrarySection }
  | { kind: "books"; key: string; books: LibraryBook[] };

/** A large count shortened for the interface language, such as 1.2M or 120万. */
export const compactCount = (value: number) => i18n().compact(value, 1);

/**
 * Every matching book as grid rows or list rows, of which only the rows near the visible area
 * are rendered; grouped, each group is one row: its heading above a carousel of its books. The
 * grid takes as many columns as its responsive card width fits, measured from a hidden probe
 * that lays out the grid's tracks in either view.
 */
export function LibraryCollection({
  sections,
  view,
  renderBook,
  restore,
  onScroll,
  groupLink,
  renderReadingBook,
  rowOffset,
  onRowOffset,
}: LibraryCollectionProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<GridLayout | null>(null);

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(probe);
      const tracks = style.gridTemplateColumns.split(" ").filter((track) => track.endsWith("px"));
      const gap = Number.parseFloat(style.rowGap) || 0;
      const next = {
        columns: Math.max(1, tracks.length),
        columnWidth: Number.parseFloat(tracks[0] ?? "") || probe.clientWidth,
        gap,
      };
      setLayout((current) =>
        current &&
        current.columns === next.columns &&
        Math.abs(current.columnWidth - next.columnWidth) < 0.5 &&
        current.gap === next.gap
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [view]);

  const columns = view === "list" ? 1 : (layout?.columns ?? 1);
  const gap = layout?.gap ?? 16;
  // A list card in a carousel is as wide as two grid cards.
  const itemWidth = layout
    ? view === "list"
      ? layout.columnWidth * 2 + gap
      : layout.columnWidth
    : 0;
  const carousels = groupLink !== undefined;
  // A named group is a carousel; the ungrouped Library's books under All books never are.
  const isCarousel = useCallback(
    (section: LibrarySection) => carousels && section.title !== null && section.key !== ALL_BOOKS,
    [carousels],
  );
  const cardOf = (section: LibrarySection) =>
    section.key === READING_GROUP && renderReadingBook ? renderReadingBook : renderBook;
  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const section of sections) {
      if (isCarousel(section)) {
        result.push({ kind: "group", section });
        continue;
      }
      if (section.title !== null) result.push({ kind: "heading", section });
      for (let start = 0; start < section.books.length; start += columns)
        result.push({
          kind: "books",
          key: `${section.key}:${start}`,
          books: section.books.slice(start, start + columns),
        });
    }
    return result;
  }, [isCarousel, columns, sections]);
  const kindOf = useCallback((index: number) => rows[index]?.kind ?? "books", [rows]);
  const keyOf = useCallback(
    (index: number) => {
      const row = rows[index];
      return !row ? "" : row.kind === "books" ? row.key : row.section.key;
    },
    [rows],
  );
  // A grid card is its cover (2:2.85) above about six lines of details.
  const estimate = view === "list" ? 84 : layout ? (layout.columnWidth * 2.85) / 2 + 104 : 360;
  const kindEstimates = useMemo(
    () => ({ heading: 56, group: 56 + (view === "list" ? 112 : estimate) }),
    [estimate, view],
  );
  // The books outside carousels are one Tab stop; each carousel is its own.
  const rovingRef = useRef<HTMLDivElement | null>(null);
  const rovingBooks = useMemo(
    () => sections.flatMap((section) => (isCarousel(section) ? [] : section.books)),
    [isCarousel, sections],
  );
  const cards = useCardRoving(rovingRef, rovingBooks, columns);
  const virtualRows = useVirtualRows(listRef, {
    count: layout || !virtualSupported() ? rows.length : 0,
    estimate,
    gap,
    kindOf,
    kindEstimates,
    layoutKey: `${view}:${columns}:${Math.round(layout?.columnWidth ?? 0)}`,
    keyOf,
    restore,
    onScroll,
  });

  if (!virtualRows.virtual) {
    return (
      <CardTabStop stop={cards.stop}>
        <div className="library-sections" ref={rovingRef} {...cards.props}>
          {sections.map((section) => (
            <div className="library-section" key={section.key} {...groupRegion(section)}>
              {isCarousel(section) && groupLink ? (
                <LibraryCarousel
                  books={section.books}
                  gap={gap}
                  heading={<SectionHeading section={section} />}
                  initialOffset={rowOffset?.(section.key)}
                  itemWidth={itemWidth}
                  onOffset={onRowOffset ? (offset) => onRowOffset(section.key, offset) : undefined}
                  renderBook={cardOf(section)}
                  seeAll={groupLink(section)}
                  title={section.title ?? ""}
                  view={view}
                />
              ) : (
                <>
                  {section.title !== null ? <SectionHeading section={section} /> : null}
                  <div className={`library-books library-books--${view}`}>
                    {section.books.map(renderBook)}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </CardTabStop>
    );
  }
  return (
    <CardTabStop stop={cards.stop}>
      <div
        className={`library-books library-books--virtual library-books--${view}`}
        ref={(element) => {
          listRef.current = element;
          rovingRef.current = element;
        }}
        style={{ height: virtualRows.total }}
        {...cards.props}
      >
        <div aria-hidden="true" className="library-books__probe" ref={probeRef} />
        {virtualRows.rows.map(({ index, start }) => {
          const row = rows[index];
          if (!row) return null;
          if (row.kind === "group")
            return (
              <div
                className="library-books__row library-books__row--group"
                data-index={index}
                key={row.section.key}
                ref={virtualRows.measureRef}
                style={{ transform: `translateY(${start}px)` }}
                {...groupRegion(row.section)}
              >
                <LibraryCarousel
                  books={row.section.books}
                  gap={gap}
                  heading={<SectionHeading section={row.section} />}
                  initialOffset={rowOffset?.(row.section.key)}
                  itemWidth={itemWidth}
                  onOffset={
                    onRowOffset ? (offset) => onRowOffset(row.section.key, offset) : undefined
                  }
                  renderBook={cardOf(row.section)}
                  seeAll={groupLink?.(row.section) ?? ""}
                  title={row.section.title ?? ""}
                  view={view}
                />
              </div>
            );
          return row.kind === "heading" ? (
            <div
              className="library-books__row library-books__row--heading"
              data-index={index}
              key={row.section.key}
              ref={virtualRows.measureRef}
              style={{ transform: `translateY(${start}px)` }}
            >
              <SectionHeading section={row.section} />
            </div>
          ) : (
            <div
              className="library-books__row"
              data-index={index}
              key={row.key}
              ref={virtualRows.measureRef}
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                transform: `translateY(${start}px)`,
              }}
            >
              {row.books.map(renderBook)}
            </div>
          );
        })}
      </div>
    </CardTabStop>
  );
}

/** A group's name, then its books and the characters and words they hold, as the Library's summary. */
function SectionHeading({ section }: { section: LibrarySection }) {
  const { tp } = useI18n();
  const full = groupAmounts(section.books, false);
  // All books names the Library's own books under Continue reading; the Library's summary
  // already counts them.
  if (section.key === ALL_BOOKS)
    return (
      <h3 className="library-group-heading library-all-heading">
        <span>{section.title}</span>
      </h3>
    );
  return (
    <h3 className="library-group-heading">
      <span title={section.title ?? undefined}>{section.title}</span>
      <small>
        {tp("librarySummary.books", section.books.length)}
        {groupAmounts(section.books, true).map((short, index) => (
          <span key={short} title={full[index]}>
            {" · "}
            {short}
          </span>
        ))}
      </small>
    </h3>
  );
}

/** Continue reading is a region of its own, named by its heading. */
const groupRegion = (section: LibrarySection) =>
  section.key === READING_GROUP
    ? { role: "region", "aria-label": section.title ?? undefined, "data-group": READING_GROUP }
    : {};

const virtualSupported = () => typeof ResizeObserver !== "undefined";
