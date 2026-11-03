import { useI18n } from "../../i18n/i18n";
import { SelectionRadio } from "../../components/ui/SelectionBox";
import { useId, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { LibraryBook } from "./libraryApi";

interface RenameDialogProps {
  /** The book being renamed; none closes the dialog. */
  book: LibraryBook | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  /** A blank title shows the book's own again. */
  onConfirm: (title: string) => void;
}

const MAX_TITLE = 500;

/** Shows one book under a title set by hand, or under its own again; its file is unchanged. */
export function RenameDialog({ book, busy, error, onCancel, onConfirm }: RenameDialogProps) {
  const { t } = useI18n();
  // Keyed by the book, so each opens on its own title.
  const [own, setOwn] = useState(false);
  const [title, setTitle] = useState(book?.title ?? "");
  const titleId = useId();

  const trimmed = title.trim().replace(/\s+/g, " ");
  const choice = own ? "" : trimmed && trimmed.length <= MAX_TITLE ? trimmed : null;

  return (
    <ConfirmDialog
      busy={busy}
      busyLabel={t("backup.saving")}
      confirmDisabled={choice === null}
      confirmLabel={t("rename.title")}
      confirmTone="primary"
      description={book?.fileName ?? ""}
      dialogRole="dialog"
      error={error}
      onCancel={onCancel}
      onConfirm={() => choice !== null && onConfirm(choice)}
      open={book !== null}
      title={t("rename.title")}
    >
      <form
        className="series-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice !== null && !busy) onConfirm(choice);
        }}
      >
        {book?.titleManual ? (
          <label className="series-dialog__option">
            <SelectionRadio checked={!own} name="title-kind" onChange={() => setOwn(false)} />
            <span>
              <strong>{t("rename.name")}</strong>
            </span>
          </label>
        ) : null}
        <div
          className={
            book?.titleManual
              ? "series-dialog__name"
              : "series-dialog__name series-dialog__name--alone"
          }
        >
          <label className="visually-hidden" htmlFor={titleId}>
            {t("rename.name")}
          </label>
          <input
            autoComplete="off"
            data-dialog-focus
            disabled={own}
            id={titleId}
            maxLength={MAX_TITLE}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("rename.name")}
            spellCheck={false}
            value={title}
          />
        </div>
        {book?.titleManual ? (
          <label className="series-dialog__option">
            <SelectionRadio checked={own} name="title-kind" onChange={() => setOwn(true)} />
            <span>
              <strong>{t("rename.own")}</strong>
              {book.ownTitle ? <small>{book.ownTitle}</small> : null}
            </span>
          </label>
        ) : null}
      </form>
    </ConfirmDialog>
  );
}
