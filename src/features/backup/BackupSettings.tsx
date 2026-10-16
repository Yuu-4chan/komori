import {
  ArchiveIcon,
  ClockCounterClockwiseIcon,
  DownloadIcon,
  HardDriveIcon,
  TrashIcon,
  UploadIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Select } from "../../components/ui/Select";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useAppearance } from "../appearance/AppearanceProvider";
import { formatSize } from "../storage/formatSize";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  backupFrequencies,
  backupKeepChoices,
  createSnapshot,
  defaultBackupSettings,
  deleteSnapshot,
  exportBackup,
  getBackupSettings,
  listSnapshots,
  openBackupFile,
  openSnapshot,
  restoreBackup,
  saveBackupSettings,
  type BackupPreview,
  type BackupSettings as Settings,
  type PreviewStatus,
  type Snapshot,
} from "./backupApi";

const keepValues = backupKeepChoices.map((keep) => String(keep) as `${typeof keep}`);
const kindLabel: Record<Snapshot["kind"], MessageKey> = {
  automatic: "backup.kindAutomatic",
  manual: "backup.kindManual",
  restore: "backup.kindRestore",
};
const refusal: Record<Exclude<PreviewStatus, "ready" | "canceled">, MessageKey> = {
  foreign: "backup.refusedForeign",
  newer: "backup.refusedNewer",
  damaged: "backup.refusedDamaged",
  tooLarge: "backup.refusedTooLarge",
  unreadable: "backup.refusedUnreadable",
  missing: "backup.refusedMissing",
};

const formatTime = (time: number) => i18n().date(time, { dateStyle: "medium", timeStyle: "short" });

/** A notice written when shown, so it follows the interface language. */
type Message = () => string;

/**
 * Settings > Backup: automatic snapshots, exporting a backup file, importing one (previewed and
 * confirmed before anything changes), and the snapshots Komori keeps in its data folder.
 * Backups hold Komori's own data only; books and dictionaries stay where they are.
 */
