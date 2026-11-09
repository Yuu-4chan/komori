import {
  ArrowsClockwiseIcon,
  CheckIcon,
  DownloadSimpleIcon,
  MonitorIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useState } from "react";

import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ToggleSetting } from "../components/ui/ToggleSetting";
import { rowCounts } from "../features/dictionary/DictionarySources";
import { timeAgo } from "../features/library/libraryView";
import { formatSize } from "../features/storage/formatSize";
import { useI18n, type MessageKey } from "../i18n/i18n";
import {
  checkPc,
  clearPcCovers,
  copyPcDictionary,
  getPcLink,
  listPcDictionaries,
  onPcSynced,
  onPcTransfer,
  pairPc,
  pcErrorKey,
  pcStorage,
  setPcAddress,
  setPcSync,
  syncPc,
  transferPercent,
  unpairPc,
  type PcDictionary,
  type PcLink,
  type PcStorage,
} from "./pcLinkApi";

type Status =
  | { kind: "checking" }
  | { kind: "connected"; name: string }
  | { kind: "problem"; message: MessageKey };

const validPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/**
 * Settings > Sync on the phone: whether it syncs with Komori PC, where the PC is and the code
 * it pairs with, whether the PC answers and when the phone last synced, syncing now, the PC's
 * dictionaries to copy here, and unpairing.
 */
