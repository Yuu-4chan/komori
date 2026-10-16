import { useI18n } from "../../i18n/i18n";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { DialogCaption } from "../layout/WindowControls";
import { Button } from "./Button";

interface ConfirmDialogProps {
  busy?: boolean;
  busyLabel?: string;
  /** The dismissing button's label; Cancel by default. */
  cancelLabel?: string;
  /** Shown below the description, for example the items an action affects. */
  children?: ReactNode;
  confirmDisabled?: boolean;
  confirmLabel: string;
  confirmTone?: "primary" | "danger";
  dialogRole?: "dialog" | "alertdialog";
  description: string;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  /** Where focus returns on close, for an opener disabled while the dialog's content loads. */
  returnFocus?: HTMLElement | null;
  title: string;
}

export function ConfirmDialog({
  busy = false,
  busyLabel,
  cancelLabel,
  children,
  confirmDisabled = false,
  confirmLabel,
  confirmTone = "danger",
  dialogRole = "alertdialog",
  description,
  error,
  onCancel,
  onConfirm,
  open,
  returnFocus,
  title,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    returnFocusRef.current = returnFocus ?? (document.activeElement as HTMLElement | null);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      ref={dialogRef}
      role={dialogRole}
    >
      <DialogCaption />
      <div className="confirm-dialog__content">
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {children}
        {error ? (
          <p className="confirm-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog__actions">
          <Button data-dialog-cancel disabled={busy} onClick={onCancel} tone="secondary">
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button disabled={busy || confirmDisabled} onClick={onConfirm} tone={confirmTone}>
            {busy ? (busyLabel ?? t("common.working")) : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
