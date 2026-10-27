import { i18n } from "../../i18n/i18n";
import type { ReaderProgressUnit } from "../reader/renderer";
import { speed } from "./statistics";

/** One stretch of reading a book, as native code stores it. Times are Unix milliseconds. */
export interface ReadingSession {
  id: string;
  startedAt: number;
  endedAt: number;
  /** Time actually read: stretches without progress, an unfocused/hidden window, and a closed Reader excluded. */
  activeMs: number;
  unit: ReaderProgressUnit;
  /** Units read forward from where reading began or last jumped to, each counted once. */
  unitsRead: number;
  /** The book's position when the session began and where it ended. */
  startUnits: number;
  endUnits: number;
  totalUnits: number;
}

/** Units read per hour of active reading, in the book's counted unit. */
export interface ReadingSpeed {
  perHour: number;
  unit: ReaderProgressUnit;
}

/** Formats a speed as the Reader shows it: `31,200 Ch./h`, `14,400 Wo./h`. */
export function formatReadingSpeed({ perHour, unit }: ReadingSpeed): string {
  return i18n().t(unit === "characters" ? "speed.chars" : "speed.words", { count: perHour });
}

/** A gap between ticks longer than this (a suspended timer) is not counted. */
const maxTickMs = 5000;
/** A single forward move further than this is a jump (such as a scrollbar drag), not reading. */
export const maxReadStep = 5000;
/** A session is recorded once it read something or was read for this long. */
export const minRecordedMs = 30 * 1000;

interface Position {
  unit: ReaderProgressUnit;
  current: number;
  total: number;
}

/**
 * When the session starts counting: `now` as it is created, `read` at the first forward move,
 * or `manual` only through `start()`.
 */
export type SessionStart = "now" | "read" | "manual";

export interface SessionOptions {
  start?: SessionStart;
  /** A move further than this in units, forward or back, is reported as a jump; 0 never. */
  jumpLimit?: number;
  /**
   * Shown time without reading forward after which the session stops counting, and the time
   * since its last forward move is dropped, until it reads forward again; 0 never stops it.
   */
  idleLimitMs?: number;
}

/**
 * Measures one Reader session: active time from ticks while it counts and the window is focused
 * and visible, and units read from forward moves. Time since the last forward move stays
 * provisional: past `idleLimitMs` it is dropped, so time away from the book never lowers the
 * speed, and counting waits for the next forward move. Going back and reading again counts the
 * same text once; a jump starts counting afresh. A paused session counts neither time nor units.
 */
