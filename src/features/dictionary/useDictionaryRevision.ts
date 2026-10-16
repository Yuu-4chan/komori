import { useEffect, useState } from "react";
import { dictionariesChanged } from "./sourcePolicy";

/** Maintenance notifications invalidate only dictionary consumers, never the book renderer. */
export function useDictionaryRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener(dictionariesChanged, changed);
    return () => window.removeEventListener(dictionariesChanged, changed);
  }, []);
  return revision;
}
