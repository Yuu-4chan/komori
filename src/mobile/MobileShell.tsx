import { ArrowLeftIcon, GearSixIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";

import { navigationItems } from "../app/navigation";
import { flushPendingWrites } from "../app/windowLifecycle";
import { BrandMark } from "../brand/BrandMark";
import { isLibraryReturn } from "../features/library/libraryCache";
import { MobileHeaderContext, type MobileHeaderProps } from "../components/layout/mobileHeader";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { StatisticsSourceContext } from "../features/statistics/statisticsSource";
import { useI18n } from "../i18n/i18n";
import { mobileStatisticsSource } from "./mobileStatisticsSource";
import { autoSync } from "./pcLinkApi";
import { systemBarIcons, useBackButton, watchKeyboard, watchSafeArea } from "./system";

/**
 * Komori's frame on the phone: the page scrolls under the status bar's inset, and a floating
 * dock of destinations sits above the gesture bar, except in Settings, which Back leaves. In the
 * Library, the dock steps away while the reader scrolls down. Each page heads itself.
 */
export function MobileShell() {
  const { t } = useI18n();
  const location = useLocation();
  const docked = location.pathname !== "/settings";
  const content = useRef<HTMLElement>(null);
  useScrollMemory(content);
  const library = location.pathname === "/" || location.pathname === "/library";
  const away = useDockAway(content, docked && library, location.key);
  // The bars' icons follow Komori's theme here, and the book's in the Reader.
  const lightTheme = useAppearance().themeBase === "light";
  useEffect(() => systemBarIcons(lightTheme), [lightTheme]);
  return (
    <MobileHeaderContext.Provider value={MobilePageHeader}>
      <StatisticsSourceContext.Provider value={mobileStatisticsSource}>
        <div className="mobile-shell">
          <main className="mobile-shell__content" id="main-content" ref={content}>
            <Outlet />
          </main>
          <nav
            aria-label={t("shell.primaryNavigation")}
            className={away ? "mobile-dock mobile-dock--away" : "mobile-dock"}
            hidden={!docked}
            inert={away}
          >
            {navigationItems.map(({ icon: NavigationIcon, label, path }) => (
              <NavLink
                className={({ isActive }) =>
                  isActive ? "mobile-dock__item mobile-dock__item--active" : "mobile-dock__item"
                }
                key={path}
                onClick={(event: MouseEvent) => {
                  // Tapping the page already open takes it back to its top.
                  if (location.pathname !== path || location.search) return;
                  event.preventDefault();
                  content.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
                state={FROM_DOCK}
                to={path}
              >
                <NavigationIcon aria-hidden="true" weight="duotone" />
                <span>{t(label)}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </StatisticsSourceContext.Provider>
    </MobileHeaderContext.Provider>
  );
}

// Where each page was scrolled to, by its history entry and by its path: kept while Komori runs,
// and across the Reader, which leaves the shell.
const scrolledTo = new Map<string, number>();
const scrolledToPath = new Map<string, number>();

/** The state of a navigation from the dock, which returns to a page where it was left. */
const FROM_DOCK = { dock: true };

/**
 * Pages open at their top, and Back, the dock or the Reader's Back returns to a page where it
 * was left: the shell's scroller outlives its pages, so without this a page would open where the
 * last one was scrolled to. A page still listing what it shows is followed until it is tall
 * enough or the reader scrolls.
 */
function useScrollMemory(content: RefObject<HTMLElement | null>) {
  const { key, pathname, search, state } = useLocation();
  const navigation = useNavigationType();
  const path = pathname + search;
  const returning = (state as typeof FROM_DOCK | null)?.dock === true || isLibraryReturn(state);
  useLayoutEffect(() => {
    const page = content.current;
    if (!page) return;
    const target =
      navigation === "POP"
        ? (scrolledTo.get(key) ?? 0)
        : returning
          ? (scrolledToPath.get(path) ?? 0)
          : 0;
    page.scrollTop = target;
    let following = target > 0 && page.scrollTop < target;
    // While the page grows to where it was, its shorter scroll is not where it was left.
    const remember = () => {
      if (following) return;
      scrolledTo.set(key, page.scrollTop);
      scrolledToPath.set(path, page.scrollTop);
    };
    const stop = () => {
      following = false;
    };
    const grown =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (following) page.scrollTop = target;
            if (page.scrollTop >= target) following = false;
          });
    if (following) for (const child of page.children) grown?.observe(child);
    const giveUp = window.setTimeout(stop, 3000);
    page.addEventListener("scroll", remember, { passive: true });
    page.addEventListener("touchstart", stop, { passive: true });
    page.addEventListener("wheel", stop, { passive: true });
    return () => {
      window.clearTimeout(giveUp);
      grown?.disconnect();
      page.removeEventListener("scroll", remember);
      page.removeEventListener("touchstart", stop);
      page.removeEventListener("wheel", stop);
    };
  }, [content, key, navigation, path, returning]);
}

/** How far the reader scrolls one way before the dock steps away, or comes back. */
export const DOCK_AWAY_AFTER = 24;
export const DOCK_BACK_AFTER = 12;

/**
 * Whether the dock is away: scrolling down hides it, to show more of the page, and scrolling up,
 * or reaching the top, brings it back. Only the reader's own scrolling counts, so a page
 * returning to where it was left keeps the dock; each page opens with it.
 */
function useDockAway(content: RefObject<HTMLElement | null>, enabled: boolean, page: string) {
  const [awayOn, setAwayOn] = useState<string | null>(null);
  useEffect(() => {
    const scroller = content.current;
    if (!enabled || !scroller) return;
    let last = scroller.scrollTop;
    let travelled = 0;
    let touched = false;
    const touch = () => {
      touched = true;
    };
    const scrolled = () => {
      const top = scroller.scrollTop;
      const moved = top - last;
      last = top;
      if (top <= 0) {
        travelled = 0;
        setAwayOn(null);
        return;
      }
      if (!touched || moved === 0) return;
      // Turning around starts counting again.
      travelled = Math.sign(moved) === Math.sign(travelled) ? travelled + moved : moved;
      if (travelled >= DOCK_AWAY_AFTER) setAwayOn(page);
      else if (travelled <= -DOCK_BACK_AFTER) setAwayOn(null);
    };
    scroller.addEventListener("touchstart", touch, { passive: true });
    scroller.addEventListener("wheel", touch, { passive: true });
    scroller.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", touch);
      scroller.removeEventListener("wheel", touch);
      scroller.removeEventListener("scroll", scrolled);
    };
  }, [content, enabled, page]);
  return enabled && awayOn === page;
}

/**
 * A page's heading on the phone: the brand, its title, Settings and its own actions.
 */
export function MobilePageHeader({ title, actions, back = false }: MobileHeaderProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <header className="mobile-header">
      <div className="mobile-header__row">
        {back ? (
          <button
            aria-label={t("common.back")}
            className="mobile-round-button"
            onClick={() => navigate(-1)}
            type="button"
          >
            <ArrowLeftIcon aria-hidden="true" weight="bold" />
          </button>
        ) : (
          <BrandMark className="mobile-header__brand" />
        )}
        <div className="mobile-header__title">
          <h1>{title}</h1>
        </div>
        {back ? null : (
          <Link aria-label={t("shell.settings")} className="mobile-round-button" to="/settings">
            <GearSixIcon aria-hidden="true" weight="duotone" />
          </Link>
        )}
        {actions}
      </div>
    </header>
  );
}

/**
 * What the phone asks of every page: the safe area's insets, the keyboard's height, Android's
 * Back, saving what is pending when Komori goes to the background, where Android may end it
 * without warning, and syncing with the PC on starting, on going to the background (so the PC
 * has the place read last, within the seconds Android still lets Komori reach the network) and
 * on coming back.
 */
export function MobileSystem() {
  useBackButton();
  useEffect(() => watchSafeArea(), []);
  useEffect(() => watchKeyboard(), []);
  useEffect(() => {
    void autoSync();
    const changed = () => {
      if (document.visibilityState === "hidden") void flushPendingWrites().then(() => autoSync());
      else void autoSync();
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return null;
}
