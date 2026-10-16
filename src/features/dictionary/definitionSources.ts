import { useEffect, useState } from "react";
import { listDictionaries, type DictionarySummary } from "./dictionaryApi";
import { dictionariesChanged } from "./sourcePolicy";

/** Whether any installed dictionary can supply definitions; frequency or pitch alone cannot. */
export function suppliesDefinitions(dictionaries: DictionarySummary[]) {
  return dictionaries.some((dictionary) => dictionary.hasDefinitions);
}

/**
 * Whether an installed dictionary can supply definitions, refreshed as dictionaries change; null
 * until known, when the list cannot be read or when not wanted. Source choices do not affect it.
 */
export function useDefinitionSources(wanted = true) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      listDictionaries().then(
        (dictionaries) =>
          active && request === current && setInstalled(suppliesDefinitions(dictionaries)),
        () => active && request === current && setInstalled(null),
      );
    };
    refresh();
    window.addEventListener(dictionariesChanged, refresh);
    return () => {
      active = false;
      window.removeEventListener(dictionariesChanged, refresh);
    };
  }, [wanted]);
  return wanted ? installed : null;
}
