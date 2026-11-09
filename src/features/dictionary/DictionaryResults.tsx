import { isTauri } from "@tauri-apps/api/core";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import type { SourcePolicy } from "./sourcePolicy";
import { defaultLookupLanguage, type LookupLanguage } from "./lookupLanguage";
import { SpeakerHighIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  lookupKanji,
  lookupTerms,
  type Deinflection,
  type KanjiLookup,
  type TermGroup,
  type TermTag,
} from "./dictionaryApi";
import { isKanji } from "./kanji";
import { getWordAudio } from "./wordAudio";
import { useAppearance } from "../appearance/AppearanceProvider";

// The Dictionary page's lookup and result rendering, shared with the Reader's lookup popup.

/**
 * One text's lookup. `matched` is the text the first groups match: the query, or its longest
 * matching start; `inflected` says every group of that start was deinflected, and `deinflection`
 * names the one dictionary form they all matched as, when there is one. Shorter starts' groups
 * follow them.
 */
export interface DictionaryLookup {
  query: string;
  matched: string;
  inflected: boolean;
  deinflection: Deinflection | null;
  groups: TermGroup[];
  kanji: KanjiLookup;
}

export const noKanji: KanjiLookup = { entries: [], frequencies: [] };

/** Look up a trimmed, nonempty query as the Dictionary page does, in the lookup language. */
export async function lookupDictionary(
  query: string,
  sources?: SourcePolicy,
  maxResults?: number,
  language: LookupLanguage = defaultLookupLanguage,
): Promise<DictionaryLookup> {
  const japanese = language === defaultLookupLanguage;
  // Only a one-character query can be a kanji; the native lookup decides whether it is one.
  // Kanji are looked up only in Japanese.
  const [{ text: matched, groups }, kanji] = await Promise.all([
    !japanese
      ? lookupTerms(query, sources, maxResults, language)
      : maxResults !== undefined
        ? lookupTerms(query, sources, maxResults)
        : sources
          ? lookupTerms(query, sources)
          : lookupTerms(query),
    japanese && [...query].length === 1
      ? sources
        ? lookupKanji(query, sources)
        : lookupKanji(query)
      : noKanji,
  ]);
  // The header describes the longest start; shorter starts' cards name their own.
  const longest = groups.filter((group) => group.text === matched);
  const inflected = longest.every((group) => group.deinflection);
  const deinflection = onlyDeinflection(longest);
  return { query, matched, inflected, deinflection, groups, kanji };
}

/** The pronunciation playing, one at a time across the app; `stop` ends it at once. */
let activePronunciation: { owner: object; stop: () => void } | null = null;

function stopPronunciation() {
  const current = activePronunciation;
  activePronunciation = null;
  current?.stop();
}

/** The results header: the text the longest start matched, and how many entries show. */
export function DictionaryResultsHeader({
  lookup,
  entryCount,
}: {
  lookup: DictionaryLookup;
  entryCount: number;
}) {
  const { t, tp } = useI18n();
  return (
    <div className="dictionary-results__header">
      {(lookup.matched !== lookup.query || lookup.inflected) && lookup.groups.length > 0 ? (
        <div>
          <span>{t("dictionaryResults.showingFor")}</span> <strong>{lookup.matched}</strong>
          {lookup.deinflection && (
            <>
              {" "}
              <span>→</span> <strong>{lookup.deinflection.form}</strong>{" "}
              {lookup.deinflection.inflections.length > 0 && (
                <span>({inflectionNames(lookup.deinflection.inflections)})</span>
              )}
            </>
          )}
          {lookup.matched !== lookup.query && (
            <>
              {" "}
              <span
                className="dictionary-results__query"
                title={t("dictionaryResults.noExact", { query: lookup.query })}
              >
                {t("dictionaryResults.noExact", { query: lookup.query })}
              </span>
            </>
          )}
        </div>
      ) : (
        <div>
          <span>{t("dictionaryResults.resultsFor")}</span>{" "}
          <strong title={lookup.query}>{lookup.query}</strong>
        </div>
      )}
      <span>{tp("dictionaryResults.entries", entryCount)}</span>
    </div>
  );
}

