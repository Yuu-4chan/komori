import { useI18n } from "../../i18n/i18n";
import { ArrowSquareOutIcon, TranslateIcon } from "@phosphor-icons/react";
import { type Ref, type CSSProperties, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDictionaryRevision } from "../dictionary/useDictionaryRevision";

import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import {
  groupKey,
  KanjiCard,
  lookupDictionary,
  useWordAudioAvailable,
  type DictionaryLookup,
} from "../dictionary/DictionaryResults";
import { useAppearance } from "../appearance/AppearanceProvider";
import { popupThemeStyle } from "./popupThemes";
import { LookupEntry } from "../dictionary/LookupEntry";
import { type ReaderCardContext } from "../anki/AnkiAction";
import { lookupPopupFontSize, lookupQuery } from "./lookupPopup";
import { triggerEnabled, lookupTextAllowed, type LookupTriggerPreferences } from "./lookupTriggers";
import { characterAtPoint, textFromCharacter } from "./textSelection";
import type { ReaderRect } from "./renderer";
import { activateExpression } from "./popupShortcuts";

type LookupState =
  | { status: "initial" }
  | { status: "loading" }
  | { status: "ready"; lookup: DictionaryLookup }
  | { status: "error" };

/** A lookup asked for from inside a popup: its text and where that text shows. */
export interface ChildLookupRequest {
  query: string;
  rect: ReaderRect;
}

interface ReaderLookupPopupProps {
  /** The trimmed text to look up. A new query needs a new popup (keyed by its selection). */
  query: string;
  readerContext?: ReaderCardContext;
  /** Where the popup shows, in its container's CSS pixels. */
  placement: { left: number; top: number; width: number; height: number };
  /** Successful longest matched start in Unicode characters; zero for failure/no match. */
  onMatch?: (length: number) => void;
  /** Search the Dictionary page, as a headword kanji or glossary term link does there. */
  onSearchTerm: (term: string) => void;
  /**
   * Look up text from inside this popup (a scan, a selection, a headword kanji or glossary link)
   * in a child popup. Without it, kanji and links search the Dictionary page.
   */
  onChildLookup?: (request: ChildLookupRequest) => void;
  /** Pointer presses inside this popup (a child popup's parent closes its children). */
  onPointerDown?: () => void;
  ref?: Ref<HTMLElement>;
  preview?: boolean;
  retry?: number;
  /**
   * Whether an installed dictionary can supply definitions (null until known), read once by the
   * Reader for all its popups. The settings preview sits beside its own source settings.
   */
  definitionSources?: boolean | null;
}

/**
 * The lookup of a Reader selection: each matched headword as an entry with its actions on the
 * headword's row. It looks its query up once; a response arriving after it closed is discarded.
 */
