import {
  BooksIcon,
  ListIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconButton } from "../../components/ui/IconButton";
import { NoticeClose } from "../../components/ui/NoticeClose";
import { useSelection } from "../selection/useSelection";
import { selectAllKey, selectionKeyTarget } from "../selection/selectionKeyboard";
import { SelectionCheckbox } from "../../components/ui/SelectionBox";
import { useBulkOperation, operationLabel } from "../operations/bulkOperation";
import { OperationNotice } from "../operations/OperationNotice";
import { StarterDictionaries } from "./StarterDictionaries";
import { starterActive, useStarterDictionaries } from "./useStarterDictionaries";
import { dictionariesChanged } from "./sourcePolicy";
import {
  importDictionaries,
  listDictionaries,
  moveDictionary,
  removeDictionaries,
  removeDictionary,
  type DictionaryImportBatch,
  type DictionaryImportResult,
  type DictionarySummary,
} from "./dictionaryApi";
import { failureText } from "../../i18n/failure";
import { i18n, useI18n } from "../../i18n/i18n";

/** A notice written when shown, so it follows the interface language. */
type Message = () => string;

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; dictionaries: DictionarySummary[] }
  | { kind: "error"; message: string };

/** Imported dictionaries in lookup order, moved by their handle or Alt+Arrow keys,
 * with native import and confirmed single/bulk removal. */
