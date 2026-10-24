import { GearSixIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { navigationItems } from "../../app/navigation";
import { BrandMark } from "../../brand/BrandMark";
import { LibraryImportContext, useLibraryImport } from "../../features/library/libraryImport";
import { ShellSearchSlot } from "./shellSlots";
import { WindowControls } from "./WindowControls";
import { shortcutCommand } from "../../features/reader/shortcuts";
import { AutoscrollController, scrollableAncestor } from "../../app/autoscroll";
import { useAppearance } from "../../features/appearance/AppearanceProvider";
import { useI18n } from "../../i18n/i18n";
import type { DiscordPage } from "../../features/discord/discordApi";
import { useDiscordBrowsing } from "../../features/discord/useDiscordPresence";

const discordPages: Record<string, DiscordPage> = {
  "/": "library",
  "/library": "library",
  "/dictionary": "dictionary",
  "/statistics": "statistics",
  "/settings": "settings",
};

/**
 * The application frame. Its top bar is the window's title bar: it drags the window, holds the
 * brand, the Library's search with Settings and Add books beside it (on the Library only), and
 * the window controls, and its controls float over the page once it scrolls. Below it the page
 * scrolls, and a floating dock of destinations sits at the bottom, the current one larger.
 */
export function AppShell() {
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const { pathname, key: routeKey } = useLocation();
  const navigate = useNavigate();
  const imports = useLibraryImport();
  const onLibrary = pathname === "/library" || pathname === "/";
  const { middleClickAutoscroll } = useAppearance();
  const { t } = useI18n();
  useDiscordBrowsing(discordPages[pathname] ?? null);

  useEffect(() => {
    if (!onLibrary || !middleClickAutoscroll) return;
    const controller = new AutoscrollController(document, (event) => {
      const boundary = contentRef.current;
      if (
        !boundary ||
        !boundary.contains(event.target as Node) ||
        document.querySelector('dialog[open], [role="menu"]')
      )
        return null;
      const target = scrollableAncestor(event.target as Element, boundary);
      return { axes: "both", move: (x, y) => target.scrollBy(x, y) };
    });
    controller.addDocument(document);
    return () => controller.dispose();
  }, [onLibrary, routeKey, middleClickAutoscroll]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        document.querySelector("dialog[open]") ||
        (event.target as Element | null)?.closest?.(
          '[role="menu"], [role="listbox"], [role="dialog"]',
        )
      )
        return;
      const command = shortcutCommand(event, "Application pages");
      const destination = {
        library: "/library",
        dictionary: "/dictionary",
        statistics: "/statistics",
        settings: "/settings",
      }[command as "library" | "dictionary" | "statistics" | "settings"];
      if (!destination || (command === "library" && onLibrary)) return;
      event.preventDefault();
      if (pathname !== destination) navigate(destination);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [navigate, onLibrary, pathname]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const update = () => setScrolled(content.scrollTop > 4);
    update();
    content.addEventListener("scroll", update, { passive: true });
    return () => content.removeEventListener("scroll", update);
  }, [pathname]);

  return (
    <LibraryImportContext.Provider value={imports}>
      <div className="app-shell">
        <header
          className={scrolled ? "app-topbar app-topbar--floating" : "app-topbar"}
          data-tauri-drag-region="deep"
        >
          <NavLink className="app-topbar__brand" to="/library" aria-label={t("shell.brand")}>
            <BrandMark />
          </NavLink>
          <div className="app-topbar__center">
            <div className="app-topbar__search" ref={setSearchSlot} />
            {onLibrary ? (
              <>
                <NavLink
                  aria-label={t("shell.settings")}
                  className="app-topbar__button"
                  title={t("shell.settings")}
                  to="/settings"
                >
                  <GearSixIcon aria-hidden="true" weight="duotone" />
                </NavLink>
                <button
                  aria-label={imports.busy ? imports.label : t("shell.addBooks")}
                  className="app-topbar__button"
                  disabled={imports.busy}
                  onClick={() => void imports.run()}
                  title={imports.busy ? imports.label : t("shell.addBooks")}
                  type="button"
                >
                  <PlusIcon aria-hidden="true" weight="bold" />
                </button>
              </>
            ) : null}
          </div>
          <WindowControls className="app-topbar__window" />
        </header>

        <main className="app-shell__content" id="main-content" ref={contentRef}>
          <ShellSearchSlot.Provider value={searchSlot}>
            <Outlet />
          </ShellSearchSlot.Provider>
        </main>

        <nav className="app-dock" aria-label={t("shell.primaryNavigation")}>
          {navigationItems.map(({ icon: NavigationIcon, label, path }) => (
            <NavLink
              key={path}
              className={({ isActive }) =>
                ["app-dock__item", isActive ? "app-dock__item--active" : ""]
                  .filter(Boolean)
                  .join(" ")
              }
              to={path}
            >
              <NavigationIcon aria-hidden="true" weight="duotone" />
              <span>{t(label)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </LibraryImportContext.Provider>
  );
}
