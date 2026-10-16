import { ChartBarIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Select } from "../../components/ui/Select";
import { Stepper } from "../../components/ui/Stepper";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useAppearance } from "../appearance/AppearanceProvider";
import { deleteReadingSessions, getStatisticsCounts, type StatisticsCounts } from "./statisticsApi";
import {
  sessionStartModes,
  statisticsIdleMinutes,
  statisticsJumpLimit,
} from "./statisticsPreferences";
import { useI18n, type MessageKey } from "../../i18n/i18n";

const startHints = {
  auto: "statisticsSettings.startAutoHint",
  "first-read": "statisticsSettings.startFirstReadHint",
  manual: "statisticsSettings.startManualHint",
} as const;

/**
 * Settings > Statistics: whether and how the Reader records reading sessions, and deleting
 * what was recorded. Every choice saves at once with the appearance record; deletions are
 * confirmed and done by native code.
 */
export function StatisticsSettings() {
  const {
    statisticsEnabled,
    statisticsSessionStart,
    statisticsJumpLimit: jumpLimit,
    statisticsIdleMinutes: idleMinutes,
    setStatistics,
  } = useAppearance();
  const [counts, setCounts] = useState<StatisticsCounts | null>(null);
  const [confirming, setConfirming] = useState<"orphans" | "all" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { t, tp, number } = useI18n();
  const [dialogError, setDialogError] = useState<MessageKey | null>(null);
  const [deleted, setDeleted] = useState<number | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);

  const readCounts = useCallback(async () => {
    try {
      setCounts(await getStatisticsCounts());
      setError(null);
    } catch {
      setError("statisticsSettings.readFailed");
    }
  }, []);
  useEffect(() => {
    void readCounts();
  }, [readCounts]);

  async function confirmDelete() {
    if (!confirming) return;
    setDeleting(true);
    setDialogError(null);
    try {
      const deleted = await deleteReadingSessions(confirming === "orphans");
      setDeleted(deleted);
      setConfirming(null);
      await readCounts();
    } catch {
      setDialogError("statisticsSettings.deleteFailed");
    } finally {
      setDeleting(false);
    }
  }

  const orphans = counts?.orphanSessions ?? 0;
  return (
    <>
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <ChartBarIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("statisticsSettings.title")}</h2>
            <p>{t("statisticsSettings.description")}</p>
          </div>
        </div>
        <div className="settings-list">
          <ToggleSetting
            label={t("statisticsSettings.record")}
            description={t("statisticsSettings.recordHint")}
            checked={statisticsEnabled}
            onChange={(enabled) => setStatistics({ statisticsEnabled: enabled })}
          />
          <div className="settings-field">
            <Select
              label={t("statisticsSettings.sessionStart")}
              value={statisticsSessionStart}
              options={sessionStartModes.map((mode) => ({ ...mode, label: t(mode.label) }))}
              onChange={(mode) => setStatistics({ statisticsSessionStart: mode })}
            />
            <p className="settings-field__hint">{t(startHints[statisticsSessionStart])}</p>
          </div>
          <div className="settings-field">
            <Stepper
              label={t("statisticsSettings.jumpLimit")}
              value={jumpLimit}
              {...statisticsJumpLimit}
              format={(value) => number(value)}
              unit={t("statisticsSettings.jumpLimitUnit")}
              onChange={(value) => setStatistics({ statisticsJumpLimit: value })}
            />
            <p className="settings-field__hint">{t("statisticsSettings.jumpLimitHint")}</p>
          </div>
          <div className="settings-field">
            <Stepper
              label={t("statisticsSettings.idleLimit")}
              value={idleMinutes}
              {...statisticsIdleMinutes}
              format={(value) => number(value)}
              unit={t("statisticsSettings.idleLimitUnit")}
              onChange={(value) => setStatistics({ statisticsIdleMinutes: value })}
            />
            <p className="settings-field__hint">{t("statisticsSettings.idleLimitHint")}</p>
          </div>
        </div>
      </Card>

      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <TrashIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("statisticsSettings.recordedTitle")}</h2>
            <p>
              {counts
                ? tp("statisticsSettings.holds", counts.sessions)
                : t("statisticsSettings.keeps")}{" "}
              {t("statisticsSettings.neverDeleted")}
            </p>
          </div>
        </div>
        {error ? (
          <div className="library-notice library-notice--error" role="alert">
            <WarningCircleIcon aria-hidden="true" weight="duotone" />
            <span>{t(error)}</span>
          </div>
        ) : null}
        {deleted !== null ? (
          <div className="library-notice" role="status">
            <span>{tp("statisticsSettings.deleted", deleted)}</span>
          </div>
        ) : null}
        <div className="settings-list">
          <div className="settings-row">
            <div>
              <strong>{t("statisticsSettings.deleteOrphans")}</strong>
              <span>
                {orphans > 0
                  ? tp("statisticsSettings.orphans", counts?.orphanBooks ?? 0, {
                      sessions: tp("statisticsSettings.sessions", orphans),
                    })
                  : t("statisticsSettings.noOrphans")}
              </span>
            </div>
            <Button
              disabled={orphans === 0}
              icon={<TrashIcon aria-hidden="true" weight="bold" />}
              onClick={() => {
                setDialogError(null);
                setConfirming("orphans");
              }}
              tone="secondary"
            >
              {t("common.delete")}
            </Button>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("statisticsSettings.deleteAll")}</strong>
              <span>{t("statisticsSettings.deleteAllHint")}</span>
            </div>
            <Button
              disabled={!counts?.sessions}
              icon={<TrashIcon aria-hidden="true" weight="bold" />}
              onClick={() => {
                setDialogError(null);
                setConfirming("all");
              }}
              tone="danger"
            >
              {t("statisticsSettings.deleteAllButton")}
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        busy={deleting}
        busyLabel={t("statisticsSettings.deleting")}
        confirmLabel={
          confirming === "all" ? t("statisticsSettings.deleteAllConfirm") : t("common.delete")
        }
        description={
          confirming === "all"
            ? tp("statisticsSettings.deleteAllDescription", counts?.sessions ?? 0)
            : tp("statisticsSettings.deleteOrphansDescription", orphans)
        }
        error={dialogError && t(dialogError)}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void confirmDelete()}
        open={confirming !== null}
        title={
          confirming === "all"
            ? t("statisticsSettings.deleteAllTitle")
            : t("statisticsSettings.deleteOrphansTitle")
        }
      />
    </>
  );
}
