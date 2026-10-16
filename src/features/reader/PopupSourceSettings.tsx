import { useEffect, useState } from "react";
import { BooksIcon } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Select } from "../../components/ui/Select";
import { SelectionCheckbox } from "../../components/ui/SelectionBox";
import { useAppearance } from "../appearance/AppearanceProvider";
import { listDictionaries, type DictionarySummary } from "../dictionary/dictionaryApi";
import { sourceRoles, type SourceRole, type SourceSelection } from "../dictionary/sourcePolicy";
import { useDictionaryRevision } from "../dictionary/useDictionaryRevision";
import { useI18n } from "../../i18n/i18n";

const roleLabels = {
  definitions: "popupSources.definitions",
  frequency: "popupSources.frequency",
  pitch: "popupSources.pitch",
} as const;
const selectLabels = {
  definitions: "popupSources.selectDefinitions",
  frequency: "popupSources.selectFrequency",
  pitch: "popupSources.selectPitch",
} as const;
function eligibleSource(source: DictionarySummary, role: SourceRole) {
  return role === "definitions"
    ? source.hasDefinitions
    : role === "frequency"
      ? source.hasFrequency
      : source.hasPitch;
}

export function PopupSourceSettings({
  onDictionarySettings,
}: {
  onDictionarySettings: () => void;
}) {
  const appearance = useAppearance();
  const { t, tp } = useI18n();
  const choices = {
    definitions: appearance.readerPopupDefinitionSources,
    frequency: appearance.readerPopupFrequencySources,
    pitch: appearance.readerPopupPitchSources,
  };
  const [sources, setSources] = useState<DictionarySummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [dialog, setDialog] = useState<{ role: SourceRole; draft: SourceSelection } | null>(null);
  const [retry, setRetry] = useState(0);
  const revision = useDictionaryRevision();
  useEffect(() => {
    let active = true;
    setStatus("loading");
    listDictionaries().then(
      (list) => {
        if (active) {
          setSources(list);
          setStatus("ready");
        }
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [revision, retry]);
  return (
    <Card className="settings-card settings-card--wide">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <BooksIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("popupSources.title")}</h2>
          <p>{t("popupSources.description")}</p>
        </div>
      </div>
      {status === "loading" && <p role="status">{t("popupSources.loading")}</p>}
      {status === "error" && (
        <p role="alert">
          {t("popupSources.loadFailed")}{" "}
          <Button tone="secondary" onClick={() => setRetry(retry + 1)}>
            {t("popupSources.retry")}
          </Button>
        </p>
      )}
      <div className="settings-list">
        {sourceRoles.map((role) => {
          const eligible = sources.filter((source) => eligibleSource(source, role));
          const choice = choices[role];
          const active = eligible.filter(
            (source) =>
              choice.mode === "all" ||
              (choice.mode === "selected" && choice.ids.includes(source.id)),
          );
          const unavailable =
            choice.mode === "selected"
              ? choice.ids.filter((id) => !active.some((source) => source.id === id)).length
              : 0;
          const names = active.map((source) => source.title).join(", ");
          const missing = eligible.length === 0;
          return (
            <div key={role} className="settings-row">
              <div>
                <strong>{t(roleLabels[role])}</strong>
                <span>
                  {status !== "ready"
                    ? t("popupSources.unavailable")
                    : missing
                      ? t("popupSources.noneImported")
                      : choice.mode === "all"
                        ? `${t("popupSources.all")} · ${names}`
                        : choice.mode === "none"
                          ? t("popupSources.none")
                          : `${names || t("popupSources.selectedCount", { count: choice.ids.length })}${unavailable ? ` · ${t("popupSources.unavailableCount", { count: unavailable })}` : ""}`}
                </span>
              </div>
              {status === "ready" && missing ? (
                <Button tone="secondary" onClick={onDictionarySettings}>
                  {t("popupSources.openSettings")}
                </Button>
              ) : (
                <Button
                  tone="secondary"
                  aria-label={t(selectLabels[role])}
                  onClick={() => setDialog({ role, draft: choices[role] })}
                >
                  {t("popupSources.choose")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!dialog}
        dialogRole="dialog"
        confirmTone="primary"
        title={dialog ? t(selectLabels[dialog.role]) : t("popupSources.select")}
        description={t("popupSources.dialogDescription")}
        confirmLabel={t("popupSources.apply")}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog) appearance.setReaderPopupSources(dialog.role, dialog.draft);
          setDialog(null);
        }}
      >
        {dialog && (
          <>
            {status !== "ready" && (
              <p role="status">
                {status === "loading"
                  ? t("popupSources.loadingSources")
                  : t("popupSources.availabilityFailed")}
              </p>
            )}
            {status === "ready" &&
              !sources.some((source) => eligibleSource(source, dialog.role)) && (
                <p>
                  {t("popupSources.noneImported")}{" "}
                  <Button
                    tone="quiet"
                    onClick={() => {
                      setDialog(null);
                      onDictionarySettings();
                    }}
                  >
                    {t("popupSources.openSettings")}
                  </Button>
                </p>
              )}
            <Select
              label={t("popupSources.selection")}
              value={dialog.draft.mode}
              options={[
                { value: "all", label: t("popupSources.all") },
                { value: "selected", label: t("popupSources.selected") },
                { value: "none", label: t("popupSources.none") },
              ]}
              onChange={(mode) =>
                setDialog({
                  ...dialog,
                  draft:
                    mode === "selected"
                      ? { mode, ids: dialog.draft.mode === "selected" ? dialog.draft.ids : [] }
                      : { mode },
                })
              }
            />
            {dialog.draft.mode === "selected" && status === "ready" && (
              <div
                className="popup-source-options"
                role="group"
                aria-label={t("popupSources.selected")}
              >
                {sources
                  .filter((source) => eligibleSource(source, dialog.role))
                  .map((source) => (
                    <label key={source.id}>
                      <SelectionCheckbox
                        aria-label={source.title}
                        checked={
                          dialog.draft.mode === "selected" && dialog.draft.ids.includes(source.id)
                        }
                        onChange={(event) => {
                          if (dialog.draft.mode !== "selected") return;
                          const ids = dialog.draft.ids;
                          if (event.target.checked && ids.length >= 128) return;
                          setDialog({
                            ...dialog,
                            draft: {
                              mode: "selected",
                              ids: event.target.checked
                                ? [...ids, source.id]
                                : ids.filter((id) => id !== source.id),
                            },
                          });
                        }}
                      />
                      <span>
                        <strong>{source.title}</strong>
                        <small>{t("popupSources.revision", { revision: source.revision })}</small>
                      </span>
                    </label>
                  ))}
                {dialog.draft.ids
                  .filter(
                    (id) =>
                      !sources.some(
                        (source) => eligibleSource(source, dialog.role) && source.id === id,
                      ),
                  )
                  .map((id) => (
                    <label key={id}>
                      <SelectionCheckbox
                        checked
                        onChange={() => {
                          if (dialog.draft.mode === "selected")
                            setDialog({
                              ...dialog,
                              draft: {
                                mode: "selected",
                                ids: dialog.draft.ids.filter((value) => value !== id),
                              },
                            });
                        }}
                      />
                      {t("popupSources.unavailableSource", { id: String(id) })}
                    </label>
                  ))}
                {dialog.draft.ids.length === 0 && <p>{t("popupSources.noneSelected")}</p>}
                {dialog.draft.ids.length >= 128 && <p>{tp("popupSources.maximum", 128)}</p>}
              </div>
            )}
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}
