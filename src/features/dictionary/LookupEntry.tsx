import { useI18n, type MessageKey } from "../../i18n/i18n";
import { AnkiAction, termCardSources, type ReaderCardContext } from "../anki/AnkiAction";
import { ArrowSquareOutIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";
import { IconButton } from "../../components/ui/IconButton";
import { type ReactNode, useId, useMemo, useState } from "react";
import { furiganaSegments } from "./furigana";
import {
  defaultLookupLanguage,
  readsBeside,
  type LookupLanguage,
  transcriptionText,
} from "./lookupLanguage";

import type { FrequencyMatch, TermGroup, TermMatch } from "./dictionaryApi";
import {
  frequencyValue,
  HeadwordKanji,
  PronunciationButton,
  senseNumberTag,
  shownTags,
  inflectionNames,
  type ShownTag,
} from "./DictionaryResults";
import { pitchMarks, pitchPatterns, readingMoras, type PitchPattern } from "./pitchAccent";
import { GlossaryText, termGlossaries } from "./GlossaryText";

/**
 * One headword in the Reader's lookup popup and on the Dictionary page, compact: the headword with
 * its reading (beside it, or above it as furigana) and a common word's stars, then its Voice,
 * Dictionary and Anki actions as plain icons on the same row; a row of small frequency boxes; a
 * Pitch row with each pattern drawn on the reading; and each dictionary's numbered definitions
 * under its name, which folds them, with their tags beside it. An entry whose imported data cannot be rendered
 * shows a one-line failure in its place.
 */
export function LookupEntry(props: Parameters<typeof LookupEntryContent>[0]) {
  return (
    <ErrorBoundary fallback={<LookupEntryFailure expression={props.group.expression} />}>
      <LookupEntryContent {...props} />
    </ErrorBoundary>
  );
}

function LookupEntryFailure({ expression }: { expression: string }) {
  const { t } = useI18n();
  return (
    <p className="lookup-entry-failure" role="alert">
      {t("lookupEntry.failed", { expression })}
    </p>
  );
}

function LookupEntryContent({
  readerContext,
  showAnkiAction = true,
  showPitch,
  showFrequency,
  showVoiceAction,
  showDictionaryNames,
  readingPosition = "beside",
  language = defaultLookupLanguage,
  canPlayAudio,
  group,
  onSearchTerm,
  onOpenDictionary = onSearchTerm,
  showOpenAction = true,
  start,
}: {
  readerContext?: ReaderCardContext;
  showAnkiAction?: boolean;
  showPitch: boolean;
  showFrequency: boolean;
  showVoiceAction: boolean;
  showDictionaryNames: boolean;
  readingPosition?: "beside" | "above";
  /**
   * The lookup language: furigana and pitch show only for Japanese, where a reading is kana.
   * Japanese by default.
   */
  language?: LookupLanguage;
  /** Whether Voice has word audio sources to ask. */
  canPlayAudio: boolean;
  group: TermGroup;
  /** Search a headword kanji or glossary link (a child popup in the Reader). */
  onSearchTerm: (term: string) => void;
  /** Open the headword on the Dictionary page. */
  onOpenDictionary?: (term: string) => void;
  /** Off on the Dictionary page itself. */
  showOpenAction?: boolean;
  /** The shorter start the group matched, when it is not the one the header names. */
  start: string | null;
}) {
  const { t } = useI18n();
  const { sentence, bookTitle, bookId } = readerContext ?? {};
  // The Reader passes a new context object on each render; its fields decide the sources.
  const cardSources = useMemo(
    () => (showAnkiAction ? termCardSources(group, { sentence, bookTitle, bookId }) : []),
    [group, showAnkiAction, sentence, bookTitle, bookId],
  );
  const reading = group.reading !== group.expression ? group.reading : null;
  const japanese = language === "ja";
  const above = japanese && readingPosition === "above" && reading !== null;
  // Each pitch pattern is drawn on the reading in the Pitch row.
  const patterns = useMemo(
    () => (showPitch && japanese ? pitchPatterns(group.pitches, group.reading) : []),
    [showPitch, japanese, group.pitches, group.reading],
  );
  // A common word's stars follow the headword; the other tags follow their dictionaries' names.
  const popular = shownTags(group.terms.flatMap((term) => term.tags)).filter(
    (tag) => tag.category === "popular",
  );
  // Each dictionary's definitions together, in the order the dictionaries first match, with
  // their glossaries read once per entry rather than on every render.
  const sources = useMemo(() => {
    const byDictionary = new Map<number, { term: TermMatch; glossaries: unknown[] }[]>();
    for (const term of group.terms)
      byDictionary.set(term.dictionaryId, [
        ...(byDictionary.get(term.dictionaryId) ?? []),
        { term, glossaries: senseGlossaries(term) },
      ]);
    return [...byDictionary.values()];
  }, [group.terms]);
  return (
    <article
      aria-label={reading ? `${group.expression} (${reading})` : group.expression}
      className={`lookup-entry${above ? " lookup-entry--furigana" : ""}`}
    >
      <header className="lookup-entry__header">
        <div className="lookup-entry__headline">
          <div className="lookup-entry__word">
            <strong className="lookup-entry__expression" lang={language}>
              {above ? (
                <FuriganaHeadword
                  expression={group.expression}
                  reading={reading}
                  onSearchTerm={onSearchTerm}
                />
              ) : (
                <HeadwordKanji expression={group.expression} onSearchTerm={onSearchTerm} />
              )}
            </strong>
            {reading && !above ? (
              <span className="lookup-entry__reading" lang={language}>
                {reading}
              </span>
            ) : null}
            {popular.length > 0 && (
              <span className="lookup-entry__stars">
                {popular.map(({ name, notes }) => (
                  <span aria-description={notes || undefined} key={name} title={notes || undefined}>
                    {name}
                  </span>
                ))}
              </span>
            )}
            {group.transcriptions.length > 0 && (
              <span className="lookup-entry__transcription">
                {transcriptionText(language, group.transcriptions)}
              </span>
            )}
            {start !== null ? (
              <span
                className="lookup-entry__note"
                lang={language}
                title={t("lookupEntry.matched", { text: start })}
              >
                <span className="visually-hidden">{t("lookupEntry.matchedLabel")} </span>
                <span aria-hidden="true">← </span>
                {start}
              </span>
            ) : null}
            {group.deinflection?.inflections.length ? (
              <span
                className="lookup-entry__note"
                title={t("lookupEntry.inflected", {
                  inflections: inflectionNames(group.deinflection.inflections),
                })}
              >
                <span className="visually-hidden">{t("lookupEntry.inflectedLabel")} </span>
                {group.deinflection.inflections.map((name) => inflectionNames([name])).join(" · ")}
              </span>
            ) : null}
          </div>
          <div className="lookup-entry__actions">
            {showVoiceAction && (
              <PronunciationButton
                canPlay={canPlayAudio}
                expression={group.expression}
                reading={group.reading}
                size={16}
              />
            )}
            {showOpenAction && (
              <IconButton
                className="reader-lookup__action"
                label={t("lookupEntry.open", { expression: group.expression })}
                onClick={() => onOpenDictionary(group.expression)}
              >
                <ArrowSquareOutIcon aria-hidden="true" size={16} />
              </IconButton>
            )}
            {showAnkiAction && <AnkiAction sources={cardSources} />}
          </div>
        </div>
        {showFrequency && group.frequencies.length > 0 && (
          <EntryFrequencies
            frequencies={group.frequencies}
            showDictionaryNames={showDictionaryNames}
          />
        )}
        <EntryPitch patterns={patterns} reading={group.reading} />
      </header>
      {sources.map((terms) => (
        <EntrySource
          key={terms[0].term.dictionaryId}
          tags={shownTags(
            terms
              .flatMap(({ term }) => term.tags)
              .filter((tag) => !senseNumberTag(tag) && tag.category !== "popular"),
          )}
          title={terms[0].term.dictionaryTitle}
        >
          <ol
            className={`lookup-source__senses${terms.length > 1 ? "" : " lookup-source__senses--single"}`}
          >
            {terms.map(({ term, glossaries }, index) => (
              <li key={`${term.sequence}-${index}`}>
                {glossaries.map((glossary, item) => (
                  <GlossaryText key={item} onSearchTerm={onSearchTerm} value={glossary} />
                ))}
              </li>
            ))}
          </ol>
        </EntrySource>
      ))}
    </article>
  );
}

/** An entry's frequencies as small boxes, close together: each frequency dictionary with its values. */
export function EntryFrequencies({
  frequencies,
  showDictionaryNames,
}: {
  frequencies: FrequencyMatch[];
  showDictionaryNames: boolean;
}) {
  const { t } = useI18n();
  // A dictionary's values share its box, in the order the dictionaries first appear.
  const boxes: { key: string; title: string; values: string[] }[] = [];
  for (const frequency of frequencies) {
    const last = boxes[boxes.length - 1];
    const value = frequencyValue(frequency.data);
    if (last && last.key === String(frequency.dictionaryId)) last.values.push(value);
    else
      boxes.push({
        key: String(frequency.dictionaryId),
        title: frequency.dictionaryTitle,
        values: [value],
      });
  }
  return (
    <ul aria-label={t("ankiContent.frequency")} className="lookup-entry__frequencies">
      {boxes.map((box, index) => (
        <li key={`${box.key}-${index}`} title={box.title}>
          <span className={showDictionaryNames ? undefined : "visually-hidden"}>{box.title}</span>
          {box.values.map((value, item) => (
            <strong key={item}>{value}</strong>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Text whose characters carry their pitch marks. */
function PitchKana({ text, marks }: { text: string; marks: (string | undefined)[] }) {
  return Array.from(text).map((character, index) => (
    <span className={marks[index]} key={index}>
      {character}
    </span>
  ));
}

/**
 * The Pitch row: each pattern drawn on the reading, as accent dictionaries draw it, with its
 * position and tags, the patterns separated by commas; its sources show in its tooltip, and its
 * nasal and devoiced morae and sources are said in words for screen readers.
 */
function EntryPitch({ patterns, reading }: { patterns: PitchPattern[]; reading: string }) {
  const { t } = useI18n();
  const label = useId();
  if (patterns.length === 0) return null;
  const moras = readingMoras(reading) ?? [];
  const marks = (key: MessageKey, numbers: number[]) =>
    numbers.length
      ? t(key, {
          marks: numbers
            .map((mora) => t("dictionaryResults.mora", { kana: moras[mora - 1], mora }))
            .join(", "),
        })
      : null;
  return (
    <div className="lookup-entry__pitch">
      <span className="lookup-entry__row-label" id={label}>
        {t("dictionaryResults.pitch")}
      </span>
      <ul aria-labelledby={label}>
        {patterns.map((pattern, index) => {
          const sources = pattern.sources.map((source) => source.title).join(", ");
          const drawn = pitchMarks(reading, pattern);
          // Said as one phrase; the drawn reading and the bracketed position are for the eye.
          const spoken = [
            t("dictionaryResults.position", { position: pattern.position }),
            pattern.tags.join(", "),
            marks("dictionaryResults.nasal", pattern.nasal),
            marks("dictionaryResults.devoiced", pattern.devoice),
            sources,
          ]
            .filter(Boolean)
            .join("; ");
          return (
            <li
              key={index}
              title={`[${pattern.position}]${pattern.tags.length ? ` ${pattern.tags.join(", ")}` : ""} ${sources}`}
            >
              {drawn.length > 0 && (
                <span aria-hidden="true" className="lookup-entry__pitch-reading" lang="ja">
                  <PitchKana marks={drawn} text={reading} />
                </span>
              )}
              <span aria-hidden="true" className="lookup-entry__pitch-position">
                [{pattern.position}]
              </span>
              {pattern.tags.length > 0 && (
                <span aria-hidden="true" className="lookup-entry__pitch-tags">
                  {pattern.tags.join(", ")}
                </span>
              )}
              <span className="visually-hidden">{spoken}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A definition's glossaries, with its consecutive plain glosses run together on one line. */
function senseGlossaries(term: TermMatch): unknown[] {
  return termGlossaries(term.glossary).reduce<unknown[]>((items, glossary) => {
    if (glossary === "") return items;
    const last = items.length - 1;
    if (typeof glossary === "string" && typeof items[last] === "string")
      items[last] = `${items[last]}; ${glossary}`;
    else items.push(glossary);
    return items;
  }, []);
}

/**
 * The headword with each kanji run's part of the reading spread evenly above that run, so each kana
 * sits over its kanji rather than bunched at the start; its kanji stay links.
 */
function FuriganaHeadword({
  expression,
  reading,
  onSearchTerm,
}: {
  expression: string;
  reading: string;
  onSearchTerm: (term: string) => void;
}) {
  return furiganaSegments(expression, reading).map((segment, index) =>
    segment.reading ? (
      <ruby key={index}>
        <span className="lookup-entry__ruby-base">
          <HeadwordKanji expression={segment.text} onSearchTerm={onSearchTerm} />
        </span>
        <rt>
          {Array.from(segment.reading).map((kana, position) => (
            <span key={position}>{kana}</span>
          ))}
        </rt>
      </ruby>
    ) : (
      <HeadwordKanji expression={segment.text} key={index} onSearchTerm={onSearchTerm} />
    ),
  );
}

/**
 * One dictionary's part of an entry: its name, which folds the part, and the tags it shares in
 * small italics; then its definitions or meanings.
 */
export function EntrySource({
  title,
  tags,
  children,
}: {
  title: string;
  tags: ShownTag[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const { t } = useI18n();
  return (
    <section aria-label={title} className={`lookup-source${open ? "" : " lookup-source--closed"}`}>
      <div className="lookup-source__head">
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          aria-label={t(open ? "lookupEntry.collapse" : "lookupEntry.expand", { title })}
          className="lookup-source__name"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          {title}
          <CaretDownIcon aria-hidden="true" className="lookup-source__caret" size={12} />
        </button>
        {tags.length > 0 && (
          <span className="lookup-source__tags">
            {tags.map(({ name, notes }) => (
              <span
                aria-description={notes || undefined}
                className={notes ? "lookup-source__tag--noted" : undefined}
                key={name}
                title={notes || undefined}
              >
                {name}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="lookup-source__body" hidden={!open} id={bodyId}>
        {children}
      </div>
    </section>
  );
}

/**
 * One headword in the popup's dictionary style: the headword with its furigana, then
 * each dictionary's definitions under its name, numbered when it has more than one. It has no
 * voice, tags, notes, pitch, frequency or actions.
 */
export function DictionaryLookupEntry(props: Parameters<typeof DictionaryLookupEntryContent>[0]) {
  return (
    <ErrorBoundary fallback={<LookupEntryFailure expression={props.group.expression} />}>
      <DictionaryLookupEntryContent {...props} />
    </ErrorBoundary>
  );
}

function DictionaryLookupEntryContent({
  group,
  language = defaultLookupLanguage,
  showDictionaryNames,
  onSearchTerm,
}: {
  group: TermGroup;
  /** The lookup language: the headword takes furigana only in Japanese. */
  language?: LookupLanguage;
  showDictionaryNames: boolean;
  /** Search a headword kanji or glossary link (a child popup in the Reader). */
  onSearchTerm: (term: string) => void;
}) {
  const other = group.reading !== group.expression ? group.reading : null;
  const reading = language === "ja" ? other : null;
  const beside = readsBeside(language) ? other : null;
  // Each dictionary's definitions together, in the order the dictionaries first match.
  const sources = new Map<number, TermMatch[]>();
  for (const term of group.terms)
    sources.set(term.dictionaryId, [...(sources.get(term.dictionaryId) ?? []), term]);
  return (
    <article
      aria-label={
        (reading ?? beside) ? `${group.expression} (${reading ?? beside})` : group.expression
      }
      className="dictionary-entry"
    >
      <strong
        className={`dictionary-entry__headword${reading ? " dictionary-entry__headword--furigana" : ""}`}
        lang={language}
      >
        {reading ? (
          <FuriganaHeadword
            expression={group.expression}
            reading={reading}
            onSearchTerm={onSearchTerm}
          />
        ) : (
          <HeadwordKanji expression={group.expression} onSearchTerm={onSearchTerm} />
        )}
        {beside && <span className="dictionary-entry__reading">{beside}</span>}
        {group.transcriptions.length > 0 && (
          <span className="dictionary-entry__reading">
            {transcriptionText(language, group.transcriptions)}
          </span>
        )}
      </strong>
      {[...sources.values()].map((terms) => (
        <section
          aria-label={terms[0].dictionaryTitle}
          className="dictionary-entry__source"
          key={terms[0].dictionaryId}
        >
          {showDictionaryNames && (
            <span aria-hidden="true" className="dictionary-entry__name">
              {terms[0].dictionaryTitle}
            </span>
          )}
          <ol
            className={`dictionary-entry__senses${terms.length > 1 ? "" : " dictionary-entry__senses--single"}`}
          >
            {terms.map((term, index) => (
              <li key={`${term.sequence}-${index}`}>
                {senseGlossaries(term).map((glossary, item) => (
                  <GlossaryText key={item} onSearchTerm={onSearchTerm} value={glossary} />
                ))}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </article>
  );
}
