import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { ReaderScrollMetrics } from "./renderer";

export interface ReaderScrollTrack {
  metrics(): ReaderScrollMetrics | null;
  scrollTo(position: number): void;
  watch(listener: () => void): () => void;
}

/** The thumb is never shorter than this, in pixels, however long the book. */
const MIN_THUMB = 32;

/**
 * A continuous book's scrollbar along the window's right edge, or its bottom edge for a book
 * scrolling sideways, however narrow or short the reading area. The book's own scrollbar
 * would otherwise float beside a narrowed column.
 */
export function ReaderScrollbar({
  track,
  refresh,
}: {
  track: ReaderScrollTrack;
  refresh: unknown;
}) {
  const [metrics, setMetrics] = useState<ReaderScrollMetrics | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; from: number; position: number } | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setMetrics((current) => {
        const next = trackRef.current.metrics();
        return sameMetrics(current, next) ? current : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    const unwatch = trackRef.current.watch(schedule);
    window.addEventListener("resize", schedule);
    return () => {
      unwatch();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [refresh]);

  if (!metrics || metrics.length <= 0) return null;
  const vertical = metrics.axis === "vertical";
  const size = () => {
    const box = element.current?.getBoundingClientRect();
    return (vertical ? box?.height : box?.width) ?? 0;
  };
  const thumbShare = metrics.visible / (metrics.visible + metrics.length);
  const progress = Math.min(1, Math.max(0, metrics.position / metrics.length));
  // From the start of the reading order: the right end for a right-to-left book.
  const along = metrics.reversed ? 1 - progress : progress;
  const travel = (thumb: number) => Math.max(1, size() - thumb);
  const thumbSize = () => Math.max(MIN_THUMB, size() * thumbShare);
  const coordinate = (event: PointerEvent) => (vertical ? event.clientY : event.clientX);

  return (
    <div
      ref={element}
      aria-hidden="true"
      className={`reader-scrollbar reader-scrollbar--${metrics.axis}`}
      style={
        {
          "--reader-scroll-thumb": `max(${MIN_THUMB}px, ${thumbShare * 100}%)`,
          "--reader-scroll-along": along,
        } as CSSProperties
      }
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const thumb = thumbSize();
        const start = (vertical ? box.top : box.left) + along * travel(thumb);
        const point = coordinate(event);
        if (point >= start && point <= start + thumb) {
          drag.current = { pointer: event.pointerId, from: point, position: metrics.position };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          return;
        }
        // The track pages toward the press, as a system scrollbar does.
        const toward = point < start ? -1 : 1;
        const step = toward * (metrics.reversed ? -1 : 1) * metrics.visible * 0.9;
        track.scrollTo(metrics.position + step);
      }}
      onPointerMove={(event) => {
        const held = drag.current;
        if (!held || held.pointer !== event.pointerId) return;
        const moved = (coordinate(event) - held.from) * (metrics.reversed ? -1 : 1);
        track.scrollTo(held.position + (moved / travel(thumbSize())) * metrics.length);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <span className="reader-scrollbar__thumb" />
    </div>
  );
}

function sameMetrics(a: ReaderScrollMetrics | null, b: ReaderScrollMetrics | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.axis === b.axis &&
    a.reversed === b.reversed &&
    a.position === b.position &&
    a.length === b.length &&
    a.visible === b.visible
  );
}
