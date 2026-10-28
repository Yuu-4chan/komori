export type TurnDirection = "advance" | "retreat";

const EXCLUDED =
  'button, a, input, textarea, select, option, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-reader-navigation-exclude]';

/**
 * Whether Space may finish a VN text reveal from where it was pressed: anywhere in the
 * book or Reader, but never in a dialog, menu or list, or on a control.
 */
export function revealsVnText(target: EventTarget | null): boolean {
  if (!target || (target as Node).nodeType !== 1) return true;
  const element = target as Element;
  if (
    element.closest('dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]')
  )
    return false;
  return !element.closest(EXCLUDED);
}

export function acceptsReaderInput(target: EventTarget | null, contentDocument = false): boolean {
  // EPUB content lives in a separate window, so instanceof Element uses the wrong realm.
  if (!target || (target as Node).nodeType !== 1) return false;
  const element = target as Element;
  if (element.closest(EXCLUDED)) return false;
  if (!contentDocument && !element.closest(".reader-viewport")) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (
      contentDocument &&
      (node === element.ownerDocument.body || node === element.ownerDocument.documentElement)
    )
      break;
    if (!contentDocument && node.classList.contains("reader-viewport")) break;
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)
      return false;
  }
  return true;
}

/**
 * The reading direction of an arrow key, which turns a page or scrolls a continuous book:
 * Left and Right follow the page direction, and Down reads on and Up goes back in either
 * axis.
 */
export function arrowTurn(
  key: string,
  forwardArrow: "ArrowLeft" | "ArrowRight",
): TurnDirection | null {
  if (key === "ArrowDown") return "advance";
  if (key === "ArrowUp") return "retreat";
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  return key === forwardArrow ? "advance" : "retreat";
}

/**
 * The reading direction of a page key, a whole page turn in every view: Page Down and
 * Space read on, Page Up and Shift+Space go back.
 */
export function pageKey(key: string, shift: boolean): TurnDirection | null {
  if (key === " ") return shift ? "retreat" : "advance";
  if (shift) return null;
  if (key === "PageDown") return "advance";
  if (key === "PageUp") return "retreat";
  return null;
}

/** How far one arrow key press scrolls: a tenth of the reading area, at least 40px. */
export function arrowScrollDistance(extent: number): number {
  return Math.max(40, Math.round(extent / 10));
}

/**
 * Reader wheel step choices: how far one mouse wheel step scrolls a continuous book, in
 * CSS pixels. Keep in step with `src-tauri/src/appearance_preferences.rs`.
 */
export const readerWheelStep = { min: 10, max: 2000, step: 10, default: 100 } as const;

/** A supported wheel step: a whole step within range, or the default for anything else. */
export function normalizeWheelStep(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerWheelStep.default;
  const stepped = Math.round(value / readerWheelStep.step) * readerWheelStep.step;
  return Math.min(readerWheelStep.max, Math.max(readerWheelStep.min, stepped));
}

/** Whether a value is already a supported wheel step. */
export function isWheelStep(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= readerWheelStep.min &&
    (value as number) <= readerWheelStep.max &&
    (value as number) % readerWheelStep.step === 0
  );
}

/** The wheel delta, in pixels, that the browser reports for one mouse wheel step. */
const wheelStepDelta = 100;

/** A wheel event's vertical movement in wheel steps, fractional for finer input. */
export function wheelSteps(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  // Line mode reports three lines per step, page mode one page.
  if (deltaMode === 1) return deltaY / 3;
  if (deltaMode === 2) return deltaY;
  return deltaY / wheelStepDelta;
}

/**
 * The whole steps of a mouse wheel event, or null for finer movement such as a
 * touchpad's. A mouse wheel reports at least half a step at a time, and a little more
 * than one under some display scales, so such an event is its whole steps and at least
 * one: every step of the wheel counts exactly once.
 */
export function wholeWheelSteps(steps: number): number | null {
  const size = Math.abs(steps);
  if (!(size >= 0.5)) return null;
  return Math.sign(steps) * Math.max(1, Math.floor(size));
}

/**
 * Counts wheel steps for page turns: each mouse wheel step is one page, and finer
 * movement turns a page once a whole step's worth has built up in one direction.
 */
export class WheelStepCounter {
  private partial = 0;
  private direction = 0;

  /** The pages this movement turns, negative backwards. */
  consume(steps: number): number {
    if (!Number.isFinite(steps) || steps === 0) return 0;
    const sign = Math.sign(steps);
    if (sign !== this.direction) {
      this.partial = 0;
      this.direction = sign;
    }
    const whole = wholeWheelSteps(steps);
    if (whole !== null) {
      this.partial = 0;
      return whole;
    }
    this.partial += Math.abs(steps);
    if (this.partial < 1) return 0;
    this.partial -= 1;
    return sign;
  }

  reset() {
    this.partial = 0;
    this.direction = 0;
  }
}

/** Wheel steps required at a settled chapter edge, independently of page turns. */
export const readerChapterWheelThreshold = { min: 1, max: 20, step: 1, default: 3 } as const;

export function isChapterWheelThreshold(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20;
}

/** Serial page input. Only movement received at a settled edge can authorize crossing it. */
export class WheelNavigationQueue {
  private counter = new WheelStepCounter();
  private queued = 0;
  private direction = 0;
  private edgeAmount = 0;
  private permit = 0;
  private lastInput = 0;

  constructor(private threshold = readerChapterWheelThreshold.default as number) {}

  add(steps: number, atEdge: boolean, busy: boolean, now = performance.now()) {
    if (!Number.isFinite(steps) || steps === 0) return;
    const direction = Math.sign(steps);
    if (direction !== this.direction || now - this.lastInput > 700) this.reset();
    this.direction = direction;
    this.lastInput = now;
    if (atEdge) {
      this.counter.reset();
      this.queued = 0;
      // Input queued before this page finished arriving cannot buy a chapter change.
      if (busy) return;
      this.edgeAmount += Math.abs(wholeWheelSteps(steps) ?? steps);
      if (this.edgeAmount + 1e-9 >= this.threshold) {
        this.permit = direction;
        this.queued = direction;
        this.edgeAmount = 0;
      }
    } else {
      this.edgeAmount = 0;
      this.permit = 0;
      this.queued = Math.max(-50, Math.min(50, this.queued + this.counter.consume(steps)));
    }
  }

  /** Recheck the actual page before every queued turn. Discard excess at a new edge. */
  take(atEdge: boolean): number {
    const direction = Math.sign(this.queued);
    if (!direction) return 0;
    if (atEdge) {
      const permitted = this.permit === direction;
      this.queued = 0;
      this.permit = 0;
      this.counter.reset();
      return permitted ? direction : 0;
    }
    this.queued -= direction;
    return direction;
  }

  get pendingDirection() {
    return Math.sign(this.queued);
  }

  reset() {
    this.counter.reset();
    this.queued = 0;
    this.direction = 0;
    this.edgeAmount = 0;
    this.permit = 0;
    this.lastInput = 0;
  }
}
