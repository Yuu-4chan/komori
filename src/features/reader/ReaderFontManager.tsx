import { CloudArrowDownIcon, TrashIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogCaption } from "../../components/layout/WindowControls";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { TextField } from "../../components/ui/TextField";
import { useI18n } from "../../i18n/i18n";
import { googleFonts } from "./fontChoices";
import {
  changeDownloadedFont,
  importReaderFonts,
  refreshReaderFonts,
  useReaderFonts,
} from "./readerFonts";

export function ReaderFontManager({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { fonts, pending, completed, total, error } = useReaderFonts();
  const [query, setQuery] = useState("");
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
  const uploads = fonts.filter((f) => f.source === "uploaded" && matches(f.family));
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
        <div className="font-manager__list">
          {uploads.length > 0 && (
            <section>
              <h3>{t("fonts.sectionUploaded")}</h3>
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
            </section>
          )}
          {["asian", "western"]
            .filter((category) =>
              googleFonts.some((f) => f.category === category && matches(f.family)),
            )
            .map((category) => (
              <section key={category}>
                <h3>
                  {t(category === "asian" ? "fonts.asianCollection" : "fonts.westernCollection")}
                </h3>
                <div className="settings-list">
                  {googleFonts
                    .filter((f) => f.category === category && matches(f.family))
                    .map((family) => (
                      <div className="font-manager__row" key={family.id}>
                        <div>
                          <strong>{family.family}</strong>
                          <small>SIL Open Font License 1.1</small>
                        </div>
                        <div className="font-manager__weights">
                          {family.files.map((file) => {
                            const available = fonts.some((f) => f.id === file.id && f.available);
                            const weight = file.weight.split(" ").map(Number).join("–");
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
                                aria-label={t(available ? "fonts.remove" : "fonts.download", {
                                  name: `${family.family} ${weight}`,
                                })}
                                title={t(available ? "fonts.remove" : "fonts.download", {
                                  name: `${family.family} ${weight}`,
                                })}
                                onClick={() =>
                                  void changeDownloadedFont(
                                    file.id,
                                    available ? "remove" : "download",
                                  )
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
              </section>
            ))}
          {!uploads.length && !googleFonts.some((f) => matches(f.family)) && (
            <p>{t("fonts.noMatch", { query: query.trim() })}</p>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
