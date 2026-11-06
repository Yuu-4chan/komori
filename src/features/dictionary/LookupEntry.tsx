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

// Frequency boxes and a dictionary's tags shown before "+N more", so a long list does not push
// definitions away.
const shownFrequencies = 6;
const shownTagCount = 4;

/**
 * One headword in the Reader's lookup popup and on the Dictionary page, compact: the headword with
 * its reading (beside it, or above it as furigana) and the pitch drawn on the reading, then its
 * Voice, Dictionary and Anki actions as plain icons on the same row; a row of small frequency
 * boxes led by a common word's star; and each dictionary's numbered definitions under its name,
 * which folds them, with their tags beside it. An entry whose imported data cannot be rendered
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
  // The first pitch pattern is drawn on the reading; the others follow it as positions.
  const patterns = useMemo(
    () => (showPitch && japanese ? pitchPatterns(group.pitches, group.reading) : []),
    [showPitch, japanese, group.pitches, group.reading],
  );
  const marks = pitchMarks(group.reading, patterns[0]);
  // Kept here, so hiding the frequencies and showing them again keeps the list as it was.
  const [allFrequencies, setAllFrequencies] = useState(false);
  // A common word's star leads the frequencies; the other tags follow their dictionaries' names.
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
  const facts =
    popular.length > 0 || (showFrequency && group.frequencies.length > 0) ? (
      <EntryFrequencies
        expanded={allFrequencies}
        frequencies={showFrequency ? group.frequencies : []}
        popular={popular}
        showDictionaryNames={showDictionaryNames}
        onExpandedChange={setAllFrequencies}
      />
    ) : null;
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
                  marks={marks}
                  reading={reading}
                  onSearchTerm={onSearchTerm}
                />
              ) : reading === null && patterns.length > 0 ? (
                <PitchKana marks={marks} text={group.expression} />
              ) : (
                <HeadwordKanji expression={group.expression} onSearchTerm={onSearchTerm} />
              )}
            </strong>
            {reading && !above ? (
              <span className="lookup-entry__reading" lang={language}>
                <PitchKana marks={marks} text={reading} />
              </span>
            ) : null}
            <PitchNote patterns={patterns} reading={group.reading} />
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
        {facts}
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

/**
 * An entry's frequencies as small boxes, close together: a common word's star first, then each
 * frequency dictionary with its values, the ones past the first few behind "+N more" unless
 * `expanded`.
 */