export class ReadingSessionTracker {
  readonly id: string;
  /** When it first counted, or when it was created until then. */
  startedAt: number;
  /** Time up to the last forward move, a pause, or the start. */
  private confirmedMs = 0;
  /** Time since then; dropped when it passes the idle limit. */
  private pendingMs = 0;
  /** Stopped for want of progress, until the next forward move. */
  private idle = false;
  private endedAt: number;
  /** When `confirmedMs` last grew, where an idle session ends. */
  private confirmedAt: number;
  private lastTick: number;
  private start: Position | null = null;
  /** Where the session ends: the latest position, not counting a jump past the limit. */
  private position: Position | null = null;
  /** The latest position reported, to measure the next move from. */
  private last: Position | null = null;
  /** The furthest point reached since reading began or last jumped. */
  private furthest = 0;
  private unitsRead = 0;
  private running: boolean;
  private started: boolean;
  private readonly startMode: SessionStart;
  private readonly jumpLimit: number;
  private readonly idleLimitMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    id: string = crypto.randomUUID(),
    { start = "now", jumpLimit = 0, idleLimitMs = 0 }: SessionOptions = {},
  ) {
    this.id = id;
    this.startedAt = now();
    this.endedAt = this.startedAt;
    this.confirmedAt = this.startedAt;
    this.lastTick = this.startedAt;
    this.startMode = start;
    this.jumpLimit = jumpLimit;
    this.idleLimitMs = idleLimitMs;
    this.running = start === "now";
    this.started = this.running;
  }

  /** Whether time and reading count now. */
  get counting() {
    return this.running;
  }

  /** Starts counting, or resumes after a pause. */
  resume() {
    if (this.running) return;
    const now = this.now();
    if (!this.started) {
      this.started = true;
      this.startedAt = now;
      this.endedAt = now;
      // The session's start is where counting began.
      if (this.last) this.start = this.position = this.last;
    }
    this.running = true;
    this.idle = false;
    this.lastTick = now;
  }

  /** Stops counting until `resume`, keeping what was counted: a pause is chosen, not idle. */
  pause() {
    if (!this.running) return;
    this.tick(true);
    this.confirm();
    this.running = false;
  }

  /** Keeps the provisional time: the reader read forward or paused. */
  private confirm() {
    this.idle = false;
    if (this.pendingMs <= 0) return;
    this.confirmedMs += this.pendingMs;
    this.pendingMs = 0;
    this.confirmedAt = this.endedAt;
  }

  /** Counts the time since the previous tick when it was read. */
  tick(visible: boolean) {
    const now = this.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (!this.running || this.idle || !visible || elapsed <= 0 || elapsed > maxTickMs) return;
    this.pendingMs += elapsed;
    if (this.idleLimitMs > 0 && this.pendingMs > this.idleLimitMs) {
      // Away from the book: the time since the last forward move was not reading.
      this.pendingMs = 0;
      this.idle = true;
      this.endedAt = this.confirmedAt;
      return;
    }
    this.endedAt = now;
  }

  /**
   * The book's position after a turn, a scroll, or (`jumped`) any other move. Returns `jump`
   * when the move went further than the jump limit; it is not counted.
   */
  progress({ unit, current, total }: Position, jumped: boolean, active = true): "jump" | undefined {
    if (!(total > 0) || current < 0 || current > total) return;
    const next = { unit, current, total };
    const previous = this.last;
    this.last = next;
    if (!this.start || previous?.unit !== unit) {
      this.start = next;
      this.position = next;
      this.furthest = current;
      return;
    }
    // Background navigation establishes a baseline without starting, counting or ending a session.
    if (!active) {
      this.position = next;
      this.furthest = current;
      return;
    }
    // The session keeps the position from before the jump as its end.
    if (this.jumpLimit > 0 && Math.abs(current - previous.current) > this.jumpLimit) {
      this.furthest = current;
      return "jump";
    }
    this.position = next;
    if (jumped || current - this.furthest > maxReadStep) {
      this.furthest = current;
    } else if (current > this.furthest) {
      if (!this.started && this.startMode === "read") {
        this.resume();
        // Reading began where this move started.
        this.start = previous;
      }
      if (this.running) {
        this.unitsRead += current - this.furthest;
        if (this.idle) {
          // Reading again: counting resumes from now.
          this.idle = false;
          this.lastTick = this.now();
        }
        this.confirm();
      }
      this.furthest = current;
    }
  }

  /** The active time so far, for the Reader's footer. */
  get readingMs() {
    return this.confirmedMs + this.pendingMs;
  }

  /**
   * The session's units read per hour of active time, or null until a minute was read
   * in a counted book.
   */
  get readingSpeed(): ReadingSpeed | null {
    if (!this.position) return null;
    const perHour = speed(this.unitsRead, this.readingMs);
    return perHour === null ? null : { perHour, unit: this.position.unit };
  }

  /** The session to save, or null while it has no counted book or nothing worth recording. */
  record(): ReadingSession | null {
    const { start, position } = this;
    if (!start || !position || !this.started) return null;
    if (this.unitsRead <= 0 && this.readingMs < minRecordedMs) return null;
    const endedAt = Math.max(this.endedAt, this.startedAt);
    return {
      id: this.id,
      startedAt: this.startedAt,
      endedAt,
      activeMs: Math.min(Math.round(this.readingMs), endedAt - this.startedAt),
      unit: position.unit,
      unitsRead: this.unitsRead,
      startUnits: Math.min(start.current, position.total),
      endUnits: position.current,
      totalUnits: position.total,
    };
  }
}

/** Formats a duration as Statistics shows it: `45m`, `2h 05m`, `<1m` under a minute, `0m` for none. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(minutes / 60);
  const { t } = i18n();
  // Reading under a minute still shows, rather than as no reading at all.
  if (minutes === 0 && ms > 0) return t("duration.underMinute");
  if (hours === 0) return t("duration.minutes", { minutes: String(minutes) });
  return t("duration.hoursMinutes", {
    hours: String(hours),
    minutes: String(minutes % 60).padStart(2, "0"),
  });
}

/** Formats a duration with its seconds, as the Reader shows it: `12m 05s`, `1h 02m 05s`. */
export function formatDurationSeconds(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, "0");
  const { t } = i18n();
  if (hours === 0) return t("duration.minutesSeconds", { minutes: String(minutes), seconds: rest });
  return t("duration.hoursMinutesSeconds", {
    hours: String(hours),
    minutes: String(minutes).padStart(2, "0"),
    seconds: rest,
  });
}
