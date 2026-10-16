import {
  ArrowClockwiseIcon,
  CheckIcon,
  NotePencilIcon,
  PlusIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../components/ui/IconButton";
import { useI18n } from "../../i18n/i18n";
import type { FrequencyMatch, TermGroup } from "../dictionary/dictionaryApi";
import { frequencyValue } from "../dictionary/DictionaryResults";
import { glossaryPlainText } from "../dictionary/GlossaryText";
import {
  ankiChanged,
  ankiNoteChanged,
  ankiError,
  cachedAnki,
  checkNote,
  createNote,
  browseNote,
  noteStatus,
  type NoteOutcome,
  type NoteStatus,
} from "./ankiApi";
import {
  emptyContext,
  cardFields,
  expressionFurigana,
  fieldProblem,
  firstFieldParts,
  validText,
  type CardContext,
} from "./templates";

export interface CardSource {
  label: string;
  dictionaryId?: number;
  matchedText?: string;
  bookId?: string;
  context: CardContext;
  glossary?: unknown;
  tagSources?: import("./ankiApi").DictionaryTagSource[];
  /** A word's reading, so a note for another reading of the same word is not a duplicate. */
  reading?: string;
}
const frequencyText = (frequencies: FrequencyMatch[]) =>
  frequencies.map((f) => `${f.dictionaryTitle}: ${frequencyValue(f.data)}`).join("\n");
/**
 * Each source's first rank, as Yomitan's frequency-harmonic/average-rank read it: a display
 * value's leading number when it has one (11 for 11㋕), else the numeric frequency. Repeated
 * rows from one source and occurrence-count sources are skipped.
 */
export function frequencyRanks(frequencies: FrequencyMatch[]): number[] {
  const ranks: number[] = [];
  let previous: number | undefined;
  for (const f of frequencies) {
    const repeated = f.dictionaryId === previous;
    previous = f.dictionaryId;
    if (repeated || f.frequencyMode === "occurrence-based") continue;
    const rank = frequencyRank(f.data);
    if (rank !== null) ranks.push(rank);
  }
  return ranks;
}
function frequencyRank(data: unknown): number | null {
  let value = data;
  if (value && typeof value === "object" && "frequency" in value)
    value = (value as Record<string, unknown>).frequency;
  const leading = (text: unknown) => {
    const match = typeof text === "string" ? /^\s*(\d+)/.exec(text) : null;
    return match ? Number(match[1]) : null;
  };
  let rank: number | null = null;
  if (typeof value === "number") rank = value;
  else if (typeof value === "string") rank = leading(value);
  else if (value && typeof value === "object") {
    const detail = value as Record<string, unknown>;
    rank = leading(detail.displayValue);
    if (!rank) rank = typeof detail.value === "number" ? detail.value : leading(detail.value);
  }
  return rank !== null && Number.isFinite(rank) && rank > 0 ? rank : null;
}
/** Yomitan's empty rank, so cards without a frequency sort last. */
const noRank = "9999999";
const frequencyHarmonic = (frequencies: FrequencyMatch[]) => {
  const ranks = frequencyRanks(frequencies);
  return ranks.length
    ? String(Math.floor(ranks.length / ranks.reduce((sum, rank) => sum + 1 / rank, 0)))
    : noRank;
};
const frequencyAverage = (frequencies: FrequencyMatch[]) => {
  const ranks = frequencyRanks(frequencies);
  return ranks.length
    ? String(Math.floor(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length))
    : noRank;
};
function frequencyTags(frequencies: FrequencyMatch[]) {
  return frequencies.map((f) => ({
    id: f.dictionaryId,
    title: f.dictionaryTitle,
    values: frequencyTagValues(f.data),
  }));
}
function frequencyTagValues(data: unknown): string[] {
  let value = data;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    value = item.frequency ?? item;
    if (value && typeof value === "object") {
      const detail = value as Record<string, unknown>;
      value = detail.displayValue ?? detail.value;
    }
  }
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))
    return [];
  const text = String(value);
  return text.trim() && validText(text, 1024) ? [text] : [];
}
export function termCardSources(group: TermGroup, reader?: ReaderCardContext): CardSource[] {
  const pitches = group.pitches
    .flatMap((p) => {
      if (!p.data || typeof p.data !== "object") return [];
      const data = p.data as Record<string, unknown>;
      if (data.reading !== group.reading || !Array.isArray(data.pitches)) return [];
      return data.pitches.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const fields = entry as Record<string, unknown>;
        if (
          typeof fields.position !== "number" ||
          !Number.isSafeInteger(fields.position) ||
          fields.position < 0
        )
          return [];
        return [`${p.dictionaryTitle}: ${fields.position}`];
      });
    })
    .join("\n");
  const definitions = group.terms.map((term) => glossaryPlainText(term.glossary));
  const glossary = definitions.join("\n\n");
  return group.terms.map((term, index) => ({
    label: `${index + 1}. ${term.dictionaryTitle}`,
    dictionaryId: term.dictionaryId,
    glossary: term.glossary,
    tagSources: frequencyTags(group.frequencies),
    matchedText: group.text,
    bookId: reader?.bookId,
    reading: group.reading,
    context: {
      ...emptyContext,
      expression: group.expression,
      reading: group.reading,
      expressionFurigana: expressionFurigana(group.expression, group.reading),
      glossary,
      definition: definitions[index],
      source: term.dictionaryTitle,
      frequency: frequencyText(group.frequencies),
      frequencyHarmonic: frequencyHarmonic(group.frequencies),
      frequencyAverage: frequencyAverage(group.frequencies),
      pitch: pitches,
      sentence: reader?.sentence ?? "",
      bookTitle: reader?.bookTitle ?? "",
    },
  }));
}
export interface ReaderCardContext {
  sentence?: string;
  bookTitle?: string;
  bookId?: string;
}
export function AnkiAction({ sources }: { sources: CardSource[] }) {
  // A new word gets a new action; its glossaries are not part of its identity.
  const identity = JSON.stringify(
    sources.map((s) => [s.context.expression, s.reading, s.dictionaryId, s.context.sentence]),
  );
  return <CardAction key={identity} sources={sources} />;
}