export function EntryFrequencies({
  popular,
  frequencies,
  showDictionaryNames,
  expanded,
  onExpandedChange,
}: {
  popular: ShownTag[];
  frequencies: FrequencyMatch[];
  showDictionaryNames: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useI18n();
  const all = expanded;
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
  const hidden = all ? 0 : Math.max(0, boxes.length - shownFrequencies);
  return (
    <ul aria-label={t("ankiContent.frequency")} className="lookup-entry__frequencies">
      {popular.map(({ name, notes }) => (
        <li className="lookup-entry__popular" key={name} title={notes || undefined}>
          {name}
        </li>
      ))}
      {boxes.slice(0, boxes.length - hidden).map((box, index) => (
        <li key={`${box.key}-${index}`} title={box.title}>
          <span className={showDictionaryNames ? undefined : "visually-hidden"}>{box.title}</span>
          {box.values.map((value, item) => (
            <strong key={item}>{value}</strong>
          ))}
        </li>
      ))}
      {boxes.length > shownFrequencies ? (
        <li className="lookup-entry__more">
          <button aria-expanded={all} onClick={() => onExpandedChange(!all)} type="button">
            {all ? t("lookupEntry.fewer") : t("lookupEntry.more", { count: hidden })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** Text whose characters carry their pitch marks, from `offset` in the reading's marks. */
function PitchKana({
  text,
  marks,
  offset = 0,
}: {
  text: string;
  marks: (string | undefined)[];
  offset?: number;
}) {
  const characters = Array.from(text);
  if (!characters.some((_, index) => marks[offset + index])) return text;
  return characters.map((character, index) => (
    <span className={marks[offset + index]} key={index}>
      {character}
    </span>
  ));
}

/**
 * The pitch drawn on the reading, said in words for screen readers with its tags, nasal and
 * devoiced morae and sources, which a tooltip also lists; any other pattern follows as its
 * position.
 */
function PitchNote({ patterns, reading }: { patterns: PitchPattern[]; reading: string }) {
  const { t } = useI18n();
  if (patterns.length === 0) return null;
  const moras = readingMoras(reading) ?? [];
  const marks = (label: MessageKey, numbers: number[]) =>
    numbers.length
      ? t(label, {
          marks: numbers
            .map((mora) => t("dictionaryResults.mora", { kana: moras[mora - 1], mora }))
            .join(", "),
        })
      : null;
  return (
    <span
      className="lookup-entry__pitch"
      title={patterns
        .map(
          (pattern) =>
            `[${pattern.position}]${pattern.tags.length ? ` ${pattern.tags.join(", ")}` : ""} ${pattern.sources.map((source) => source.title).join(", ")}`,
        )
        .join("\n")}
    >
      <span className="visually-hidden">
        {t("dictionaryResults.pitch")}:{" "}
        {patterns
          .map((pattern) =>
            [
              t("dictionaryResults.position", { position: pattern.position }),
              pattern.tags.join(", "),
              marks("dictionaryResults.nasal", pattern.nasal),
              marks("dictionaryResults.devoiced", pattern.devoice),
              pattern.sources.map((source) => source.title).join(", "),
            ]
              .filter(Boolean)
              .join("; "),
          )
          .join(". ")}
      </span>
      {patterns.slice(1).map((pattern, index) => (
        <span aria-hidden="true" key={index}>
          [{pattern.position}]
        </span>
      ))}
    </span>
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
 * sits over its kanji rather than bunched at the start; its kanji stay links. With pitch marks,
 * each kana of the reading, over a kanji run or in the headword, carries its own.
 */
function FuriganaHeadword({
  expression,
  reading,
  marks = [],
  onSearchTerm,
}: {
  expression: string;
  reading: string;
  marks?: (string | undefined)[];
  onSearchTerm: (term: string) => void;
}) {
  let offset = 0;
  return furiganaSegments(expression, reading).map((segment, index) => {
    const from = offset;
    offset += Array.from(segment.reading ?? segment.text).length;
    return segment.reading ? (
      <ruby key={index}>
        <span className="lookup-entry__ruby-base">
          <HeadwordKanji expression={segment.text} onSearchTerm={onSearchTerm} />
        </span>
        <rt>
          {Array.from(segment.reading).map((kana, position) => (
            <span className={marks[from + position]} key={position}>
              {kana}
            </span>
          ))}
        </rt>
      </ruby>
    ) : marks.length > 0 ? (
      <PitchKana key={index} marks={marks} offset={from} text={segment.text} />
    ) : (
      <HeadwordKanji expression={segment.text} key={index} onSearchTerm={onSearchTerm} />
    );
  });
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
  const [allTags, setAllTags] = useState(false);
  const bodyId = useId();
  const { t } = useI18n();
  const hiddenTags = allTags ? 0 : Math.max(0, tags.length - shownTagCount);
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
            {tags.slice(0, tags.length - hiddenTags).map(({ name, notes }) => (
              <span
                aria-description={notes || undefined}
                className={notes ? "lookup-source__tag--noted" : undefined}
                key={name}
                title={notes || undefined}
              >
                {name}
              </span>
            ))}
            {tags.length > shownTagCount ? (
              <button
                aria-expanded={allTags}
                className="lookup-source__more"
                onClick={() => setAllTags((current) => !current)}
                type="button"
              >
                {allTags ? t("lookupEntry.fewer") : t("lookupEntry.more", { count: hiddenTags })}
              </button>
            ) : null}
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
