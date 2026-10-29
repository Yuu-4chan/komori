import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useI18n } from "../../i18n/i18n";
import { DiscordIcon } from "./DiscordIcon";
import {
  defaultDiscordPreferences,
  getDiscordPreferences,
  saveDiscordPreferences,
  type DiscordPreferences,
} from "./discordApi";

const parts = [
  "showBookTitle",
  "showBookProgress",
  "showChapterProgress",
  "showReadingSpeed",
  "showBrowsing",
] as const;

/**
 * Settings > Discord: whether Discord shows what the Reader is reading, which parts, and the page
 * in use outside the Reader. Each choice waits for native confirmation.
 */
export function DiscordSettings() {
  const [preferences, setPreferences] = useState<DiscordPreferences>(defaultDiscordPreferences);
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "save" | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void getDiscordPreferences().then(
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

  async function change(key: keyof DiscordPreferences, value: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPreferences(await saveDiscordPreferences({ [key]: value }));
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
          <DiscordIcon aria-hidden="true" />
        </span>
        <div>
          <h2>{t("discord.title")}</h2>
          <p>{t("discord.description")}</p>
        </div>
      </div>
      {error && (
        <p className="library-notice library-notice--error" role="alert">
          {t(error === "read" ? "discord.readError" : "discord.saveError")}
        </p>
      )}
      <div className="settings-list">
        <ToggleSetting
          label={t("discord.enabled")}
          description={t("discord.enabledHint")}
          checked={preferences.enabled}
          disabled={!loaded || busy}
          onChange={(value) => void change("enabled", value)}
        />
        {parts.map((key) => (
          <ToggleSetting
            key={key}
            label={t(`discord.${key}`)}
            // The speed comes from reading statistics, so it needs a word on when it shows; the
            // pages need a word on which they are.
            description={
              key === "showReadingSpeed"
                ? t("discord.showReadingSpeedHint")
                : key === "showBrowsing"
                  ? t("discord.showBrowsingHint")
                  : undefined
            }
            checked={preferences[key]}
            disabled={!loaded || busy || !preferences.enabled}
            onChange={(value) => void change(key, value)}
          />
        ))}
      </div>
      {!loaded && error && (
        <Button tone="secondary" onClick={() => setAttempt((value) => value + 1)}>
          {t("common.tryAgain")}
        </Button>
      )}
    </Card>
  );
}
