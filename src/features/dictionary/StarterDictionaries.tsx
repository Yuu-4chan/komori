import { ArrowClockwiseIcon, CheckIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { starterActive, type StarterEntry, useStarterDictionaries } from "./useStarterDictionaries";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";

/** Komori's own words for the sources it offers; the native catalog's are the fallback. */
const starterText: Record<string, { name?: MessageKey; description: MessageKey }> = {
  jitendex: { description: "starter.jitendexDescription" },
  jmdict: { description: "starter.jmdictDescription" },
  kanjidic: { description: "starter.kanjidicDescription" },
  jmnedict: { description: "starter.jmnedictDescription" },
  jiten: { name: "starter.jitenName", description: "starter.jitenDescription" },
};
const starterName = (entry: StarterEntry) => {
  const key = starterText[entry.id]?.name;
  return key ? i18n().t(key) : entry.name;
};

export function StarterDictionaries({
  empty,
  installed,
  busy,
  starter,
}: {
  empty: boolean;
  /** Titles of the installed dictionaries; a removed download is offered again. */
  installed: readonly string[];
  busy: boolean;
  starter: ReturnType<typeof useStarterDictionaries>;
}) {
  const { snapshot, error, retry, download, dismiss } = starter;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState(false);
  const { t } = useI18n();
  const visible = empty || (snapshot?.started && !snapshot.dismissed);
  if (!visible) return null;
  const active = starterActive(snapshot);
  async function act(action: () => Promise<unknown>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setActionError(false);
    try {
      await action();
    } catch {
      setActionError(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <section className="starter-dictionaries" aria-labelledby="starter-title">
      <div className="settings-section-header">
        <div>
          <h3 id="starter-title">{t("starter.title")}</h3>
          <span>{t("starter.description")}</span>
        </div>
        {!empty && !active && (
          <Button tone="quiet" disabled={pending} onClick={() => void act(dismiss)}>
            {t("common.done")}
          </Button>
        )}
      </div>
      {!snapshot && !error && <p role="status">{t("starter.loading")}</p>}
      {error && (
        <p role="alert">
          {t("starter.loadFailed")}{" "}
          <Button tone="quiet" onClick={retry}>
            {t("common.tryAgain")}
          </Button>
        </p>
      )}
      {actionError && <p role="alert">{t("starter.actionFailed")}</p>}
      {snapshot && (
        <div className="settings-list starter-dictionaries__list">
          {snapshot.entries.map((shown) => {
            const removed =
              (shown.phase === "imported" || shown.phase === "alreadyImported") &&
              !installed.includes(shown.title ?? "");
            const entry: StarterEntry = removed ? { ...shown, phase: "ready" } : shown;
            const name = starterName(entry);
            const failed = entry.phase === "failed" || entry.phase === "interrupted";
            const added = entry.phase === "imported" || entry.phase === "alreadyImported";
            return (
              <article
                className="settings-row starter-dictionaries__source"
                key={entry.id}
                aria-labelledby={`starter-${entry.id}`}
              >
                <div>
                  <h4 id={`starter-${entry.id}`}>{name}</h4>
                  <span>
                    {starterText[entry.id]
                      ? t(starterText[entry.id].description)
                      : entry.description}
                  </span>
                  <small>
                    {entry.attribution}{" "}
                    <button
                      className="settings-inline-link"
                      type="button"
                      onClick={() =>
                        void act(() =>
                          invoke("open_starter_information", { id: entry.id, license: false }),
                        )
                      }
                    >
                      {t("starter.source")}
                    </button>
                    {" · "}
                    <button
                      className="settings-inline-link"
                      type="button"
                      onClick={() =>
                        void act(() =>
                          invoke("open_starter_information", { id: entry.id, license: true }),
                        )
                      }
                    >
                      {entry.license}
                    </button>
                  </small>
                  {entry.phase !== "ready" && (
                    <p
                      className={`starter-dictionaries__status${added ? " starter-dictionaries__status--added" : ""}`}
                      role="status"
                    >
                      {added && <CheckIcon aria-hidden="true" weight="bold" />}
                      {status(entry)}
                    </p>
                  )}
                  {entry.phase === "downloading" && (
                    <progress
                      aria-label={t("starter.progress", { name })}
                      max={entry.total ?? undefined}
                      value={entry.total ? entry.received : undefined}
                    />
                  )}
                </div>
                <Button
                  aria-label={t(failed ? "starter.retry" : "starter.download", { name })}
                  disabled={busy || active || pending}
                  icon={
                    failed ? (
                      <ArrowClockwiseIcon aria-hidden="true" />
                    ) : (
                      <DownloadSimpleIcon aria-hidden="true" />
                    )
                  }
                  tone="secondary"
                  onClick={() => void act(() => download(entry.id))}
                >
                  {t(failed ? "starter.retryShort" : "starter.downloadShort")}
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function status(entry: StarterEntry): string {
  const { t, number } = i18n();
  const megabytes = (bytes: number) =>
    number(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  switch (entry.phase) {
    case "ready":
      return "";
    case "downloading":
      return entry.total
        ? t("starter.downloadingOf", {
            received: megabytes(entry.received),
            total: megabytes(entry.total),
          })
        : t("starter.downloading", { received: megabytes(entry.received) });
    case "verifying":
      return t("starter.verifying");
    case "importing":
      return t("starter.importing");
    case "imported":
      return t("starter.imported");
    case "alreadyImported":
      return t("starter.alreadyImported");
    case "interrupted":
      return t("starter.interrupted");
    case "failed":
      return t("starter.failed");
  }
}
