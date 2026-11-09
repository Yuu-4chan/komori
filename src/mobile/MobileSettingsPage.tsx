import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChartBarIcon,
  ArrowSquareOutIcon,
  BooksIcon,
  ChatTextIcon,
  GearSixIcon,
  GithubLogoIcon,
  InfoIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { version } from "../../package.json";
import { BrandMark } from "../brand/BrandMark";
import { Card } from "../components/ui/Card";
import { ToggleSetting } from "../components/ui/ToggleSetting";
import { ankiChanged, cachedAnki } from "../features/anki/ankiApi";
import { AnkiIcon } from "../features/anki/AnkiIcon";
import { AnkiSettings } from "../features/anki/AnkiSettings";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { AppThemeSettings } from "../features/appearance/AppThemeSettings";
import { DictionarySources } from "../features/dictionary/DictionarySources";
import { WordAudioSettings } from "../features/dictionary/WordAudioSettings";
import { LibraryFolders } from "../features/library/LibraryFolders";
import { openExternalLink } from "../features/dictionary/dictionaryApi";
import { ReaderPopupSettings } from "../features/reader/ReaderPopupSettings";
import { getStartupPreferences, saveStartupPreferences } from "../features/startup/startupApi";
import { StatisticsSettings } from "../features/statistics/StatisticsSettings";
import { sessionStartModes } from "../features/statistics/statisticsPreferences";
import { UpdateSetting } from "../features/updates/UpdateSetting";
import { useI18n } from "../i18n/i18n";
import { MobilePageHeader } from "./MobileShell";
import { MobileSyncSettings } from "./MobileSyncSettings";
import { usePcLink } from "./pcLinkApi";

const sections = [
  { id: "general", label: "settings.general", icon: GearSixIcon },
  { id: "library", label: "folders.cardTitle", icon: BooksIcon },
  { id: "popup", label: "settings.popup", icon: ChatTextIcon },
  { id: "dictionary", label: "settings.dictionary", icon: TranslateIcon },
  { id: "anki", label: "settings.anki", icon: AnkiIcon },
  { id: "statistics", label: "settings.statistics", icon: ChartBarIcon },
  { id: "sync", label: "settings.sync", icon: ArrowsClockwiseIcon },
  { id: "about", label: "settings.about", icon: InfoIcon },
] as const;

/**
 * Settings on the phone: a list of its sections, each opening as its own page that Back
 * leaves. General holds the interface language, the application theme and Restore last book;
 * Library, the book folders and Automatic series; Reader popup, the
 * lookup sheet's content, look, sources and scanning; Dictionary, the dictionaries and word
 * audio; Anki, AnkiDroid and the cards it gets; Statistics, whether and how the Reader counts
 * reading sessions; Sync, pairing with Komori PC and its dictionaries; About, the version and its
 * release date, updates and the project's page.
 */
export function MobileSettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    lookupLanguage,
    setLookupLanguage,
    starterDefinitions,
    setStarterDefinitions,
    statisticsEnabled,
    statisticsSessionStart,
  } = useAppearance();
  const section = sections.find(({ id }) => id === searchParams.get("section"));
  const deck = useAnkiDeck();
  const link = usePcLink();
  const details: Partial<Record<(typeof sections)[number]["id"], string>> = {
    anki: deck ? `AnkiDroid · ${deck}` : "AnkiDroid",
    statistics: statisticsEnabled
      ? t(
          sessionStartModes.find(({ value }) => value === statisticsSessionStart)?.label ??
            "statisticsSettings.startAuto",
        )
      : t("readingStatus.off"),
    sync: link?.paired ? (link.pcName ?? "") : t("sync.notPaired"),
  };

  if (!section)
    return (
      <div className="mobile-page mobile-settings">
        <MobilePageHeader back title={t("settings.title")} />
        <nav aria-label={t("settings.categories")} className="mobile-group">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              className="mobile-row"
              key={id}
              onClick={() => navigate(`/settings?section=${id}`)}
              type="button"
            >
              <span aria-hidden="true" className="mobile-row__icon">
                <Icon weight="fill" />
              </span>
              {details[id] !== undefined ? (
                <span className="mobile-row__text">
                  <span className="mobile-row__label">{t(label)}</span>
                  <span className="mobile-row__detail">{details[id]}</span>
                </span>
              ) : (
                <span className="mobile-row__label">{t(label)}</span>
              )}
              <CaretRightIcon aria-hidden="true" className="mobile-row__chevron" weight="bold" />
            </button>
          ))}
        </nav>
        <p className="mobile-settings__version">{t("settings.version", { version })}</p>
      </div>
    );

  return (
    <div className={`mobile-page mobile-settings mobile-settings--${section.id}`}>
      <MobilePageHeader back title={t(section.label)} />
      {section.id === "general" && (
        <>
          <AppThemeSettings />
          <GeneralChoices />
        </>
      )}
      {section.id === "library" && (
        <LibraryFolders>
          <SeriesFromTitles />
        </LibraryFolders>
      )}
      {section.id === "popup" && (
        <ReaderPopupSettings
          onDictionarySettings={() => navigate("/settings?section=dictionary")}
        />
      )}
      {section.id === "dictionary" && (
        <>
          <DictionarySources
            lookupLanguage={lookupLanguage}
            onLookupLanguageChange={setLookupLanguage}
            starterDefinitions={starterDefinitions}
            onStarterDefinitionsChange={setStarterDefinitions}
          />
          <WordAudioSettings />
        </>
      )}
      {section.id === "anki" && <AnkiSettings lookupLanguage={lookupLanguage} />}
      {section.id === "statistics" && <StatisticsSettings recorded={false} />}
      {section.id === "sync" && <MobileSyncSettings />}
      {section.id === "about" && <About />}
    </div>
  );
}

