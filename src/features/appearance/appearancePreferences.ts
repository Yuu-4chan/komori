import { type AppIconId, defaultAppIcon, isAppIcon } from "../../brand/appIcons";
import {
  defaultWordAudioSources,
  normalizeWordAudioSources,
  type WordAudioSource,
} from "../dictionary/wordAudio";
import { backgroundBlurLevel, isBackgroundBlurLevel } from "../reader/backgroundAppearance";
import {
  defaultAsianFont,
  defaultPopupFont,
  defaultWesternFont,
  isReaderFontChoice,
  normalizeFontChoice,
  type ReaderFontChoice,
} from "../reader/fontChoices";
import { isFaceWeight } from "../reader/fontWeights";
import {
  defaultReaderFooter,
  normalizeReaderFooter,
  type ReaderFooterPreferences,
} from "../reader/footerPreferences";
import {
  defaultStatistics,
  normalizeStatistics,
  type StatisticsPreferences,
} from "../statistics/statisticsPreferences";
import {
  defaultReaderSerifFont,
  defaultReaderSansFont,
  isReaderSerifFont,
  isReaderSansFont,
  type ReaderSerifFont,
  type ReaderSansFont,
} from "../reader/fontFamilies";
import {
  allSources,
  normalizeSourceSelection,
  type SourceSelection,
} from "../dictionary/sourcePolicy";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  defaultInterfaceLanguage,
  isInterfaceLanguage,
  type InterfaceLanguage,
} from "../../i18n/languages";
import {
  isLookupDimension,
  isLookupFontSize,
  isLookupPopupStyle,
  isLookupRadius,
  lookupPopupFontSize,
  lookupPopupLineHeight,
  lookupPopupRadius,
  lookupPopupWidth,
  lookupPopupHeight,
  lookupPopupSize,
  type LookupPopupStyle,
} from "../reader/lookupPopup";

