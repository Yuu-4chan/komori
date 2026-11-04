import { ArrowLeftIcon, GearSixIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { navigationItems } from "../app/navigation";
import { flushPendingWrites } from "../app/windowLifecycle";
import { BrandMark } from "../brand/BrandMark";
import { MobileHeaderContext, type MobileHeaderProps } from "../components/layout/mobileHeader";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { useI18n } from "../i18n/i18n";
import { systemBarIcons, useBackButton, watchKeyboard, watchSafeArea } from "./system";

/**
 * Komori's frame on the phone: the page scrolls under the status bar's inset, and a floating
 * dock of destinations sits above the gesture bar, except in Settings, which Back leaves. Each
 * page heads itself.
 */
export function MobileShell() {
  const { t } = useI18n();
  const docked = useLocation().pathname !== "/settings";
  // The bars' icons follow Komori's theme here, and the book's in the Reader.
  const lightTheme = useAppearance().themeBase === "light";
  useEffect(() => systemBarIcons(lightTheme), [lightTheme]);
  return (
    <MobileHeaderContext.Provider value={MobilePageHeader}>
      <div className="mobile-shell">
        <main className="mobile-shell__content" id="main-content">
          <Outlet />
        </main>
        <nav className="mobile-dock" aria-label={t("shell.primaryNavigation")} hidden={!docked}>
          {navigationItems.map(({ icon: NavigationIcon, label, path }) => (
            <NavLink
              className={({ isActive }) =>
                isActive ? "mobile-dock__item mobile-dock__item--active" : "mobile-dock__item"
              }
              key={path}
              to={path}
            >
              <NavigationIcon aria-hidden="true" weight="duotone" />
              <span>{t(label)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </MobileHeaderContext.Provider>
  );
}

/** A page's heading on the phone: the brand, its title, Settings and its own actions. */
export function MobilePageHeader({ title, summary, actions, back = false }: MobileHeaderProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <header className="mobile-header">
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
        {summary}
      </div>
      {back ? null : (
        <Link aria-label={t("shell.settings")} className="mobile-round-button" to="/settings">
          <GearSixIcon aria-hidden="true" weight="duotone" />
        </Link>
      )}
      {actions}
    </header>
  );
}

/**
 * What the phone asks of every page: the safe area's insets, the keyboard's height, Android's
 * Back, and saving what is pending when Komori goes to the background, where Android may end
 * it without warning.
 */
export function MobileSystem() {
  useBackButton();
  useEffect(() => watchSafeArea(), []);
  useEffect(() => watchKeyboard(), []);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") void flushPendingWrites();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  return null;
}
