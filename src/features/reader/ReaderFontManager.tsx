import {
  CheckIcon,
  CloudArrowDownIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogCaption } from "../../components/layout/WindowControls";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { TextField } from "../../components/ui/TextField";
import { useI18n } from "../../i18n/i18n";
import { googleFonts, type FontCategory } from "./fontChoices";
import {
  changeDownloadedFont,
  importReaderFonts,
  refreshReaderFonts,
  useReaderFonts,
} from "./readerFonts";

type Tab = FontCategory | "uploaded";

/** The Reader's fonts, one collection at a time, opening on the menu's own. */
export function ReaderFontManager({
  category,
  onClose,
}: {
  category: FontCategory;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { fonts, pending, completed, total, error } = useReaderFonts();
  const [query, setQuery] = useState("");
  const [chosenTab, setTab] = useState<Tab>(category);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>("[data-close]")?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      previous?.focus();
    };
  }, []);
  const matches = (family: string) => family.toLowerCase().includes(query.trim().toLowerCase());
  const added = fonts.filter((f) => f.source === "uploaded");
  // The added fonts' tab shows while there are some, and opens when an import adds more.
  const addedCount = useRef(added.length);
  useEffect(() => {
    if (added.length > addedCount.current) setTab("uploaded");
    addedCount.current = added.length;
  }, [added.length]);
  const tab = chosenTab === "uploaded" && !added.length ? category : chosenTab;
  const uploads = tab === "uploaded" ? added.filter((f) => matches(f.family)) : [];
  const families =
    tab === "uploaded" ? [] : googleFonts.filter((f) => f.category === tab && matches(f.family));
  const tabs: { value: Tab; label: string }[] = [
    { value: "asian", label: t("fonts.asianCollection") },
    { value: "western", label: t("fonts.westernCollection") },
    ...(added.length ? [{ value: "uploaded" as const, label: t("fonts.sectionUploaded") }] : []),
  ];
  return createPortal(
    <dialog
      ref={dialogRef}
      className="confirm-dialog font-manager"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <DialogCaption />
      <div className="confirm-dialog__content">
        <div className="font-manager__header">
          <h2 id={titleId}>{t("fonts.managerTitle")}</h2>
          <IconButton data-close label={t("common.close")} onClick={onClose}>
            <XIcon aria-hidden="true" />
          </IconButton>
        </div>
        <div className="font-manager__toolbar">
          <TextField label={t("fonts.search")} value={query} onChange={setQuery} />
          <Button
            tone="secondary"
            icon={<UploadSimpleIcon aria-hidden="true" />}
            disabled={!!pending}
            onClick={() => void importReaderFonts()}
          >
            {t("fonts.import")}
          </Button>
        </div>
        {pending && (
          <p role="status">
            {t(pending === "import" ? "fonts.importing" : "fonts.downloading", {
              name: fonts.find((f) => f.id === pending)?.family ?? "",
              progress: total ? `${Math.round((completed / total) * 100)}%` : "",
            })}
          </p>
        )}
        {error && (
          <p className="confirm-dialog__error" role="alert">
            {t(error)}{" "}
            <Button tone="quiet" disabled={!!pending} onClick={() => void refreshReaderFonts()}>
              {t("fonts.refresh")}
            </Button>
          </p>
        )}
        <SegmentedControl
          label={t("fonts.collections")}
          value={tab}
          options={tabs}
          onChange={setTab}
        />
        <div className="font-manager__list">
          {uploads.length > 0 && (
            <div className="settings-list">
              {uploads.map((f) => (
                <div className="font-manager__row" key={f.id}>
                  <div>
                    <strong>{f.family}</strong>
                    <small>
                      {f.weight}
                      {f.style === "italic" ? ` · ${t("fonts.italic")}` : ""}
                    </small>
                  </div>
                  <IconButton
                    label={t("fonts.remove", { name: `${f.family} ${f.weight}` })}
                    disabled={!!pending}
                    onClick={() => void changeDownloadedFont(f.id, "remove")}
                  >
                    <TrashIcon aria-hidden="true" />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {families.length > 0 && (
            <div className="settings-list">
              {families.map((family) => (
                <div className="font-manager__row" key={family.id}>
                  <div>
                    <strong>{family.family}</strong>
                    <small>SIL Open Font License 1.1</small>
                  </div>
                  <div className="font-manager__weights">
                    {family.files.map((file) => {
                      const font = fonts.find((f) => f.id === file.id);
                      const weight = file.weight.split(" ").map(Number).join("–");
                      const name = `${family.family} ${weight}`;
                      // An included file is always there: it shows its weight, with no action.
                      if (font?.bundled)
                        return (
                          <span
                            key={file.id}
                            className="font-manager__included"
                            title={t("fonts.included", { name })}
                          >
                            <CheckIcon aria-hidden="true" />
                            {weight}
                            <span className="visually-hidden">{t("fonts.included", { name })}</span>
                          </span>
                        );
                      const available = !!font?.available;
                      return (
                        <Button
                          key={file.id}
                          tone="secondary"
                          icon={
                            available ? (
                              <TrashIcon aria-hidden="true" />
                            ) : (
                              <CloudArrowDownIcon aria-hidden="true" />
                            )
                          }
                          disabled={!!pending}
                          aria-label={t(available ? "fonts.remove" : "fonts.download", { name })}
                          title={t(available ? "fonts.remove" : "fonts.download", { name })}
                          onClick={() =>
                            void changeDownloadedFont(file.id, available ? "remove" : "download")
                          }
                        >
                          {weight}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!uploads.length && !families.length && (
            <p>{t("fonts.noMatch", { query: query.trim() })}</p>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
