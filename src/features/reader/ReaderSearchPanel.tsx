import { i18n, useI18n } from "../../i18n/i18n";
import { ReaderPanelHeading } from "./ReaderPanelHeading";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { searchEscape } from "../../components/ui/searchEscape";
import { SEARCH_QUERY_LIMIT, searchQuery } from "./bookSearch";
import type { ReaderRendererFactory, ReaderSearchResults, ReaderSearchScope } from "./renderer";

export interface ReaderSearchPanelProps {
  ready: boolean;
  navigationBusy: boolean;
  session?: ReaderRendererFactory;
  onSearch: (
    query: string,
    scope: ReaderSearchScope,
    signal: AbortSignal,
  ) => Promise<ReaderSearchResults>;
  onJump: (id: string, signal: AbortSignal, settled: (success: boolean) => void) => boolean;
  onExit?: () => void;
}

export function ReaderSearchPanel({
  ready,
  navigationBusy,
  session,
  onSearch,
  onJump,
  onExit,
}: ReaderSearchPanelProps) {
  const { t, tp } = useI18n();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ReaderSearchScope>("book");
  const [status, setStatus] = useState<"initial" | "loading" | "ready" | "error">("initial");
  const [results, setResults] = useState<ReaderSearchResults>({ matches: [], truncated: false });
  const [jumpError, setJumpError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const normalized = searchQuery(query);
  const tooLong = [...normalized].length > SEARCH_QUERY_LIMIT;
  const cancel = () => {
    request.current?.abort();
    request.current = null;
    setStatus("initial");
    setResults({ matches: [], truncated: false });
    setJumpError(false);
    setSelected(null);
  };
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    cancel();
    setQuery("");
  }, [session]);
  useEffect(() => {
    if (!ready) cancel();
  }, [ready]);

  const submit = () => {
    if (!ready || navigationBusy || !normalized || tooLong) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    setJumpError(false);
    setSelected(null);
    setResults({ matches: [], truncated: false });
    void onSearch(normalized, scope, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setResults(value);
        setStatus("ready");
      },
      () => {
        if (!controller.signal.aborted) setStatus("error");
      },
    );
  };
  const matchCount = `${i18n().number(results.matches.length)}${results.truncated ? "+" : ""}`;
  return (
    <section className="reader-search-panel" aria-labelledby="reader-search-heading">
      <ReaderPanelHeading
        id="reader-search-heading"
        eyebrow={t("sidebar.find")}
        title={t("sidebar.search")}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="reader-search-row">
          <label className="reader-search-box">
            <MagnifyingGlassIcon aria-hidden="true" />
            <span className="visually-hidden">{t("search.label")}</span>
            <input
              type="search"
              value={query}
              placeholder={t("search.placeholder")}
              spellCheck={false}
              onKeyDown={(event) => {
                if (searchEscape(event)) onExit?.();
              }}
              onChange={(event) => {
                cancel();
                setQuery(event.target.value);
              }}
            />
          </label>
          <Button type="submit" disabled={!ready || navigationBusy || !normalized || tooLong}>
            {t("search.find")}
          </Button>
        </div>
        <div className="reader-search-scope" role="group" aria-label={t("search.scope")}>
          {(["book", "chapter"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => {
                cancel();
                setScope(value);
              }}
            >
              {t(value === "book" ? "search.wholeBook" : "search.thisChapter")}
            </button>
          ))}
        </div>
      </form>
      <p className="reader-search-summary" role="status">
        {!ready
          ? t("search.needsBook")
          : tooLong
            ? t("search.tooLong", { count: SEARCH_QUERY_LIMIT })
            : status === "initial"
              ? ""
              : status === "loading"
                ? t("search.searching")
                : status === "error"
                  ? t("search.failed")
                  : !results.matches.length
                    ? t("search.none")
                    : [
                        tp("search.matches", results.matches.length, { shown: matchCount }),
                        results.truncated ? t("search.first100") : null,
                        t(scope === "book" ? "search.wholeBook" : "search.chapterAtSearch"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
      </p>
      {jumpError && <p role="alert">{t("search.jumpFailed")}</p>}
      <div className="reader-search-results" aria-busy={status === "loading"}>
        {results.matches.map((result, index) => (
          <button
            key={result.id}
            type="button"
            className="reader-search-result"
            aria-label={t("search.jump", { index: index + 1, label: result.label })}
            aria-describedby={`reader-search-excerpt-${index}`}
            aria-current={selected === result.id ? "location" : undefined}
            aria-disabled={navigationBusy || undefined}
            onClick={() => {
              const controller = request.current;
              if (navigationBusy || !controller || controller.signal.aborted) return;
              setJumpError(false);
              if (
                !onJump(result.id, controller.signal, (success) => {
                  if (controller.signal.aborted) return;
                  setJumpError(!success);
                  if (success) setSelected(result.id);
                })
              )
                setJumpError(true);
            }}
          >
            <span className="reader-search-result__topline">
              <strong>{result.label}</strong>
            </span>
            <p id={`reader-search-excerpt-${index}`}>
              {result.before}
              <mark>{result.match}</mark>
              {result.after}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}