export const inflectionKeys: Record<string, MessageKey> = {
  past: "inflection.past",
  negative: "inflection.negative",
  polite: "inflection.polite",
  volitional: "inflection.volitional",
  progressive: "inflection.progressive",
  completive: "inflection.completive",
  preparatory: "inflection.preparatory",
  conditional: "inflection.conditional",
  contracted: "inflection.contracted",
  "negative volitional": "inflection.negativeVolitional",
  desiderative: "inflection.desiderative",
  adverbial: "inflection.adverbial",
  causative: "inflection.causative",
  "short causative": "inflection.shortCausative",
  passive: "inflection.passive",
  potential: "inflection.potential",
  "potential or passive": "inflection.potentialOrPassive",
  imperative: "inflection.imperative",
  "negative imperative": "inflection.negativeImperative",
  "volitional slang": "inflection.volitionalSlang",
  continuative: "inflection.continuative",
  attributive: "inflection.attributive",
  "n-slang": "inflection.nSlang",
  "negative imperative slang": "inflection.negativeImperativeSlang",
  "kansai-ben": "inflection.kansaiBen",
  plural: "inflection.plural",
  possessive: "inflection.possessive",
  "third person singular": "inflection.thirdPersonSingular",
  "interposed object": "inflection.interposedObject",
  archaic: "inflection.archaic",
  adverb: "inflection.adverb",
  comparative: "inflection.comparative",
  superlative: "inflection.superlative",
  "dropped g": "inflection.droppedG",
  "going-to future": "inflection.goingToFuture",
  "will future": "inflection.willFuture",
  nominalization: "inflection.nominalization",
  "past participle": "inflection.pastParticiple",
  "zu-infinitive": "inflection.zuInfinitive",
  present: "inflection.present",
  "present participle": "inflection.presentParticiple",
  declension: "inflection.declension",
  "present indicative": "inflection.presentIndicative",
  "imperfect indicative": "inflection.imperfectIndicative",
  future: "inflection.future",
  "imperative present": "inflection.imperativePresent",
  preterite: "inflection.preterite",
  "present subjunctive": "inflection.presentSubjunctive",
  feminine: "inflection.feminine",
  "feminine adjective": "inflection.feminineAdjective",
  imperfect: "inflection.imperfect",
  "imperfect subjunctive": "inflection.imperfectSubjunctive",
  participle: "inflection.participle",
  reflexive: "inflection.reflexive",
  "pronoun substitution": "inflection.pronounSubstitution",
  pronoun: "inflection.pronoun",
  diminutive: "inflection.diminutive",
  gerund: "inflection.gerund",
  pluperfect: "inflection.pluperfect",
  "future subjunctive": "inflection.futureSubjunctive",
  case: "inflection.case",
  "short form": "inflection.shortForm",
};

/**
 * The deinflector's names in the interface language, joined; endings and affixes such as -te,
 * -tara, -ing and un- keep their romanized names.
 */
export function inflectionNames(names: readonly string[]): string {
  const { t } = i18n();
  return names
    .map((name) => (inflectionKeys[name] ? t(inflectionKeys[name]) : name))
    .join(t("dictionaryResults.inflectionSeparator"));
}

export function groupKey(group: TermGroup) {
  return `${group.expression}\u0000${group.reading}`;
}

// The dictionary form every group matched as, when they all matched as one inflected form.
function onlyDeinflection(groups: TermGroup[]): Deinflection | null {
  const first = groups[0]?.deinflection;
  if (!first) return null;
  const same = (deinflection: Deinflection | null) =>
    deinflection?.form === first.form &&
    deinflection.inflections.join("\u0000") === first.inflections.join("\u0000");
  return groups.every((group) => same(group.deinflection)) ? first : null;
}

/** Whether Voice can play anything: recordings come from the desktop app's saved sources. */
export function useWordAudioAvailable(): boolean {
  const { wordAudioSources } = useAppearance();
  return isTauri() && wordAudioSources.length > 0;
}

type PronunciationState = "idle" | "loading" | "playing" | "missing";
type Pronunciation = { owner: object; stop: () => void };

/**
 * Plays a headword's first recording from the word audio sources. One pronunciation plays at a
 * time across the app, and leaving stops it.
 */
function usePronunciation(expression: string, reading: string, canPlay: boolean) {
  const [state, setState] = useState<PronunciationState>("idle");
  const owner = useRef({});

  // Each word starts over: another word can have a recording this one lacked.
  useEffect(() => {
    setState("idle");
    return () => {
      if (activePronunciation?.owner === owner.current) stopPronunciation();
    };
  }, [expression, reading]);

  async function playRecording(blob: Blob, pronunciation: Pronunciation): Promise<boolean> {
    const url = URL.createObjectURL(blob);
    const element = new Audio(url);
    const release = () => {
      element.onended = null;
      element.onerror = null;
      element.pause();
      URL.revokeObjectURL(url);
    };
    // Ends a recording that finished by itself; nothing needs cancelling.
    const finished = () => {
      release();
      if (activePronunciation !== pronunciation) return;
      activePronunciation = null;
      setState("idle");
    };
    pronunciation.stop = () => {
      release();
      setState("idle");
    };
    element.onended = finished;
    element.onerror = finished;
    try {
      await element.play();
    } catch {
      release();
      return false;
    }
    if (activePronunciation === pronunciation) setState("playing");
    return true;
  }

  async function play() {
    if (!canPlay) return;
    stopPronunciation();
    const pronunciation: Pronunciation = { owner: owner.current, stop: () => setState("idle") };
    activePronunciation = pronunciation;
    const current = () => activePronunciation === pronunciation;
    setState("loading");
    const recording = await getWordAudio(expression, reading).catch(() => null);
    if (!current()) return;
    if (recording && (await playRecording(recording, pronunciation))) return;
    if (!current()) return;
    activePronunciation = null;
    setState("missing");
  }

  return { state, play };
}

