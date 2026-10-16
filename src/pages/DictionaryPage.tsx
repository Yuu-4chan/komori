import { BooksIcon, MagnifyingGlassIcon, TranslateIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { dictionariesChanged } from "../features/dictionary/sourcePolicy";

import { PageHeader } from "../components/layout/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { searchEscape } from "../components/ui/searchEscape";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { useI18n } from "../i18n/i18n";
import {
  DictionaryResultsHeader,
  groupKey,
  KanjiCard,
  lookupDictionary,
  noKanji,
  useWordAudioAvailable,
  type DictionaryLookup,
} from "../features/dictionary/DictionaryResults";
import { listDictionaries, type DictionarySummary } from "../features/dictionary/dictionaryApi";
import { suppliesDefinitions } from "../features/dictionary/definitionSources";
import { LookupEntry } from "../features/dictionary/LookupEntry";

type SearchState =
  | { status: "empty" }
  | { status: "loading"; query: string }
  | ({ status: "ready" } & DictionaryLookup)
  | { status: "error"; query: string };

type SourcesState =
  | { status: "loading" }
  | { status: "ready"; dictionaries: DictionarySummary[] }
  | { status: "error" };

/** Entries painted with a result's first frame, about a screenful: one entry of a common word can
 * hold thousands of elements, and the word matches dozens. */
const FIRST_ENTRIES = 2;

/** Runs `run` once the browser is idle (at the latest after a short wait); returns a cancel. */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 0);
  return () => window.clearTimeout(handle);
}

interface DictionaryPageProps {
  /** A search to run as the page opens, such as one the Reader's lookup popup starts. */
  initialQuery?: string;
}

