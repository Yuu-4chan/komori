import { isBackgroundBlurLevel } from "../reader/backgroundAppearance";
import { normalizeWordAudioSources, type WordAudioSource } from "../dictionary/wordAudio";
import { isReaderFontChoice, type ReaderFontChoice } from "../reader/fontChoices";
import { normalizeReaderFooter, type ReaderFooterPreferences } from "../reader/footerPreferences";
import { registerWindowFlush } from "../../app/windowLifecycle";
import {
  normalizeStatistics,
  type StatisticsPreferences,
} from "../statistics/statisticsPreferences";
import {
  isReaderSerifFont,
  isReaderSansFont,
  type ReaderSerifFont,
  type ReaderSansFont,
} from "../reader/fontFamilies";
import {
  normalizeSourceSelection,
  type SourceSelection,
  type SourceRole,
} from "../dictionary/sourcePolicy";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isLookupDimension,
  isLookupFontSize,
  isLookupPopupStyle,
  isLookupRadius,
  lookupPopupWidth,
  lookupPopupHeight,
  type LookupPopupStyle,
} from "../reader/lookupPopup";
import { normalizeLookupTriggers, type LookupTriggerPreferences } from "../reader/lookupTriggers";

import {
  isBlurMode,
  isFuriganaStyle,
  type ReaderFuriganaStyle,
  type ReaderBlurMode,
  normalizeFontSize,
  normalizeFontWeight,
  normalizeLetterSpacing,
  normalizeLineHeight,
  normalizeMaxHeight,
  normalizeParagraphIndent,
  normalizeParagraphMargin,
  normalizeSideMargin,
  normalizeMaxWidth,
  isPageLayout,
  isVnParagraphs,
  isVnTextSpeed,
  type ReaderPageLayout,
  normalizeTextOrientation,
  normalizeViewMode,
  normalizeWordSpacing,
  normalizeWritingMode,
  type ReaderTextOrientation,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "../reader/presentation";
import { normalizeWheelStep, isChapterWheelThreshold } from "../reader/navigationInput";
import {
  defaultReaderTheme,
  isPresetThemeId,
  isThemeColor,
  isThemeName,
  newCustomThemeId,
  newCustomThemeName,
  readerCustomThemeLimit,
  resolveReaderTheme,
  themeColors,
  type ReaderCustomTheme,
  type ReaderThemeColors,
} from "../reader/readerThemes";
import {
  isLibraryCardSize,
  type LibraryFilter,
  type LibraryGroup,
  type LibrarySort,
  type LibraryView,
} from "../library/libraryView";
import {
  appThemeTokens,
  normalizeAppCustomTheme,
  resolveAppAccent,
  resolveAppTheme,
  type AppThemeColors,
} from "./appThemes";
import {
  AppearancePreferencesSaver,
  defaultAppearance,
  defaultAppearanceStore,
  isAccentColor,
  isAppTheme,
  type AppearancePreferences,
  type AppearancePreferencesStore,
  type AppTheme,
} from "./appearancePreferences";

import {
  normalizePopupPalette,
  isReaderPopupTheme,
  type ReaderPopupTheme,
  type ReaderPopupPalette,
} from "../reader/popupThemes";

import { I18nProvider } from "../../i18n/i18n";
import { isInterfaceLanguage, type InterfaceLanguage } from "../../i18n/languages";
import { type AppIconId, isAppIcon } from "../../brand/appIcons";

export type { AppTheme } from "./appearancePreferences";

/** The Library's saved view choices. */
export interface LibraryDisplay {
  view: LibraryView;
  sort: LibrarySort;
  sortReversed: boolean;
  filter: LibraryFilter;
  group: LibraryGroup;
  cardSeries: boolean;
  cardLanguage: boolean;
  cardKanji: boolean;
  cardLastRead: boolean;
  /** The narrowest a grid card may be, in px. */
  cardSize: number;
}

interface AppearanceContextValue
  extends LookupTriggerPreferences, ReaderFooterPreferences, StatisticsPreferences {
  setReaderFooter: (patch: Partial<ReaderFooterPreferences>) => void;
  /** Saves valid statistics choices; invalid fields are ignored. */
  setStatistics: (patch: Partial<StatisticsPreferences>) => void;
  /** Applies the saved preferences again, as after a backup was restored. */
  reloadAppearance: () => Promise<void>;
  readerPopupDefinitionSources: SourceSelection;
  readerPopupFrequencySources: SourceSelection;
  readerPopupPitchSources: SourceSelection;
  setReaderPopupSources: (role: SourceRole, selection: SourceSelection) => void;
  setReaderPopupTriggers: (patch: Partial<LookupTriggerPreferences>) => void;
  readerPopupShowFrequency: boolean;
  setReaderPopupShowFrequency: (enabled: boolean) => void;
  readerPopupShowPitch: boolean;
  setReaderPopupShowPitch: (enabled: boolean) => void;
  readerPopupShowDictionaryNames: boolean;
  setReaderPopupShowDictionaryNames: (enabled: boolean) => void;
  readerPopupAnkiAction: boolean;
  setReaderPopupAnkiAction: (enabled: boolean) => void;
  readerPopupVoiceAction: boolean;
  setReaderPopupVoiceAction: (enabled: boolean) => void;
  readerPopupMouseSelection: boolean;
  setReaderPopupMouseSelection: (enabled: boolean) => void;
  readerPopupEnabled: boolean;
  setReaderPopupEnabled: (enabled: boolean) => void;
  readerPopupCustomPalette: ReaderPopupPalette;
  setReaderPopupCustomPalette: (palette: ReaderPopupPalette) => void;
  readerPopupRadius: number;
  setReaderPopupRadius: (radius: number) => void;
  readerPopupFontSize: number;
  setReaderPopupFontSize: (size: number) => void;
  readerPopupLineHeight: number;
  setReaderPopupLineHeight: (lineHeight: number) => void;
  readerPopupTheme: ReaderPopupTheme;
  setReaderPopupTheme: (theme: ReaderPopupTheme) => void;
  readerPopupWidth: number;
  readerPopupHeight: number;
  setReaderPopupWidth: (width: number) => void;
  setReaderPopupHeight: (height: number) => void;
  /** The popup's layout; the dictionary shows headwords and definitions only. */
  readerPopupStyle: LookupPopupStyle;
  setReaderPopupStyle: (style: LookupPopupStyle) => void;
  /** The font of the popup's headwords, readings and definitions. */
  readerPopupFont: ReaderFontChoice;
  setReaderPopupFont: (font: ReaderFontChoice) => void;
  /** The language of Komori's interface, applied at once without reloading anything. */
  interfaceLanguage: InterfaceLanguage;
  /** Chooses an interface language; anything else is ignored. */
  setInterfaceLanguage: (language: InterfaceLanguage) => void;
  /** The window and tray icon, applied natively when saved. */
  appIcon: AppIconId;
  setAppIcon: (icon: AppIconId) => void;
  accentColor: string;
  setAccentColor: (color: string) => void;
  /** Chooses an application theme; the accent stays as it is. */
  setTheme: (theme: AppTheme) => void;
  theme: AppTheme;
  /** Whether the shown application theme is light or dark. */
  themeBase: "light" | "dark";
  /** The colors of the application's custom theme. */
  appCustomTheme: AppThemeColors;
  /** Recolors the custom theme; invalid values are ignored. */
  updateAppCustomTheme: (patch: Partial<AppThemeColors>) => void;
  library: LibraryDisplay;
  updateLibrary: (patch: Partial<LibraryDisplay>) => void;
  /** How far one mouse wheel step scrolls a continuous book, in CSS pixels. */
  readerWheelStep: number;
  setReaderWheelStep: (step: number) => void;
  middleClickAutoscroll: boolean;
  setMiddleClickAutoscroll: (enabled: boolean) => void;
  readerChapterWheelThreshold: number;
  setReaderChapterWheelThreshold: (steps: number) => void;
  /** The Reader's base font size in CSS pixels. */
  readerFontSize: number;
  setReaderFontSize: (size: number) => void;
  /** The Reader's line height as a multiple of the font size. */
  readerLineHeight: number;
  setReaderLineHeight: (lineHeight: number) => void;
  /** The space added between characters and at word spaces in CSS pixels; 0 keeps the book's. */
  readerLetterSpacing: number;
  setReaderLetterSpacing: (spacing: number) => void;
  readerWordSpacing: number;
  setReaderWordSpacing: (spacing: number) => void;
  /** Ordered font choices for every reflowable book. */
  readerAsianFont: ReaderFontChoice;
  readerWesternFont: ReaderFontChoice;
  setReaderAsianFont: (font: ReaderFontChoice) => void;
  setReaderWesternFont: (font: ReaderFontChoice) => void;
  readerFontFamilyGroup1: ReaderSerifFont;
  setReaderFontFamilyGroup1: (font: ReaderSerifFont) => void;
  readerFontFamilyGroup2: ReaderSansFont;
  setReaderFontFamilyGroup2: (font: ReaderSansFont) => void;
  /** The weight of the Reader's normal text. */
  readerFontWeight: number;
  readerWesternFontWeight: number;
  readerAsianFontWeight: number;
  setReaderWesternFontWeight: (weight: number) => void;
  setReaderAsianFontWeight: (weight: number) => void;
  setReaderFontWeight: (weight: number) => void;
  /** The Reader's paragraph indentation in em. */
  readerParagraphIndent: number;
  setReaderParagraphIndent: (indent: number) => void;
  /** The space before and after the Reader's paragraphs in CSS pixels. */
  readerParagraphMargin: number;
  setReaderParagraphMargin: (margin: number) => void;
  /** The space left and right of each Reader page's text in CSS pixels. */
  readerPageMargin: number;
  setReaderPageMargin: (margin: number) => void;
  /** Maximum Reader text width per page in CSS pixels. */
  readerMaxWidth: number;
  setReaderMaxWidth: (margin: number) => void;
  /** The tallest the Reader's reading area may be, in CSS pixels. */
  readerMaxHeight: number;
  setReaderMaxHeight: (height: number) => void;
  /** The Reader's writing mode. */
  readerWritingMode: ReaderWritingMode;
  setReaderWritingMode: (mode: ReaderWritingMode) => void;
  /** How the Reader's vertical text stands. */
  readerTextOrientation: ReaderTextOrientation;
  setReaderTextOrientation: (orientation: ReaderTextOrientation) => void;
  /** Independent prose paragraph choices. Off preserves publisher composition. */
  readerTextJustification: boolean;
  setReaderTextJustification: (justify: boolean) => void;
  readerPrettyTextWrap: boolean;
  setReaderPrettyTextWrap: (pretty: boolean) => void;
  /** Whether the Reader hides every book's furigana (ruby annotations). */
  readerHideFurigana: boolean;
  setReaderHideFurigana: (hide: boolean) => void;
  readerFuriganaStyle: ReaderFuriganaStyle;
  setReaderFuriganaStyle: (style: ReaderFuriganaStyle) => void;
  /** Which book images blur while enabled. */
  readerBlurMode: ReaderBlurMode;
  setReaderBlurMode: (mode: ReaderBlurMode) => void;
  /** Whether book images blur within the selected scope. */
  readerBlurImage: boolean;
  readerBackgroundBlur: boolean;
  readerBackgroundBlurLevel: number;
  setReaderBackgroundBlurLevel: (level: number) => void;
  setReaderBackgroundBlur: (blur: boolean) => void;
  setReaderBlurImage: (blur: boolean) => void;
  /** Whether the Reader turns pages or scrolls continuously. */
  readerPageLayout: ReaderPageLayout;
  setReaderPageLayout: (layout: ReaderPageLayout) => void;
  readerViewMode: ReaderViewMode;
  readerVnParagraphs: number;
  setReaderVnParagraphs: (count: number) => void;
  readerVnTextSpeed: number;
  setReaderVnTextSpeed: (speed: number) => void;
  setReaderViewMode: (mode: ReaderViewMode) => void;
  /** Whether the Reader's sidebar is pinned beside the book rather than floating over it. */
  readerSidebarPinned: boolean;
  setReaderSidebarPinned: (pinned: boolean) => void;
  /** The Reader theme: a preset's ID or one of the custom themes'. */
  readerTheme: string;
  /** Chooses a preset or a kept custom theme; anything else is ignored. */
  setReaderTheme: (theme: string) => void;
  /** The Reader themes the reader created. */
  readerCustomThemes: ReaderCustomTheme[];
  /** Creates a custom theme from the chosen theme's colors and chooses it. */
  createReaderCustomTheme: () => void;
  /** Renames or recolors a custom theme; invalid values are ignored. */
  updateReaderCustomTheme: (id: string, patch: ReaderCustomThemePatch) => void;
  /** Deletes a custom theme; deleting the chosen one returns to Paper. */
  deleteReaderCustomTheme: (id: string) => void;
  wordAudioSources: WordAudioSource[];
  /** Saves the word audio sources in order; an invalid list is ignored. */
  setWordAudioSources: (sources: WordAudioSource[]) => void;
}

export type ReaderCustomThemePatch = Partial<ReaderThemeColors & { name: string }>;

type PreferencesPatch =
  | Partial<AppearancePreferences>
  | ((current: AppearancePreferences) => Partial<AppearancePreferences> | null);

function applyPatch(
  current: AppearancePreferences,
  patch: PreferencesPatch,
): AppearancePreferences {
  const next = typeof patch === "function" ? patch(current) : patch;
  return next ? { ...current, ...next } : current;
}

/** This computer's own defaults; one that cannot be read leaves the built-in defaults. */
function installDefaults(
  store: AppearancePreferencesStore,
): Promise<Partial<AppearancePreferences>> {
  return store.installDefaults?.().catch(() => ({})) ?? Promise.resolve({});
}

// Saved preferences normally load in milliseconds. A stalled load shows the defaults.
const LOAD_TIMEOUT_MS = 2000;

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({
  children,
  store,
}: {
  children: ReactNode;
  /** Where preferences are saved; the native store by default, none outside the app. */
  store?: AppearancePreferencesStore | null;
}) {
  const [preferencesStore] = useState(() =>
    store === undefined ? defaultAppearanceStore() : store,
  );
  const [saver] = useState(
    () => preferencesStore && new AppearancePreferencesSaver(preferencesStore),
  );
  const [preferences, setPreferences] = useState<AppearancePreferences>(defaultAppearance);
  // With a store, nothing renders until the saved preferences apply, so a saved theme
  // never flashes the default.
  const [loaded, setLoaded] = useState(!preferencesStore);
  const changed = useRef(false);
  // Until the saved record is seen, edits are kept so they can be replayed over it:
  // a write never replaces saved preferences with defaults the reader never saw.
  const savedSeen = useRef(!preferencesStore);
  const edits = useRef<PreferencesPatch[]>([]);
  const loading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => (saver ? registerWindowFlush(() => saver.flush()) : undefined), [saver]);

  const adoptSaved = useCallback(
    (saved: Partial<AppearancePreferences>, installed: Partial<AppearancePreferences>) => {
      savedSeen.current = true;
      const replayed = edits.current;
      edits.current = [];
      // Edits made over the shown defaults apply on top of the saved record, so a late
      // load never undoes them, and their write keeps every field they did not touch.
      setPreferences(replayed.reduce(applyPatch, { ...defaultAppearance, ...installed, ...saved }));
    },
    [],
  );

  const loadSaved = useCallback(() => {
    if (!preferencesStore || loading.current) return;
    loading.current = true;
    const done = () => {
      loading.current = false;
      setLoaded(true);
    };
    Promise.all([preferencesStore.load(), installDefaults(preferencesStore)]).then(
      ([saved, installed]) => {
        done();
        if (mounted.current && !savedSeen.current) adoptSaved(saved, installed);
      },
      done,
    );
  }, [preferencesStore, adoptSaved]);

  useEffect(() => {
    mounted.current = true;
    // A stalled load shows the defaults; it still applies whenever it arrives.
    const timeout = setTimeout(() => setLoaded(true), LOAD_TIMEOUT_MS);
    loadSaved();
    return () => {
      mounted.current = false;
      clearTimeout(timeout);
    };
  }, [loadSaved]);

  const update = useCallback((patch: PreferencesPatch) => {
    changed.current = true;
    if (!savedSeen.current) edits.current.push(patch);
    setPreferences((current) => applyPatch(current, patch));
  }, []);

  const reloadAppearance = useCallback(async () => {
    if (!preferencesStore) return;
    const [saved, installed] = await Promise.all([
      preferencesStore.load(),
      installDefaults(preferencesStore),
    ]);
    // What was saved replaces everything, without saving it again.
    changed.current = false;
    savedSeen.current = true;
    edits.current = [];
    setPreferences({ ...defaultAppearance, ...installed, ...saved });
  }, [preferencesStore]);

  useEffect(() => {
    if (!changed.current) return;
    // An edit before the saved record is known waits for it (loading again after a failure).
    if (savedSeen.current) saver?.save(preferences);
    else loadSaved();
  }, [preferences, saver, loadSaved]);

  const {
    readerPopupAnkiAction,
    readerPopupVoiceAction,
    readerPopupShowPitch,
    readerPopupShowFrequency,
    readerPopupShowDictionaryNames,
    readerPopupEnabled,
    readerPopupMouseSelection,
    readerPopupCustomPalette,
    readerPopupRadius,
    readerPopupFontSize,
    readerPopupLineHeight,
    readerPopupTheme,
    readerPopupWidth,
    readerPopupHeight,
    readerPopupStyle,
    readerPopupFont,
    interfaceLanguage,
    appIcon,
    theme,
    appCustomTheme,
    accentColor,
    libraryView,
    librarySort,
    librarySortReversed,
    libraryFilter,
    libraryCardSeries,
    libraryCardLanguage,
    libraryCardLastRead,
    libraryCardKanji,
    libraryGroup,
    libraryCardSize,
    readerWheelStep,
    middleClickAutoscroll,
    readerChapterWheelThreshold,
    readerFontSize,
    readerLineHeight,
    readerLetterSpacing,
    readerWordSpacing,
    readerAsianFont,
    readerWesternFont,
    readerFontFamilyGroup1,
    readerFontFamilyGroup2,
    readerFontWeight,
    readerWesternFontWeight,
    readerAsianFontWeight,
    readerParagraphIndent,
    readerParagraphMargin,
    readerPageMargin,
    readerMaxWidth,
    readerMaxHeight,
    readerWritingMode,
    readerTextOrientation,
    readerTextJustification,
    readerPrettyTextWrap,
    readerHideFurigana,
    readerFuriganaStyle,
    readerBlurImage,
    readerBackgroundBlur,
    readerBackgroundBlurLevel,
    readerBlurMode,
    readerPageLayout,
    readerViewMode,
    readerVnParagraphs,
    readerVnTextSpeed,
    readerSidebarPinned,
    readerTheme,
    readerCustomThemes,
    wordAudioSources,
  } = preferences;

  const shownTheme = useMemo(() => resolveAppTheme(theme, appCustomTheme), [theme, appCustomTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = shownTheme.base;
    root.dataset.appTheme = theme;
    root.style.colorScheme = shownTheme.base;
    for (const [name, value] of Object.entries(appThemeTokens(shownTheme))) {
      root.style.setProperty(name, value);
    }

    const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    metaTheme?.setAttribute("content", shownTheme.background);
  }, [theme, shownTheme]);

  // Presets bring their own accent; only the custom theme uses the saved one.
  const shownAccent = resolveAppAccent(theme, accentColor);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent-base", shownAccent);
  }, [shownAccent]);

  const value = useMemo(
    () => ({
      ...(normalizeReaderFooter(preferences) as ReaderFooterPreferences),
      setReaderFooter: (patch: Partial<ReaderFooterPreferences>) => {
        const valid = normalizeReaderFooter(patch);
        if (Object.keys(valid).length) update(valid);
      },
      reloadAppearance,
      ...(normalizeStatistics(preferences) as StatisticsPreferences),
      setStatistics: (patch: Partial<StatisticsPreferences>) => {
        const valid = normalizeStatistics(patch);
        if (Object.keys(valid).length) update(valid);
      },
      ...(normalizeLookupTriggers(preferences) as LookupTriggerPreferences),
      readerPopupDefinitionSources: preferences.readerPopupDefinitionSources,
      readerPopupFrequencySources: preferences.readerPopupFrequencySources,
      readerPopupPitchSources: preferences.readerPopupPitchSources,
      setReaderPopupSources: (role: SourceRole, selection: SourceSelection) => {
        const valid = normalizeSourceSelection(selection);
        const fields = {
          definitions: "readerPopupDefinitionSources",
          frequency: "readerPopupFrequencySources",
          pitch: "readerPopupPitchSources",
        } as const;
        if (valid && fields[role]) update({ [fields[role]]: valid });
      },
      setReaderPopupTriggers: (patch: Partial<LookupTriggerPreferences>) => {
        const valid = normalizeLookupTriggers(patch);
        if (Object.keys(valid).length) update(valid);
      },
      readerPopupShowFrequency,
      setReaderPopupShowFrequency: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupShowFrequency: enabled });
      },
      readerPopupShowPitch,
      setReaderPopupShowPitch: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupShowPitch: enabled });
      },
      readerPopupShowDictionaryNames,
      setReaderPopupShowDictionaryNames: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupShowDictionaryNames: enabled });
      },
      readerPopupAnkiAction,
      readerPopupVoiceAction,
      readerPopupEnabled,
      readerPopupMouseSelection,
      setReaderPopupAnkiAction: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupAnkiAction: enabled });
      },
      setReaderPopupVoiceAction: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupVoiceAction: enabled });
      },
      setReaderPopupMouseSelection: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupMouseSelection: enabled });
      },
      setReaderPopupEnabled: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ readerPopupEnabled: enabled });
      },
      readerPopupCustomPalette,
      setReaderPopupCustomPalette: (palette: ReaderPopupPalette) => {
        const valid = normalizePopupPalette(palette);
        if (valid) update({ readerPopupCustomPalette: valid });
      },
      readerPopupRadius,
      setReaderPopupRadius: (radius: number) => {
        if (isLookupRadius(radius)) update({ readerPopupRadius: radius });
      },
      readerPopupFontSize,
      setReaderPopupFontSize: (size: number) => {
        if (isLookupFontSize(size)) update({ readerPopupFontSize: size });
      },
      readerPopupLineHeight,
      setReaderPopupLineHeight: (lineHeight: number) => {
        if (Number.isFinite(lineHeight))
          update({ readerPopupLineHeight: normalizeLineHeight(lineHeight) });
      },
      readerPopupTheme,
      setReaderPopupTheme: (theme: ReaderPopupTheme) => {
        if (isReaderPopupTheme(theme)) update({ readerPopupTheme: theme });
      },
      readerPopupWidth,
      readerPopupHeight,
      setReaderPopupWidth: (width: number) => {
        if (isLookupDimension(width, lookupPopupWidth)) update({ readerPopupWidth: width });
      },
      setReaderPopupHeight: (height: number) => {
        if (isLookupDimension(height, lookupPopupHeight)) update({ readerPopupHeight: height });
      },
      readerPopupStyle,
      setReaderPopupStyle: (style: LookupPopupStyle) => {
        if (isLookupPopupStyle(style)) update({ readerPopupStyle: style });
      },
      readerPopupFont,
      setReaderPopupFont: (font: ReaderFontChoice) => {
        if (isReaderFontChoice(font)) update({ readerPopupFont: font });
      },
      interfaceLanguage,
      setInterfaceLanguage: (language: InterfaceLanguage) => {
        if (isInterfaceLanguage(language)) update({ interfaceLanguage: language });
      },
      appIcon,
      setAppIcon: (icon: AppIconId) => {
        if (isAppIcon(icon)) update({ appIcon: icon });
      },
      accentColor,
      setAccentColor: (color: string) => {
        if (isAccentColor(color)) update({ accentColor: color });
      },
      setTheme: (next: AppTheme) => {
        if (isAppTheme(next)) update({ theme: next });
      },
      theme,
      themeBase: shownTheme.base,
      appCustomTheme,
      updateAppCustomTheme: (patch: Partial<AppThemeColors>) =>
        update((current) => {
          const next = normalizeAppCustomTheme({ ...current.appCustomTheme, ...patch });
          return next ? { appCustomTheme: next } : null;
        }),
      library: {
        view: libraryView,
        sort: librarySort,
        sortReversed: librarySortReversed,
        filter: libraryFilter,
        group: libraryGroup,
        cardSeries: libraryCardSeries,
        cardLanguage: libraryCardLanguage,
        cardKanji: libraryCardKanji,
        cardLastRead: libraryCardLastRead,
        cardSize: libraryCardSize,
      },
      updateLibrary: (patch: Partial<LibraryDisplay>) =>
        update({
          ...(patch.view !== undefined && { libraryView: patch.view }),
          ...(patch.sort !== undefined && { librarySort: patch.sort }),
          ...(patch.sortReversed !== undefined && { librarySortReversed: patch.sortReversed }),
          ...(patch.filter !== undefined && { libraryFilter: patch.filter }),
          ...(patch.group !== undefined && { libraryGroup: patch.group }),
          ...(patch.cardKanji !== undefined && { libraryCardKanji: patch.cardKanji }),
          ...(patch.cardSeries !== undefined && { libraryCardSeries: patch.cardSeries }),
          ...(patch.cardLanguage !== undefined && { libraryCardLanguage: patch.cardLanguage }),
          ...(patch.cardLastRead !== undefined && { libraryCardLastRead: patch.cardLastRead }),
          ...(isLibraryCardSize(patch.cardSize) && { libraryCardSize: patch.cardSize }),
        }),
      readerWheelStep,
      setReaderWheelStep: (step: number) => update({ readerWheelStep: normalizeWheelStep(step) }),
      middleClickAutoscroll,
      setMiddleClickAutoscroll: (enabled: boolean) => {
        if (typeof enabled === "boolean") update({ middleClickAutoscroll: enabled });
      },
      readerChapterWheelThreshold,
      setReaderChapterWheelThreshold: (steps: number) => {
        if (isChapterWheelThreshold(steps)) update({ readerChapterWheelThreshold: steps });
      },
      readerFontSize,
      setReaderFontSize: (size: number) => update({ readerFontSize: normalizeFontSize(size) }),
      readerLineHeight,
      setReaderLineHeight: (lineHeight: number) =>
        update({ readerLineHeight: normalizeLineHeight(lineHeight) }),
      readerLetterSpacing,
      setReaderLetterSpacing: (spacing: number) =>
        update({ readerLetterSpacing: normalizeLetterSpacing(spacing) }),
      readerWordSpacing,
      setReaderWordSpacing: (spacing: number) =>
        update({ readerWordSpacing: normalizeWordSpacing(spacing) }),
      readerAsianFont,
      readerWesternFont,
      setReaderAsianFont: (font: ReaderFontChoice) => {
        if (isReaderFontChoice(font)) update({ readerAsianFont: font });
      },
      setReaderWesternFont: (font: ReaderFontChoice) => {
        if (isReaderFontChoice(font)) update({ readerWesternFont: font });
      },
      readerFontFamilyGroup1,
      readerFontFamilyGroup2,
      readerFontWeight,
      readerWesternFontWeight,
      readerAsianFontWeight,
      setReaderWesternFontWeight: (weight: number) => {
        if (Number.isInteger(weight) && weight >= 1 && weight <= 1000)
          update({ readerWesternFontWeight: weight });
      },
      setReaderAsianFontWeight: (weight: number) => {
        if (Number.isInteger(weight) && weight >= 1 && weight <= 1000)
          update({ readerAsianFontWeight: weight });
      },
      setReaderFontFamilyGroup1: (font: ReaderSerifFont) => {
        if (isReaderSerifFont(font))
          update({ readerFontFamilyGroup1: font, readerAsianFont: { source: "preset", id: font } });
      },
      setReaderFontFamilyGroup2: (font: ReaderSansFont) => {
        if (isReaderSansFont(font))
          update({
            readerFontFamilyGroup2: font,
            readerWesternFont: { source: "preset", id: font },
          });
      },
      setReaderFontWeight: (weight: number) =>
        update({
          readerFontWeight: normalizeFontWeight(weight),
          readerWesternFontWeight: normalizeFontWeight(weight),
          readerAsianFontWeight: normalizeFontWeight(weight),
        }),
      readerParagraphIndent,
      setReaderParagraphIndent: (indent: number) =>
        update({ readerParagraphIndent: normalizeParagraphIndent(indent) }),
      readerParagraphMargin,
      setReaderParagraphMargin: (margin: number) =>
        update({ readerParagraphMargin: normalizeParagraphMargin(margin) }),
      readerPageMargin,
      setReaderPageMargin: (margin: number) =>
        update({ readerPageMargin: normalizeSideMargin(margin) }),
      readerMaxWidth,
      setReaderMaxWidth: (margin: number) => update({ readerMaxWidth: normalizeMaxWidth(margin) }),
      readerMaxHeight,
      setReaderMaxHeight: (height: number) =>
        update({ readerMaxHeight: normalizeMaxHeight(height) }),
      readerWritingMode,
      setReaderWritingMode: (mode: ReaderWritingMode) =>
        update({ readerWritingMode: normalizeWritingMode(mode) }),
      readerTextOrientation,
      setReaderTextOrientation: (orientation: ReaderTextOrientation) =>
        update({ readerTextOrientation: normalizeTextOrientation(orientation) }),
      readerTextJustification,
      readerPrettyTextWrap,
      readerHideFurigana,
      readerFuriganaStyle,
      setReaderFuriganaStyle: (style: ReaderFuriganaStyle) => {
        if (isFuriganaStyle(style)) update({ readerFuriganaStyle: style });
      },
      setReaderTextJustification: (justify: boolean) => {
        if (typeof justify === "boolean") update({ readerTextJustification: justify });
      },
      setReaderPrettyTextWrap: (pretty: boolean) => {
        if (typeof pretty === "boolean") update({ readerPrettyTextWrap: pretty });
      },
      setReaderHideFurigana: (hide: boolean) => update({ readerHideFurigana: hide === true }),
      readerBlurImage,
      readerBackgroundBlur,
      readerBackgroundBlurLevel,
      readerBlurMode,
      setReaderBlurMode: (mode: ReaderBlurMode) => {
        if (isBlurMode(mode)) update({ readerBlurMode: mode });
      },
      setReaderBackgroundBlurLevel: (level: number) => {
        if (isBackgroundBlurLevel(level)) update({ readerBackgroundBlurLevel: level });
      },
      setReaderBackgroundBlur: (blur: boolean) => {
        if (typeof blur === "boolean") update({ readerBackgroundBlur: blur });
      },
      setReaderBlurImage: (blur: boolean) => update({ readerBlurImage: blur === true }),
      readerPageLayout,
      setReaderPageLayout: (layout: ReaderPageLayout) => {
        if (isPageLayout(layout)) update({ readerPageLayout: layout });
      },
      readerViewMode,
      readerVnParagraphs,
      setReaderVnParagraphs: (count: number) => {
        if (isVnParagraphs(count)) update({ readerVnParagraphs: count });
      },
      readerVnTextSpeed,
      setReaderVnTextSpeed: (speed: number) => {
        if (isVnTextSpeed(speed)) update({ readerVnTextSpeed: speed });
      },
      setReaderViewMode: (mode: ReaderViewMode) =>
        update({ readerViewMode: normalizeViewMode(mode) }),
      readerSidebarPinned,
      setReaderSidebarPinned: (pinned: boolean) => update({ readerSidebarPinned: pinned === true }),
      readerTheme,
      setReaderTheme: (theme: string) =>
        update((current) =>
          isPresetThemeId(theme) || current.readerCustomThemes.some((custom) => custom.id === theme)
            ? { readerTheme: theme }
            : null,
        ),
      readerCustomThemes,
      wordAudioSources,
      setWordAudioSources: (sources: WordAudioSource[]) => {
        const valid = normalizeWordAudioSources(sources);
        if (valid) update({ wordAudioSources: valid });
      },
      createReaderCustomTheme: () =>
        update((current) => {
          if (current.readerCustomThemes.length >= readerCustomThemeLimit) return null;
          const shown = resolveReaderTheme(current.readerTheme, current.readerCustomThemes);
          const theme: ReaderCustomTheme = {
            id: newCustomThemeId(),
            name: newCustomThemeName(current.readerCustomThemes),
            ...themeColors(shown),
          };
          return {
            readerTheme: theme.id,
            readerCustomThemes: [...current.readerCustomThemes, theme],
          };
        }),
      updateReaderCustomTheme: (id: string, patch: ReaderCustomThemePatch) =>
        update((current) => {
          const valid = validThemePatch(patch);
          if (!Object.keys(valid).length) return null;
          return {
            readerCustomThemes: current.readerCustomThemes.map((theme) =>
              theme.id === id ? { ...theme, ...valid } : theme,
            ),
          };
        }),
      deleteReaderCustomTheme: (id: string) =>
        update((current) =>
          current.readerCustomThemes.some((theme) => theme.id === id)
            ? {
                readerCustomThemes: current.readerCustomThemes.filter((theme) => theme.id !== id),
                ...(current.readerTheme === id && { readerTheme: defaultReaderTheme }),
              }
            : null,
        ),
    }),
    [
      preferences,
      preferences.readerPopupDefinitionSources,
      preferences.readerPopupFrequencySources,
      preferences.readerPopupPitchSources,
      readerPopupShowDictionaryNames,
      readerPopupShowPitch,
      readerPopupAnkiAction,
      readerPopupVoiceAction,
      readerPopupShowFrequency,
      readerPopupEnabled,
      readerPopupMouseSelection,
      readerPopupCustomPalette,
      readerPopupRadius,
      readerPopupFontSize,
      readerPopupLineHeight,
      readerPopupTheme,
      readerPopupWidth,
      readerPopupHeight,
      readerPopupStyle,
      readerPopupFont,
      interfaceLanguage,
      appIcon,
      accentColor,
      theme,
      shownTheme,
      appCustomTheme,
      libraryView,
      librarySort,
      librarySortReversed,
      libraryFilter,
      libraryCardSeries,
      libraryCardLanguage,
      libraryCardLastRead,
      readerWheelStep,
      middleClickAutoscroll,
      readerChapterWheelThreshold,
      readerFontSize,
      readerLineHeight,
      readerLetterSpacing,
      readerWordSpacing,
      readerAsianFont,
      readerWesternFont,
      readerFontFamilyGroup1,
      readerFontFamilyGroup2,
      readerFontWeight,
      readerWesternFontWeight,
      readerAsianFontWeight,
      readerParagraphIndent,
      readerParagraphMargin,
      readerPageMargin,
      readerMaxWidth,
      readerMaxHeight,
      readerWritingMode,
      readerTextOrientation,
      readerTextJustification,
      readerPrettyTextWrap,
      readerHideFurigana,
      readerBlurImage,
      readerFuriganaStyle,
      readerBackgroundBlur,
      readerBackgroundBlurLevel,
      readerBlurMode,
      readerPageLayout,
      readerViewMode,
      readerVnParagraphs,
      readerVnTextSpeed,
      readerSidebarPinned,
      readerTheme,
      readerCustomThemes,
      wordAudioSources,
      reloadAppearance,
      update,
    ],
  );

  // The language is set before the first paint, so fonts and line breaking match it at once.
  useLayoutEffect(() => {
    document.documentElement.lang = interfaceLanguage;
  }, [interfaceLanguage]);

  return (
    <AppearanceContext.Provider value={value}>
      <I18nProvider language={interfaceLanguage}>{loaded ? children : null}</I18nProvider>
    </AppearanceContext.Provider>
  );
}

/** The valid fields of a custom theme change, colors in lowercase. */
function validThemePatch(patch: ReaderCustomThemePatch): ReaderCustomThemePatch {
  const valid: ReaderCustomThemePatch = {};
  if (isThemeName(patch.name)) valid.name = patch.name;
  for (const key of ["background", "text", "highlight", "selection", "footerText"] as const) {
    const color = patch[key];
    if (isThemeColor(color)) valid[key] = color.toLowerCase();
  }
  return valid;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);

  if (!context) {
    throw new Error("useAppearance must be used within AppearanceProvider");
  }

  return context;
}