/** The project's page, where its releases, source and issues are. */
const PROJECT_PAGE = "https://github.com/Yuu-4chan/komori";

/**
 * About: Komori's mark, version and release date; Updates, which checks the releases and opens
 * a newer one's notes and installer, and whether Komori checks by itself at start; and the
 * project's page on GitHub, in the browser.
 */
function About() {
  const { t, date } = useI18n();
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getStartupPreferences().then(
      (saved) => {
        if (active) setAutomatic(saved.checkForUpdates);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  async function changeAutomatic(checkForUpdates: boolean) {
    setSaving(true);
    setAutomatic(checkForUpdates);
    try {
      setAutomatic((await saveStartupPreferences({ checkForUpdates })).checkForUpdates);
    } catch {
      setAutomatic(!checkForUpdates);
    } finally {
      setSaving(false);
    }
  }
  // The date of the commit this build was made from, which for a release is its version's.
  const releaseDate = import.meta.env.VITE_RELEASE_DATE as string | undefined;
  const released = releaseDate ? new Date(`${releaseDate}T00:00:00`) : null;
  return (
    <>
      <div className="mobile-about">
        <BrandMark className="mobile-about__brand" />
        <p className="mobile-about__version">{t("settings.version", { version })}</p>
        {released && !Number.isNaN(released.getTime()) ? (
          <p>{t("settings.released", { date: date(released, { dateStyle: "long" }) })}</p>
        ) : null}
      </div>
      <Card className="settings-card">
        <div className="settings-list">
          <UpdateSetting />
          <ToggleSetting
            checked={automatic ?? false}
            disabled={automatic === null || saving}
            label={t("startup.checkForUpdates")}
            onChange={(value) => void changeAutomatic(value)}
          />
        </div>
      </Card>
      <div className="mobile-group">
        <button
          className="mobile-row"
          onClick={() => void openExternalLink(PROJECT_PAGE).catch(() => {})}
          type="button"
        >
          <span aria-hidden="true" className="mobile-row__icon">
            <GithubLogoIcon weight="fill" />
          </span>
          <span className="mobile-row__text">
            <span className="mobile-row__label">GitHub</span>
            <span className="mobile-row__detail">github.com/Yuu-4chan/komori</span>
          </span>
          <ArrowSquareOutIcon aria-hidden="true" className="mobile-row__chevron" weight="bold" />
        </button>
      </div>
    </>
  );
}

/** The deck new cards go to, as saved. */
function useAnkiDeck() {
  const [deck, setDeck] = useState("");
  useEffect(() => {
    let active = true;
    const read = () =>
      cachedAnki().then(
        (preferences) => {
          if (active) setDeck(preferences.deck);
        },
        () => {},
      );
    void read();
    window.addEventListener(ankiChanged, read);
    return () => {
      active = false;
      window.removeEventListener(ankiChanged, read);
    };
  }, []);
  return deck;
}

/** Automatic series: whether numbered titles and file names name series. */
function SeriesFromTitles() {
  const { library, updateLibrary } = useAppearance();
  const { t } = useI18n();
  return (
    <ToggleSetting
      checked={library.seriesFromTitles}
      description={t("librarySettings.seriesFromTitlesHint")}
      label={t("librarySettings.seriesFromTitles")}
      onChange={(seriesFromTitles) => updateLibrary({ seriesFromTitles })}
    />
  );
}

/**
 * General's choice from the PC's: Restore last book, whether Komori opens on the book last
 * read (the native startup choice).
 */
function GeneralChoices() {
  const { t } = useI18n();
  // Null until the saved choice is read; it is the native one the app opens by.
  const [restore, setRestore] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getStartupPreferences().then(
      (saved) => {
        if (active) setRestore(saved.restoreLastBook);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  async function changeRestore(restoreLastBook: boolean) {
    setSaving(true);
    setRestore(restoreLastBook);
    try {
      setRestore((await saveStartupPreferences({ restoreLastBook })).restoreLastBook);
    } catch {
      setRestore(!restoreLastBook);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="settings-card">
      <div className="settings-list">
        <ToggleSetting
          checked={restore ?? false}
          disabled={restore === null || saving}
          label={t("startup.restoreLastBook")}
          onChange={(value) => void changeRestore(value)}
        />
      </div>
    </Card>
  );
}