/**
 * The headword's audio button: plays its recording and shows playback. It is disabled while
 * asking the sources, when none has the word, and when there is no source to ask.
 */
export function PronunciationButton({
  expression,
  reading = "",
  canPlay,
  size = 17,
}: {
  expression: string;
  reading?: string;
  canPlay: boolean;
  size?: number;
}) {
  const { state, play } = usePronunciation(expression, reading, canPlay);
  const { t } = useI18n();
  const active = state === "loading" || state === "playing";
  const label = !canPlay
    ? t("dictionaryResults.noSources")
    : state === "missing"
      ? t("dictionaryResults.noAudio", { expression })
      : t("dictionaryResults.play", { expression });
  return (
    <button
      aria-busy={state === "loading" || undefined}
      aria-label={t("dictionaryResults.play", { expression })}
      aria-pressed={active}
      className={`dictionary-audio-button${active ? " dictionary-audio-button--playing" : ""}`}
      disabled={!canPlay || state === "loading" || state === "missing"}
      onClick={() => void play()}
      title={label}
      type="button"
    >
      <SpeakerHighIcon aria-hidden="true" size={size} />
    </button>
  );
}

// An expanded headword links each kanji to its own search; kana and other characters stay text.
export function HeadwordKanji({
  expression,
  onSearchTerm,
}: {
  expression: string;
  onSearchTerm: (term: string) => void;
}) {
  const { t } = useI18n();
  return [...expression].map((character, index) =>
    isKanji(character) ? (
      <button
        aria-label={t("dictionaryResults.searchKanji", { character })}
        className="dictionary-result-card__kanji"
        key={index}
        onClick={() => onSearchTerm(character)}
        title={t("dictionaryResults.searchKanji", { character })}
        type="button"
      >
        {character}
      </button>
    ) : (
      <Fragment key={index}>{character}</Fragment>
    ),
  );
}

// The dictionary format's tag categories that have a header tag color (see dictionary.css).
const coloredTagCategories = new Set([
  "name",
  "expression",
  "popular",
  "frequent",
  "archaism",
  "dictionary",
  "frequency",
  "partOfSpeech",
  "search",
  "pronunciation-dictionary",
]);

export interface ShownTag {
  name: string;
  category: string | undefined;
  notes: string;
}

// A sense's own number, such as JMdict's "1" to "10" ("JMdict Sense #1"): definitions are
// numbered already, so the headword's tags leave these out.
export const senseNumberTag = ({ name, category }: TermTag) =>
  /^\d+$/u.test(name.trim()) && !category;

// Each returned tag name once. A name keeps the first definition any returned tag had for it;
// its notes, if not blank, explain it, and its category, if colored, is kept. Tags follow their
// definition's order (lower first); equal orders keep source order, and
// name-only tags follow every defined tag in source order.
export function shownTags(returned: TermTag[]): ShownTag[] {
  const tags = new Map<string, TermTag>();
  for (const tag of returned) {
    if (tags.get(tag.name)?.notes === undefined) tags.set(tag.name, tag);
  }
  const rank = ({ order }: TermTag) => (typeof order === "number" ? order : Infinity);
  // The sort is stable, so ties keep the source order the map preserved.
  const ordered = [...tags.values()].sort((a, b) => {
    const [first, second] = [rank(a), rank(b)];
    return first === second ? 0 : first < second ? -1 : 1;
  });
  return ordered.map(({ name, category, notes }) => ({
    name,
    category: category !== undefined && coloredTagCategories.has(category) ? category : undefined,
    notes: notes?.trim() ?? "",
  }));
}

export function frequencyValue(data: unknown): string {
  if (typeof data === "number" || typeof data === "string") return String(data);
  if (!data || typeof data !== "object") return "—";
  const item = data as Record<string, unknown>;
  const frequency = item.frequency;
  if (typeof frequency === "number" || typeof frequency === "string") return String(frequency);
  if (frequency && typeof frequency === "object") {
    const detail = frequency as Record<string, unknown>;
    return String(detail.displayValue ?? detail.value ?? "—");
  }
  return String(item.displayValue ?? item.value ?? "—");
}
