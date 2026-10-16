import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { ScrollPlace } from "./libraryCache";

interface VirtualRow {
  index: number;
  /** Offset of the row's top from the list's top, in px. */
  start: number;
}

interface VirtualRowsOptions {
  count: number;
  /** A row's height before any row is measured. */
  estimate: number;
  gap: number;
  /**
   * The kind of each row, when rows differ (headings among rows of books). Each kind keeps its
   * own typical height; a kind in `kindEstimates` starts from that height instead of `estimate`.
   */
  kindOf?: (index: number) => string;
  kindEstimates?: Readonly<Record<string, number>>;
  /** Changes when rows change shape (view or columns), discarding measured heights. */
  layoutKey: string;
  /** Each row's lasting identity, by which a restored place finds the row it was left at. */
  keyOf?: (index: number) => string;
  /** A place to restore once, when the list first lays out. */
  restore?: ScrollPlace;
  /** Told the place as it changes, for restoring later. */
  onScroll?: (place: ScrollPlace) => void;
}

// How long a restored place is held while the content around it settles (covers, a shelf above
// the list, measured rows), unless the reader scrolls first.
const RESTORE_HOLD_MS = 1500;

// The typical measured row height of each layout, kept across visits so a returning Library
// lays out at its real height at once and restores its scroll position exactly.
const typicalHeights = new Map<string, number>();

/**
 * Renders only the rows of a long list that are within about one screen of its scroll
 * container's visible area, as Calibre's grid does, so a Library of thousands of books lays
 * out and scrolls as fast as a small one. Rows measure themselves; a row above the view that
 * changes height scrolls by as much, so the books in view stay in place. Where layout cannot
 * be observed (as in tests), every row is rendered in normal flow (`virtual` is false).
 */
