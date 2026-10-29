import { useSearchParams } from "react-router-dom";
import { useLayoutEffect, useRef } from "react";
import { AnkiSettings } from "../features/anki/AnkiSettings";
import { version } from "../../package.json";
import {
  CardsIcon,
  ChartBarIcon,
  ChatTextIcon,
  GearSixIcon,
  HardDrivesIcon,
  TranslateIcon,
  KeyboardIcon,
} from "@phosphor-icons/react";

import { PageHeader } from "../components/layout/PageHeader";
import { AppThemeSettings } from "../features/appearance/AppThemeSettings";
import { DictionarySources } from "../features/dictionary/DictionarySources";
import { DiscordIcon } from "../features/discord/DiscordIcon";
import { DiscordSettings } from "../features/discord/DiscordSettings";
import { WordAudioSettings } from "../features/dictionary/WordAudioSettings";
import { LibrarySettings } from "../features/library/LibrarySettings";
import { ReaderPopupSettings } from "../features/reader/ReaderPopupSettings";
import { StatisticsSettings } from "../features/statistics/StatisticsSettings";
import { StorageSettings } from "../features/storage/StorageSettings";
import { GeneralSettings } from "../features/startup/GeneralSettings";
import { ShortcutSettings } from "../features/reader/ShortcutSettings";
import { useI18n } from "../i18n/i18n";

const sections = [
  {
    id: "general",
    label: "settings.general",
    description: "settings.generalDescription",
    icon: GearSixIcon,
  },
  {
    id: "storage",
    label: "settings.storage",
    description: "settings.storageDescription",
    icon: HardDrivesIcon,
  },
  {
    id: "shortcuts",
    label: "settings.shortcuts",
    description: "settings.shortcutsDescription",
    icon: KeyboardIcon,
  },
  {
    id: "popup",
    label: "settings.popup",
    description: "settings.popupDescription",
    icon: ChatTextIcon,
  },
  {
    id: "dictionary",
    label: "settings.dictionary",
    description: "settings.dictionaryDescription",
    icon: TranslateIcon,
  },
  {
    id: "statistics",
    label: "settings.statistics",
    description: "settings.statisticsDescription",
    icon: ChartBarIcon,
  },
  {
    id: "anki",
    label: "settings.anki",
    description: "settings.ankiDescription",
    icon: CardsIcon,
  },
  {
    id: "discord",
    label: "settings.discord",
    description: "settings.discordDescription",
    icon: DiscordIcon,
  },
] as const;

type SectionId = (typeof sections)[number]["id"];

const groups = [
  { label: "settings.groupApplication", ids: ["general", "storage", "shortcuts"] },
  { label: "settings.groupReading", ids: ["popup", "dictionary", "statistics"] },
  { label: "settings.groupIntegrations", ids: ["anki", "discord"] },
] as const;

/** Categories that were folded into others still open where their settings now live. */
const movedSections: Record<string, SectionId> = {
  appearance: "general",
  library: "general",
  backup: "storage",
};

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, rich } = useI18n();
  const requested = searchParams.get("section") ?? "";
  const activeSection =
    sections.find(({ id }) => id === (movedSections[requested] ?? requested)) ?? sections[0];
  const section = activeSection.id;
  const headingRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  function revealSection() {
    // Compact layouts stack the categories above the section, so move past them; wider ones
    // bring the heading back only when the previous section left it scrolled away.
    headingRef.current?.scrollIntoView?.({
      block: window.innerWidth <= 960 ? "start" : "nearest",
    });
  }
  useLayoutEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    revealSection();
  }, [section]);
  // A short window scrolls the sticky categories; keep the chosen one in view there, including
  // a section opened by its URL.
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const active = sidebar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!sidebar || !active || sidebar.scrollHeight <= sidebar.clientHeight) return;
    const bounds = sidebar.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < bounds.top) sidebar.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) sidebar.scrollTop += item.bottom - bounds.bottom;
  }, [section]);
  function setSection(id: SectionId) {
    if (id === section) revealSection();
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("section", id);
      return next;
    });
  }
  const SectionIcon = activeSection.icon;
  return (
    <div className="page page--settings">
      <PageHeader title={t("settings.title")} description={t("settings.description")} />

      <div className="settings-layout">
        <div className="settings-sidebar" ref={sidebarRef}>
          <nav className="settings-navigation" aria-label={t("settings.categories")}>
            {groups.map((group) => (
              <div
                className="settings-navigation__group"
                key={group.label}
                role="group"
                aria-label={t(group.label)}
              >
                <div className="settings-navigation__items">
                  {sections
                    .filter(({ id }) => group.ids.some((candidate) => candidate === id))
                    .map(({ id, label, description, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        aria-label={t(label)}
                        aria-describedby={`settings-${id}-description`}
                        aria-current={section === id ? "page" : undefined}
                        onClick={() => setSection(id)}
                      >
                        <span className="settings-navigation__icon" aria-hidden="true">
                          <Icon size={18} weight="fill" />
                        </span>
                        <span>
                          <strong>{t(label)}</strong>
                          <small id={`settings-${id}-description`}>{t(description)}</small>
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </nav>
          <p className="settings-note">{t("settings.version", { version })}</p>
        </div>
        <div className="settings-content">
          <div className="settings-content__heading" ref={headingRef}>
            <span className="settings-card__icon">
              <SectionIcon aria-hidden="true" weight="duotone" />
            </span>
            <h2>{t("settings.sectionTitle", { section: t(activeSection.label) })}</h2>
          </div>
          {section === "general" && (
            <>
              <AppThemeSettings />
              <LibrarySettings />
              <GeneralSettings />
            </>
          )}
          {section === "storage" && <StorageSettings />}
          {section === "shortcuts" && <ShortcutSettings />}
          {section === "popup" && (
            <ReaderPopupSettings onDictionarySettings={() => setSection("dictionary")} />
          )}
          {section === "anki" && <AnkiSettings />}
          {section === "discord" && <DiscordSettings />}
          {section === "dictionary" && (
            <>
              <p className="settings-note">
                {rich("settings.dictionarySourcesNote", {
                  link: (
                    <button
                      className="settings-inline-link"
                      type="button"
                      onClick={() => setSection("popup")}
                    >
                      {t("settings.popupLink")}
                    </button>
                  ),
                })}
              </p>
              <DictionarySources />
              <WordAudioSettings />
            </>
          )}
          {section === "statistics" && <StatisticsSettings />}
        </div>
      </div>
    </div>
  );
}
