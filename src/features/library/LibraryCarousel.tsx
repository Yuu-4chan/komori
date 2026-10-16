import { useI18n } from "../../i18n/i18n";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { CardTabStop, useCardRoving } from "./cardRoving";
import type { LibraryBook } from "./libraryApi";
import type { LibraryView } from "./libraryView";

interface LibraryCarouselProps {
  heading: ReactNode;
  /** The group's name, for its controls' labels. */
  title: string;
  books: readonly LibraryBook[];
  view: LibraryView;
  /** Each card's width in px; 0 before the Library has measured its grid. */
  itemWidth: number;
  gap: number;
  renderBook: (book: LibraryBook) => ReactNode;
  /** The group's own page. */
  seeAll: string;
  /** How far the row was scrolled when it was shown last, restored when it lays out. */
  initialOffset?: number;
  /** Told how far the row is scrolled as it moves. */
  onOffset?: (offset: number) => void;
}

/**
 * One group of a grouped Library: its heading with See all, above its books in one horizontally
 * scrolling row. Previous/next arrows over the row's edges move by the cards that fit, each
 * shown only while the row can move that way; only the cards
 * within one width of the visible part are rendered, so a group of thousands scrolls as fast as
 * a small one. Where layout cannot be observed (as in tests) every card is rendered.
 */
export function LibraryCarousel({
  heading,
  title,
  books,
  view,
  itemWidth,
  gap,
  renderBook,
  seeAll,
  initialOffset,
  onOffset,
}: LibraryCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, width: 0, max: 0 });
  const measurable = typeof ResizeObserver !== "undefined" && itemWidth > 0;
  const restoreOffset = useRef(initialOffset);
  const onOffsetRef = useRef(onOffset);
  onOffsetRef.current = onOffset;

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    // Until the row is restored, its offset is not the reader's yet.
    if (restoreOffset.current === undefined) onOffsetRef.current?.(track.scrollLeft);
    const next = {
      left: track.scrollLeft,
      width: track.clientWidth,
      max: Math.max(0, track.scrollWidth - track.clientWidth),
    };
    setScroll((current) =>
      Math.abs(current.left - next.left) < 1 &&
      current.width === next.width &&
      Math.abs(current.max - next.max) < 1
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track && itemWidth > 0 && restoreOffset.current !== undefined) {
      track.scrollLeft = restoreOffset.current;
      restoreOffset.current = undefined;
    }
    measure();
  }, [measure, books.length, itemWidth]);
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    track.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(track);
    return () => {
      cancelAnimationFrame(frame);
      track.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [measure]);

  const step = itemWidth + gap;
  const perView = measurable ? Math.max(1, Math.floor((scroll.width + gap) / step)) : 1;
  let first = 0;
  let last = books.length - 1;
  if (measurable) {
    first = Math.max(0, Math.floor(scroll.left / step) - perView);
    last = Math.min(books.length - 1, Math.ceil((scroll.left + scroll.width) / step) + perView);
  }
  // Space for the cards not rendered, less the gap the row already puts beside a spacer.
  const before = first * step - gap;
  const after = (books.length - 1 - last) * step - gap;

  const canPrevious = measurable && scroll.left > 1;
  const canNext = measurable && scroll.left < scroll.max - 1;

  const cards = useCardRoving(trackRef, books, 0);
  const { t } = useI18n();
  function move(direction: 1 | -1) {
    trackRef.current?.scrollBy({ left: direction * perView * step, behavior: "smooth" });
  }

  return (
    <div className="library-carousel">
      <div className="library-carousel__head">
        {heading}
        <Link
          aria-label={t("libraryCarousel.seeAllOf", { title })}
          className="library-carousel__see-all"
          to={seeAll}
        >
          {t("libraryCarousel.seeAll")}
        </Link>
      </div>
      <div
        className={`library-carousel__body library-carousel__body--${view}`}
        style={itemWidth > 0 ? { ["--library-carousel-item" as string]: `${itemWidth}px` } : {}}
      >
        <div
          className={`library-carousel__track library-carousel__track--${view}`}
          ref={trackRef}
          style={{ gap }}
          {...cards.props}
        >
          <CardTabStop stop={cards.stop}>
            {before > 0 ? <span aria-hidden="true" style={{ flex: `0 0 ${before}px` }} /> : null}
            {books.slice(first, last + 1).map(renderBook)}
            {after > 0 ? <span aria-hidden="true" style={{ flex: `0 0 ${after}px` }} /> : null}
          </CardTabStop>
        </div>
        {canPrevious ? (
          <button
            aria-label={t("libraryCarousel.previousIn", { title })}
            className="library-carousel__arrow library-carousel__arrow--previous"
            onClick={() => move(-1)}
            title={t("libraryCarousel.previous")}
            type="button"
          >
            <CaretLeftIcon aria-hidden="true" size={18} weight="bold" />
          </button>
        ) : null}
        {canNext ? (
          <button
            aria-label={t("libraryCarousel.nextIn", { title })}
            className="library-carousel__arrow library-carousel__arrow--next"
            onClick={() => move(1)}
            title={t("libraryCarousel.next")}
            type="button"
          >
            <CaretRightIcon aria-hidden="true" size={18} weight="bold" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