export function MobileSyncSettings() {
  const { t } = useI18n();
  const ids = { address: useId(), port: useId(), code: useId() };
  const [link, setLink] = useState<PcLink | null>(null);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [dictionaries, setDictionaries] = useState<PcDictionary[] | null>(null);
  const [copying, setCopying] = useState<Record<string, number>>({});
  const [unpairing, setUnpairing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [storage, setStorage] = useState<PcStorage | null>(null);
  const [clearing, setClearing] = useState(false);

  const show = useCallback((saved: PcLink) => {
    setLink(saved);
    setAddress(saved.address);
    setPort(String(saved.port));
  }, []);

  useEffect(() => {
    let active = true;
    void getPcLink().then(
      (saved) => {
        if (active) show(saved);
      },
      () => {
        if (active) setProblem("sync.error.failed");
      },
    );
    return () => {
      active = false;
    };
  }, [show]);

  const paired = link?.paired ?? false;
  const check = useCallback(async () => {
    setStatus({ kind: "checking" });
    try {
      const answer = await checkPc();
      if (answer.status !== "connected") {
        setStatus({ kind: "problem", message: pcErrorKey(answer.status) });
        return;
      }
      setStatus({ kind: "connected", name: answer.name ?? "" });
      setDictionaries(await listPcDictionaries());
    } catch (error) {
      setStatus({ kind: "problem", message: pcErrorKey(error) });
    }
  }, []);

  useEffect(() => {
    if (paired) void check();
    else setDictionaries(null);
  }, [paired, check]);

  // What the PC's books and covers take here, read from the phone alone.
  useEffect(() => {
    let active = true;
    if (paired)
      void pcStorage().then(
        (sizes) => {
          if (active) setStorage(sizes);
        },
        () => {},
      );
    else setStorage(null);
    return () => {
      active = false;
    };
  }, [paired]);

  async function clearCovers() {
    setClearing(true);
    try {
      setStorage(await clearPcCovers());
    } catch {
      setProblem("sync.error.failed");
    } finally {
      setClearing(false);
    }
  }

  // A sync started elsewhere, as on returning to Komori, shows here too.
  useEffect(() => onPcSynced(show), [show]);

  async function syncNow() {
    setSyncing(true);
    try {
      show(await syncPc());
      setStatus((current) =>
        current.kind === "connected" ? current : { kind: "connected", name: pcName },
      );
    } catch (error) {
      setStatus({ kind: "problem", message: pcErrorKey(error) });
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    const stop = onPcTransfer((transfer) => {
      if (transfer.kind !== "dictionary") return;
      setCopying((current) =>
        current[transfer.id] === undefined
          ? current
          : { ...current, [transfer.id]: transferPercent(transfer) },
      );
    });
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  async function run(action: () => Promise<PcLink>) {
    setBusy(true);
    setProblem(null);
    try {
      show(await action());
      return true;
    } catch (error) {
      setProblem(pcErrorKey(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pair() {
    const value = Number(port);
    if (!validPort(value)) {
      setPort(String(link?.port ?? ""));
      return;
    }
    if (await run(() => pairPc(address, value, code))) setCode("");
  }

  // A paired phone follows the PC to a new address or port without pairing again.
  function commitPlace() {
    if (!link || !paired) return;
    const value = Number(port);
    if (!validPort(value)) {
      setPort(String(link.port));
      return;
    }
    if (address.trim() === link.address && value === link.port) return;
    void run(() => setPcAddress(address, value)).then((saved) => {
      if (saved) void check();
    });
  }

  async function copy(dictionary: PcDictionary) {
    const key = String(dictionary.id);
    setCopying((current) => ({ ...current, [key]: 0 }));
    setProblem(null);
    try {
      await copyPcDictionary(dictionary.id);
      setDictionaries((current) =>
        current
          ? current.map((each) => (each.id === dictionary.id ? { ...each, onPhone: true } : each))
          : current,
      );
    } catch (error) {
      setProblem(pcErrorKey(error));
    } finally {
      setCopying(({ [key]: _done, ...rest }) => rest);
    }
  }

  const pcName = link?.pcName ?? "";
  const lastSynced = timeAgo(link?.lastSynced);
  const fieldProps = {
    autoCapitalize: "off",
    autoCorrect: "off",
    className: "mobile-field__input",
    disabled: !link || busy,
    spellCheck: false,
  } as const;

  return (
    <div className="mobile-sync" aria-busy={!link || busy}>
      <div className="mobile-group">
        <ToggleSetting
          checked={link?.syncOn ?? false}
          disabled={!paired || busy}
          label={t("sync.on")}
          onChange={(on) => void run(() => setPcSync(on))}
        />
      </div>

      <section className="mobile-sync__section" aria-labelledby="mobile-sync-connection">
        <h2 className="mobile-section-heading" id="mobile-sync-connection">
          {t("sync.connection")}
        </h2>
        <div className="mobile-group">
          <div className="mobile-field">
            <label htmlFor={ids.address}>{t("sync.address")}</label>
            <input
              {...fieldProps}
              id={ids.address}
              inputMode="url"
              onBlur={commitPlace}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="192.168.0.10"
              value={address}
            />
          </div>
          <div className="mobile-field">
            <label htmlFor={ids.port}>{t("sync.port")}</label>
            <input
              {...fieldProps}
              id={ids.port}
              inputMode="numeric"
              onBlur={commitPlace}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
              value={port}
            />
          </div>
          <div className="mobile-field">
            <label htmlFor={paired ? undefined : ids.code}>{t("sync.code")}</label>
            {paired ? (
              <span className="mobile-sync__paired">
                <CheckIcon aria-hidden="true" weight="bold" />
                {t("sync.paired")}
              </span>
            ) : (
              <span className="mobile-sync__pair">
                <input
                  {...fieldProps}
                  autoComplete="one-time-code"
                  id={ids.code}
                  inputMode="numeric"
                  maxLength={7}
                  onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ""))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void pair();
                  }}
                  placeholder="000 000"
                  value={code}
                />
                <Button
                  disabled={
                    !link || busy || code.replace(/\D/g, "").length !== 6 || !address.trim()
                  }
                  onClick={() => void pair()}
                >
                  {busy ? t("sync.pairing") : t("sync.pair")}
                </Button>
              </span>
            )}
          </div>
        </div>
        {problem && !unpairing ? (
          <p className="mobile-sync__problem" role="alert">
            {t(problem, { name: pcName })}
          </p>
        ) : null}
      </section>

      {paired ? (
        <>
          <section className="mobile-group mobile-sync__status" aria-live="polite">
            <div className="mobile-sync__state">
              <span aria-hidden="true" className="mobile-sync__pc">
                <MonitorIcon />
              </span>
              <span className="mobile-row__text">
                <span className="mobile-row__label">
                  {status.kind === "connected" ? (
                    <>
                      <span aria-hidden="true" className="mobile-sync__dot" />
                      {t("sync.connected", { name: status.name || pcName })}
                    </>
                  ) : (
                    pcName
                  )}
                </span>
                {status.kind !== "connected" ? (
                  <span className="mobile-row__detail">
                    {status.kind === "checking"
                      ? t("sync.checking")
                      : t(status.message, { name: pcName })}
                  </span>
                ) : lastSynced ? (
                  <span className="mobile-row__detail">
                    {t("sync.lastSynced", { time: lastSynced })}
                  </span>
                ) : null}
              </span>
              {status.kind === "problem" ? (
                <Button tone="secondary" onClick={() => void check()}>
                  {t("common.tryAgain")}
                </Button>
              ) : null}
            </div>
            {link?.syncOn ? (
              <button
                aria-busy={syncing}
                className="mobile-sync__now"
                disabled={status.kind !== "connected" || syncing}
                onClick={() => void syncNow()}
                type="button"
              >
                <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
                {t("sync.syncNow")}
              </button>
            ) : null}
          </section>

          {dictionaries && dictionaries.length > 0 ? (
            <section className="mobile-sync__section" aria-labelledby="mobile-sync-dictionaries">
              <h2 className="mobile-section-heading" id="mobile-sync-dictionaries">
                {t("sync.dictionaries", { name: pcName })}
              </h2>
              <ul className="mobile-group mobile-sync__dictionaries">
                {dictionaries.map((dictionary) => {
                  const percent = copying[String(dictionary.id)];
                  const size = dictionary.size ? formatSize(dictionary.size) : null;
                  return (
                    <li className="mobile-sync__dictionary" key={dictionary.id}>
                      <span className="mobile-row__text">
                        <span className="mobile-row__label">{dictionary.title}</span>
                        <span className="mobile-row__detail">
                          {size ? `${rowCounts(dictionary)} · ${size}` : rowCounts(dictionary)}
                        </span>
                      </span>
                      {dictionary.onPhone ? (
                        <span className="mobile-sync__saved">
                          <CheckIcon aria-hidden="true" weight="bold" />
                          {t("sync.onPhone")}
                        </span>
                      ) : percent !== undefined ? (
                        <span
                          aria-label={t("sync.copying", { percent })}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={percent}
                          className="mobile-sync__copying"
                          role="progressbar"
                        >
                          <span className="mobile-sync__bar">
                            <span style={{ width: `${percent}%` }} />
                          </span>
                          {percent}%
                        </span>
                      ) : (
                        <button
                          className="mobile-sync__copy"
                          disabled={status.kind !== "connected"}
                          onClick={() => void copy(dictionary)}
                          type="button"
                        >
                          <DownloadSimpleIcon aria-hidden="true" weight="bold" />
                          {t("sync.copy")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {storage ? (
            <section className="mobile-sync__section" aria-labelledby="mobile-sync-storage">
              <h2 className="mobile-section-heading" id="mobile-sync-storage">
                {t("settings.storage")}
              </h2>
              <ul className="mobile-group mobile-sync__dictionaries">
                <li className="mobile-sync__dictionary">
                  <span className="mobile-row__text">
                    <span className="mobile-row__label">
                      {t("sync.storageBooks", { name: pcName })}
                    </span>
                    <span className="mobile-row__detail">
                      {formatSize(storage.kept + storage.cached)}
                    </span>
                  </span>
                </li>
                <li className="mobile-sync__dictionary">
                  <span className="mobile-row__text">
                    <span className="mobile-row__label">{t("sync.storageCovers")}</span>
                    <span className="mobile-row__detail">{formatSize(storage.covers)}</span>
                  </span>
                  <button
                    className="mobile-sync__copy"
                    disabled={clearing || storage.covers === 0}
                    onClick={() => void clearCovers()}
                    type="button"
                  >
                    {t("sync.clear")}
                  </button>
                </li>
              </ul>
            </section>
          ) : null}

          <button
            className="mobile-sync__unpair"
            disabled={busy}
            onClick={() => setUnpairing(true)}
            type="button"
          >
            {t("sync.unpair")}
          </button>
        </>
      ) : null}

      <ConfirmDialog
        busy={busy}
        confirmLabel={t("sync.unpairConfirm")}
        description={t("sync.unpairDescription", { name: pcName })}
        error={unpairing && problem ? t(problem, { name: pcName }) : null}
        onCancel={() => setUnpairing(false)}
        onConfirm={() =>
          void run(unpairPc).then((done) => {
            if (done) setUnpairing(false);
          })
        }
        open={unpairing}
        title={t("sync.unpairTitle", { name: pcName })}
      />
    </div>
  );
}
