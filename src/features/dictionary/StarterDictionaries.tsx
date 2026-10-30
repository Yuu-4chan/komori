import { ArrowClockwiseIcon, CheckIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { starterActive, type StarterEntry, useStarterDictionaries } from "./useStarterDictionaries";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import type { InterfaceLanguage } from "../../i18n/languages";
import { isLookupLanguage, lookupLanguages, type LookupLanguage } from "./lookupLanguage";

/** Komori's own words for the sources it offers; the native catalog's are the fallback. */
const starterText: Record<string, { name?: MessageKey; description: MessageKey }> = {
  jitendex: { description: "starter.jitendexDescription" },
  jmdict: { description: "starter.jmdictDescription" },
  kanjidic: { description: "starter.kanjidicDescription" },
  jmnedict: { description: "starter.jmnedictDescription" },
  jiten: { name: "starter.jitenName", description: "starter.jitenDescription" },
};
const pronunciation = (entry: StarterEntry) => entry.id.endsWith("-ipa");
const starterName = (entry: StarterEntry) => {
  if (entry.id.startsWith("wty-")) {
    return i18n().t(pronunciation(entry) ? "starter.wiktionaryIpa" : "starter.wiktionary");
  }
  const key = starterText[entry.id]?.name;
  return key ? i18n().t(key) : entry.name;
};
const starterDescription = (entry: StarterEntry) => {
  const { t } = i18n();
  const language = (code: string | null) =>
    isLookupLanguage(code) ? t(`lookupLanguage.${code}`) : "";
  if (entry.id.startsWith("wty-")) {
    return pronunciation(entry)
      ? t("starter.wiktionaryIpaDescription", { language: language(entry.language) })
      : t("starter.wiktionaryDescription", {
          language: language(entry.language),
          definitions: language(entry.definitions),
        });
  }
  const text = starterText[entry.id];
  return text ? t(text.description) : entry.description;
};
/** The lookup language closest to an interface language. */
const interfaceLookupLanguage = (language: InterfaceLanguage): string => language.split("-")[0];

export function StarterDictionaries({
  language,
  savedDefinitions = "",
  onDefinitionsChange,
  empty,
  installed,
  busy,
  starter,
}: {
  /** The lookup language whose dictionaries are offered. */
  language: LookupLanguage;
  /** The saved language of the definitions offered; empty follows the interface language. */
  savedDefinitions?: LookupLanguage | "";
  onDefinitionsChange?: (language: LookupLanguage) => void;
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
  const { t, language: interfaceLanguage } = useI18n();
  const offered = snapshot?.entries.filter((entry) => entry.language === language) ?? [];
  const definitionChoices = lookupLanguages.filter((code) =>
    offered.some((entry) => entry.definitions === code),
  );
  // The saved choice, then the interface language, then English, where this language has it.
  const definitions =
    [savedDefinitions, interfaceLookupLanguage(interfaceLanguage), "en"]
      .map((code) => definitionChoices.find((choice) => choice === code))
      .find(Boolean) ?? definitionChoices[0];
  const shown = offered.filter(
    (entry) => entry.definitions === null || entry.definitions === definitions,
  );
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
          {language === "ja" && <span>{t("starter.description")}</span>}
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
          {definitionChoices.length > 1 && definitions && (
            <div className="settings-field">
              <Select
                label={t("starter.definitions")}
                value={definitions}
                options={definitionChoices.map((value) => ({
                  value,
                  label: t(`lookupLanguage.${value}`),
                }))}
                onChange={(value) => onDefinitionsChange?.(value)}
              />
            </div>
          )}
          {shown.map((listed) => {
            const removed =
              (listed.phase === "imported" || listed.phase === "alreadyImported") &&
              !installed.includes(listed.title ?? "");
            const entry: StarterEntry = removed ? { ...listed, phase: "ready" } : listed;
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
                  <span>{starterDescription(entry)}</span>
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