/**
 * The compact + action. It never shows a message box: a check or creation problem disables it
 * (or, after an uncertain creation, turns it into a check) and explains itself in its tooltip.
 * Rechecks after a card or configuration change, or when Komori regains focus, keep the last
 * answer usable, so a click never lands on a button that a background check just disabled.
 */
function CardAction({ sources }: { sources: CardSource[] }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [status, setStatus] = useState<NoteStatus | null>(null);
  const [policy, setPolicy] = useState<"prevent" | "overwrite" | "allow">("prevent");
  const [outcome, setOutcome] = useState<NoteOutcome | null>(null);
  const [problem, setProblem] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const alive = useRef(false);
  const operation = useRef(false);
  const revision = useRef(0);
  const submitted = useRef(false);
  const unresolved = useRef(false);
  const latest = useRef(sources);
  latest.current = sources;
  // The text selected in this popup (or results page) when the action is pressed.
  const selection = useRef("");
  useEffect(() => {
    alive.current = true;
    const refresh = async (fresh: boolean) => {
      const current = latest.current;
      if (!current.length || operation.current || unresolved.current) return;
      const version = ++revision.current;
      if (fresh) {
        setChecking(true);
        setStatus(null);
        setOutcome(null);
        submitted.current = false;
      }
      try {
        const prefs = await cachedAnki();
        if (!alive.current || version !== revision.current) return;
        const mapping = prefs.mappings[prefs.model];
        if (!mapping) throw "changed";
        const first = firstFieldParts(mapping, current);
        if ("problem" in first) {
          setStatus(null);
          setProblem(first.problem);
          return;
        }
        const next = await noteStatus(prefs, first.parts, current[0].reading);
        if (!alive.current || version !== revision.current) return;
        setPolicy(prefs.duplicatePolicy ?? "prevent");
        setStatus(next);
        setProblem("");
        if (next.status === "pending") {
          setRequestId(next.requestId);
          submitted.current = true;
          unresolved.current = true;
          setOutcome({ status: "uncertain" });
        }
      } catch (error) {
        if (alive.current && version === revision.current) {
          setStatus(null);
          setProblem(ankiError(error));
        }
      } finally {
        if (alive.current && version === revision.current) setChecking(false);
      }
    };
    const recheck = () => {
      if (!operation.current) void refresh(false);
    };
    const changed = () => {
      if (unresolved.current) return;
      if (operation.current) revision.current++;
      else void refresh(true);
    };
    void refresh(true);
    window.addEventListener(ankiChanged, changed);
    window.addEventListener(ankiNoteChanged, recheck);
    window.addEventListener("focus", recheck);
    return () => {
      alive.current = false;
      revision.current++;
      window.removeEventListener(ankiChanged, changed);
      window.removeEventListener(ankiNoteChanged, recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);
  if (!sources.length) return null;
  const expression = sources[0].context.expression;
  const existing = status?.status === "existing" ? status : null;
  const canWrite =
    status?.status === "missing" ||
    (!!existing && (policy === "allow" || (policy === "overwrite" && existing.count === 1)));
  function finishOperation() {
    operation.current = false;
    if (alive.current) setBusy(false);
  }
  async function add() {
    if (operation.current || !status || outcome || !canWrite) return;
    operation.current = true;
    revision.current++;
    setBusy(true);
    setProblem("");
    try {
      const prefs = await cachedAnki();
      if (!alive.current) return;
      const mapping = prefs.mappings[prefs.model];
      if (!mapping) throw "changed";
      const selectionText = selection.current;
      const { fields, ...content } = cardFields(
        mapping,
        sources.map((source) => ({ ...source, context: { ...source.context, selectionText } })),
      );
      const invalid = fieldProblem(fields, mapping.fields);
      if (invalid) {
        if (alive.current) setProblem(invalid);
        return;
      }
      const id = crypto.randomUUID();
      setRequestId(id);
      submitted.current = true;
      const result = await createNote(id, prefs, fields, {
        ...content,
        bookId: sources[0].bookId,
        ...(sources[0].reading ? { reading: sources[0].reading } : {}),
      });
      unresolved.current = result.status === "uncertain";
      if (alive.current) setOutcome(result);
      window.dispatchEvent(new Event(ankiNoteChanged));
    } catch (error) {
      if (!alive.current) return;
      if (
        !submitted.current ||
        [
          "invalid",
          "contentTooLarge",
          "changed",
          "unavailable",
          "protocol",
          "rejected",
          "busy",
          "pending",
        ].includes(String(error))
      ) {
        submitted.current = false;
        setProblem(ankiError(error));
      } else {
        unresolved.current = true;
        setOutcome({ status: "uncertain" });
      }
    } finally {
      finishOperation();
    }
  }
  async function check() {
    if (!requestId || operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      const result = await checkNote(requestId);
      unresolved.current = result.status === "uncertain";
      if (alive.current) {
        setOutcome(result);
        setProblem("");
      }
      window.dispatchEvent(new Event(ankiNoteChanged));
    } catch (error) {
      if (alive.current) setProblem(ankiError(error));
    } finally {
      finishOperation();
    }
  }
  const noteId = outcome && "id" in outcome ? outcome.id : existing?.id;
  const confirmed = outcome?.status === "created" || outcome?.status === "updated";
  const uncertain = outcome?.status === "uncertain";
  const marked = confirmed || outcome?.status === "duplicate" || (!!existing && !canWrite);
  const waiting = busy || (checking && !status && !problem);
  const label = t(
    waiting
      ? busy
        ? "ankiAction.saving"
        : "ankiAction.checking"
      : uncertain
        ? "ankiAction.checkUncertain"
        : confirmed
          ? "ankiAction.saved"
          : outcome?.status === "duplicate" || (existing && !canWrite)
            ? "ankiAction.exists"
            : outcome?.status === "failed"
              ? "ankiAction.failed"
              : existing && policy === "overwrite"
                ? "ankiAction.update"
                : existing && policy === "allow"
                  ? "ankiAction.addAnother"
                  : "ankiAction.add",
    { expression },
  );
  const uncertainNote = uncertain ? t("ankiAction.uncertain") : "";
  const note = problem || uncertainNote;
  return (
    <div className="anki-action-group">
      {noteId && (
        <IconButton
          data-anki-action="browse"
          label={t("ankiAction.browse", { expression })}
          className="anki-action"
          disabled={busy}
          onClick={() => {
            if (operation.current) return;
            operation.current = true;
            setBusy(true);
            void browseNote(noteId)
              .catch((error) => {
                if (alive.current) setProblem(ankiError(error));
              })
              .finally(finishOperation);
          }}
        >
          <NotePencilIcon aria-hidden="true" size={18} />
        </IconButton>
      )}
      <IconButton
        data-anki-action="add"
        label={label}
        title={note ? `${label}. ${note}` : label}
        aria-description={note || undefined}
        className={`anki-action${marked ? " anki-action--saved" : ""}${waiting ? " anki-action--checking" : ""}${problem ? " anki-action--blocked" : ""}`}
        disabled={waiting || (uncertain ? false : !!problem || !!outcome || !canWrite)}
        // Read before the press can move or clear the selection; keys keep it as it is.
        onPointerDown={(event) => {
          selection.current = selectedText(event.currentTarget);
        }}
        onClick={(event) => {
          if (event.detail === 0) selection.current = selectedText(event.currentTarget);
          void (uncertain ? check() : add());
        }}
      >
        {waiting ? (
          <SpinnerGapIcon aria-hidden="true" size={18} />
        ) : uncertain ? (
          <WarningCircleIcon aria-hidden="true" size={18} />
        ) : marked ? (
          <CheckIcon aria-hidden="true" size={18} />
        ) : existing && policy === "overwrite" ? (
          <ArrowClockwiseIcon aria-hidden="true" size={18} />
        ) : (
          <PlusIcon aria-hidden="true" size={18} />
        )}
      </IconButton>
      <span className="visually-hidden" role="status">
        {problem ||
          (outcome?.status === "created"
            ? t("ankiAction.added")
            : outcome?.status === "updated"
              ? t("ankiAction.updated")
              : outcome?.status === "duplicate"
                ? t("ankiAction.duplicate")
                : outcome?.status === "failed"
                  ? t("ankiAction.creationFailed")
                  : uncertainNote)}
      </span>
    </div>
  );
}

/** The text selected within the action's popup, or on its page outside any popup. */
function selectedText(action: Element): string {
  const selection = action.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const scope = action.closest(".reader-lookup") ?? action.ownerDocument.body;
  const range = selection.getRangeAt(0);
  if (!scope.contains(range.commonAncestorContainer)) return "";
  return selection.toString().trim();
}
