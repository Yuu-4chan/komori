import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

// How far the arrow, which moves half as far as the finger, must come down to sync, and the
// most it follows, in CSS pixels.
const enough = 36;
const most = 72;
// How far the finger moves before the gesture counts as a pull or as a sideways swipe.
const decide = 10;

/**
 * Pulling the page down from its top, as the Library's, runs `onPull`, with a turning arrow
 * that follows the finger and spins until it is done. A touch that first moves more sideways
 * than down, as a swipe along a carousel does, is no pull however it drifts after.
 */
export function PullToSync({
  enabled,
  onPull,
}: {
  enabled: boolean;
  onPull: () => Promise<unknown>;
}) {
  const [pulled, setPulled] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const pull = useRef(onPull);
  pull.current = onPull;

  useEffect(() => {
    const page = document.getElementById("main-content");
    if (!enabled || !page) return;
    let start: number | null = null;
    let startX = 0;
    let pulling = false;
    let distance = 0;
    let busy = false;
    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        !busy && page.scrollTop <= 0 && event.touches.length === 1 && touch ? touch.clientY : null;
      startX = touch?.clientX ?? 0;
      pulling = false;
      distance = 0;
    };
    const move = (event: TouchEvent) => {
      if (start === null) return;
      const touch = event.touches[0];
      const down = (touch?.clientY ?? start) - start;
      if (!pulling) {
        const sideways = Math.abs((touch?.clientX ?? startX) - startX);
        if (Math.max(sideways, Math.abs(down)) < decide) return;
        if (sideways >= Math.abs(down)) {
          start = null;
          return;
        }
        pulling = true;
      }
      if (down <= 0 || page.scrollTop > 0) {
        start = distance > 0 ? start : null;
        distance = 0;
        setPulled(0);
        return;
      }
      distance = Math.min(most, down / 2);
      setPulled(distance);
    };
    const end = () => {
      const far = distance >= enough;
      start = null;
      distance = 0;
      if (!far) {
        setPulled(0);
        return;
      }
      busy = true;
      setSyncing(true);
      void pull.current().finally(() => {
        busy = false;
        setSyncing(false);
        setPulled(0);
      });
    };
    page.addEventListener("touchstart", begin, { passive: true });
    page.addEventListener("touchmove", move, { passive: true });
    page.addEventListener("touchend", end);
    page.addEventListener("touchcancel", end);
    return () => {
      page.removeEventListener("touchstart", begin);
      page.removeEventListener("touchmove", move);
      page.removeEventListener("touchend", end);
      page.removeEventListener("touchcancel", end);
    };
  }, [enabled]);

  const shown = syncing ? enough : pulled;
  if (!shown) return null;
  return (
    <div
      aria-hidden="true"
      className={syncing ? "mobile-pull mobile-pull--syncing" : "mobile-pull"}
      style={
        {
          "--pull-down": `${shown - 8}px`,
          "--pull-shown": Math.min(1, shown / enough),
          "--pull-turn": `${shown * 6}deg`,
        } as CSSProperties
      }
    >
      <span>
        <ArrowsClockwiseIcon weight="bold" />
      </span>
    </div>
  );
}