export function DictionaryPage({ initialQuery = "" }: DictionaryPageProps) {
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState<SearchState>({ status: "empty" });
  const { readerPopupReadingPosition } = useAppearance();
  const { t } = useI18n();
  const [sources, setSources] = useState<SourcesState>({ status: "loading" });
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  // The result and source whose entries have all been rendered.
  const [completed, setCompleted] = useState<{ search: SearchState; source: number | null }>();
  const canPlayAudio = useWordAudioAvailable();
  const searchId = useRef(0);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void listDictionaries().then(
        (dictionaries) => {
          if (!active || request !== current) return;
          setSources({
            status: "ready",
            dictionaries,
          });
        },
        () => active && request === current && setSources({ status: "error" }),
      );
    };
    refresh();
    window.addEventListener(dictionariesChanged, refresh);
    return () => {
      active = false;
      window.removeEventListener(dictionariesChanged, refresh);
    };
  }, []);

  useEffect(
    () => () => {
      searchId.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (initialQuery.trim()) void submitSearch(initialQuery);
    // Only the query the page opened with; later searches come from the page itself.
  }, []);

  async function submitSearch(rawQuery: string) {
    const value = rawQuery.trim();
    const request = ++searchId.current;
    if (!value) {
      setSearch({ status: "empty" });
      return;
    }
    setSearch({ status: "loading", query: value });
    setSelectedSource(null);
    try {
      const lookup = await lookupDictionary(value);
      if (request !== searchId.current) return;
      setSearch({ status: "ready", ...lookup });
    } catch {
      if (request === searchId.current) setSearch({ status: "error", query: value });
    }
  }

  function searchTerm(term: string) {
    setQuery(term);
    void submitSearch(term);
  }

  const groups = search.status === "ready" ? search.groups : [];
  const kanji = search.status === "ready" ? search.kanji : noKanji;
  // Term rows and kanji rows count alike; frequency rows accompany them uncounted.
  const sourceCounts = new Map<number, number>();
  for (const row of [...groups.flatMap((group) => group.terms), ...kanji.entries]) {
    sourceCounts.set(row.dictionaryId, (sourceCounts.get(row.dictionaryId) ?? 0) + 1);
  }
  const totalRows = [...sourceCounts.values()].reduce((total, count) => total + count, 0);
  // Only dictionaries with matching definitions or kanji rows; frequency and pitch dictionaries
  // describe the results without being sources of their own.
  const matchingSources =
    sources.status === "ready"
      ? sources.dictionaries.filter((dictionary) => (sourceCounts.get(dictionary.id) ?? 0) > 0)
      : [];
  const shownSource = matchingSources.some(({ id }) => id === selectedSource)
    ? selectedSource
    : null;
  const visibleGroups =
    shownSource === null
      ? groups
      : groups.flatMap((group) => {
          const terms = group.terms.filter((term) => term.dictionaryId === shownSource);
          return terms.length ? [{ ...group, terms }] : [];
        });
  const visibleKanjiEntries =
    shownSource === null
      ? kanji.entries
      : kanji.entries.filter((entry) => entry.dictionaryId === shownSource);
  // With all sources, frequency rows alone still describe the kanji.
  const showKanji =
    visibleKanjiEntries.length > 0 || (shownSource === null && kanji.frequencies.length > 0);
  const entryCount = visibleGroups.length + (showKanji ? 1 : 0);
  // The first entries paint at once and the rest follow when idle, in the same order.
  const complete =
    visibleGroups.length <= FIRST_ENTRIES ||
    (completed?.search === search && completed.source === shownSource);
  const renderedGroups = complete ? visibleGroups : visibleGroups.slice(0, FIRST_ENTRIES);
  useEffect(() => {
    if (complete) return;
    return whenIdle(() => setCompleted({ search, source: shownSource }));
  }, [complete, search, shownSource]);

  return (
    <div className="page page--dictionary">
      <PageHeader title={t("shell.dictionary")} description={t("dictionaryPage.description")} />
      {sources.status === "ready" && !suppliesDefinitions(sources.dictionaries) && (
        <div className="library-notice dictionary-starter-offer">
          <div>
            <strong>{t("dictionaryPage.noDictionaries")}</strong>
            <p>{t("dictionaryPage.noDictionariesHint")}</p>
          </div>
          <Link className="button button--secondary" to="/settings?section=dictionary">
            {t("dictionaryPage.getDictionaries")}
          </Link>
        </div>
      )}
      <form
        className="dictionary-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void submitSearch(query);
        }}
      >
        <label className="dictionary-search">
          <MagnifyingGlassIcon aria-hidden="true" size={21} />
          <input
            aria-label={t("dictionaryPage.search")}
            onKeyDown={searchEscape}
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("dictionaryPage.placeholder")}
            value={query}
          />
          {query && (
            <button
              aria-label={t("libraryToolbar.clearSearch")}
              className="dictionary-search__clear"
              onClick={() => {
                searchId.current += 1;
                setQuery("");
                setSearch({ status: "empty" });
              }}
              type="button"
            >
              <XIcon aria-hidden="true" size={16} />
            </button>
          )}
        </label>
        <button className="dictionary-search-button" type="submit">
          <MagnifyingGlassIcon aria-hidden="true" size={18} /> {t("dictionaryPage.searchButton")}
        </button>
      </form>
      <div className="dictionary-workspace">
        <aside aria-label={t("dictionarySources.title")} className="dictionary-sources">
          <div className="dictionary-sources__header">
            <div>
              <strong>{t("storage.dictionaries")}</strong>
              <span>{t("settings.dictionaryDescription")}</span>
            </div>
            <BooksIcon aria-hidden="true" size={18} />
          </div>
          <div className="dictionary-sources__list">
            <SourceButton
              active={shownSource === null}
              count={totalRows}
              detail={t("dictionaryPage.everyMatching")}
              name={t("dictionaryPage.allSources")}
              onClick={() => setSelectedSource(null)}
            />
            {matchingSources.map((dictionary) => (
              <SourceButton
                active={shownSource === dictionary.id}
                count={sourceCounts.get(dictionary.id) ?? 0}
                detail={t("dictionarySources.revision", { revision: dictionary.revision })}
                key={dictionary.id}
                name={dictionary.title}
                onClick={() => setSelectedSource(dictionary.id)}
              />
            ))}
          </div>
          {sources.status === "ready" &&
            sources.dictionaries.length > 0 &&
            matchingSources.length === 0 && (
              <p className="dictionary-sources__message">
                {search.status === "ready"
                  ? t("dictionaryPage.noSourceMatches")
                  : t("dictionaryPage.sourcesAppear")}
              </p>
            )}
          {sources.status === "loading" && (
            <p className="dictionary-sources__message">{t("popupSources.loadingSources")}</p>
          )}
          {sources.status === "error" && (
            <p className="dictionary-sources__message" role="alert">
              {t("popupSources.loadFailed")}
            </p>
          )}
        </aside>
        <section
          aria-label={t("dictionaryPage.results")}
          className="dictionary-results"
          aria-live="polite"
        >
          {search.status === "empty" && (
            <div className="dictionary-results__empty">
              <EmptyState
                icon={TranslateIcon}
                title={t("dictionaryPage.emptyTitle")}
                description={t("dictionaryPage.emptyDescription")}
              />
            </div>
          )}
          {search.status === "loading" && (
            <p className="dictionary-results__message">{t("dictionaryPage.searching")}</p>
          )}
          {search.status === "error" && (
            <div className="dictionary-results__message" role="alert">
              {t("dictionaryPage.searchFailed")}
            </div>
          )}
          {search.status === "ready" && (
            <>
              <DictionaryResultsHeader entryCount={entryCount} lookup={search} />
              {entryCount === 0 ? (
                <div className="dictionary-results__empty">
                  <EmptyState
                    icon={TranslateIcon}
                    title={t(
                      shownSource === null
                        ? "dictionaryPage.noMatches"
                        : "dictionaryPage.noMatchesInSource",
                    )}
                    description={t(
                      shownSource === null
                        ? "dictionaryPage.noMatchesHint"
                        : "dictionaryPage.noMatchesInSourceHint",
                    )}
                  />
                </div>
              ) : (
                <div className="dictionary-sheet">
                  {showKanji && (
                    <KanjiCard
                      character={search.query}
                      entries={visibleKanjiEntries}
                      frequencies={kanji.frequencies}
                    />
                  )}
                  {renderedGroups.map((group) => (
                    <LookupEntry
                      canPlayAudio={canPlayAudio}
                      group={group}
                      key={groupKey(group)}
                      onSearchTerm={searchTerm}
                      readingPosition={readerPopupReadingPosition}
                      showDictionaryNames
                      showFrequency
                      showOpenAction={false}
                      showPitch
                      showVoiceAction
                      start={group.text === search.matched ? null : group.text}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function SourceButton({
  active,
  count,
  detail,
  name,
  onClick,
}: {
  active: boolean;
  count: number;
  detail: string;
  name: string;
  onClick: () => void;
}) {
  const { tp } = useI18n();
  return (
    <button
      aria-pressed={active}
      className={`dictionary-source${active ? " dictionary-source--active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden="true" className="dictionary-source__marker" />
      <span className="dictionary-source__copy">
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      <span
        aria-label={tp("dictionaryPage.matchingRows", count)}
        className="dictionary-source__count"
      >
        {count}
      </span>
    </button>
  );
}
