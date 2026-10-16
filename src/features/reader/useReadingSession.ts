import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { registerWindowFlush, watchWindowVisibility } from "../../app/windowLifecycle";

import {
  ReadingSessionTracker,
  type ReadingSession,
  type SessionStart,
} from "../statistics/readingSession";
import type { SessionStartMode } from "../statistics/statisticsPreferences";
import type { ReaderBookProgress, ReaderRendererFactory } from "./renderer";

/** How often a session in progress is saved again. */
const saveEveryMs = 30 * 1000;
const tickMs = 1000;

export interface SessionRecording {
  /** Off records nothing, and no session runs. */
  enabled: boolean;
  start: SessionStartMode;
  /** Characters or words; 0 never stops a session. */
  jumpLimit: number;
  /** Minutes without reading forward before counting stops; 0 never stops. */
  idleMinutes?: number;
}

/**
 * What the Reader can show: `off` while statistics are disabled or no book is ready,
 * `waiting` until an automatic session's first forward move, `counting`, or `paused`
 * (a manual session, or one paused with `P`, until `P`).
 */
export type SessionState = "off" | "waiting" | "counting" | "paused";

/**
 * Tracks reading sessions while a book is ready and statistics are enabled: active time and
 * the units read, saved through `save` every 30 s, when the window hides/loses focus, and when the book
 * closes. Auto starts counting as the book opens, First character read at the first forward
 * move, and Manual through `toggle` (the Reader's `P`), which also pauses and resumes a session
 * in every mode; a session paused with `P` stays paused until `P`. A move past the jump limit
 * ends an automatic session, so the next forward move starts a new one, and pauses a manual one.
 * After `idleMinutes` without reading forward, counting stops and that stretch is dropped.
 * `readingMs` reads the session's active time and `readingSpeed` its speed.
 */