import {
  isBlurMode,
  isFuriganaStyle,
  type ReaderFuriganaStyle,
  type ReaderBlurMode,
  isFontWeight,
  isLetterSpacing,
  isLineHeight,
  isMaxHeight,
  isParagraphIndent,
  isParagraphMargin,
  isMaxWidth,
  isPageLayout,
  legacyTextWidth,
  normalizeMaxHeight,
  normalizeMaxWidth,
  type ReaderPageLayout,
  isTextOrientation,
  isViewMode,
  isVnParagraphs,
  isVnTextSpeed,
  readerVnParagraphs,
  readerVnTextSpeed,
  isWordSpacing,
  isWritingMode,
  defaultTextOrientation,
  defaultWritingMode,
  readerFontSize,
  readerFontWeight,
  readerLetterSpacing,
  readerLineHeight,
  readerMaxHeight,
  readerParagraphIndent,
  readerParagraphMargin,
  readerMaxWidth,
  readerWordSpacing,
  type ReaderTextOrientation,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "../reader/presentation";
import {
  isWheelStep,
  readerWheelStep,
  isChapterWheelThreshold,
  readerChapterWheelThreshold,
} from "../reader/navigationInput";
import {
  defaultReaderTheme,
  isCustomThemeId,
  isReaderThemeId,
  normalizeCustomThemes,
  type ReaderCustomTheme,
} from "../reader/readerThemes";
import {
  isLibraryCardSize,
  isLibraryFilter,
  isLibraryGroup,
  isLibrarySort,
  isLibraryView,
  libraryCardSize,
  type LibraryFilter,
  type LibraryGroup,
  type LibrarySort,
  type LibraryView,
} from "../library/libraryView";
import {
  defaultAppCustomTheme,
  defaultAppTheme,
  isAppThemeId,
  normalizeAppCustomTheme,
  type AppThemeColors,
  type AppThemeId,
} from "./appThemes";

import {
  defaultPopupPalette,
  normalizePopupPalette,
  isReaderPopupTheme,
  type ReaderPopupTheme,
  type ReaderPopupPalette,
} from "../reader/popupThemes";

export type AppTheme = AppThemeId;

import {
  defaultLookupTriggers,
  normalizeLookupTriggers,
  type LookupTriggerPreferences,
} from "../reader/lookupTriggers";

export interface AppearancePreferences
  extends LookupTriggerPreferences, ReaderFooterPreferences, StatisticsPreferences {
  readerPopupPitchSources: SourceSelection;
  readerPopupFrequencySources: SourceSelection;
  readerPopupDefinitionSources: SourceSelection;
  readerPopupEnabled: boolean;
  readerPopupMouseSelection: boolean;
  readerPopupAnkiAction: boolean;
  readerPopupVoiceAction: boolean;
  readerPopupShowDictionaryNames: boolean;
  readerPopupShowPitch: boolean;
  readerPopupShowFrequency: boolean;
  readerPopupCustomPalette: ReaderPopupPalette;
  readerPopupRadius: number;
  /** The popup's definition text size in pixels; the rest of its content scales with it. */
  readerPopupFontSize: number;
  /** The line height of the popup's definitions. */
  readerPopupLineHeight: number;
  readerPopupTheme: ReaderPopupTheme;
  readerPopupWidth: number;
  readerPopupHeight: number;
  /** The popup's layout: the full entry, or the experimental dictionary. */
  readerPopupStyle: LookupPopupStyle;
  /** The font of the popup's headwords, readings and definitions. */
  readerPopupFont: ReaderFontChoice;
  /** The language of Komori's own interface; books and dictionaries keep theirs. */
  interfaceLanguage: InterfaceLanguage;
  /** The window and tray icon; the executable keeps the default. */
  appIcon: AppIconId;
  /** The application theme: a preset's ID or "custom". */
  theme: AppTheme;
  /** The colors of the application's custom theme. */
  appCustomTheme: AppThemeColors;
  accentColor: string;
  /** Whether the Library shows books as a grid or a list. */
  libraryView: LibraryView;
  librarySort: LibrarySort;
  librarySortReversed: boolean;
  /** The Library's reading-status filter. */
  libraryFilter: LibraryFilter;
  /** Optional details the Library's book cards show. */
  libraryCardSeries: boolean;
  libraryCardLanguage: boolean;
  libraryCardLastRead: boolean;
  /** Distinct kanji under the cover, for books Komori counted. */
  libraryCardKanji: boolean;
  /** Headed groups of books in the Library: none, by series, or by language. */
  libraryGroup: LibraryGroup;
  /** The narrowest a Library grid card may be, in px. */
  libraryCardSize: number;
  /** How far one mouse wheel step scrolls a continuous book, in CSS pixels. */
  readerWheelStep: number;
  middleClickAutoscroll: boolean;
  readerChapterWheelThreshold: number;
  /** The Reader's base font size in CSS pixels. */
  readerFontSize: number;
  /** The Reader's line height as a multiple of the font size. */
  readerLineHeight: number;
  /** The space added between characters and at word spaces, in CSS pixels; 0 keeps the book's. */
  readerLetterSpacing: number;
  readerWordSpacing: number;
  /** Ordered font choices for every reflowable book. */
  readerAsianFont: ReaderFontChoice;
  readerWesternFont: ReaderFontChoice;
  readerFontFamilyGroup1: ReaderSerifFont;
  readerFontFamilyGroup2: ReaderSansFont;
  /** The weight of the Reader's normal text. */
  readerFontWeight: number;
  readerWesternFontWeight: number;
  readerAsianFontWeight: number;
  /** The Reader's paragraph indentation in em. */
  readerParagraphIndent: number;
  /** The space before and after the Reader's paragraphs in CSS pixels. */
  readerParagraphMargin: number;
  /** Maximum Reader text width per page in CSS pixels. */
  readerMaxWidth: number;
  /** The tallest the Reader's reading area may be, in CSS pixels. */
  readerMaxHeight: number;
  /** The Reader's writing mode. */
  readerWritingMode: ReaderWritingMode;
  /** How the Reader's vertical text stands. */
  readerTextOrientation: ReaderTextOrientation;
  /** Independent prose paragraph choices. Off preserves publisher composition. */
  readerTextJustification: boolean;
  readerPrettyTextWrap: boolean;
  /** Whether the Reader hides every book's furigana (ruby annotations). */
  readerHideFurigana: boolean;
  readerFuriganaStyle: ReaderFuriganaStyle;
  /** Whether the Reader blurs every book's images. */
  readerBlurImage: boolean;
  readerBackgroundBlur: boolean;
  readerBackgroundBlurLevel: number;
  readerBlurMode: ReaderBlurMode;
  /** Pages shown per paginated turn. */
  readerPageLayout: ReaderPageLayout;
  /** Whether the Reader turns pages or scrolls continuously. */
  readerViewMode: ReaderViewMode;
  readerVnParagraphs: number;
  readerVnTextSpeed: number;
  /** Whether the Reader's sidebar is pinned beside the book rather than floating over it. */
  readerSidebarPinned: boolean;
  /** The Reader theme: a preset's ID or one of the custom themes'. */
  readerTheme: string;
  /** The Reader themes the reader created, in the order they were created. */
  readerCustomThemes: ReaderCustomTheme[];
  /** Where Voice and Anki's {{audio}} get recordings, in the order they are tried. */
  wordAudioSources: WordAudioSource[];
}

/** The defaults, which apply to every book until the reader changes them. */
export const defaultAppearance: AppearancePreferences = {
  ...defaultReaderFooter,
  ...defaultStatistics,
  ...defaultLookupTriggers,
  readerPopupPitchSources: allSources,
  readerPopupFrequencySources: allSources,
  readerPopupDefinitionSources: allSources,
  readerPopupEnabled: true,
  readerPopupMouseSelection: defaultLookupTriggers.readerPopupMouseSelection,
  readerPopupAnkiAction: true,
  readerPopupVoiceAction: true,
  readerPopupShowDictionaryNames: true,
  readerPopupShowPitch: true,
  readerPopupShowFrequency: true,
  readerPopupCustomPalette: defaultPopupPalette,
  readerPopupRadius: lookupPopupRadius.default,
  readerPopupFontSize: lookupPopupFontSize.default,
  readerPopupLineHeight: lookupPopupLineHeight.default,
  readerPopupTheme: "application",
  readerPopupWidth: lookupPopupSize.width,
  readerPopupHeight: lookupPopupSize.height,
  readerPopupStyle: "standard",
  readerPopupFont: defaultPopupFont,
  interfaceLanguage: defaultInterfaceLanguage,
  appIcon: defaultAppIcon,
  theme: defaultAppTheme,
  appCustomTheme: defaultAppCustomTheme,
  accentColor: "#b8743c",
  libraryView: "grid",
  librarySort: "title",
  librarySortReversed: false,
  libraryFilter: "all",
  libraryCardSeries: true,
  libraryCardLanguage: true,
  libraryCardLastRead: true,
  libraryCardKanji: true,
  libraryGroup: "none",
  libraryCardSize: libraryCardSize.default,
  readerWheelStep: readerWheelStep.default,
  middleClickAutoscroll: true,
  readerChapterWheelThreshold: readerChapterWheelThreshold.default,
  readerFontSize: readerFontSize.default,
  readerLineHeight: readerLineHeight.default,
  readerLetterSpacing: readerLetterSpacing.default,
  readerWordSpacing: readerWordSpacing.default,
  readerAsianFont: defaultAsianFont,
  readerWesternFont: defaultWesternFont,
  readerFontFamilyGroup1: defaultReaderSerifFont,
  readerFontFamilyGroup2: defaultReaderSansFont,
  readerFontWeight: readerFontWeight.default,
  readerWesternFontWeight: readerFontWeight.default,
  readerAsianFontWeight: readerFontWeight.default,
  readerParagraphIndent: readerParagraphIndent.default,
  readerParagraphMargin: readerParagraphMargin.default,
  readerMaxWidth: readerMaxWidth.default,
  readerMaxHeight: readerMaxHeight.default,
  readerWritingMode: defaultWritingMode,
  readerTextOrientation: defaultTextOrientation,
  readerTextJustification: false,
  readerPrettyTextWrap: false,
  readerHideFurigana: false,
  readerFuriganaStyle: "hide",
  readerBlurImage: false,
  readerBackgroundBlur: false,
  readerBackgroundBlurLevel: backgroundBlurLevel.default,
  readerBlurMode: "all",
  readerPageLayout: "double",
  readerViewMode: "paginated",
  readerVnParagraphs: readerVnParagraphs.default,
  readerVnTextSpeed: readerVnTextSpeed.default,
  readerSidebarPinned: false,
  readerTheme: defaultReaderTheme,
  readerCustomThemes: [],
  wordAudioSources: defaultWordAudioSources,
};

/** Native-owned persistence for the application's appearance preferences. */
export interface AppearancePreferencesStore {
  /** The saved preferences, each missing or invalid one left out. */
  load(): Promise<Partial<AppearancePreferences>>;
  save(preferences: AppearancePreferences): Promise<void>;
  /** Defaults that depend on this computer, used where nothing valid was saved. */
  installDefaults?(): Promise<Partial<AppearancePreferences>>;
}

export const isAppTheme = (value: unknown): value is AppTheme => isAppThemeId(value);

export const isAccentColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

const isFontSize = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= readerFontSize.min &&
  (value as number) <= readerFontSize.max;

/** Keep each valid saved preference on its own and leave out the rest. */
export function normalizeAppearancePreferences(value: unknown): Partial<AppearancePreferences> {
  if (!value || typeof value !== "object") return {};
  const {
    readerPopupEnabled,
    readerPopupMouseSelection,
    readerPopupAnkiAction,
    readerPopupVoiceAction,
    readerPopupShowDictionaryNames,
    readerPopupShowPitch,
    readerPopupShowFrequency,
    readerPopupCustomPalette: savedPopupPalette,
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
    appCustomTheme: savedCustomTheme,
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
    libraryCardSize: savedCardSize,
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
    readerCustomThemes: savedCustomThemes,
    wordAudioSources: savedWordAudioSources,
  } = value as Record<string, unknown>;
  const wordAudioSources = normalizeWordAudioSources(savedWordAudioSources);
  const readerCustomThemes = normalizeCustomThemes(savedCustomThemes);
  // A custom theme stays chosen only while it is kept.
  const themeKept =
    isReaderThemeId(readerTheme) &&
    (!isCustomThemeId(readerTheme) ||
      !!readerCustomThemes?.some((theme) => theme.id === readerTheme));
  const appCustomTheme = normalizeAppCustomTheme(savedCustomTheme);
  const readerPopupCustomPalette = normalizePopupPalette(savedPopupPalette);
  const migratedWidth =
    readerMaxWidth === undefined
      ? legacyTextWidth((value as Record<string, unknown>).readerSideMargin)
      : undefined;
  return {
    ...normalizeReaderFooter(value),
    ...normalizeStatistics(value),
    ...normalizeLookupTriggers(value),
    ...(normalizeSourceSelection((value as Record<string, unknown>).readerPopupPitchSources) && {
      readerPopupPitchSources: normalizeSourceSelection(
        (value as Record<string, unknown>).readerPopupPitchSources,
      ),
    }),
    ...(normalizeSourceSelection(
      (value as Record<string, unknown>).readerPopupFrequencySources,
    ) && {
      readerPopupFrequencySources: normalizeSourceSelection(
        (value as Record<string, unknown>).readerPopupFrequencySources,
      ),
    }),
    ...(normalizeSourceSelection(
      (value as Record<string, unknown>).readerPopupDefinitionSources,
    ) && {
      readerPopupDefinitionSources: normalizeSourceSelection(
        (value as Record<string, unknown>).readerPopupDefinitionSources,
      ),
    }),
    ...(typeof readerPopupEnabled === "boolean" && { readerPopupEnabled }),
    ...(typeof readerPopupMouseSelection === "boolean" && { readerPopupMouseSelection }),
    ...(typeof readerPopupAnkiAction === "boolean" && { readerPopupAnkiAction }),
    ...(typeof readerPopupVoiceAction === "boolean" && { readerPopupVoiceAction }),
    ...(typeof readerPopupShowDictionaryNames === "boolean" && { readerPopupShowDictionaryNames }),
    ...(typeof readerPopupShowPitch === "boolean" && {
      readerPopupShowPitch,
    }),
    ...(typeof readerPopupShowFrequency === "boolean" && { readerPopupShowFrequency }),
    ...(readerPopupCustomPalette && { readerPopupCustomPalette }),
    ...(isLookupRadius(readerPopupRadius) && { readerPopupRadius }),
    ...(isLookupFontSize(readerPopupFontSize) && { readerPopupFontSize }),
    ...(isLineHeight(readerPopupLineHeight) && { readerPopupLineHeight }),
    ...(isReaderPopupTheme(readerPopupTheme) && { readerPopupTheme }),
    ...(isLookupDimension(readerPopupWidth, lookupPopupWidth) && { readerPopupWidth }),
    ...(isLookupDimension(readerPopupHeight, lookupPopupHeight) && { readerPopupHeight }),
    ...(isLookupPopupStyle(readerPopupStyle) && { readerPopupStyle }),
    ...(isReaderFontChoice(readerPopupFont) && { readerPopupFont }),
    ...(isInterfaceLanguage(interfaceLanguage) && { interfaceLanguage }),
    ...(isAppIcon(appIcon) && { appIcon }),
    ...(isAppTheme(theme) && { theme }),
    ...(appCustomTheme && { appCustomTheme }),
    ...(isAccentColor(accentColor) && { accentColor }),
    ...(isLibraryView(libraryView) && { libraryView }),
    ...(isLibrarySort(librarySort) && { librarySort }),
    ...(typeof librarySortReversed === "boolean" && { librarySortReversed }),
    ...(isLibraryFilter(libraryFilter) && { libraryFilter }),
    ...(typeof libraryCardSeries === "boolean" && { libraryCardSeries }),
    ...(typeof libraryCardLanguage === "boolean" && { libraryCardLanguage }),
    ...(typeof libraryCardLastRead === "boolean" && { libraryCardLastRead }),
    ...(typeof libraryCardKanji === "boolean" && { libraryCardKanji }),
    ...(isLibraryGroup(libraryGroup) && { libraryGroup }),
    ...(isLibraryCardSize(savedCardSize) && { libraryCardSize: savedCardSize }),
    ...(isWheelStep(readerWheelStep) && { readerWheelStep }),
    ...(typeof middleClickAutoscroll === "boolean" && { middleClickAutoscroll }),
    ...(isChapterWheelThreshold(readerChapterWheelThreshold) && { readerChapterWheelThreshold }),
    ...(isFontSize(readerFontSize) && { readerFontSize }),
    ...(isLineHeight(readerLineHeight) && { readerLineHeight }),
    ...(isLetterSpacing(readerLetterSpacing) && { readerLetterSpacing }),
    ...(isWordSpacing(readerWordSpacing) && { readerWordSpacing }),
    ...(normalizeFontChoice(
      readerAsianFont,
      isReaderSerifFont(readerFontFamilyGroup1) ? readerFontFamilyGroup1 : undefined,
    ) && { readerAsianFont: normalizeFontChoice(readerAsianFont, readerFontFamilyGroup1) }),
    ...(normalizeFontChoice(
      readerWesternFont,
      isReaderSansFont(readerFontFamilyGroup2) ? readerFontFamilyGroup2 : undefined,
    ) && { readerWesternFont: normalizeFontChoice(readerWesternFont, readerFontFamilyGroup2) }),
    ...(isReaderSerifFont(readerFontFamilyGroup1) && { readerFontFamilyGroup1 }),
    ...(isReaderSansFont(readerFontFamilyGroup2) && { readerFontFamilyGroup2 }),
    ...(isFontWeight(readerFontWeight) && { readerFontWeight }),
    ...(isFaceWeight(readerWesternFontWeight)
      ? { readerWesternFontWeight }
      : readerWesternFontWeight === undefined && isFontWeight(readerFontWeight)
        ? { readerWesternFontWeight: readerFontWeight }
        : {}),
    ...(isFaceWeight(readerAsianFontWeight)
      ? { readerAsianFontWeight }
      : readerAsianFontWeight === undefined && isFontWeight(readerFontWeight)
        ? { readerAsianFontWeight: readerFontWeight }
        : {}),
    ...(isParagraphIndent(readerParagraphIndent) && { readerParagraphIndent }),
    ...(isParagraphMargin(readerParagraphMargin) && { readerParagraphMargin }),
    ...(isMaxWidth(readerMaxWidth)
      ? { readerMaxWidth }
      : migratedWidth !== undefined
        ? { readerMaxWidth: migratedWidth }
        : {}),
    ...(isPageLayout(readerPageLayout) && { readerPageLayout }),
    ...(isMaxHeight(readerMaxHeight) && { readerMaxHeight }),
    ...(isWritingMode(readerWritingMode) && { readerWritingMode }),
    ...(isTextOrientation(readerTextOrientation) && { readerTextOrientation }),
    ...(typeof readerTextJustification === "boolean" && { readerTextJustification }),
    ...(typeof readerPrettyTextWrap === "boolean" && { readerPrettyTextWrap }),
    ...(typeof readerHideFurigana === "boolean" && { readerHideFurigana }),
    ...(isFuriganaStyle(readerFuriganaStyle) && { readerFuriganaStyle }),
    ...(typeof readerBlurImage === "boolean" && { readerBlurImage }),
    ...(typeof readerBackgroundBlur === "boolean" && { readerBackgroundBlur }),
    ...(isBackgroundBlurLevel(readerBackgroundBlurLevel) && { readerBackgroundBlurLevel }),
    ...(isBlurMode(readerBlurMode) && { readerBlurMode }),
    ...(isViewMode(readerViewMode) && { readerViewMode }),
    ...(isVnParagraphs(readerVnParagraphs) && { readerVnParagraphs }),
    ...(isVnTextSpeed(readerVnTextSpeed) && { readerVnTextSpeed }),
    ...(typeof readerSidebarPinned === "boolean" && { readerSidebarPinned }),
    ...(themeKept && { readerTheme }),
    ...(readerCustomThemes && { readerCustomThemes }),
    ...(wordAudioSources && { wordAudioSources }),
  };
}

/** The native store in the desktop application; none elsewhere, such as in tests. */
export function defaultAppearanceStore(): AppearancePreferencesStore | null {
  if (!isTauri()) return null;
  return {
    async load() {
      return normalizeAppearancePreferences(await invoke<unknown>("get_appearance_preferences"));
    },
    async save(preferences) {
      await invoke("save_appearance_preferences", { preferences });
    },
    installDefaults: monitorReaderSize,
  };
}

/**
 * The Reader's maximum text width and height default to the monitor Komori opens on, so a new
 * reader sees the size the reading area can actually reach rather than an unreachable number.
 */
export async function monitorReaderSize(): Promise<Partial<AppearancePreferences>> {
  try {
    const monitor = await invoke<{ width: number; height: number } | null>(
      "get_reader_monitor_size",
    );
    if (!monitor || !(monitor.width > 0) || !(monitor.height > 0)) return {};
    const step = readerMaxWidth.step;
    return {
      readerMaxWidth: normalizeMaxWidth(Math.ceil(monitor.width / step) * step),
      readerMaxHeight: normalizeMaxHeight(Math.ceil(monitor.height / step) * step),
    };
  } catch {
    return {};
  }
}

/**
 * Writes preferences one at a time. A change during a write is saved right after it,
 * and only the latest of several such changes is written.
 */
export class AppearancePreferencesSaver {
  private pending: AppearancePreferences | null = null;
  private writing = false;
  private drained = Promise.resolve(true);

  constructor(private readonly store: AppearancePreferencesStore) {}

  save(preferences: AppearancePreferences): void {
    this.pending = preferences;
    if (!this.writing) this.drained = this.drain();
  }

  /**
   * Waits for the current and queued choices before the native window closes, retrying a choice
   * whose write failed. Resolves with whether every choice was saved.
   */
  flush(): Promise<boolean> {
    if (!this.writing && this.pending) this.drained = this.drain();
    return this.drained;
  }

  /** A choice stays pending until its write succeeds; the next save or flush retries it. */
  private async drain(): Promise<boolean> {
    this.writing = true;
    try {
      while (this.pending) {
        const next = this.pending;
        try {
          await this.store.save(next);
        } catch {
          if (this.pending === next) return false;
          continue;
        }
        if (this.pending === next) this.pending = null;
      }
      return true;
    } finally {
      this.writing = false;
    }
  }
}