export function ReaderLookupPopup({
  query,
  readerContext,
  placement,
  onMatch,
  onSearchTerm,
  onChildLookup,
  onPointerDown,
  ref,
  preview = false,
  retry = 0,
  definitionSources = null,
}: ReaderLookupPopupProps) {
  const appearance = useAppearance();
  const { t } = useI18n();
  const {
    readerPopupDefinitionSources,
    readerPopupFrequencySources,
    readerPopupPitchSources,
    readerPopupShowDictionaryNames,
    readerPopupShowPitch,
    readerPopupShowFrequency,
    readerPopupAnkiAction,
    readerPopupVoiceAction,
    readerPopupTheme,
    readerPopupRadius,
    readerPopupFontSize,
    readerPopupLineHeight,
    readerPopupCustomPalette,
    readerPopupMaxResults,
    readerPopupReadingPosition,
  } = appearance;
  const [state, setState] = useState<LookupState>({ status: "loading" });
  const canPlayAudio = useWordAudioAvailable();
  const revision = useDictionaryRevision();
  const previous = useRef(false);
  const root = useRef<HTMLElement | null>(null);
  const policyKey = JSON.stringify({
    definitions: readerPopupDefinitionSources,
    frequency: readerPopupFrequencySources,
    pitch: readerPopupPitchSources,
  });

  useEffect(() => {
    let active = true;
    if (previous.current) onMatch?.(0);
    previous.current = true;
    setState({ status: query ? "loading" : "initial" });
    if (!query) return;
    const policy = JSON.parse(policyKey);
    lookupDictionary(
      query,
      Object.values(policy).every((role) => (role as { mode: string }).mode === "all")
        ? undefined
        : policy,
      readerPopupMaxResults,
    ).then(
      (lookup) => {
        if (!active) return;
        setState({ status: "ready", lookup });
        const hasKanji = lookup.kanji.entries.length > 0 || lookup.kanji.frequencies.length > 0;
        onMatch?.(lookup.groups.length > 0 ? [...lookup.matched].length : hasKanji ? 1 : 0);
      },
      () => {
        if (active) {
          setState({ status: "error" });
          onMatch?.(0);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [query, onMatch, policyKey, revision, retry, readerPopupMaxResults]);

  usePopupScanning(root, onChildLookup, appearance);

  // Inside the Reader, kanji and glossary links open a child popup beside the link.
  const searchTerm = onChildLookup
    ? (term: string) => {
        const focused = document.activeElement;
        const anchor =
          focused instanceof HTMLElement && root.current?.contains(focused)
            ? focused
            : root.current;
        if (anchor) onChildLookup({ query: term, rect: anchor.getBoundingClientRect() });
      }
    : onSearchTerm;

  const lookup = state.status === "ready" ? state.lookup : null;
  const showKanji =
    !!lookup && (lookup.kanji.entries.length > 0 || lookup.kanji.frequencies.length > 0);
  const entryCount = (lookup?.groups.length ?? 0) + (showKanji ? 1 : 0);

  return (
    <section
      aria-label={t("popup.label", { query })}
      className={preview ? "reader-lookup reader-lookup--preview" : "reader-lookup"}
      ref={(element) => {
        root.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      role={preview ? "region" : "dialog"}
      data-popup-theme={readerPopupTheme}
      onPointerDown={(event) => {
        const expression = (event.target as Element).closest("[data-popup-expression]");
        if (expression) activateExpression(event.currentTarget, expression);
        onPointerDown?.();
      }}
      onFocusCapture={(event) => {
        const expression = (event.target as Element).closest("[data-popup-expression]");
        if (expression) activateExpression(event.currentTarget, expression);
      }}
      style={
        {
          ...popupThemeStyle(readerPopupTheme, readerPopupCustomPalette),
          ...placement,
          borderRadius: `${readerPopupRadius}px`,
          "--scroll-radius": `${readerPopupRadius}px`,
          "--popup-zoom": readerPopupFontSize / lookupPopupFontSize.default,
          "--popup-line-height": readerPopupLineHeight,
        } as CSSProperties
      }
    >
      <div className="reader-lookup__body scroll-safe" aria-live="polite">
        {!preview && <span className="visually-hidden" data-active-expression-status />}
        {state.status === "initial" && (
          <p className="dictionary-results__message">{t("popup.initial")}</p>
        )}
        {state.status === "loading" && (
          <p className="dictionary-results__message">{t("dictionaryPage.searching")}</p>
        )}
        {state.status === "error" && (
          <p className="dictionary-results__message" role="alert">
            {t(preview ? "popup.previewFailed" : "popup.failed")}
          </p>
        )}
        {lookup && entryCount === 0 && definitionSources === false && (
          <div className="reader-lookup__empty">
            <EmptyState
              icon={TranslateIcon}
              title={t("dictionaryPage.noDictionaries")}
              description={t("dictionaryPage.noDictionariesHint")}
            />
            <Link className="button button--secondary" to="/settings?section=dictionary">
              {t("dictionaryPage.getDictionaries")}
            </Link>
          </div>
        )}
        {lookup && entryCount === 0 && definitionSources !== false && (
          <div className="reader-lookup__empty">
            <EmptyState
              icon={TranslateIcon}
              title={t("dictionaryPage.noMatches")}
              description={t("popup.noMatches")}
            />
            <OpenInDictionary term={query} onOpen={onSearchTerm} />
          </div>
        )}
        {lookup && entryCount > 0 && (
          <div className="reader-lookup__entries">
            {showKanji && (
              <div data-popup-expression data-active="true">
                <KanjiCard
                  character={lookup.query}
                  entries={lookup.kanji.entries}
                  frequencies={lookup.kanji.frequencies}
                  showFrequencies={readerPopupShowFrequency}
                  showDictionaryNames={readerPopupShowDictionaryNames}
                  actions={
                    <span className="lookup-entry__actions">
                      <OpenInDictionary term={lookup.query} onOpen={onSearchTerm} />
                    </span>
                  }
                />
              </div>
            )}
            {lookup.groups.map((group, index) => (
              <div
                key={groupKey(group)}
                data-popup-expression
                data-active={!showKanji && index === 0 ? "true" : "false"}
              >
                <LookupEntry
                  readerContext={readerContext}
                  showAnkiAction={readerPopupAnkiAction}
                  showPitch={readerPopupShowPitch}
                  showFrequency={readerPopupShowFrequency}
                  showVoiceAction={readerPopupVoiceAction}
                  showDictionaryNames={readerPopupShowDictionaryNames}
                  readingPosition={readerPopupReadingPosition}
                  canPlayAudio={canPlayAudio}
                  group={group}
                  key={groupKey(group)}
                  onSearchTerm={searchTerm}
                  onOpenDictionary={onSearchTerm}
                  start={group.text === lookup.matched ? null : group.text}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function OpenInDictionary({ term, onOpen }: { term: string; onOpen: (term: string) => void }) {
  const { t } = useI18n();
  return (
    <IconButton
      className="reader-lookup__action"
      label={t("lookupEntry.open", { expression: term })}
      onClick={() => onOpen(term)}
    >
      <ArrowSquareOutIcon aria-hidden="true" size={16} />
    </IconButton>
  );
}

/**
 * Lookups from inside a popup, with the Reader's own trigger settings: Shift over its text, hover
 * after the scan delay, and releasing a mouse selection. Scans read up to the scan length from
 * the character under the pointer, as the book does.
 */
function usePopupScanning(
  root: { current: HTMLElement | null },
  onScan: ((request: ChildLookupRequest) => void) | undefined,
  settings: LookupTriggerPreferences,
) {
  const latest = useRef({ onScan, settings });
  latest.current = { onScan, settings };
  const enabled = !!onScan;
  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) return;
    let pointer: { x: number; y: number } | null = null;
    let scanned: { node: Node; offset: number } | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const body = () => element.querySelector(".reader-lookup__body");
    const scan = (origin: "shift" | "hover") => {
      const { onScan, settings } = latest.current;
      if (!pointer || !onScan || !triggerEnabled(settings, origin)) return;
      const range = characterAtPoint(document, pointer.x, pointer.y);
      if (!range || !body()?.contains(range.startContainer)) return;
      if (scanned && scanned.node === range.startContainer && scanned.offset === range.startOffset)
        return;
      scanned = { node: range.startContainer, offset: range.startOffset };
      const query = lookupQuery(textFromCharacter(range, settings.readerPopupScanLength).text);
      if (query && lookupTextAllowed(settings, query))
        onScan({ query, rect: range.getBoundingClientRect() });
    };
    const cancelHover = () => clearTimeout(hoverTimer);
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      cancelHover();
      if (event.buttons) return;
      const { settings } = latest.current;
      if (event.shiftKey && triggerEnabled(settings, "shift")) scan("shift");
      else if (triggerEnabled(settings, "hover")) {
        scanned = null;
        hoverTimer = setTimeout(() => scan("hover"), settings.readerPopupHoverDelay);
      } else scanned = null;
    };
    const leave = () => {
      pointer = null;
      scanned = null;
      cancelHover();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Shift" && !event.repeat && pointer) scan("shift");
    };
    const release = (event: PointerEvent) => {
      if (event.button !== 0) return;
      setTimeout(() => {
        const { onScan, settings } = latest.current;
        const selection = document.getSelection();
        if (!onScan || !selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (
          !triggerEnabled(settings, "pointer") ||
          !body()?.contains(range.commonAncestorContainer)
        )
          return;
        const query = lookupQuery(selection.toString());
        if (query && lookupTextAllowed(settings, query))
          onScan({ query, rect: range.getBoundingClientRect() });
      }, 0);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("pointerup", release);
    window.addEventListener("keydown", key);
    return () => {
      cancelHover();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("pointerup", release);
      window.removeEventListener("keydown", key);
    };
  }, [enabled, root]);
}