export function DictionarySources() {
  const operation = useBulkOperation("dictionaries");
  const starter = useStarterDictionaries();
  const { t, tp } = useI18n();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const loadSequence = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
    };
  }, []);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<DictionaryImportBatch | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // An import finished on another route shows the operation's own result until it is closed.
  const [closedImport, setClosedImport] = useState<string | null>(null);
  // A ref guards against a second picker even before the importing state re-renders.
  const importingRef = useRef(false);
  const [removeTarget, setRemoveTarget] = useState<DictionarySummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<Message | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const [moving, setMoving] = useState(false);
  // The order shown while a move is saved, so a dropped row does not jump back until it fails.
  const [pendingOrder, setPendingOrder] = useState<number[] | null>(null);
  // The row keyboard focus stays on while it moves, by dictionary ID.
  const [focusAfterMove, setFocusAfterMove] = useState<number | null>(null);
  // Said by a live region once a move is saved.
  const [announcement, setAnnouncement] = useState("");
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [bulkRemoveError, setBulkRemoveError] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<Message | null>(null);
  const moveHintId = useId();
  const busy =
    importing ||
    removing ||
    bulkRemoving ||
    moving ||
    Boolean(operation?.active) ||
    starterActive(starter.snapshot);
  const dictionaries = useMemo(() => (list.kind === "loaded" ? list.dictionaries : []), [list]);
  const dictionaryIds = useMemo(
    () => dictionaries.map((dictionary) => dictionary.id),
    [dictionaries],
  );
  const installedTitles = useMemo(
    () => dictionaries.map((dictionary) => dictionary.title),
    [dictionaries],
  );
  const selection = useSelection(dictionaryIds);
  const selected = dictionaries.filter((dictionary) => selection.isSelected(dictionary.id));
  // Each row has its own selection box; choosing one shows the actions for the chosen ones.
  const selecting = selection.selectedCount > 0;

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++loadSequence.current;
    try {
      const dictionaries = await listDictionaries();
      if (sequence === loadSequence.current) setList({ kind: "loaded", dictionaries });
    } catch (error) {
      if (sequence === loadSequence.current)
        setList({ kind: "error", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, operation?.active]);

  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener(dictionariesChanged, changed);
    return () => window.removeEventListener(dictionariesChanged, changed);
  }, [refresh]);

  useEffect(() => {
    if (busy || bulkRemoveOpen || removeTarget || dictionaries.length === 0) return;
    function handleKey(event: KeyboardEvent) {
      if (!selectionKeyTarget(event, ".settings-dictionary-sources")) return;
      // Before anything is chosen, only keys pressed within the list select its dictionaries.
      const within = (event.target as Element | null)?.closest?.(".settings-dictionary-sources");
      if (!selecting && !within) return;
      if (selectAllKey(event)) {
        event.preventDefault();
        selection.selectAll();
      } else if (event.key === "Escape" && !event.ctrlKey && !event.metaKey) {
        selection.cancel();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [
    busy,
    bulkRemoveOpen,
    dictionaries.length,
    removeTarget,
    selecting,
    selection.cancel,
    selection.selectAll,
  ]);

  const requestRemoval = useCallback((dictionary: DictionarySummary) => {
    setRemoveError(null);
    setNotice(null);
    setChangeError(null);
    setRemoveTarget(dictionary);
  }, []);

  async function move(dictionary: DictionarySummary, position: number, keepFocus = false) {
    if (busy || list.kind !== "loaded") return;
    const order = list.dictionaries.map((item) => item.id);
    const from = order.indexOf(dictionary.id);
    if (from < 0 || position === from) return;
    setMoving(true);
    setChangeError(null);
    setNotice(null);
    setAnnouncement("");
    if (keepFocus) setFocusAfterMove(dictionary.id);
    setPendingOrder(movedOrder(order, from, position));
    const failure = () => i18n().t("dictionarySources.moveFailed", { title: dictionary.title });
    try {
      const status = await moveDictionary(dictionary.id, position);
      if (status === "failed") {
        setChangeError(() => failure);
        return;
      }
      if (status === "notFound") {
        setNotice(() => alreadyRemoved([dictionary]));
      } else {
        const place = Math.min(position, order.length - 1) + 1;
        setAnnouncement(
          i18n().t("dictionarySources.moved", {
            title: dictionary.title,
            place,
            count: order.length,
          }),
        );
      }
      await refresh();
    } catch (error) {
      setChangeError(() => () => `${failure()} ${errorMessage(error)}`);
    } finally {
      setPendingOrder(null);
      setMoving(false);
    }
  }

  function requestBulkRemoval() {
    if (selection.selectedCount === 0 || busy) return;
    setBulkRemoveError(null);
    setNotice(null);
    setChangeError(null);
    setBulkRemoveOpen(true);
  }

  async function confirmBulkRemoval() {
    const targets = selected;
    if (targets.length === 0 || bulkRemoving) return;
    setBulkRemoving(true);
    setBulkRemoveError(null);
    try {
      const results = await removeDictionaries(targets.map((dictionary) => dictionary.id));
      const statuses = new Map(results.map((result) => [result.id, result.status]));
      const gone = targets.filter((dictionary) => statuses.get(dictionary.id) === "notFound");
      // A missing result is treated as a failure, so its dictionary stays selected.
      const failed = targets.filter(
        (dictionary) => statuses.get(dictionary.id) !== "removed" && !gone.includes(dictionary),
      );
      setBulkRemoveOpen(false);
      if (gone.length > 0) {
        setNotice(() => alreadyRemoved(gone));
      }
      if (failed.length > 0) {
        setChangeError(
          () => () =>
            i18n().tp("dictionarySources.removeFailed", failed.length, {
              titles: titleList(failed),
            }),
        );
        selection.replace(failed.map((dictionary) => dictionary.id));
      } else {
        selection.cancel();
      }
      await refresh();
    } catch (error) {
      setBulkRemoveError(errorMessage(error));
    } finally {
      setBulkRemoving(false);
    }
  }

  async function confirmRemoval() {
    if (!removeTarget || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const status = await removeDictionary(removeTarget.id);
      if (status === "failed") {
        setRemoveError(() => () => i18n().t("dictionarySources.removeOneFailed"));
        return;
      }
      if (status === "notFound") {
        const target = removeTarget;
        setNotice(() => alreadyRemoved([target]));
      }
      setRemoveTarget(null);
      await refresh();
    } catch (error) {
      const message = errorMessage(error);
      setRemoveError(() => () => message);
    } finally {
      setRemoving(false);
    }
  }

  async function handleAdd() {
    if (importingRef.current || busy) return;
    importingRef.current = true;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setNotice(null);
    setChangeError(null);
    try {
      const result = await importDictionaries();
      if (!result.canceled) {
        setImportResult(result);
        await refresh();
      }
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <Card className="settings-card settings-card--wide" aria-labelledby="dictionary-sources-title">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <BooksIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2 id="dictionary-sources-title">{t("dictionarySources.title")}</h2>
          <p>{t("dictionarySources.description")}</p>
        </div>
      </div>

      <div className="settings-dictionary-sources">
        <OperationNotice
          operation={operation}
          items={dictionaries.map((dictionary) => ({ id: dictionary.id, title: dictionary.title }))}
        />
        <div className="settings-list">
          <div className="settings-row">
            <div>
              <strong>{t("dictionarySources.installed")}</strong>
              <span>
                {importing ? t("dictionarySources.importingHint") : t("dictionarySources.addHint")}
              </span>
            </div>
            <Button
              disabled={busy}
              icon={<PlusIcon aria-hidden="true" weight="bold" />}
              onClick={() => void handleAdd()}
              tone="secondary"
            >
              {operation?.active
                ? operationLabel(operation)
                : importing
                  ? t("dictionarySources.adding")
                  : t("dictionarySources.add")}
            </Button>
          </div>

          {dictionaries.length > 0 ? (
            <div className="settings-source-toolbar">
              <p id={moveHintId}>{t("dictionarySources.moveHint")}</p>
              {selecting ? (
                <div
                  className="library-selection-toolbar"
                  aria-label={t("dictionarySources.selection")}
                  role="toolbar"
                >
                  <output aria-live="polite">
                    {tp("dictionarySources.selected", selection.selectedCount)}
                  </output>
                  <Button disabled={busy} onClick={selection.selectAll} tone="quiet">
                    {t("dictionarySources.selectAll")}
                  </Button>
                  <Button
                    disabled={busy}
                    icon={<TrashIcon aria-hidden="true" />}
                    onClick={requestBulkRemoval}
                    tone="danger"
                  >
                    {t("dictionarySources.removeSelected")}
                  </Button>
                  <Button
                    disabled={busy}
                    icon={<XIcon aria-hidden="true" />}
                    onClick={selection.cancel}
                    tone="secondary"
                  >
                    {t("dictionarySources.clear")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <DictionaryList
            busy={busy}
            focusAfterMove={focusAfterMove}
            isSelected={selection.isSelected}
            list={list}
            moveHintId={moveHintId}
            onFocused={() => setFocusAfterMove(null)}
            onMove={(dictionary, position, keepFocus) => void move(dictionary, position, keepFocus)}
            onRemove={requestRemoval}
            onToggleSelection={(id) => {
              setNotice(null);
              setChangeError(null);
              selection.toggle(id);
            }}
            pendingOrder={pendingOrder}
          />
        </div>
        {importError ? (
          <div className="library-notice" role="alert">
            <span>{t("dictionarySources.addFailed", { error: importError })}</span>
            <NoticeClose onClose={() => setImportError(null)} />
          </div>
        ) : null}
        {importResult ? (
          <ImportNotice result={importResult} onClose={() => setImportResult(null)} />
        ) : operation?.command === "import_dictionaries" &&
          !operation.active &&
          operation.result &&
          operation.operationId !== closedImport ? (
          <ImportNotice
            result={operation.result as DictionaryImportBatch}
            onClose={() => setClosedImport(operation.operationId)}
          />
        ) : null}
        {changeError ? (
          <div className="library-notice library-notice--error" role="alert">
            <WarningCircleIcon aria-hidden="true" weight="duotone" />
            <span>{changeError()}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="library-notice" role="status">
            <span>{notice()}</span>
          </div>
        ) : null}

        {list.kind === "loaded" && (
          <StarterDictionaries
            empty={dictionaries.length === 0}
            installed={installedTitles}
            busy={busy}
            starter={starter}
          />
        )}
        <p className="visually-hidden" aria-live="polite">
          {announcement}
        </p>
      </div>
      <ConfirmDialog
        busy={removing}
        busyLabel={operation?.active ? operationLabel(operation) : t("dictionarySources.removing")}
        confirmLabel={t("dictionarySources.removeDictionary")}
        description={
          removeTarget
            ? t("dictionarySources.removeDescription", {
                title: removeTarget.title,
                revision: removeTarget.revision,
              })
            : ""
        }
        error={removeError && removeError()}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemoval()}
        open={removeTarget !== null}
        title={t("dictionarySources.removeTitle")}
      />
      <ConfirmDialog
        busy={bulkRemoving}
        busyLabel={operation?.active ? operationLabel(operation) : t("dictionarySources.removing")}
        confirmLabel={tp("dictionarySources.removeCount", selected.length)}
        description={tp("dictionarySources.bulkDescription", selected.length)}
        error={bulkRemoveError}
        onCancel={() => setBulkRemoveOpen(false)}
        onConfirm={() => void confirmBulkRemoval()}
        open={bulkRemoveOpen}
        title={tp("dictionarySources.bulkTitle", selected.length)}
      >
        <ul className="confirm-dialog__list" aria-label={t("dictionarySources.toRemove")}>
          {selected.map((dictionary) => (
            <li key={dictionary.id}>
              {dictionary.title}{" "}
              <span>{t("dictionarySources.revisionParen", { revision: dictionary.revision })}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </Card>
  );
}

interface Drag {
  id: number;
  pointerId: number;
  /** The dragged row's current place in the shown order. */
  position: number;
}

/** `order` with the ID at `from` moved to `to` (clamped to the end). */
function movedOrder(order: number[], from: number, to: number): number[] {
  const moved = [...order];
  const [id] = moved.splice(from, 1);
  moved.splice(Math.min(to, moved.length), 0, id);
  return moved;
}

function DictionaryList({
  busy,
  focusAfterMove,
  isSelected,
  list,
  moveHintId,
  onFocused,
  onMove,
  onRemove,
  onToggleSelection,
  pendingOrder,
}: {
  busy: boolean;
  focusAfterMove: number | null;
  isSelected: (id: number) => boolean;
  list: ListState;
  moveHintId: string;
  onFocused: () => void;
  onMove: (dictionary: DictionarySummary, position: number, keepFocus?: boolean) => void;
  onRemove: (dictionary: DictionarySummary) => void;
  onToggleSelection: (id: number) => void;
  pendingOrder: number[] | null;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const { t } = useI18n();
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dictionaries = list.kind === "loaded" ? list.dictionaries : [];
  const movable = !busy;

  // Keyboard focus stays on the moved row while its new place is shown and saved.
  useLayoutEffect(() => {
    if (focusAfterMove === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-dictionary-id="${focusAfterMove}"]`,
    );
    if (row && document.activeElement !== row) row.focus();
    if (!busy) onFocused();
  }, [busy, focusAfterMove, list, onFocused, pendingOrder]);

  if (list.kind === "loading") {
    return <p className="settings-source-empty">{t("dictionarySources.loading")}</p>;
  }
  if (list.kind === "error") {
    return (
      <p className="settings-source-empty" role="alert">
        {t("dictionarySources.loadFailed", { error: list.message })}
      </p>
    );
  }
  if (dictionaries.length === 0) {
    return <p className="settings-source-empty">{t("dictionarySources.empty")}</p>;
  }

  const byId = new Map(dictionaries.map((dictionary) => [dictionary.id, dictionary]));
  let order = pendingOrder ?? dictionaries.map((dictionary) => dictionary.id);
  if (drag) {
    order = order.filter((id) => id !== drag.id);
    order.splice(drag.position, 0, drag.id);
  }
  const shown = order.flatMap((id) => byId.get(id) ?? []);

  function startDrag(event: ReactPointerEvent<HTMLSpanElement>, dictionary: DictionarySummary) {
    if (!movable || dragRef.current || event.button !== 0) return;
    event.preventDefault();
    // React moves row nodes downward during the preview. Capturing a moved row loses
    // capture in WebView2; the list is stationary for the entire gesture.
    listRef.current?.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id: dictionary.id,
      pointerId: event.pointerId,
      position: dictionaries.indexOf(dictionary),
    };
    setDrag(dragRef.current);
  }

  function dragTo(event: ReactPointerEvent<HTMLOListElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !listRef.current) return;
    // The dragged row goes after every other row whose middle is above the pointer.
    const rows = [...listRef.current.children].filter(
      (row) => row instanceof HTMLElement && row.dataset.dictionaryId !== String(drag.id),
    );
    const position = rows.filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.top + bounds.height / 2 < event.clientY;
    }).length;
    if (position !== drag.position) {
      dragRef.current = { ...drag, position };
      setDrag(dragRef.current);
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLOListElement>, drop: boolean) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    const dictionary = byId.get(drag.id);
    if (drop && dictionary && drag.position !== dictionaries.indexOf(dictionary)) {
      onMove(dictionary, drag.position);
    }
  }

  function moveByKey(
    event: ReactKeyboardEvent<HTMLLIElement>,
    dictionary: DictionarySummary,
    index: number,
  ) {
    if (event.target !== event.currentTarget || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const position = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (!movable || drag || position < 0 || position >= shown.length) return;
    onMove(dictionary, position, true);
  }

  return (
    <ol
      className={["settings-source-list", drag ? "settings-source-list--dragging" : null]
        .filter(Boolean)
        .join(" ")}
      aria-label={t("dictionarySources.installed")}
      ref={listRef}
      onLostPointerCapture={(event) => {
        if (event.target === event.currentTarget) endDrag(event, false);
      }}
      onPointerCancel={(event) => endDrag(event, false)}
      onPointerMove={dragTo}
      onPointerUp={(event) => endDrag(event, true)}
    >
      {shown.map((dictionary, index) => {
        const selected = isSelected(dictionary.id);
        return (
          <li
            aria-describedby={moveHintId}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            className={[
              "settings-source-row",
              movable ? "settings-source-row--movable" : null,
              selected ? "settings-source-row--selected" : null,
              drag?.id === dictionary.id ? "settings-source-row--dragged" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            data-dictionary-id={dictionary.id}
            key={dictionary.id}
            onKeyDown={(event) => moveByKey(event, dictionary, index)}
            tabIndex={0}
          >
            <SelectionCheckbox
              className="settings-source-row__selection"
              aria-label={t("dictionarySources.select", { title: dictionary.title })}
              checked={selected}
              disabled={busy}
              onChange={() => onToggleSelection(dictionary.id)}
            />
            <span
              className="settings-source-row__handle"
              aria-hidden="true"
              data-disabled={movable ? undefined : true}
              title={movable ? t("dictionarySources.drag", { title: dictionary.title }) : undefined}
              onPointerDown={(event) => startDrag(event, dictionary)}
            >
              <ListIcon className="settings-source-row__grip" weight="bold" />
            </span>
            <div>
              <strong>{dictionary.title}</strong>
              <small>
                {rowCounts(dictionary)} ·{" "}
                {t("dictionarySources.revision", { revision: dictionary.revision })}
              </small>
            </div>
            <IconButton
              className="settings-source-row__remove"
              disabled={busy}
              label={t("dictionarySources.remove", { title: dictionary.title })}
              onClick={() => onRemove(dictionary)}
            >
              <TrashIcon aria-hidden="true" weight="bold" />
            </IconButton>
          </li>
        );
      })}
    </ol>
  );
}

function rowCounts(dictionary: DictionarySummary): string {
  const { t, tp } = i18n();
  const parts = [
    [dictionary.termCount, "dictionarySources.terms"],
    [dictionary.termMetaCount, "dictionarySources.termMeta"],
    [dictionary.kanjiCount, "dictionarySources.kanji"],
    [dictionary.kanjiMetaCount, "dictionarySources.kanjiMeta"],
  ] as const;
  const counted = parts.filter(([count]) => count > 0).map(([count, key]) => tp(key, count));
  return counted.length > 0 ? counted.join(" · ") : t("dictionarySources.noEntries");
}

function ImportNotice({ result, onClose }: { result: DictionaryImportBatch; onClose: () => void }) {
  const added = result.results.filter((item) => item.status === "imported").length;
  const existing = result.results.filter((item) => item.status === "alreadyImported").length;
  const refused = result.results.filter(
    (item) => item.status !== "imported" && item.status !== "alreadyImported",
  );
  const unsuccessful = result.results.filter((item) => item.status !== "imported");
  const { t } = useI18n();
  const summary = [
    t("dictionarySources.added", { count: added }),
    existing > 0 ? t("dictionarySources.alreadyInstalled", { count: existing }) : null,
    refused.length > 0 ? t("dictionarySources.notAdded", { count: refused.length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="library-notice" role="status">
      <div>
        <strong>{summary}</strong>
        {unsuccessful.length > 0 ? (
          <ul>
            {unsuccessful.map((item, index) => (
              <li key={`${item.fileName}-${index}`}>
                <strong>{item.fileName}:</strong> {resultMessage(item)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <NoticeClose onClose={onClose} />
    </div>
  );
}

function resultMessage(result: DictionaryImportResult): string {
  const { t } = i18n();
  switch (result.status) {
    case "imported":
      return t("dictionarySources.resultImported", {
        title: result.title ?? t("dictionarySources.theDictionary"),
      });
    case "alreadyImported":
      return t("dictionarySources.resultAlready", {
        title: result.title ?? t("dictionarySources.thisDictionary"),
      });
    case "invalid":
      return t("dictionarySources.resultInvalid");
    case "unreadable":
      return t("dictionarySources.resultUnreadable");
    case "failed":
      return t("dictionarySources.resultFailed");
  }
}

/** Titles joined as prose for the interface language: "A", "A and B", "A, B, and C". */
function titleList(dictionaries: DictionarySummary[]): string {
  return i18n().list(dictionaries.map((dictionary) => dictionary.title));
}

/** The notice for dictionaries that were already removed, written when shown. */
const alreadyRemoved =
  (dictionaries: DictionarySummary[]): Message =>
  () =>
    i18n().tp("dictionarySources.alreadyRemoved", dictionaries.length, {
      titles: titleList(dictionaries),
    });

function errorMessage(error: unknown): string {
  return failureText(error instanceof Error ? error.message : String(error), i18n().t);
}
