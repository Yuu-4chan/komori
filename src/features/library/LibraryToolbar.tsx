import { ChoiceCheck, SelectionBox } from "../../components/ui/SelectionBox";
import { searchEscape } from "../../components/ui/searchEscape";
import {
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  FunnelIcon,
  RowsIcon,
  ListIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  SquaresFourIcon,
  StackIcon,
  TranslateIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { LibraryDisplay } from "../appearance/AppearanceProvider";
import { defaultAppearance } from "../appearance/appearancePreferences";
import type { LibraryFilter, LibraryGroup, LibrarySort } from "./libraryView";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";

type MenuName = "filter" | "group" | "cards" | "sort";

const filterOptions: { value: LibraryFilter; label: MessageKey; description: MessageKey }[] = [
  {
    value: "all",
    label: "libraryToolbar.filter.all",
    description: "libraryToolbar.filter.allHint",
  },
  {
    value: "reading",
    label: "libraryToolbar.filter.reading",
    description: "libraryToolbar.filter.readingHint",
  },
  {
    value: "completed",
    label: "libraryToolbar.filter.completed",
    description: "libraryToolbar.filter.completedHint",
  },
  {
    value: "not-started",
    label: "libraryToolbar.filter.not-started",
    description: "libraryToolbar.filter.not-startedHint",
  },
];

const groupOptions: { value: LibraryGroup; label: MessageKey; description: MessageKey }[] = [
  {
    value: "none",
    label: "libraryToolbar.group.none",
    description: "libraryToolbar.group.noneHint",
  },
  {
    value: "series",
    label: "libraryToolbar.group.series",
    description: "libraryToolbar.group.seriesHint",
  },
  {
    value: "language",
    label: "libraryToolbar.group.language",
    description: "libraryToolbar.group.languageHint",
  },
];

const sortOptions: { value: LibrarySort; label: MessageKey; description: MessageKey }[] = [
  {
    value: "recent",
    label: "libraryToolbar.sort.recent",
    description: "libraryToolbar.sort.recentHint",
  },
  {
    value: "added",
    label: "libraryToolbar.sort.added",
    description: "libraryToolbar.sort.addedHint",
  },
  {
    value: "title",
    label: "libraryToolbar.sort.title",
    description: "libraryToolbar.sort.titleHint",
  },
  {
    value: "progress",
    label: "libraryToolbar.sort.progress",
    description: "libraryToolbar.sort.progressHint",
  },
  {
    value: "characters",
    label: "libraryToolbar.sort.characters",
    description: "libraryToolbar.sort.charactersHint",
  },
  {
    value: "words",
    label: "libraryToolbar.sort.words",
    description: "libraryToolbar.sort.wordsHint",
  },
];

/** The saved preference behind each card detail, whose default the Cards pill compares with. */
const defaultCardDetail = {
  cardSeries: "libraryCardSeries",
  cardLanguage: "libraryCardLanguage",
  cardKanji: "libraryCardKanji",
  cardLastRead: "libraryCardLastRead",
} as const;

const cardOptions: {
  key: "cardSeries" | "cardLanguage" | "cardKanji" | "cardLastRead";
  label: MessageKey;
  icon: ReactNode;
}[] = [
  { key: "cardSeries", label: "libraryToolbar.cardSeries", icon: <StackIcon /> },
  { key: "cardLanguage", label: "libraryToolbar.cardLanguage", icon: <TranslateIcon /> },
  {
    key: "cardKanji",
    label: "libraryToolbar.cardKanji",
    icon: (
      <span className="floating-menu__glyph" lang="ja">
        漢
      </span>
    ),
  },
  {
    key: "cardLastRead",
    label: "libraryToolbar.cardLastRead",
    icon: <ClockCounterClockwiseIcon />,
  },
];

const sortLabel = (sort: LibrarySort) =>
  i18n().t(
    sortOptions.find((option) => option.value === sort)?.label ?? "libraryToolbar.sort.recent",
  );

interface LibraryToolbarProps {
  display: LibraryDisplay;
  onDisplayChange: (patch: Partial<LibraryDisplay>) => void;
  /** Hides Group, as on a group's own page. */
  grouping?: boolean;
}

/**
 * The Library's toolbar beside its title: Filters, Group, Cards, Sort with its direction, and
 * the grid/list switch last. Its menus close on a choice, a click outside, or Escape. Books are
 * selected from each card's corner box.
 */
export function LibraryToolbar({ display, onDisplayChange, grouping = true }: LibraryToolbarProps) {
  const [open, setOpen] = useState<MenuName | null>(null);
  const { t } = useI18n();
  const actionsRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement;
    actionsRef.current?.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!actionsRef.current?.contains(event.target as Node)) setOpen(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        returnFocusRef.current?.focus();
        return;
      }
      const menu = actionsRef.current?.querySelector('[role="menu"]');
      if (!menu?.contains(document.activeElement)) return;
      if (event.key === "Tab") {
        setOpen(null);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const toggle = (menu: MenuName) => setOpen((current) => (current === menu ? null : menu));

  return (
    <div className="book-library__toolbar" role="toolbar" aria-label={t("libraryToolbar.view")}>
      <div className="book-library__actions" ref={actionsRef}>
        <div className="book-filter-wrap">
          <ToolbarPill
            active={display.filter !== "all"}
            expanded={open === "filter"}
            icon={<FunnelIcon aria-hidden="true" size={17} />}
            label={t("libraryToolbar.filters")}
            onClick={() => toggle("filter")}
          />
          {open === "filter" ? (
            <div
              className="floating-menu floating-menu--wide"
              role="menu"
              aria-label={t("libraryToolbar.filters")}
            >
              <div className="floating-menu__section-label">{t("libraryToolbar.statusFilter")}</div>
              {filterOptions.map((option) => (
                <MenuRadio
                  checked={display.filter === option.value}
                  description={option.description}
                  key={option.value}
                  label={option.label}
                  onSelect={() => {
                    onDisplayChange({ filter: option.value });
                    setOpen(null);
                    returnFocusRef.current?.focus();
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        {grouping ? (
          <div className="book-filter-wrap">
            <ToolbarPill
              active={display.group !== "none"}
              expanded={open === "group"}
              icon={<RowsIcon aria-hidden="true" size={17} />}
              label={
                display.group === "none"
                  ? t("libraryToolbar.group")
                  : t(
                      groupOptions.find((option) => option.value === display.group)?.label ??
                        "libraryToolbar.group",
                    )
              }
              onClick={() => toggle("group")}
              srLabel={t(
                display.group === "none"
                  ? "libraryToolbar.groupByNothing"
                  : display.group === "series"
                    ? "libraryToolbar.groupBySeries"
                    : "libraryToolbar.groupByLanguage",
              )}
            />
            {open === "group" ? (
              <div
                className="floating-menu floating-menu--wide"
                role="menu"
                aria-label={t("libraryToolbar.groupBooks")}
              >
                <div className="floating-menu__section-label">{t("libraryToolbar.groupBooks")}</div>
                {groupOptions.map((option) => (
                  <MenuRadio
                    checked={display.group === option.value}
                    description={option.description}
                    key={option.value}
                    label={option.label}
                    onSelect={() => {
                      onDisplayChange({ group: option.value });
                      setOpen(null);
                      returnFocusRef.current?.focus();
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="book-filter-wrap">
          <ToolbarPill
            active={cardOptions.some(
              (option) => display[option.key] !== defaultAppearance[defaultCardDetail[option.key]],
            )}
            expanded={open === "cards"}
            icon={<SlidersHorizontalIcon aria-hidden="true" size={17} />}
            label={t("libraryToolbar.cards")}
            onClick={() => toggle("cards")}
          />
          {open === "cards" ? (
            <div className="floating-menu" role="menu" aria-label={t("libraryToolbar.cardDetails")}>
              <div className="floating-menu__section-label">
                {t("libraryToolbar.visibleOnCards")}
              </div>
              {cardOptions.map((option) => (
                <button
                  aria-checked={display[option.key]}
                  className="floating-menu__toggle"
                  key={option.key}
                  onClick={() => onDisplayChange({ [option.key]: !display[option.key] })}
                  role="menuitemcheckbox"
                  type="button"
                >
                  <span className="floating-menu__toggle-left">
                    <span className="floating-menu__mini-icon" aria-hidden="true">
                      {option.icon}
                    </span>
                    <span>{t(option.label)}</span>
                  </span>
                  <SelectionBox checked={display[option.key]} />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="book-filter-wrap">
          <ToolbarPill
            expanded={open === "sort"}
            label={sortLabel(display.sort)}
            onClick={() => toggle("sort")}
            srLabel={t("libraryToolbar.sortBy", { sort: sortLabel(display.sort) })}
          />
          {open === "sort" ? (
            <div
              className="floating-menu floating-menu--wide"
              role="menu"
              aria-label={t("libraryToolbar.sortBooks")}
            >
              <div className="floating-menu__section-label">{t("libraryToolbar.sortBooks")}</div>
              {sortOptions.map((option) => (
                <MenuRadio
                  checked={display.sort === option.value}
                  description={option.description}
                  key={option.value}
                  label={option.label}
                  onSelect={() => {
                    onDisplayChange({ sort: option.value });
                    setOpen(null);
                    returnFocusRef.current?.focus();
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <button
          aria-label={t(
            display.sortReversed
              ? "libraryToolbar.normalDirection"
              : "libraryToolbar.reverseDirection",
          )}
          aria-pressed={display.sortReversed}
          className="sort-direction-button"
          onClick={() => onDisplayChange({ sortReversed: !display.sortReversed })}
          title={t(
            display.sortReversed ? "libraryToolbar.normalOrder" : "libraryToolbar.reverseOrder",
          )}
          type="button"
        >
          {display.sortReversed ? (
            <SortDescendingIcon aria-hidden="true" size={18} />
          ) : (
            <SortAscendingIcon aria-hidden="true" size={18} />
          )}
        </button>

        <div className="book-view-toggle" role="group" aria-label={t("libraryToolbar.layout")}>
          <button
            aria-label={t("libraryToolbar.grid")}
            aria-pressed={display.view === "grid"}
            className="book-view-toggle__button"
            onClick={() => onDisplayChange({ view: "grid" })}
            title={t("libraryToolbar.grid")}
            type="button"
          >
            <SquaresFourIcon aria-hidden="true" size={18} />
          </button>
          <button
            aria-label={t("libraryToolbar.list")}
            aria-pressed={display.view === "list"}
            className="book-view-toggle__button"
            onClick={() => onDisplayChange({ view: "list" })}
            title={t("libraryToolbar.list")}
            type="button"
          >
            <ListIcon aria-hidden="true" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Search across title, author, and file name; it sits in the shell's top bar. */
export function LibrarySearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="book-search">
      <MagnifyingGlassIcon aria-hidden="true" size={18} />
      <input
        aria-label={t("libraryToolbar.search")}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (searchEscape(event) && query) onQueryChange("");
        }}
        placeholder={t("libraryToolbar.searchPlaceholder")}
        spellCheck={false}
        type="search"
        value={query}
      />
      {query ? (
        <button
          aria-label={t("libraryToolbar.clearSearch")}
          onClick={() => onQueryChange("")}
          type="button"
        >
          <XIcon aria-hidden="true" size={15} />
        </button>
      ) : null}
    </label>
  );
}

function ToolbarPill({
  icon,
  label,
  srLabel,
  active = false,
  expanded,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  srLabel?: string;
  active?: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-haspopup="menu"
      aria-label={srLabel}
      className={active ? "toolbar-pill toolbar-pill--active" : "toolbar-pill"}
      onClick={onClick}
      type="button"
    >
      {icon ? <span className="toolbar-pill__icon">{icon}</span> : null}
      <span className="toolbar-pill__label">{label}</span>
      <CaretDownIcon aria-hidden="true" className="toolbar-pill__caret" size={12} weight="bold" />
    </button>
  );
}

function MenuRadio({
  checked,
  label,
  description,
  onSelect,
}: {
  checked: boolean;
  label: MessageKey;
  description: MessageKey;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      aria-checked={checked}
      className={
        checked ? "floating-menu__option floating-menu__option--active" : "floating-menu__option"
      }
      onClick={onSelect}
      role="menuitemradio"
      type="button"
    >
      <ChoiceCheck checked={checked} />
      <span className="floating-menu__text">
        <strong>{t(label)}</strong>
        <small>{t(description)}</small>
      </span>
    </button>
  );
}
