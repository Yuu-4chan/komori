import { DeviceMobileIcon, DevicesIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useI18n } from "../../i18n/i18n";
import { timeAgo } from "../library/libraryView";
import {
  getDevices,
  groupedCode,
  newPairingCode,
  onDevicesChanged,
  removeDevice,
  setDevicesAllowed,
  setDevicesPort,
  type DevicesView,
} from "./devicesApi";

const validPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/**
 * Settings > Devices: whether phones may connect, where they find this PC, the code they pair
 * with, and the phones paired. Each change waits for native confirmation.
 */
export function DevicesSettings() {
  const { t } = useI18n();
  const portId = useId();
  const [view, setView] = useState<DevicesView | null>(null);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "save" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      void getDevices().then(
        (loaded) => {
          if (!active) return;
          setView(loaded);
          setError(null);
        },
        () => {
          if (active) setError("read");
        },
      );
    load();
    const stop = onDevicesChanged(load);
    return () => {
      active = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [attempt]);

  const savedPort = view?.port;
  useEffect(() => {
    if (savedPort !== undefined) setPort(String(savedPort));
  }, [savedPort]);

  async function change(action: () => Promise<DevicesView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch {
      setError("save");
    } finally {
      setBusy(false);
    }
  }

  function commitPort() {
    const value = Number(port);
    if (!view || value === view.port) return;
    if (validPort(value)) void change(() => setDevicesPort(value));
    else setPort(String(view.port));
  }

  const listening = view?.status === "listening";
  const problem = view?.status === "portInUse" || view?.status === "failed" ? view.status : null;
  return (
    <Card className="settings-card settings-card--wide" aria-busy={(!view && !error) || busy}>
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <DevicesIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("devices.title")}</h2>
          <p>{t("devices.description")}</p>
        </div>
      </div>
      {error && (
        <p className="library-notice library-notice--error" role="alert">
          {t(error === "read" ? "devices.readError" : "devices.saveError")}
        </p>
      )}
      <div className="settings-list">
        <ToggleSetting
          label={t("devices.allow")}
          checked={view?.allowed ?? false}
          disabled={!view || busy}
          onChange={(allowed) => void change(() => setDevicesAllowed(allowed))}
        />
        <div className="settings-row">
          <div>
            <strong>{t("devices.address")}</strong>
          </div>
          <span className="devices-value">{view?.address ?? t("devices.noNetwork")}</span>
        </div>
        <div className="settings-field">
          <div className="text-field">
            <label className="text-field__label" htmlFor={portId}>
              {t("devices.port")}
            </label>
            <input
              id={portId}
              className="text-field__input"
              type="number"
              min="1024"
              max="65535"
              spellCheck={false}
              value={port}
              disabled={!view || busy}
              onChange={(event) => setPort(event.target.value)}
              onBlur={commitPort}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitPort();
              }}
            />
          </div>
          {problem && (
            <p className="settings-field__hint devices-problem" role="status">
              {t(problem === "portInUse" ? "devices.portInUse" : "devices.failed", {
                port: String(view?.port ?? ""),
              })}
            </p>
          )}
        </div>
        <div className="settings-row">
          <div>
            <strong>{t("devices.code")}</strong>
            {listening && view?.pairingLocked && (
              <span role="status">{t("devices.pairingLocked")}</span>
            )}
          </div>
          <span className="devices-code">
            <span className="devices-value devices-value--code" aria-live="polite">
              {listening && view?.code ? groupedCode(view.code) : "––– –––"}
            </span>
            <Button
              tone="secondary"
              disabled={!listening || busy}
              onClick={() => void change(newPairingCode)}
            >
              {t("devices.newCode")}
            </Button>
          </span>
        </div>
      </div>
      <h3 className="devices-heading">{t("devices.paired")}</h3>
      <div className="settings-list">
        {view && view.devices.length === 0 && (
          <p className="settings-rows__empty">{t("devices.none")}</p>
        )}
        {view?.devices.map((device) => {
          const seen = timeAgo(device.lastSeenAt);
          const synced = timeAgo(device.lastSyncedAt);
          return (
            <div className="settings-row devices-device" key={device.id}>
              <div>
                <strong>
                  <DeviceMobileIcon aria-hidden="true" className="devices-device__icon" />
                  {device.name}
                </strong>
                {synced ? (
                  <span>{t("devices.lastSynced", { time: synced })}</span>
                ) : (
                  seen && <span>{t("devices.lastConnected", { time: seen })}</span>
                )}
              </div>
              <Button
                tone="danger"
                disabled={busy}
                onClick={() => void change(() => removeDevice(device.id))}
              >
                {t("devices.remove")}
              </Button>
            </div>
          );
        })}
      </div>
      {!view && error && (
        <Button tone="secondary" onClick={() => setAttempt((value) => value + 1)}>
          {t("common.tryAgain")}
        </Button>
      )}
    </Card>
  );
}