export function useReadingSession(
  factory: ReaderRendererFactory | undefined,
  ready: boolean,
  progress: ReaderBookProgress | null,
  progressJumped: boolean,
  save?: (session: ReadingSession) => Promise<void>,
  recording: SessionRecording = { enabled: true, start: "auto", jumpLimit: 0, idleMinutes: 0 },
) {
  const trackerRef = useRef<ReadingSessionTracker | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const jumpLimitRef = useRef(recording.jumpLimit);
  const idleMsRef = useRef((recording.idleMinutes ?? 0) * 60_000);
  const jumpedRef = useRef<() => void>(() => {});
  const toggleRef = useRef<() => void>(() => {});
  const focusedRef = useRef(true);
  const [state, setState] = useState<SessionState>("off");
  const { enabled, start: startMode } = recording;

  // A new limit applies to the next session; the current one keeps its own.
  useEffect(() => {
    jumpLimitRef.current = recording.jumpLimit;
    idleMsRef.current = (recording.idleMinutes ?? 0) * 60_000;
  }, [recording.jumpLimit, recording.idleMinutes]);

  useEffect(() => {
    if (!factory || !ready || !enabled) {
      setState("off");
      return;
    }
    const begin = (start: SessionStart) => {
      const next = new ReadingSessionTracker(Date.now, crypto.randomUUID(), {
        start,
        jumpLimit: jumpLimitRef.current,
        idleLimitMs: idleMsRef.current,
      });
      // A book counted before the session began starts it where it is.
      if (progressRef.current) next.progress(progressRef.current, true);
      return next;
    };
    let tracker = begin(startMode === "auto" ? "now" : startMode === "manual" ? "manual" : "read");
    trackerRef.current = tracker;
    // Paused with `P`: no forward move or jump starts counting again until `P`.
    let held = startMode === "manual";
    const show = () => setState(tracker.counting ? "counting" : held ? "paused" : "waiting");
    show();
    let saved = "";
    let writing = Promise.resolve();
    const flush = () => {
      const session = tracker.record();
      if (!session || !save) return writing;
      const key = JSON.stringify(session);
      if (key === saved) return writing;
      saved = key;
      writing = writing.then(() => save(session)).catch(() => {});
      return writing;
    };
    // WebView2 stays "visible" while the window is minimized, so the window is asked too.
    let minimized = false;
    let windowShown = true;
    // Native focus covers the entire window, including EPUB iframes and native dialogs.
    let focused = !isTauri();
    const shown = () =>
      document.visibilityState !== "hidden" && !minimized && windowShown && focused;
    focusedRef.current = shown();
    let wasShown = shown();
    // Hiding counts the shown time up to now and saves; showing again skips the hidden time.
    const visibilityChanged = () => {
      const now = shown();
      if (now === wasShown) return;
      tracker.tick(wasShown);
      wasShown = now;
      focusedRef.current = now;
      if (!now) flush();
    };
    const stopWatching = watchMinimized((value) => {
      minimized = value;
      visibilityChanged();
    });
    const stopVisibility = watchWindowVisibility((value) => {
      windowShown = value;
      visibilityChanged();
    });
    const stopFocus = watchFocus((value) => {
      focused = value;
      visibilityChanged();
    });
    const stopFlushing = registerWindowFlush(() => {
      tracker.tick(shown());
      return flush();
    });
    let lastSave = Date.now();
    const timer = setInterval(() => {
      tracker.tick(shown());
      if (Date.now() - lastSave >= saveEveryMs) {
        lastSave = Date.now();
        flush();
      }
    }, tickMs);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", flush);
    jumpedRef.current = () => {
      if (startMode === "manual" || held) {
        tracker.pause();
        flush();
        held = true;
      } else {
        // The jump ends this session; the next forward move starts another.
        tracker.tick(shown());
        flush();
        tracker = begin("read");
        trackerRef.current = tracker;
        saved = "";
      }
      show();
    };
    toggleRef.current = () => {
      if (!shown()) return;
      if (tracker.counting) {
        tracker.pause();
        flush();
        held = true;
      } else {
        tracker.resume();
        held = false;
      }
      show();
    };
    return () => {
      clearInterval(timer);
      stopWatching();
      stopVisibility();
      stopFocus();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", flush);
      tracker.tick(shown());
      void flush().finally(stopFlushing);
      jumpedRef.current = () => {};
      toggleRef.current = () => {};
      if (trackerRef.current === tracker) trackerRef.current = null;
    };
  }, [factory, ready, save, enabled, startMode]);

  useEffect(() => {
    if (!progress) return;
    const tracker = trackerRef.current;
    if (tracker?.progress(progress, progressJumped, focusedRef.current) === "jump")
      jumpedRef.current();
    // A session waiting for the first forward move shows that it counts once it does.
    else if (tracker?.counting)
      setState((current) => (current === "waiting" ? "counting" : current));
  }, [progress, progressJumped]);

  const toggle = useCallback(() => toggleRef.current(), []);
  const readingMs = useCallback(() => trackerRef.current?.readingMs ?? 0, []);
  const readingSpeed = useCallback(() => trackerRef.current?.readingSpeed ?? null, []);
  return { toggle, state, readingMs, readingSpeed };
}

/** Use native window focus rather than DOM blur, which also fires on entering a book iframe. */
function watchFocus(changed: (focused: boolean) => void): () => void {
  if (!isTauri()) {
    const focus = () => changed(true);
    const blur = () => changed(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }
  const appWindow = getCurrentWindow();
  let active = true;
  let revision = 0;
  const unlisten = appWindow.onFocusChanged(({ payload }) => {
    revision++;
    if (active) changed(payload);
  });
  // Register first so a late initial probe cannot replace a newer event.
  void unlisten
    .then(async () => {
      const current = revision;
      const focused = await appWindow.isFocused();
      if (active && current === revision) changed(focused);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    void unlisten.then((stop) => stop()).catch(() => undefined);
  };
}

/** Reports whether Komori's window is minimized now and whenever it changes size. */
function watchMinimized(changed: (minimized: boolean) => void): () => void {
  if (!isTauri()) return () => {};
  const appWindow = getCurrentWindow();
  let active = true;
  const update = () =>
    void appWindow
      .isMinimized()
      .then((value) => active && changed(value))
      .catch(() => undefined);
  update();
  const unlisten = appWindow.onResized(update);
  return () => {
    active = false;
    void unlisten.then((stop) => stop()).catch(() => undefined);
  };
}
