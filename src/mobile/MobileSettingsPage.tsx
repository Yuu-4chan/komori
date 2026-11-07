import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChartBarIcon,
  ChatTextIcon,
  GearSixIcon,
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
import { ReaderPopupSettings } from "../features/reader/ReaderPopupSettings";
import { getStartupPreferences, saveStartupPreferences } from "../features/startup/startupApi";
import { StatisticsSettings } from "../features/statistics/StatisticsSettings";
import { sessionStartModes } from "../features/statistics/statisticsPreferences";
import { useI18n } from "../i18n/i18n";
import { MobilePageHeader } from "./MobileShell";
import { MobileSyncSettings } from "./MobileSyncSettings";
import { usePcLink } from "./pcLinkApi";

const sections = [
  { id: "general", label: "settings.general", icon: GearSixIcon },
  { id: "popup", label: "settings.popup", icon: ChatTextIcon },
  { id: "dictionary", label: "settings.dictionary", icon: TranslateIcon },
  { id: "anki", label: "settings.anki", icon: AnkiIcon },
  { id: "statistics", label: "settings.statistics", icon: ChartBarIcon },
  { id: "sync", label: "settings.sync", icon: ArrowsClockwiseIcon },
  { id: "about", label: "settings.about", icon: InfoIcon },
] as const;

/**
 * Settings on the phone: a list of its sections, each opening as its own page that Back
 * leaves. General holds the interface language and the application theme; Reader popup, the
 * lookup sheet's content, look, sources and scanning; Dictionary, the dictionaries and word
 * audio; Anki, AnkiDroid and the cards it gets; Statistics, whether and how the Reader counts
 * reading sessions; Sync, pairing with Komori PC and its dictionaries; About, the version.
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
      {section.id === "about" && (
        <div className="mobile-about">
          <BrandMark className="mobile-about__brand" />
          <p>{t("settings.version", { version })}</p>
        </div>
      )}
    </div>
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

/**
 * General's choices from the PC's: Restore last book (whether Komori opens on the book last
 * read, the native startup choice) and Automatic series (whether numbered titles and file names
 * name series).
 */
function GeneralChoices() {
  const { library, updateLibrary } = useAppearance();
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
        <ToggleSetting
          checked={library.seriesFromTitles}
          description={t("librarySettings.seriesFromTitlesHint")}
          label={t("librarySettings.seriesFromTitles")}
          onChange={(seriesFromTitles) => updateLibrary({ seriesFromTitles })}
        />
      </div>
    </Card>
  );
}
