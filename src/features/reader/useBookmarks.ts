import { i18n, type MessageKey } from "../../i18n/i18n";
import { useEffect, useRef, useState } from "react";

import { bookmarkTextValid, type BookmarkStore, type ReaderBookmark } from "./bookmarks";
import type { ReaderBookmarkPlace } from "./renderer";

interface State {
  store?: BookmarkStore;
  status: "empty" | "loading" | "ready" | "error";
  items: ReaderBookmark[];
  busy: boolean;
  error: string;
  notice: string;
}

export function useBookmarks(store?: BookmarkStore) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<State>({
    store,
    status: store ? "loading" : "empty",
    items: [],
    busy: false,
    error: "",
    notice: "",
  });
  const session = useRef<{ store?: BookmarkStore; active: boolean; busy: boolean } | null>(null);
  useEffect(() => {
    const current = { store, active: true, busy: false };
    session.current = current;
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
              error: i18n().t("bookmarks.loadFailed"),
            }));
        },
      );
    return () => {
      current.active = false;
    };
  }, [store, reload]);
  const visible =
    state.store === store
      ? state
      : {
          store,
          status: store ? ("loading" as const) : ("empty" as const),
          items: [],
          busy: false,
          error: "",
          notice: "",
        };

  async function run(
    action: (
      store: BookmarkStore,
      active: () => boolean,
    ) => Promise<{ items?: ReaderBookmark[]; notice: MessageKey }>,
    feedback?: (message: string) => void,
  ): Promise<boolean> {
    const current = session.current;
    if (
      !store ||
      current?.store !== store ||
      !current.active ||
      current.busy ||
      visible.status !== "ready"
    )
      return false;
    current.busy = true;
    setState((state) => ({ ...state, busy: true, error: "", notice: "" }));
    try {
      const result = await action(store, () => current.active);
      if (!current.active) return false;
      const notice = i18n().t(result.notice);
      // Feedback, such as the Reader's floating notice, is the only notice of its action.
      feedback?.(notice);
      setState((state) => ({
        ...state,
        items: result.items ?? state.items,
        notice: feedback ? "" : notice,
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n().t("bookmarks.saveFailed");
      if (current.active && feedback) feedback(message);
      else if (current.active) setState((state) => ({ ...state, error: message }));
      return false;
    } finally {
      current.busy = false;
      if (current.active) setState((state) => ({ ...state, busy: false }));
    }
  }

  return {
    ...visible,
    retry: () => {
      if (!session.current?.busy) setReload((count) => count + 1);
    },
    create: (
      capture: () => Promise<ReaderBookmarkPlace | null>,
      label: string,
      feedback?: (message: string) => void,
    ) =>
      run(async (store, active) => {
        label = label.trim();
        if (!bookmarkTextValid(label, 80)) throw Error(i18n().t("bookmarks.invalidLabel"));
        const place = await capture();
        if (!active()) throw Error(i18n().t("bookmarks.bookChanged"));
        if (!place) throw Error(i18n().t("bookmarks.captureFailed"));
        const { duplicate, bookmark } = await store.create(place, label);
        return {
          items: visible.items.some((item) => item.id === bookmark.id)
            ? visible.items.map((item) => (item.id === bookmark.id ? bookmark : item))
            : [...visible.items, bookmark],
          notice: duplicate ? "bookmarks.duplicate" : "bookmarks.saved",
        };
      }, feedback),
    rename: (id: string, label: string) =>
      run(async (store) => {
        label = label.trim();
        if (!bookmarkTextValid(label, 80)) throw Error(i18n().t("bookmarks.invalidLabel"));
        await store.rename(id, label);
        return {
          items: visible.items.map((item) => (item.id === id ? { ...item, label } : item)),
          notice: "bookmarks.renamed",
        };
      }),
    remove: (id: string) =>
      run(async (store) => {
        await store.remove(id);
        return {
          items: visible.items.filter((item) => item.id !== id),
          notice: "bookmarks.removed",
        };
      }),
  };
}
