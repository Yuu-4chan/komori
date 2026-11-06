import { CaretDownIcon } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";

import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import type { FrequencyMatch, KanjiMatch, TermTag } from "./dictionaryApi";
import { shownTags } from "./DictionaryResults";
import { EntryFrequencies, EntrySource } from "./LookupEntry";

/**
 * A kanji as an ordinary entry: the character with its actions, its on and kun readings, its
 * frequencies, then each kanji dictionary's meanings under its name with its tags, and its stats.
 */
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
  const readings = [
    [t("dictionaryResults.on"), kanjiReadings(entries.map((entry) => entry.onyomi))],
    [t("dictionaryResults.kun"), kanjiReadings(entries.map((entry) => entry.kunyomi))],
  ].filter(([, value]) => value);
  const kanji = { name: t("dictionaryResults.kanji"), category: undefined, notes: "" };
  return (
    <article
      aria-label={t("dictionaryResults.kanjiLabel", { character })}
      className="lookup-entry lookup-entry--kanji"
    >
      <header className="lookup-entry__header">
        <div className="lookup-entry__headline">
          <div className="lookup-entry__word">
            <strong className="lookup-entry__expression" lang="ja">
              {character}
            </strong>
          </div>
          {actions}
        </div>
        {readings.length > 0 && (
          <dl aria-label={t("dictionaryResults.readings")} className="lookup-entry__kanji-readings">
            {readings.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd lang="ja">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {showFrequencies && frequencies.length > 0 && (
          <EntryFrequencies frequencies={frequencies} showDictionaryNames={showDictionaryNames} />
        )}
      </header>
      {entries.map((entry, index) => (
        <EntrySource
          key={index}
          tags={[...(index === 0 ? [kanji] : []), ...shownTags(entry.resolvedTags)]}
          title={entry.dictionaryTitle}
        >
          {entry.meanings.length > 0 && (
            <ol aria-label={t("dictionaryResults.meanings")} className="lookup-source__meanings">
              {entry.meanings.map((meaning, item) => (
                <li key={item}>{meaning}</li>
              ))}
            </ol>
          )}
          <KanjiStats entry={entry} />
        </EntrySource>
      ))}
    </article>
  );
}

// Readings are space-separated in kanji rows; each is shown once, across the kanji's dictionaries.
function kanjiReadings(values: string[]): string {
  return [...new Set(values.flatMap((value) => value.split(" ").filter(Boolean)))].join("、");
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
