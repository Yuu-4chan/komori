import { isTauri } from "@tauri-apps/api/core";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import type { SourcePolicy } from "./sourcePolicy";
import { CaretDownIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
  lookupKanji,
  lookupTerms,
  type Deinflection,
  type FrequencyMatch,
  type KanjiLookup,
  type KanjiMatch,
  type PitchMatch,
  type TermGroup,
  type TermTag,
} from "./dictionaryApi";
import { isKanji } from "./kanji";
import { getWordAudio } from "./wordAudio";
import { useAppearance } from "../appearance/AppearanceProvider";
import { PitchContour, readingMoras } from "./PitchContour";

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

/** Look up a trimmed, nonempty query as the Dictionary page does. */
export async function lookupDictionary(
  query: string,
  sources?: SourcePolicy,
  maxResults?: number,
): Promise<DictionaryLookup> {
  // Only a one-character query can be a kanji; the native lookup decides whether it is one.
  const [{ text: matched, groups }, kanji] = await Promise.all([
    maxResults !== undefined
      ? lookupTerms(query, sources, maxResults)
      : sources
        ? lookupTerms(query, sources)
        : lookupTerms(query),
    [...query].length === 1
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

// Rows the frequency list shows before it scrolls; see .dictionary-result-card__frequencies.
const visibleFrequencyRows = 4;

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
              <span>({inflectionNames(lookup.deinflection.inflections)})</span>
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

const inflectionKeys: Record<string, MessageKey> = {
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
};

/**
 * The deinflector's names in the interface language, joined; endings such as -te and -tara
 * keep their romanized names.
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

  useEffect(
    () => () => {
      if (activePronunciation?.owner === owner.current) stopPronunciation();
    },
    [],
  );

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
 * The headword's audio button: plays its recording, shows playback, says when no source has the
 * word, and is disabled when there is no source to ask.
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
      disabled={!canPlay}
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

// Tags as pills: a noted tag explains itself in a tooltip, and a colored category tints it.
export function TagList({ onClick, tags }: { onClick?: () => void; tags: ShownTag[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="dictionary-result-card__tags">
      {tags.map(({ name, category, notes }) =>
        notes ? (
          <span
            aria-description={notes}
            className="dictionary-result-card__tag--noted"
            data-category={category}
            key={name}
            onClick={onClick}
            title={notes}
          >
            {name}
          </span>
        ) : (
          <span data-category={category} key={name}>
            {name}
          </span>
        ),
      )}
    </span>
  );
}

function FrequencyGlance({
  frequencies,
  showDictionaryNames = true,
}: {
  frequencies: FrequencyMatch[];
  showDictionaryNames?: boolean;
}) {
  const labelId = useId();
  const { t } = useI18n();
  if (frequencies.length === 0) return null;
  return (
    <div className="dictionary-result-card__glance">
      <span id={labelId}>{t("ankiContent.frequency")}</span>
      <dl
        aria-labelledby={labelId}
        className="dictionary-result-card__frequencies"
        tabIndex={frequencies.length > visibleFrequencyRows ? 0 : undefined}
      >
        {frequencies.map((frequency, index) => (
          <div key={`${frequency.dictionaryId}-${index}`}>
            <dt
              className={showDictionaryNames ? undefined : "visually-hidden"}
              title={frequency.dictionaryTitle}
            >
              {frequency.dictionaryTitle}
            </dt>
            <dd title={showDictionaryNames ? undefined : frequency.dictionaryTitle}>
              {frequencyValue(frequency.data)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// A kanji and its rows from every kanji dictionary, always open: the rows are short, and a
// one-kanji query's word results keep the expanded first card.
export function KanjiCard({
  character,
  entries,
  frequencies,
  showDictionaryNames = true,
  showFrequencies = true,
  actions,
}: {
  character: string;
  entries: KanjiMatch[];
  frequencies: FrequencyMatch[];
  showDictionaryNames?: boolean;
  showFrequencies?: boolean;
  /** Actions shown beside the character; kanji are never sent to Anki. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <article
      aria-label={t("dictionaryResults.kanjiLabel", { character })}
      className="dictionary-result-card dictionary-result-card--expanded dictionary-kanji-card"
    >
      <div className="dictionary-result-card__summary">
        <div className="dictionary-result-card__identity">
          <span className="dictionary-result-card__source">{t("dictionaryResults.kanji")}</span>
          <span className="dictionary-result-card__headword-line">
            <strong className="dictionary-kanji-card__character" lang="ja">
              {character}
            </strong>
            {actions}
          </span>
        </div>
        {showFrequencies && (
          <FrequencyGlance frequencies={frequencies} showDictionaryNames={showDictionaryNames} />
        )}
      </div>
      {entries.length > 0 && (
        <div className="dictionary-result-card__details">
          {entries.map((entry, index) => (
            <KanjiDefinition entry={entry} index={index + 1} key={index} />
          ))}
        </div>
      )}
    </article>
  );
}

// Readings are space-separated in kanji rows.
function kanjiReadings(value: string): string {
  return value.split(" ").filter(Boolean).join("、");
}

interface KanjiStat {
  name: string;
  /** The stat's notes when its dictionary defines them, otherwise its name. */
  label: string;
  value: string;
}

interface KanjiStatGroup {
  /** Omitted when the only group is uncategorized. */
  label: string | undefined;
  stats: KanjiStat[];
}

// The format's kanji stat categories, in their usual order.
const kanjiStatCategories = new Map<string, MessageKey>([
  ["misc", "dictionaryResults.statsMisc"],
  ["class", "dictionaryResults.statsClass"],
  ["code", "dictionaryResults.statsCode"],
  ["index", "dictionaryResults.statsIndex"],
]);

// Kanji stats map a name to a string; numbers are shown too, anything else is left out.
// Stats are grouped by their definition's category: the format's categories first in their usual order,
// then other categories as they first appear; each group follows definition order (lower first,
// ties in returned order). Stats with no category, and names the dictionary doesn't define,
// follow as Other.
function kanjiStats(entry: KanjiMatch): KanjiStatGroup[] {
  const values =
    entry.stats && typeof entry.stats === "object" && !Array.isArray(entry.stats)
      ? (entry.stats as Record<string, unknown>)
      : {};
  const rank = ({ order }: TermTag) => (typeof order === "number" ? order : Infinity);
  const ordered = entry.statTags
    .filter(({ name }) => Object.hasOwn(values, name))
    .sort((a, b) => {
      const [first, second] = [rank(a), rank(b)];
      return first === second ? 0 : first < second ? -1 : 1;
    });
  const groups = new Map<string, KanjiStat[]>(
    [...kanjiStatCategories.keys()].map((category) => [category, []]),
  );
  const other: KanjiStat[] = [];
  for (const { name, category, notes } of ordered) {
    const value = values[name];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const stat = { name, label: notes?.trim() || name, value: String(value) };
    if (!category) {
      other.push(stat);
    } else if (groups.has(category)) {
      groups.get(category)!.push(stat);
    } else {
      groups.set(category, [stat]);
    }
  }
  const shown: KanjiStatGroup[] = [...groups]
    .filter(([, stats]) => stats.length > 0)
    .map(([category, stats]) => {
      const key = kanjiStatCategories.get(category);
      return { label: key ? i18n().t(key) : category, stats };
    });
  if (other.length > 0) {
    // A lone group of uncategorized stats needs no heading.
    shown.push({
      label: shown.length > 0 ? i18n().t("dictionaryResults.statsOther") : undefined,
      stats: other,
    });
  }
  return shown;
}

function KanjiStats({ entry }: { entry: KanjiMatch }) {
  const id = useId();
  const { t } = useI18n();
  const groups = kanjiStats(entry);
  const count = groups.reduce((total, group) => total + group.stats.length, 0);
  if (count === 0) return null;
  return (
    <details className="dictionary-kanji__stats">
      <summary>
        <CaretDownIcon aria-hidden="true" weight="bold" />
        {t("dictionaryResults.stats", { count })}
      </summary>
      {groups.map((group, index) => (
        <div className="dictionary-kanji__stat-group" key={index}>
          {group.label !== undefined && (
            <span className="dictionary-kanji__stat-heading" id={`${id}-${index}`}>
              {group.label}
            </span>
          )}
          <dl aria-labelledby={group.label !== undefined ? `${id}-${index}` : undefined}>
            {group.stats.map(({ name, label, value }) => (
              <div key={name}>
                <dt title={label === name ? undefined : name}>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </details>
  );
}

function KanjiDefinition({ entry, index }: { entry: KanjiMatch; index: number }) {
  const { t } = useI18n();
  const readings = [
    [t("dictionaryResults.on"), kanjiReadings(entry.onyomi)],
    [t("dictionaryResults.kun"), kanjiReadings(entry.kunyomi)],
  ].filter(([, value]) => value);
  const tags = shownTags(entry.resolvedTags);
  return (
    <div className="dictionary-definition">
      <span className="dictionary-definition__index">{index}</span>
      <div className="dictionary-kanji">
        <span className="dictionary-definition__source">{entry.dictionaryTitle}</span>
        <TagList tags={tags} />
        {entry.meanings.length > 0 && (
          <ol aria-label={t("dictionaryResults.meanings")} className="dictionary-kanji__meanings">
            {entry.meanings.map((meaning, item) => (
              <li key={item}>{meaning}</li>
            ))}
          </ol>
        )}
        {readings.length > 0 && (
          <dl aria-label={t("dictionaryResults.readings")} className="dictionary-kanji__readings">
            {readings.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd lang="ja">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <KanjiStats entry={entry} />
      </div>
    </div>
  );
}

interface PitchPattern {
  position: number;
  nasal: number[];
  devoice: number[];
  tags: string[];
  sources: { key: number; title: string }[];
}

// Dictionaries store nasal and devoiced morae as one one-based index or an array of them. Invalid
// or out-of-range values are ignored; without a representable reading no mark can be placed.
function moraMarks(value: unknown, moraCount: number): number[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const marks = values.filter(
    (mora): mora is number =>
      typeof mora === "number" && Number.isSafeInteger(mora) && mora >= 1 && mora <= moraCount,
  );
  return [...new Set(marks)].sort((a, b) => a - b);
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

// Pitch entries may tag a position with a string array (for example a part of speech). Only
// nonblank strings are kept, trimmed and once each, in their imported order.
function pitchTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

function describeMarks(label: MessageKey, marks: number[], moras: string[]) {
  const { t } = i18n();
  return marks.length
    ? t(label, {
        marks: marks
          .map((mora) => t("dictionaryResults.mora", { kana: moras[mora - 1], mora }))
          .join(", "),
      })
    : null;
}

export function PitchPositions({
  pitches,
  reading,
  showDictionaryNames = true,
}: {
  pitches: PitchMatch[];
  reading: string;
  showDictionaryNames?: boolean;
}) {
  // One pattern per distinct position and mora marks, in first-returned order, naming every
  // source row that returned it so agreement collapses and disagreement stands out.
  const moras = readingMoras(reading) ?? [];
  const { t } = useI18n();
  const patterns: PitchPattern[] = [];
  pitches.forEach((pitch, index) => {
    if (!pitch.data || typeof pitch.data !== "object" || Array.isArray(pitch.data)) return;
    const data = pitch.data as Record<string, unknown>;
    if (data.reading !== reading || !Array.isArray(data.pitches)) return;
    const rowPatterns = new Set<PitchPattern>();
    for (const entry of data.pitches as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const fields = entry as Record<string, unknown>;
      const position = fields.position;
      if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) continue;
      const nasal = moraMarks(fields.nasal, moras.length);
      const devoice = moraMarks(fields.devoice, moras.length);
      const tags = pitchTags(fields.tags);
      const tagKey = JSON.stringify([...tags].sort());
      let pattern = patterns.find(
        (candidate) =>
          candidate.position === position &&
          candidate.nasal.join() === nasal.join() &&
          candidate.devoice.join() === devoice.join() &&
          JSON.stringify([...candidate.tags].sort()) === tagKey,
      );
      if (!pattern) {
        pattern = { position, nasal, devoice, tags, sources: [] };
        patterns.push(pattern);
      }
      rowPatterns.add(pattern);
    }
    for (const pattern of rowPatterns) {
      pattern.sources.push({ key: index, title: pitch.dictionaryTitle });
    }
  });
  if (patterns.length === 0) return null;
  return (
    <section aria-label={t("dictionaryResults.pitchPositions")} className="dictionary-pitch">
      <h3>{t("dictionaryResults.pitch")}</h3>
      <ul>
        {patterns.map((pattern, patternIndex) => {
          const marks = [
            describeMarks("dictionaryResults.nasal", pattern.nasal, moras),
            describeMarks("dictionaryResults.devoiced", pattern.devoice, moras),
          ].filter(Boolean);
          return (
            <li
              key={patternIndex}
              title={
                showDictionaryNames
                  ? undefined
                  : pattern.sources.map((source) => source.title).join(", ")
              }
            >
              <span className="dictionary-pitch__position">
                <span>{t("dictionaryResults.position", { position: pattern.position })}</span>
                <PitchContour
                  devoice={pattern.devoice}
                  nasal={pattern.nasal}
                  position={pattern.position}
                  reading={reading}
                />
                {pattern.tags.length > 0 && (
                  <span className="dictionary-pitch__tags">{pattern.tags.join(", ")}</span>
                )}
                {marks.length > 0 && (
                  <span className="dictionary-pitch__marks">{marks.join("; ")}</span>
                )}
              </span>
              <span
                className={showDictionaryNames ? "dictionary-pitch__sources" : "visually-hidden"}
              >
                {pattern.sources.map((source, index) => (
                  <Fragment key={source.key}>
                    {index > 0 && <span className="dictionary-pitch__separator">, </span>}
                    <span className="dictionary-pitch__source" title={source.title}>
                      {source.title}
                    </span>
                  </Fragment>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
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
