import { useI18n } from "../../i18n/i18n";
import { AnkiAction, termCardSources, type ReaderCardContext } from "../anki/AnkiAction";
import { ArrowSquareOutIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";
import { IconButton } from "../../components/ui/IconButton";
import { useId, useMemo, useState } from "react";
import { furiganaSegments } from "./furigana";

import type { TermGroup, TermMatch } from "./dictionaryApi";
import {
  frequencyValue,
  HeadwordKanji,
  PitchPositions,
  PronunciationButton,
  senseNumberTag,
  shownTags,
  TagList,
  inflectionNames,
} from "./DictionaryResults";
import { GlossaryText } from "./GlossaryText";

// Frequency chips shown before "+N more", so a long list does not push definitions away.
const shownFrequencies = 6;

/**
 * One headword in the Reader's lookup popup and on the Dictionary page: the large headword with its reading (beside it, or
 * above it as furigana), audio, tags, and its Anki and Dictionary actions on the same row; then
 * optional frequencies and pitch, and each dictionary's collapsible numbered definitions. An entry
 * whose imported data cannot be rendered shows a one-line failure in its place.
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
  const [allFrequencies, setAllFrequencies] = useState(false);
  const { t } = useI18n();
  const { sentence, bookTitle, bookId } = readerContext ?? {};
  // The Reader passes a new context object on each render; its fields decide the sources.
  const cardSources = useMemo(
    () => (showAnkiAction ? termCardSources(group, { sentence, bookTitle, bookId }) : []),
    [group, showAnkiAction, sentence, bookTitle, bookId],
  );
  const tags = shownTags(
    group.terms.flatMap((term) => term.tags).filter((tag) => !senseNumberTag(tag)),
  );
  const hiddenFrequencies = allFrequencies
    ? 0
    : Math.max(0, group.frequencies.length - shownFrequencies);
  const reading = group.reading !== group.expression ? group.reading : null;
  const above = readingPosition === "above" && reading !== null;
  return (
    <article
      aria-label={reading ? `${group.expression} (${reading})` : group.expression}
      className={`lookup-entry${above ? " lookup-entry--furigana" : ""}`}
    >
      <header className="lookup-entry__header">
        <div className="lookup-entry__headline">
          <div className="lookup-entry__word">
            <strong className="lookup-entry__expression" lang="ja">
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
              <span className="lookup-entry__reading" lang="ja">
                {reading}
              </span>
            ) : null}
            {showVoiceAction && (
              <PronunciationButton
                canPlay={canPlayAudio}
                expression={group.expression}
                reading={group.reading}
                size={16}
              />
            )}
            <TagList tags={tags} />
          </div>
          <div className="lookup-entry__actions">
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
        {start !== null || group.deinflection ? (
          <div className="lookup-entry__notes">
            {start !== null ? (
              <span lang="ja" title={t("lookupEntry.matched", { text: start })}>
                <span className="visually-hidden">{t("lookupEntry.matchedLabel")} </span>
                {start}
              </span>
            ) : null}
            {group.deinflection ? (
              <span
                title={t("lookupEntry.inflected", {
                  inflections: inflectionNames(group.deinflection.inflections),
                })}
              >
                <span className="visually-hidden">{t("lookupEntry.inflectedLabel")} </span>
                {group.deinflection.inflections.map((name) => inflectionNames([name])).join(" · ")}
              </span>
            ) : null}
          </div>
        ) : null}
        {showFrequency && group.frequencies.length > 0 ? (
          <ul aria-label={t("ankiContent.frequency")} className="lookup-entry__frequencies">
            {group.frequencies
              .slice(0, group.frequencies.length - hiddenFrequencies)
              .map((frequency, index) => (
                <li key={`${frequency.dictionaryId}-${index}`} title={frequency.dictionaryTitle}>
                  <span className={showDictionaryNames ? undefined : "visually-hidden"}>
                    {frequency.dictionaryTitle}
                  </span>
                  <strong>{frequencyValue(frequency.data)}</strong>
                </li>
              ))}
            {group.frequencies.length > shownFrequencies ? (
              <li className="lookup-entry__more">
                <button
                  aria-expanded={allFrequencies}
                  onClick={() => setAllFrequencies((current) => !current)}
                  type="button"
                >
                  {allFrequencies
                    ? t("lookupEntry.fewer")
                    : t("lookupEntry.more", { count: hiddenFrequencies })}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {showPitch && (
          <PitchPositions
            pitches={group.pitches}
            reading={group.reading}
            showDictionaryNames={showDictionaryNames}
          />
        )}
      </header>
      <ol className="lookup-entry__definitions">
        {group.terms.map((term, index) => (
          <LookupDefinition
            index={index + 1}
            key={`${term.dictionaryId}-${term.sequence}-${index}`}
            onSearchTerm={onSearchTerm}
            term={term}
          />
        ))}
      </ol>
    </article>
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
  showDictionaryNames,
  onSearchTerm,
}: {
  group: TermGroup;
  showDictionaryNames: boolean;
  /** Search a headword kanji or glossary link (a child popup in the Reader). */
  onSearchTerm: (term: string) => void;
}) {
  const reading = group.reading !== group.expression ? group.reading : null;
  // Each dictionary's definitions together, in the order the dictionaries first match.
  const sources = new Map<number, TermMatch[]>();
  for (const term of group.terms)
    sources.set(term.dictionaryId, [...(sources.get(term.dictionaryId) ?? []), term]);
  return (
    <article
      aria-label={reading ? `${group.expression} (${reading})` : group.expression}
      className="dictionary-entry"
    >
      <strong
        className={`dictionary-entry__headword${reading ? " dictionary-entry__headword--furigana" : ""}`}
        lang="ja"
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

/** A definition's glossaries, with its consecutive plain glosses run together on one line. */
function senseGlossaries(term: TermMatch): unknown[] {
  const glossaries: unknown[] = Array.isArray(term.glossary) ? term.glossary : [term.glossary];
  return glossaries.reduce<unknown[]>((items, glossary) => {
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

function LookupDefinition({
  index,
  term,
  onSearchTerm,
}: {
  index: number;
  term: TermMatch;
  onSearchTerm: (term: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const { t } = useI18n();
  const glossaries = Array.isArray(term.glossary) ? term.glossary : [term.glossary];
  return (
    <li className={`lookup-definition${open ? "" : " lookup-definition--closed"}`}>
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={t(open ? "lookupEntry.collapse" : "lookupEntry.expand", {
          title: term.dictionaryTitle,
          index,
        })}
        className="lookup-definition__toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className="lookup-definition__index">
          {index}
        </span>
        <span className="lookup-definition__source">{term.dictionaryTitle}</span>
        <CaretDownIcon aria-hidden="true" className="lookup-definition__caret" size={16} />
      </button>
      <div className="lookup-definition__body" hidden={!open} id={bodyId}>
        {glossaries.map((glossary, item) => (
          <GlossaryText key={item} onSearchTerm={onSearchTerm} value={glossary} />
        ))}
      </div>
    </li>
  );
}
