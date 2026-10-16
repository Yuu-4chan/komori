import { i18n, type MessageKey } from "../../i18n/i18n";
import { useEffect, useRef, useState } from "react";
import { registerWindowFlush } from "../../app/windowLifecycle";
import {
  noteBodyValid,
  visibleNotes,
  type NoteOrder,
  type NoteStore,
  type NotePassage,
  type ReaderNote,
} from "./notes";

export function useNotes(store?: NoteStore) {
  const [view, setView] = useState({ store, query: "", order: "creation" as NoteOrder });
  // Owned here, above the conditionally mounted panel; reloads keep these choices.
  if (view.store !== store) setView({ store, query: "", order: "creation" });
  const query = view.store === store ? view.query : "";
  const order = view.store === store ? view.order : "creation";
  const [reload, setReload] = useState(0);
  const [state, setState] = useState({
    store,
    status: store ? "loading" : "empty",
    items: [] as ReaderNote[],
    busy: false,
    error: "",
    notice: "",
  });
  const session = useRef<{ store?: NoteStore; active: boolean; pending?: Promise<boolean> } | null>(
    null,
  );
  useEffect(() => {
    const current: NonNullable<typeof session.current> = { store, active: true };
    session.current = current;
    const stopFlush = registerWindowFlush(async () => {
      await current.pending;
    });
    setState({
      store,
      status: store ? "loading" : "empty",
      items: [],
      busy: false,
      error: "",
      notice: "",
    });
    if (store)
      void store.load().then(
        (items) => {
          if (current.active) setState((state) => ({ ...state, items, status: "ready" }));
        },
        () => {
          if (current.active)
            setState((state) => ({
              ...state,
              status: "error",
              error: i18n().t("notes.loadFailed"),
            }));
        },
      );
    return () => {
      current.active = false;
      stopFlush();
    };
  }, [store, reload]);
  const visible =
    state.store === store
      ? state
      : {
          store,
          status: store ? "loading" : "empty",
          items: [] as ReaderNote[],
          busy: false,
          error: "",
          notice: "",
        };
  function run(
    action: (store: NoteStore) => Promise<(items: ReaderNote[]) => ReaderNote[]>,
    notice: MessageKey,
  ): Promise<boolean> {
    const current = session.current;
    if (
      !store ||
      current?.store !== store ||
      !current.active ||
      current.pending ||
      visible.status !== "ready"
    )
      return Promise.resolve(false);
    setState((state) => ({ ...state, busy: true, error: "", notice: "" }));
    const pending = (async () => {
      try {
        const update = await action(store);
        if (!current.active) return false;
        setState((state) => ({ ...state, items: update(state.items), notice: i18n().t(notice) }));
        return true;
      } catch (error) {
        if (current.active)
          setState((state) => ({
            ...state,
            error: error instanceof Error ? error.message : i18n().t("notes.saveFailed"),
          }));
        return false;
      } finally {
        current.pending = undefined;
        if (current.active) setState((state) => ({ ...state, busy: false }));
      }
    })();
    current.pending = pending;
    return pending;
  }
  return {
    ...visible,
    query,
    order,
    visibleItems: visibleNotes(visible.items, query, order),
    setQuery: (query: string) => setView({ store, query, order }),
    setOrder: (order: NoteOrder) => {
      if (order === "creation" || order === "reading") setView({ store, query, order });
    },
    retry: () => {
      if (!session.current?.pending) setReload((count) => count + 1);
    },
    /** An empty body saves a highlight: the passage marked without a note. */
    create: (place: NotePassage, body: string) => {
      body = body.trim();
      return run(
        async (store) => {
          if (!noteBodyValid(body)) throw Error(i18n().t("notes.invalidBody"));
          const note = await store.create(place, body);
          return (items) => [...items, note];
        },
        body ? "notes.saved" : "notes.highlighted",
      );
    },
    edit: (id: string, body: string) =>
      run(async (store) => {
        body = body.trim();
        if (!noteBodyValid(body)) throw Error(i18n().t("notes.invalidBody"));
        await store.edit(id, body);
        return (items) => items.map((item) => (item.id === id ? { ...item, body } : item));
      }, "notes.updated"),
    remove: (id: string) =>
      run(async (store) => {
        await store.remove(id);
        return (items) => items.filter((item) => item.id !== id);
      }, "notes.removed"),
  };
}
