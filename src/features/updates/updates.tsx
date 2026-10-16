import { isTauri } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { useI18n } from "../../i18n/i18n";
import { failureText } from "../../i18n/failure";
import { getStartupPreferences } from "../startup/startupApi";
import { checkForUpdate, installUpdate, type AvailableUpdate } from "./updatesApi";

/** How long after launch the automatic check waits, so it never competes with opening a book. */
export const STARTUP_CHECK_DELAY = 5000;

type Status = "idle" | "checking" | "current" | "installing";

interface Updates {
  update: AvailableUpdate | null;
  status: Status;
  /** The last manual check's or install's failure, in the interface language. */
  error: string | null;
  /** A manual check, which reports being up to date and its failures. */
  check: () => Promise<void>;
  /** Opens the update dialog again after Later. */
  show: () => void;
}

const UpdatesContext = createContext<Updates | null>(null);

/** The application's updates, or null outside an `UpdatesProvider`. */
export function useUpdates(): Updates | null {
  return useContext(UpdatesContext);
}

/**
 * Owns update checks: one automatic check shortly after launch when the reader allows it, and
 * manual checks from Settings. A found update opens a dialog with its changelog; nothing is
 * downloaded until the reader chooses Install and restart.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const run = useCallback(
    async (manual: boolean) => {
      setStatus("checking");
      if (manual) setError(null);
      try {
        const found = await checkForUpdate();
        setUpdate(found);
        setStatus(found ? "idle" : "current");
        if (found) setOpen(true);
      } catch (failure) {
        setStatus("idle");
        // An automatic check fails quietly; the reader did not ask for it.
        if (manual) setError(failureText(String(failure), t));
      }
    },
    [t],
  );

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void getStartupPreferences().then(
      (preferences) => {
        if (active && preferences.checkForUpdates)
          timer = setTimeout(() => void run(false), STARTUP_CHECK_DELAY);
      },
      () => {},
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // Once per launch, whatever the language does later.
  }, []);

  async function install() {
    setStatus("installing");
    setError(null);
    try {
      await installUpdate();
    } catch (failure) {
      setStatus("idle");
      setError(failureText(String(failure), t));
    }
  }

  const value: Updates = {
    update,
    status,
    error,
    check: () => run(true),
    show: () => setOpen(true),
  };

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      {update ? (
        <ConfirmDialog
          busy={status === "installing"}
          busyLabel={t("updates.installing")}
          cancelLabel={t("updates.later")}
          confirmLabel={t("updates.install")}
          confirmTone="primary"
          description={t("updates.availableDescription", { current: update.currentVersion })}
          dialogRole="dialog"
          error={open ? error : null}
          onCancel={() => setOpen(false)}
          onConfirm={() => void install()}
          open={open}
          title={t("updates.availableTitle", { version: update.version })}
        >
          {update.notes ? <ReleaseNotes notes={update.notes} /> : null}
        </ConfirmDialog>
      ) : null}
    </UpdatesContext.Provider>
  );
}

/**
 * A release's changelog section. It is shown as text: `- ` lines become list items, `#` lines
 * small headings and other lines paragraphs; no markup in the notes is interpreted.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  const { t } = useI18n();
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flushList = () => {
    if (items.length)
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>,
      );
    items = [];
  };
  for (const line of notes.split("\n")) {
    const text = line.trim();
    if (/^[-*] /u.test(text)) {
      items.push(text.slice(2).trim());
      continue;
    }
    // A wrapped list item continues on an indented line.
    if (text && items.length && /^\s/u.test(line)) {
      items[items.length - 1] += ` ${text}`;
      continue;
    }
    flushList();
    if (!text) continue;
    const heading = /^#+\s+(.*)$/u.exec(text);
    blocks.push(
      heading ? <h3 key={blocks.length}>{heading[1]}</h3> : <p key={blocks.length}>{text}</p>,
    );
  }
  flushList();
  return (
    <section aria-label={t("updates.notes")} className="release-notes">
      {blocks}
    </section>
  );
}
