import { PowerIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { AutoscrollSetting } from "../appearance/AutoscrollSetting";
import { UpdateSetting } from "../updates/UpdateSetting";
import { useI18n } from "../../i18n/i18n";
import {
  defaultStartupPreferences,
  getStartupPreferences,
  saveStartupPreferences,
  type StartupPreferences,
} from "./startupApi";

const choices = [
  "launchAtStartup",
  "restoreLastBook",
  "rememberWindowSize",
  "minimizeToTray",
  "checkForUpdates",
] as const;

/**
 * Settings > General's Startup and behavior card: startup, window and update choices, autoscroll
 * and the manual update check.
 */
export function GeneralSettings() {
  const [preferences, setPreferences] = useState<StartupPreferences>(defaultStartupPreferences);
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "save" | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void getStartupPreferences().then(
      (saved) => {
        if (active) {
          setPreferences(saved);
          setLoaded(true);
          setError(null);
        }
      },
      () => {
        if (active) setError("read");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  async function change(key: keyof StartupPreferences, value: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPreferences(await saveStartupPreferences({ [key]: value }));
    } catch {
      setError("save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="settings-card settings-card--wide" aria-busy={(!loaded && !error) || busy}>
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <PowerIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("startup.title")}</h2>
          <p>{t("startup.description")}</p>
        </div>
      </div>
      {error && (
        <p className="library-notice library-notice--error" role="alert">
          {t(error === "read" ? "startup.readError" : "startup.saveError")}
        </p>
      )}
      <div className="settings-list">
        {choices.map((key) => (
          <ToggleSetting
            key={key}
            label={t(`startup.${key}`)}
            // Only Minimize to tray needs a word on what it does; the other labels say it.
            description={key === "minimizeToTray" ? t("startup.minimizeToTrayHint") : undefined}
            checked={preferences[key]}
            disabled={!loaded || busy}
            onChange={(value) => void change(key, value)}
          />
        ))}
        <AutoscrollSetting />
        <UpdateSetting />
      </div>
      {!loaded && error && (
        <Button tone="secondary" onClick={() => setAttempt((value) => value + 1)}>
          {t("common.tryAgain")}
        </Button>
      )}
    </Card>
  );
}
