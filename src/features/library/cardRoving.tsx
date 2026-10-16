import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { LibraryBook } from "./libraryApi";

/** Which card of a collection holds its one Tab stop; each card subscribes to its own flag. */
class TabStop {
  active: string | null = null;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  set(id: string | null) {
    if (id === this.active) return;
    this.active = id;
    for (const listener of this.listeners) listener();
  }
}

const TabStopContext = createContext<TabStop | null>(null);
const always = () => () => undefined;

/** Whether a card holds its collection's Tab stop; outside a collection every card does. */
export function useCardTabStop(id: string): boolean {
  const stop = useContext(TabStopContext);
  return useSyncExternalStore(stop?.subscribe ?? always, () => !stop || stop.active === id);
}

const roving = "data-card-roving";

/** The cards a collection renders itself, not those of a collection inside it. */
function ownCards(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(".library-book")).filter(
    (card) => card.parentElement?.closest(`[${roving}]`) === container,
  );
}

/** A grid's columns: the cards on the first card's row. */
function measuredColumns(cards: HTMLElement[]) {
  const top = cards[0]?.getBoundingClientRect().top;
  return Math.max(1, cards.filter((card) => card.getBoundingClientRect().top === top).length);
}

/**
 * Makes a collection of book cards one Tab stop: only the card last focused (or the first one
 * rendered) can be tabbed to, and the arrow keys move between the cards in the books' order,
 * keeping to the same control. `columns` is how far Up and Down move: a number, `measure` for
 * a grid the layout decides, or 0 for one row.
 */
export function useCardRoving(
  ref: RefObject<HTMLElement | null>,
  books: readonly LibraryBook[],
  columns: number | "measure",
) {
  const stop = useMemo(() => new TabStop(), []);

  // Books leave the list and rows scroll out of the rendered range: the stop stays on a card
  // that is there.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const cards = ownCards(container);
    if (cards.some((card) => card.dataset.catalogId === stop.active)) return;
    stop.set(cards[0]?.dataset.catalogId ?? null);
  });

  function onFocus(event: FocusEvent<HTMLElement>) {
    const card = (event.target as Element).closest<HTMLElement>(".library-book");
    if (card && card.parentElement?.closest(`[${roving}]`) === event.currentTarget)
      stop.set(card.dataset.catalogId ?? null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const container = event.currentTarget;
    const from = event.target as HTMLElement;
    const card = from.closest<HTMLElement>(".library-book");
    if (!card || card.parentElement?.closest(`[${roving}]`) !== container) return;
    if (from.closest('[role="menu"]')) return;
    const rows = columns === "measure" ? measuredColumns(ownCards(container)) : columns;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -rows, ArrowDown: rows }[event.key];
    if (!step) return;
    const index = books.findIndex((book) => book.id === card.dataset.catalogId);
    const next = index < 0 ? undefined : books[index + step];
    event.preventDefault();
    if (!next) return;
    stop.set(next.id);
    const control = from.closest(".library-book__selection")
      ? ".library-book__selection input"
      : ".library-book__open, .library-book__selection input";
    const focus = () => {
      const target = ownCards(container).find((item) => item.dataset.catalogId === next.id);
      target?.querySelector<HTMLElement>(control)?.focus();
      return Boolean(target);
    };
    // A card beyond the rendered range renders once the focused one scrolls it near the view.
    if (!focus()) requestAnimationFrame(focus);
  }

  return {
    stop,
    props: { [roving]: "", onFocus, onKeyDown },
  };
}

/** Gives the cards inside it their collection's Tab stop. */
export function CardTabStop({ stop, children }: { stop: TabStop; children: ReactNode }) {
  return <TabStopContext.Provider value={stop}>{children}</TabStopContext.Provider>;
}