export function useVirtualRows(
  listRef: RefObject<HTMLElement | null>,
  {
    count,
    estimate,
    gap,
    kindOf,
    kindEstimates,
    layoutKey,
    keyOf,
    restore: restorePlace,
    onScroll,
  }: VirtualRowsOptions,
) {
  const virtual = typeof ResizeObserver !== "undefined";
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const [version, setVersion] = useState(0);
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  const restore = useRef(restorePlace);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (virtual && list) setScroller(scrollContainer(list));
  }, [listRef, virtual]);

  const keyRef = useRef(layoutKey);
  if (keyRef.current !== layoutKey) {
    keyRef.current = layoutKey;
    heights.current = new Map();
  }

  const kindRef = useRef(kindOf);
  kindRef.current = kindOf;
  const kindEstimatesRef = useRef(kindEstimates);
  kindEstimatesRef.current = kindEstimates;
  // The height a row of this kind is assumed to have until it is measured.
  const typicalFor = useCallback(
    (index: number) => {
      const kind = kindRef.current?.(index) ?? "row";
      return (
        typicalHeights.get(`${keyRef.current}:${kind}`) ??
        kindEstimatesRef.current?.[kind] ??
        estimate
      );
    },
    [estimate],
  );

  const offsets = useMemo(() => {
    const starts = new Float64Array(count + 1);
    for (let index = 0; index < count; index++)
      starts[index + 1] = starts[index] + (heights.current.get(index) ?? typicalFor(index)) + gap;
    return starts;
    // `version` changes when a row's measured height does; `kindOf` changes with the rows.
  }, [count, gap, layoutKey, typicalFor, version, kindOf]);
  const total = count > 0 ? Math.max(0, offsets[count] - gap) : 0;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const update = useCallback(() => {
    const list = listRef.current;
    if (!list || !scroller) return;
    const top = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const viewport = scroller.clientHeight;
    const starts = offsetsRef.current;
    const rows = starts.length - 1;
    onScrollRef.current?.(placeAt(starts, top, scroller.scrollTop, keyOfRef.current));
    if (rows <= 0) {
      setRange((current) => (current === null ? current : null));
      return;
    }
    // One screen above and below is laid out ahead, so its covers are ready when it shows.
    const first = Math.max(0, rowAt(starts, -top - viewport));
    const last = Math.min(rows - 1, rowAt(starts, -top + viewport * 2));
    setRange((current) =>
      current && current.first === first && current.last === last ? current : { first, last },
    );
  }, [listRef, scroller]);

  useLayoutEffect(update, [update, offsets]);

  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    };
    // The document's own scrolling element reports its scrolling on the window.
    const target = scroller === document.scrollingElement ? window : scroller;
    target.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scroller, update]);

  // Restored after the shell's own navigation reset, once the list has its height, then held
  // on its row while what lays out around it settles.
  const holding = useRef<(() => void) | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const place = restore.current;
    if (!scroller || !list || place === undefined || count === 0) return;
    restore.current = undefined;
    const target = () => {
      const anchor = place.anchor;
      const rows = offsetsRef.current.length - 1;
      let index = -1;
      if (anchor)
        for (let row = 0; row < rows && index < 0; row++)
          if (keyOfRef.current?.(row) === anchor.key) index = row;
      if (!anchor || index < 0) return place.scrollTop;
      const listTop =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      return Math.max(0, listTop + offsetsRef.current[index] - anchor.offset);
    };
    const until = performance.now() + RESTORE_HOLD_MS;
    let frame = 0;
    const inputs = ["wheel", "pointerdown", "touchstart"] as const;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of inputs) scroller.removeEventListener(type, stop);
      window.removeEventListener("keydown", stop);
      holding.current = null;
    };
    const hold = () => {
      const next = target();
      if (Math.abs(scroller.scrollTop - next) >= 1) scroller.scrollTop = next;
      update();
      if (performance.now() < until) frame = requestAnimationFrame(hold);
      else stop();
    };
    for (const type of inputs) scroller.addEventListener(type, stop, { passive: true });
    window.addEventListener("keydown", stop);
    holding.current = stop;
    hold();
  }, [count, listRef, scroller, update]);
  useEffect(() => () => holding.current?.(), []);

  const observer = useMemo(() => {
    if (!virtual) return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      let shift = 0;
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const index = Number(element.dataset.index);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight;
        if (!Number.isInteger(index) || height <= 0) continue;
        const previous = heights.current.get(index) ?? typicalFor(index);
        if (Math.abs(previous - height) < 0.5) {
          heights.current.set(index, height);
          continue;
        }
        heights.current.set(index, height);
        const typicalKey = `${keyRef.current}:${kindRef.current?.(index) ?? "row"}`;
        if (!typicalHeights.has(typicalKey)) typicalHeights.set(typicalKey, height);
        // Keep the books in view in place when a row above them changes height.
        if (element.getBoundingClientRect().bottom <= scrollerTop) shift += height - previous;
        changed = true;
      }
      if (shift && scroller) scroller.scrollTop += shift;
      if (changed) setVersion((value) => value + 1);
    });
  }, [scroller, typicalFor, virtual]);
  useEffect(() => () => observer?.disconnect(), [observer]);

  const measureRef = useCallback(
    (element: HTMLElement | null) => {
      if (element) observer?.observe(element);
    },
    [observer],
  );

  const rows: VirtualRow[] = [];
  if (!virtual) {
    for (let index = 0; index < count; index++) rows.push({ index, start: 0 });
  } else if (range) {
    for (let index = range.first; index <= Math.min(range.last, count - 1); index++)
      rows.push({ index, start: offsets[index] });
  }
  return { virtual, rows, total, measureRef };
}

/**
 * Where the list is: its scroll offset, and once the list's top has scrolled out of view, the
 * row at the view's top and how far above the view that row begins.
 */
function placeAt(
  starts: Float64Array,
  top: number,
  scrollTop: number,
  keyOf: ((index: number) => string) | undefined,
): ScrollPlace {
  if (top >= 0 || starts.length < 2 || !keyOf) return { scrollTop };
  const index = rowAt(starts, -top);
  return { scrollTop, anchor: { key: keyOf(index), offset: starts[index] + top } };
}

/** The row whose span holds `offset`: the last row starting at or before it. */
function rowAt(starts: Float64Array, offset: number): number {
  let low = 0;
  let high = starts.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function scrollContainer(element: Element): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
