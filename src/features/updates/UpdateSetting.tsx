import { version } from "../../../package.json";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n/i18n";
import { useUpdates } from "./updates";

/** The Updates row of Settings > General: the installed version and a manual check. */
export function UpdateSetting() {
  const updates = useUpdates();
  const { t } = useI18n();
  if (!updates) return null;
  const { update, status, error, check, show } = updates;
  const busy = status === "checking" || status === "installing";
  const state =
    status === "checking"
      ? t("updates.checking")
      : error
        ? error
        : update
          ? t("updates.ready", { version: update.version })
          : status === "current"
            ? t("updates.current", { version })
            : t("settings.version", { version });
  return (
    <div className="settings-row">
      <div>
        <strong>{t("updates.title")}</strong>
        <span role="status">{state}</span>
      </div>
      <Button disabled={busy} onClick={update ? show : () => void check()} tone="secondary">
        {update ? t("updates.show") : t("updates.check")}
      </Button>
    </div>
  );
}