export function BackupSettings() {
  const { reloadAppearance } = useAppearance();
  const { t, tp, number } = useI18n();
  const [settings, setSettings] = useState<Settings>(defaultBackupSettings);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | "snapshot" | "restore" | null>(null);
  const [preview, setPreview] = useState<{
    value: BackupPreview;
    source: string;
    opener: HTMLElement | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<Snapshot | null>(null);
  const [dialogError, setDialogError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const readSnapshots = useCallback(async () => {
    try {
      setSnapshots(await listSnapshots());
    } catch {
      setSnapshots([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getBackupSettings().then(
      (saved) => active && setSettings(saved),
      () => undefined,
    );
    void readSnapshots();
    return () => {
      active = false;
    };
  }, [readSnapshots]);

  function report(message: Message | null, failure: MessageKey | null = null) {
    setNotice(() => message);
    setError(() => (failure ? () => i18n().t(failure) : null));
  }

  async function change(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      if (!(await saveBackupSettings(next))) throw new Error("refused");
      // Saving takes a due snapshot and prunes old ones.
      await readSnapshots();
    } catch {
      report(null, "backup.saveSettingsFailed");
    }
  }

  async function run(action: "export" | "import" | "snapshot") {
    if (busy) return;
    // The opener is disabled while it works, so focus has to be sent back to it explicitly.
    const opener = document.activeElement as HTMLElement | null;
    setBusy(action);
    report(null);
    try {
      if (action === "export") {
        const result = await exportBackup();
        if (result.status === "saved")
          report(() => {
            const { t, tp } = i18n();
            return t("backup.exported", {
              file: result.fileName ?? t("backup.theBackup"),
              books: tp("backup.books", result.books),
              sessions: tp("backup.sessions", result.sessions),
            });
          });
        else if (result.status === "failed") report(null, "backup.exportWriteFailed");
      } else if (action === "import") {
        show(await openBackupFile(), "file", opener);
      } else {
        const snapshot = await createSnapshot();
        if (!snapshot) throw new Error("failed");
        report(() => i18n().t("backup.snapshotSaved", { time: formatTime(snapshot.createdAt) }));
        await readSnapshots();
      }
    } catch {
      report(
        null,
        action === "snapshot"
          ? "backup.snapshotFailed"
          : action === "export"
            ? "backup.exportFailed"
            : "backup.importFailed",
      );
    } finally {
      setBusy(null);
    }
  }

  function show(value: BackupPreview, source: "file" | "snapshot", opener: HTMLElement | null) {
    if (value.status === "ready") {
      setDialogError(null);
      setPreview({ value, source, opener });
    } else if (value.status !== "canceled") report(null, refusal[value.status]);
  }

  async function previewSnapshot(snapshot: Snapshot) {
    if (busy) return;
    const opener = document.activeElement as HTMLElement | null;
    setBusy("import");
    report(null);
    try {
      show(await openSnapshot(snapshot.id), "snapshot", opener);
    } catch {
      report(null, "backup.snapshotReadFailed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmRestore() {
    if (!preview?.value.token) return;
    setBusy("restore");
    setDialogError(null);
    try {
      const result = await restoreBackup(preview.value.token);
      if (result.status === "snapshotFailed") {
        setDialogError("backup.restoreSnapshotFailed");
        return;
      }
      if (result.status !== "restored") {
        setDialogError("backup.previewStale");
        return;
      }
      setPreview(null);
      await reloadAppearance().catch(() => undefined);
      setSettings(await getBackupSettings().catch(() => settings));
      await readSnapshots();
      report(() => {
        const { t, tp } = i18n();
        const restored = t("backup.restored", {
          books: tp("backup.books", result.books),
          sessions: tp("backup.sessions", result.sessions),
        });
        if (result.unmatchedCount === 0) return restored;
        const titles = `${result.unmatched.join(", ")}${result.unmatchedCount > result.unmatched.length ? "…" : ""}`;
        return `${restored} ${tp("backup.restoredUnmatched", result.unmatchedCount, { titles })}`;
      });
    } catch {
      setDialogError("backup.restoreFailed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      if (!(await deleteSnapshot(deleting.id))) throw new Error("failed");
      const { createdAt } = deleting;
      report(() => i18n().t("backup.snapshotDeleted", { time: formatTime(createdAt) }));
      setDeleting(null);
      await readSnapshots();
    } catch {
      setDialogError("backup.snapshotDeleteFailed");
    }
  }

  const value = preview?.value;
  return (
    <>
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <HardDriveIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("backup.title")}</h2>
            <p>{t("backup.description")}</p>
          </div>
        </div>
        <div className="settings-list">
          <ToggleSetting
            label={t("backup.automatic")}
            description={t("backup.automaticHint")}
            checked={settings.automatic}
            onChange={(automatic) => void change({ automatic })}
          />
          <div className="settings-field">
            <Select
              label={t("backup.frequency")}
              value={settings.frequency}
              options={backupFrequencies.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={(frequency) => void change({ frequency })}
            />
            <p className="settings-field__hint">{t("backup.frequencyHint")}</p>
          </div>
          <div className="settings-field">
            <Select
              label={t("backup.keep")}
              value={String(settings.keep) as (typeof keepValues)[number]}
              options={keepValues.map((value) => ({
                value,
                label: tp("backup.keepCount", Number(value)),
              }))}
              onChange={(keep) => void change({ keep: Number(keep) as Settings["keep"] })}
            />
            <p className="settings-field__hint">{t("backup.keepHint")}</p>
          </div>
        </div>

        {error ? (
          <div className="library-notice library-notice--error" role="alert">
            <WarningCircleIcon aria-hidden="true" weight="duotone" />
            <span>{error()}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="library-notice" role="status">
            <span>{notice()}</span>
          </div>
        ) : null}

        <div className="settings-list" role="group" aria-label={t("backup.actions")}>
          <SettingsAction
            busy={busy === "export"}
            disabled={busy !== null}
            icon={<DownloadIcon aria-hidden="true" weight="bold" />}
            title={t("backup.export")}
            description={t("backup.exportHint")}
            label={busy === "export" ? t("backup.saving") : t("backup.exportButton")}
            onClick={() => void run("export")}
          />
          <SettingsAction
            busy={busy === "import"}
            disabled={busy !== null}
            icon={<UploadIcon aria-hidden="true" weight="bold" />}
            title={t("backup.import")}
            description={t("backup.importHint")}
            label={busy === "import" ? t("backup.reading") : t("backup.importButton")}
            onClick={() => void run("import")}
          />
          <SettingsAction
            busy={busy === "snapshot"}
            disabled={busy !== null}
            icon={<ArchiveIcon aria-hidden="true" weight="bold" />}
            title={t("backup.snapshot")}
            description={t("backup.snapshotHint")}
            label={busy === "snapshot" ? t("backup.saving") : t("backup.snapshotButton")}
            onClick={() => void run("snapshot")}
          />
        </div>
      </Card>

      <Card className="settings-card settings-card--wide" aria-labelledby="snapshots-title">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <ClockCounterClockwiseIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2 id="snapshots-title">{t("backup.snapshotsTitle")}</h2>
            <p>
              {snapshots && snapshots.length > 0
                ? tp("backup.snapshotsCount", snapshots.length)
                : t("backup.snapshotsEmptyHint")}
            </p>
          </div>
        </div>
        {snapshots === null ? null : snapshots.length === 0 ? (
          <p className="settings-rows__empty">{t("backup.noSnapshots")}</p>
        ) : (
          <ul className="settings-rows">
            {snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <div>
                  <strong>{formatTime(snapshot.createdAt)}</strong>
                  <span>
                    {t(kindLabel[snapshot.kind])} · {formatSize(snapshot.size)}
                  </span>
                </div>
                <Button
                  disabled={busy !== null}
                  onClick={() => void previewSnapshot(snapshot)}
                  tone="secondary"
                  aria-label={t("backup.restoreSnapshot", { time: formatTime(snapshot.createdAt) })}
                >
                  {t("backup.restore")}
                </Button>
                <Button
                  disabled={busy !== null}
                  icon={<TrashIcon aria-hidden="true" weight="bold" />}
                  onClick={() => {
                    setDialogError(null);
                    setDeleting(snapshot);
                  }}
                  tone="quiet"
                  aria-label={t("backup.deleteSnapshot", { time: formatTime(snapshot.createdAt) })}
                >
                  {t("common.delete")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        busy={busy === "restore"}
        busyLabel={t("backup.restoring")}
        dialogRole="dialog"
        confirmLabel={t("backup.restore")}
        confirmTone="primary"
        description={
          value
            ? t("backup.restoreDescription", {
                source: t(
                  preview.source === "file" ? "backup.sourceFile" : "backup.sourceSnapshot",
                ),
                details: [
                  value.createdAt ? t("backup.madeAt", { time: formatTime(value.createdAt) }) : "",
                  value.komoriVersion ? t("backup.madeBy", { version: value.komoriVersion }) : "",
                ].join(""),
              })
            : ""
        }
        error={dialogError && t(dialogError)}
        onCancel={() => setPreview(null)}
        onConfirm={() => void confirmRestore()}
        open={preview !== null}
        returnFocus={preview?.opener}
        title={t("backup.restoreTitle")}
      >
        {value ? (
          <ul className="backup-preview">
            <li>
              {value.books === 0 ? (
                t("backup.noBooks")
              ) : value.matched === 0 ? (
                t("backup.noneMatch")
              ) : (
                <>
                  {value.matched === value.books
                    ? tp("backup.allMatch", value.books)
                    : tp("backup.someMatch", value.books, { matched: value.matched })}{" "}
                  {t("backup.replaced")}
                </>
              )}
            </li>
            <li>{backupContents(value)}</li>
            <li>
              {value.appearance || value.anki || value.startup
                ? t("backup.settingsReplace", {
                    settings: [
                      value.appearance && t("backup.settingsAppearance"),
                      value.anki && t("backup.settingsAnki"),
                      value.startup && t("backup.settingsStartup"),
                    ]
                      .filter(Boolean)
                      .join(t("backup.and")),
                  })
                : t("backup.noSettings")}
            </li>
            {value.unmatchedCount > 0 ? (
              <li>
                {t(
                  value.unmatchedCount > value.unmatched.length
                    ? "backup.unmatchedMore"
                    : "backup.unmatched",
                  {
                    titles: value.unmatched.join(", "),
                    more: number(value.unmatchedCount - value.unmatched.length),
                  },
                )}
              </li>
            ) : null}
          </ul>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        confirmLabel={t("common.delete")}
        description={
          deleting ? t("backup.deleteDescription", { time: formatTime(deleting.createdAt) }) : ""
        }
        error={dialogError && t(dialogError)}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        open={deleting !== null}
        title={t("backup.deleteTitle")}
      />
    </>
  );
}

/** What a backup adds besides its books' places, naming only what it holds. */
function backupContents(value: BackupPreview): string {
  const { t, tp, list } = i18n();
  const items = (
    [
      ["backup.places", value.positions],
      ["backup.bookmarks", value.bookmarks],
      ["backup.notes", value.notes ?? 0],
      ["backup.sessions", value.sessions],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([key, count]) => tp(key, count));
  return items.length > 0 ? t("backup.contents", { items: list(items) }) : t("backup.noContents");
}

function SettingsAction({
  busy,
  description,
  disabled,
  icon,
  label,
  onClick,
  title,
}: {
  busy: boolean;
  description: string;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <div className="settings-row">
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <Button
        aria-busy={busy || undefined}
        aria-label={busy ? undefined : title}
        disabled={disabled}
        icon={icon}
        onClick={onClick}
        tone="secondary"
      >
        {label}
      </Button>
    </div>
  );
}
