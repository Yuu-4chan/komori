import { useI18n } from "../../i18n/i18n";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconButton } from "../../components/ui/IconButton";
import { BookCover } from "./BookCover";
import { followTitle, guessVolume } from "./bookEdits";
import type { BookEdit, LibraryBook } from "./libraryApi";

interface BookEditDialogProps {
  /** The books being edited, in the order shown; none closes the dialog. */
  books: readonly LibraryBook[] | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (edits: BookEdit[]) => void;
}

const MAX_TEXT = 500;
const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * The titles and author Komori shows books under; their files are unchanged. With several
 * books, changing the first title retitles the others the same way, each with its own volume
 * number, until one is changed by hand.
 */
export function BookEditDialog({ books, ...props }: BookEditDialogProps) {
  // Keyed by the books, so each opening starts from their titles.
  const key = books?.map((book) => book.id).join("\n") ?? "";
  return <BookEditForm books={books ?? []} key={key} open={books !== null} {...props} />;
}

function BookEditForm({
  books,
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: Omit<BookEditDialogProps, "books"> & { books: readonly LibraryBook[]; open: boolean }) {
  const { t, tp } = useI18n();
  const several = books.length > 1;
  const [rows, setRows] = useState(() =>
    books.map((book) => ({ value: book.title ?? "", byHand: false })),
  );
  // Whether the others follow the first title, which only typing in it starts.
  const [leading, setLeading] = useState(false);
  const volumes = useMemo(() => books.map(guessVolume), [books]);
  const authors = new Set(books.map((book) => book.author ?? ""));
  const shared = authors.size === 1 ? [...authors][0]! : null;
  const [author, setAuthor] = useState<{ kind: "keep" | "set" | "own"; value: string }>({
    kind: "keep",
    value: shared ?? "",
  });
  const titleId = useId();
  const authorId = useId();

  const lead = collapse(rows[0]?.value ?? "");
  const titles = rows.map((row, index) =>
    index === 0 || row.byHand || !leading || !lead
      ? row.value
      : followTitle(lead, volumes[index] ?? String(index + 1)),
  );
  const tooLong =
    titles.some((title) => collapse(title).length > MAX_TEXT) ||
    collapse(author.value).length > MAX_TEXT;
  const edits = books.flatMap((book, index): BookEdit[] => {
    const edit: BookEdit = { id: book.id };
    const title = collapse(titles[index] ?? "");
    if (title !== (book.title ?? "")) edit.title = title;
    if (author.kind === "own" && book.authorManual) edit.author = "";
    if (author.kind === "set") {
      const value = collapse(author.value);
      if ((value || shared !== null) && value !== (book.author ?? "")) edit.author = value;
    }
    return edit.title === undefined && edit.author === undefined ? [] : [edit];
  });

  // Typing in the first title leads the others; its original title does not.
  function setTitle(index: number, value: string, restored = false) {
    if (index === 0) setLeading(!restored);
    setRows((current) =>
      current.map((row, at) => (at === index ? { value, byHand: index > 0 } : row)),
    );
  }

  const ownTitle = (book: LibraryBook) => (book.titleManual ? (book.ownTitle ?? "") : null);
  const restoreAuthor = books.some((book) => book.authorManual) ? (
    <IconButton
      compact
      label={t("edit.original")}
      onClick={() => {
        const own = new Set(
          books.map((book) => (book.authorManual ? (book.ownAuthor ?? "") : (book.author ?? ""))),
        );
        setAuthor({ kind: "own", value: own.size === 1 ? [...own][0]! : "" });
      }}
      quiet
      title={t("edit.original")}
    >
      <ArrowCounterClockwiseIcon aria-hidden="true" size={16} />
    </IconButton>
  ) : null;

  function restoreTitle(index: number) {
    const book = books[index];
    const own = book && ownTitle(book);
    if (own === null || own === undefined) return null;
    return (
      <IconButton
        compact
        label={t("edit.original")}
        onClick={() => setTitle(index, own, true)}
        quiet
        title={t("edit.original")}
      >
        <ArrowCounterClockwiseIcon aria-hidden="true" size={16} />
      </IconButton>
    );
  }

  return (
    <ConfirmDialog
      busy={busy}
      busyLabel={t("backup.saving")}
      confirmDisabled={tooLong || edits.length === 0}
      confirmLabel={t("edit.save")}
      confirmTone="primary"
      description={several ? tp("library.selected", books.length) : (books[0]?.fileName ?? "")}
      dialogRole="dialog"
      error={error}
      onCancel={onCancel}
      onConfirm={() => onConfirm(edits)}
      open={open}
      title={t("edit.title")}
      wide={several}
    >
      <form
        className="book-edit"
        // Several fields and no submit button: Enter saves, except while an IME composes.
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
            return;
          if (!(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (!busy && !tooLong && edits.length > 0) onConfirm(edits);
        }}
        onSubmit={(event) => event.preventDefault()}
      >
        {several ? (
          <div className="book-edit__field">
            <div className="book-edit__label">
              <span>
                <strong>{t("edit.titles")}</strong>
                <small>{t("edit.titlesHint")}</small>
              </span>
            </div>
            <ol className="book-edit__list">
              {books.map((book, index) => (
                <li className="book-edit__row" key={book.id}>
                  <BookCover book={book} size="small" />
                  <span className="book-edit__title">
                    <input
                      aria-label={t("edit.titleField")}
                      autoComplete="off"
                      data-dialog-focus={index === 0 ? true : undefined}
                      maxLength={MAX_TEXT}
                      onChange={(event) => setTitle(index, event.target.value)}
                      placeholder={book.fileName}
                      spellCheck={false}
                      value={titles[index]}
                    />
                    <small title={book.fileName}>{book.fileName}</small>
                  </span>
                  {restoreTitle(index)}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="book-edit__field">
            <div className="book-edit__label">
              <label htmlFor={titleId}>
                <strong>{t("edit.titleField")}</strong>
              </label>
              {restoreTitle(0)}
            </div>
            <input
              autoComplete="off"
              data-dialog-focus
              id={titleId}
              maxLength={MAX_TEXT}
              onChange={(event) => setTitle(0, event.target.value)}
              placeholder={books[0]?.fileName}
              spellCheck={false}
              value={titles[0]}
            />
          </div>
        )}
        <div className="book-edit__field">
          <div className="book-edit__label">
            <label htmlFor={authorId}>
              <strong>{t("edit.author")}</strong>
            </label>
            {restoreAuthor}
          </div>
          <input
            autoComplete="off"
            id={authorId}
            maxLength={MAX_TEXT}
            onChange={(event) =>
              setAuthor({
                kind: event.target.value.trim() || shared !== null ? "set" : "keep",
                value: event.target.value,
              })
            }
            placeholder={
              author.kind === "own"
                ? t("edit.original")
                : shared === null
                  ? t("edit.authorMixed")
                  : t("libraryCard.unknownAuthor")
            }
            spellCheck={false}
            value={author.value}
          />
        </div>
      </form>
    </ConfirmDialog>
  );
}
