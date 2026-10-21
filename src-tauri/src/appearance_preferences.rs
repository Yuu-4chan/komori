//! Komori-owned appearance preferences: the interface language, application theme (a preset
//! or the custom theme),
//! accent, the Library's view, sort, filter, and card details, and Reader
//! wheel step, font size, line height, font weight, paragraph indentation, paragraph
//! margin, side margin, max height, writing mode, text orientation, hidden furigana,
//! blurred images, view mode, whether the sidebar is pinned, and the Reader theme with the
//! reader's custom themes.
//!
//! The record is stored as one validated JSON value, so later preferences can be
//! added without a schema change. Each stored field is validated on its own when
//! loaded; a missing or invalid field loads as absent, and the frontend uses its default.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::dictionary::sources::SourceSelection;
use crate::interface_text::LANGUAGES;
use crate::library::{open_catalog, storage_error, CatalogState};
use crate::reader_fonts::FontChoice;
use crate::word_audio::AudioSource;

const POPUP_SHORTCUTS: [&str; 3] = ["shift-enter", "alt-x", "ctrl-space"];
const POPUP_MOUSE_TRIGGERS: [&str; 4] = ["left", "double", "shift-right", "middle"];
const POPUP_CLOSE_BEHAVIORS: [&str; 3] = ["escape-outside", "outside", "persistent"];
const POPUP_READING_POSITIONS: [&str; 2] = ["beside", "above"];
/// The full lookup popup, or the experimental compact dictionary of headwords and definitions.
const POPUP_STYLES: [&str; 2] = ["standard", "dictionary"];
/// Hover/scan delay (0 scans at once), scanned characters, results, and child popup levels.
const POPUP_HOVER_DELAYS: std::ops::RangeInclusive<i64> = 0..=1200;
const POPUP_SCAN_LENGTHS: std::ops::RangeInclusive<i64> = 1..=64;
const POPUP_MAX_RESULTS: std::ops::RangeInclusive<i64> = 1..=64;
const POPUP_CHILD_LEVELS: std::ops::RangeInclusive<i64> = 0..=5;

const READER_SERIF_FONTS: [&str; 6] = [
    "yu-mincho",
    "noto-serif-jp",
    "noto-serif-sc",
    "noto-serif-kr",
    "georgia",
    "serif",
];
const READER_SANS_FONTS: [&str; 7] = [
    "segoe-ui",
    "yu-gothic",
    "noto-sans-jp",
    "noto-sans-sc",
    "noto-sans-kr",
    "inter",
    "sans-serif",
];

const BACKGROUND_BLUR_LEVELS: std::ops::RangeInclusive<i64> = 0..=40;

const RECORD_NAME: &str = "appearance";
/// Reader wheel step: how far one mouse wheel step scrolls a continuous book, in CSS
/// pixels, in steps of 10. Keep in step with `src/features/reader/navigationInput.ts`.
const READER_WHEEL_STEPS: std::ops::RangeInclusive<i64> = 10..=2000;
const READER_WHEEL_STEP_STEP: i64 = 10;
/// Reader font size in CSS pixels. Keep in step with `src/features/reader/presentation.ts`.
const READER_FONT_SIZES: std::ops::RangeInclusive<i64> = 8..=72;
/// The lookup popup's definition text size in pixels; the rest of its text scales with it.
const READER_POPUP_FONT_SIZES: std::ops::RangeInclusive<i64> = 8..=48;
/// Reader line height as a multiple of the font size, in steps of 0.05. Absent, each
/// book keeps its own. Keep in step with `src/features/reader/presentation.ts`.
const READER_LINE_HEIGHTS: std::ops::RangeInclusive<f64> = 1.0..=3.0;
const READER_LINE_HEIGHT_STEPS_PER_UNIT: f64 = 20.0;
/// Reader font weight of the book's normal text, in steps of 100. Absent, each book
/// keeps its own. Keep in step with `src/features/reader/presentation.ts`.
const READER_FONT_WEIGHTS: std::ops::RangeInclusive<i64> = 100..=900;
/// Reader paragraph indentation in em, in steps of 0.5. Absent, each book keeps its
/// own. Keep in step with `src/features/reader/presentation.ts`.
const READER_PARAGRAPH_INDENTS: std::ops::RangeInclusive<f64> = 0.0..=20.0;
const READER_PARAGRAPH_INDENT_STEPS_PER_EM: f64 = 2.0;
/// Reader space before and after each paragraph in CSS pixels, in steps of 2. Absent,
/// each book keeps its own. Keep in step with `src/features/reader/presentation.ts`.
const READER_PARAGRAPH_MARGINS: std::ops::RangeInclusive<i64> = 0..=200;
const READER_PARAGRAPH_MARGIN_STEP: i64 = 2;
/// Reader left and right page margin in CSS pixels, in steps of 4. Absent, the Reader
/// keeps its automatic margins. Keep in step with `src/features/reader/presentation.ts`.
const READER_SIDE_MARGINS: std::ops::RangeInclusive<i64> = 0..=400;
/// Reader letter and word spacing in whole CSS pixels; 0 keeps each book's own. Keep in
/// step with `src/features/reader/presentation.ts`.
const READER_LETTER_SPACINGS: std::ops::RangeInclusive<i64> = -10..=60;
const READER_WORD_SPACINGS: std::ops::RangeInclusive<i64> = -20..=120;
const READER_SIDE_MARGIN_STEP: i64 = 4;
/// Reader max height of the reading area in CSS pixels, in steps of 10. Absent, the
/// Reader fills the window's height. Keep in step with `src/features/reader/presentation.ts`.
const READER_MAX_HEIGHTS: std::ops::RangeInclusive<i64> = 100..=1_000_000;
const READER_MAX_HEIGHT_STEP: i64 = 10;
/// Reader writing mode. Absent, each book keeps its own. Keep in step with
/// `src/features/reader/presentation.ts`.
const READER_WRITING_MODES: [&str; 2] = ["horizontal", "vertical"];
/// Reader text orientation of vertical text. Absent, each book keeps its own. Keep in
/// step with `src/features/reader/presentation.ts`.
const READER_TEXT_ORIENTATIONS: [&str; 2] = ["mixed", "upright"];
/// Reader view mode. Absent, books are paginated. Keep in step with
/// `src/features/reader/presentation.ts`.
const READER_VIEW_MODES: [&str; 4] = ["paginated", "continuous", "semi-continuous", "vn"];
/// Reader theme presets. A custom theme is chosen by its ID instead. Keep in step with
/// `src/features/reader/readerThemes.ts`.
const READER_PRESET_THEMES: [&str; 15] = [
    "paper",
    "sepia",
    "night",
    "sakura",
    "matcha",
    "hojicha",
    "solarized",
    "nord",
    "gruvbox",
    "rose-pine",
    "tokyo-night",
    "latte",
    "frappe",
    "macchiato",
    "mocha",
];
/// Reader popup colors, independent of application/book themes. Keep in step with
/// `src/features/reader/popupThemes.ts`.
const READER_POPUP_THEMES: [&str; 5] = ["application", "classic", "paper", "night", "custom"];

/// One structured custom popup palette, never CSS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReaderPopupPalette {
    background: String,
    text: String,
    accent: String,
    border: String,
    tag: String,
}

impl ReaderPopupPalette {
    fn is_valid(&self) -> bool {
        [
            &self.background,
            &self.text,
            &self.accent,
            &self.border,
            &self.tag,
        ]
        .iter()
        .all(|color| valid_accent(color))
    }
}
/// Application themes: presets and "custom", the reader's own colors. Keep in step with
/// `src/features/appearance/appThemes.ts`.
const APP_THEMES: [&str; 9] = [
    "light", "dark", "sakura", "matcha", "hojicha", "midnight", "ember", "forest", "custom",
];
/// The Library's saved view choices. Keep in step with `src/features/library/libraryView.ts`.
const LIBRARY_VIEWS: [&str; 2] = ["grid", "list"];
const LIBRARY_SORTS: [&str; 6] = [
    "recent",
    "added",
    "title",
    "progress",
    "characters",
    "words",
];
/// When a Reader session starts counting.
const SESSION_START_MODES: [&str; 3] = ["auto", "first-read", "manual"];
/// Characters or words; 0 never stops a session.
const STATISTICS_JUMP_LIMITS: std::ops::RangeInclusive<i64> = 0..=100_000;
/// Minutes without reading forward before a session stops counting; 0 never stops.
const STATISTICS_IDLE_MINUTES: std::ops::RangeInclusive<i64> = 0..=120;
/// Grid card widths, in px: 100–480 in steps of 10.
fn valid_library_card_size(size: i64) -> bool {
    (100..=480).contains(&size) && size % 10 == 0
}
const LIBRARY_FILTERS: [&str; 4] = ["all", "reading", "completed", "not-started"];
const LIBRARY_GROUPS: [&str; 3] = ["none", "series", "language"];
/// The most custom Reader themes kept, and the longest name, in characters.
const READER_CUSTOM_THEME_LIMIT: usize = 32;
const READER_THEME_NAME_MAX_CHARS: usize = 40;

/// A custom Reader theme: a name and `#rrggbb` colors, never CSS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderCustomTheme {
    id: String,
    name: String,
    background: String,
    text: String,
    selection: String,
    highlight: String,
    footer_text: String,
}

/// The application's custom theme: a light or dark base and `#rrggbb` colors, never CSS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCustomTheme {
    base: String,
    background: String,
    surface: String,
    text: String,
}

impl AppCustomTheme {
    fn is_valid(&self) -> bool {
        matches!(self.base.as_str(), "light" | "dark")
            && [&self.background, &self.surface, &self.text]
                .iter()
                .all(|color| valid_accent(color))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_reading_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_percentage: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_chapter_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_chapter_percentage: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_clock: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_reading_time: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_show_reading_speed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    statistics_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    statistics_session_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    statistics_jump_limit: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    statistics_idle_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_shift_lookup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_keyboard_shortcut: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_click_lookup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_hover_lookup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_cjk_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_shortcut_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_mouse_trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_close_behavior: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_hover_delay: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_scan_length: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_max_results: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_child_levels: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_reading_position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_font: Option<FontChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_mouse_selection: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_anki_action: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_voice_action: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_show_dictionary_names: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_show_pitch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_show_frequency: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_pitch_sources: Option<SourceSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_frequency_sources: Option<SourceSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_definition_sources: Option<SourceSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_custom_palette: Option<ReaderPopupPalette>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_radius: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_font_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_popup_height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interface_language: Option<String>,
    /// The window and tray icon (`crate::app_icon`); absent is the built-in default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_custom_theme: Option<AppCustomTheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_sort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_sort_reversed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_card_series: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_card_language: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_card_last_read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_card_kanji: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_card_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accent_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_wheel_step: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    middle_click_autoscroll: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_chapter_wheel_threshold: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_font_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_font_weight: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_western_font_weight: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_asian_font_weight: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_asian_font: Option<FontChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_western_font: Option<FontChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_font_family_group1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_font_family_group2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_paragraph_indent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_paragraph_margin: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_letter_spacing: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_word_spacing: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_side_margin: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_max_width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_page_layout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_max_height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_writing_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_text_orientation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_text_justification: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_pretty_text_wrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_hide_furigana: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_furigana_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_blur_image: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_background_blur: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_background_blur_level: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reader_blur_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_view_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_vn_paragraphs: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_vn_text_speed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_sidebar_pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_custom_themes: Option<Vec<ReaderCustomTheme>>,
    /// Word audio sources in the order they are tried; absent, JapanesePod101 alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    word_audio_sources: Option<Vec<AudioSource>>,
}

fn valid_wheel_step(step: i64) -> bool {
    READER_WHEEL_STEPS.contains(&step) && step % READER_WHEEL_STEP_STEP == 0
}

/// Keep in step with `src/features/reader/lookupPopup.ts`.
fn valid_popup_dimension(size: i64, min: i64) -> bool {
    (min..=1200).contains(&size) && size % 20 == 0
}

fn valid_theme(theme: &str) -> bool {
    APP_THEMES.contains(&theme)
}

fn valid_line_height(line_height: f64) -> bool {
    let steps = line_height * READER_LINE_HEIGHT_STEPS_PER_UNIT;
    READER_LINE_HEIGHTS.contains(&line_height) && (steps - steps.round()).abs() < 1e-9
}

fn valid_font_weight(weight: i64) -> bool {
    READER_FONT_WEIGHTS.contains(&weight) && weight % 100 == 0
}

fn valid_paragraph_indent(indent: f64) -> bool {
    let steps = indent * READER_PARAGRAPH_INDENT_STEPS_PER_EM;
    READER_PARAGRAPH_INDENTS.contains(&indent) && (steps - steps.round()).abs() < 1e-9
}

fn valid_paragraph_margin(margin: i64) -> bool {
    READER_PARAGRAPH_MARGINS.contains(&margin) && margin % READER_PARAGRAPH_MARGIN_STEP == 0
}

fn valid_side_margin(margin: i64) -> bool {
    READER_SIDE_MARGINS.contains(&margin) && margin % READER_SIDE_MARGIN_STEP == 0
}

fn valid_max_height(height: i64) -> bool {
    READER_MAX_HEIGHTS.contains(&height) && height % READER_MAX_HEIGHT_STEP == 0
}

fn valid_writing_mode(mode: &str) -> bool {
    READER_WRITING_MODES.contains(&mode)
}

fn valid_text_orientation(orientation: &str) -> bool {
    READER_TEXT_ORIENTATIONS.contains(&orientation)
}

fn valid_view_mode(mode: &str) -> bool {
    READER_VIEW_MODES.contains(&mode)
}

fn valid_accent(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A lowercase hyphenated UUID, which no preset name can be.
fn valid_custom_theme_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

/// 1–40 characters, no surrounding whitespace, and no control characters.
fn valid_theme_name(name: &str) -> bool {
    !name.is_empty()
        && name.trim() == name
        && name.chars().count() <= READER_THEME_NAME_MAX_CHARS
        && !name.chars().any(char::is_control)
}

impl ReaderCustomTheme {
    fn is_valid(&self) -> bool {
        valid_custom_theme_id(&self.id)
            && valid_theme_name(&self.name)
            && [
                &self.background,
                &self.text,
                &self.selection,
                &self.highlight,
                &self.footer_text,
            ]
            .iter()
            .all(|color| valid_accent(color))
    }
}

/// At most the limit of valid themes, each ID once.
fn valid_custom_themes(themes: &[ReaderCustomTheme]) -> bool {
    themes.len() <= READER_CUSTOM_THEME_LIMIT
        && themes.iter().enumerate().all(|(index, theme)| {
            theme.is_valid() && themes[..index].iter().all(|other| other.id != theme.id)
        })
}

/// A preset, or a custom theme that is kept.
fn valid_reader_theme(theme: &str, custom_themes: Option<&[ReaderCustomTheme]>) -> bool {
    READER_PRESET_THEMES.contains(&theme)
        || custom_themes.is_some_and(|themes| themes.iter().any(|custom| custom.id == theme))
}

/// The valid themes of a stored list, each ID once and at most the limit.
fn stored_custom_themes(value: &Value) -> Option<Vec<ReaderCustomTheme>> {
    let mut themes: Vec<ReaderCustomTheme> = Vec::new();
    for stored in value.as_array()? {
        if themes.len() == READER_CUSTOM_THEME_LIMIT {
            break;
        }
        let mut stored = stored.clone();
        // Legacy themes used Selection for pointer-match paint. Backfill only a
        // missing field, preserving the old appearance without accepting invalid colors.
        if let Some(fields) = stored.as_object_mut() {
            if !fields.contains_key("highlight") {
                if let Some(selection) = fields.get("selection").cloned() {
                    fields.insert("highlight".into(), selection);
                }
            }
        }
        let Ok(theme) = serde_json::from_value::<ReaderCustomTheme>(stored) else {
            continue;
        };
        if theme.is_valid() && themes.iter().all(|other| other.id != theme.id) {
            themes.push(theme);
        }
    }
    Some(themes)
}

impl AppearancePreferences {
    /// Points the popup's dictionary source roles at other dictionaries (see
    /// `SourceSelection::remap`).
    pub(crate) fn remap_dictionaries(&mut self, map: impl Fn(i64) -> Option<i64> + Copy) {
        for role in [
            &mut self.reader_popup_definition_sources,
            &mut self.reader_popup_frequency_sources,
            &mut self.reader_popup_pitch_sources,
        ]
        .into_iter()
        .flatten()
        {
            role.remap(map);
        }
    }

    fn is_valid(&self) -> bool {
        if [
            &self.reader_popup_definition_sources,
            &self.reader_popup_frequency_sources,
            &self.reader_popup_pitch_sources,
        ]
        .iter()
        .any(|role| role.as_ref().is_some_and(|value| !value.is_valid()))
        {
            return false;
        }
        self.interface_language
            .as_deref()
            .is_none_or(|language| LANGUAGES.contains(&language))
            && self
                .app_icon
                .as_deref()
                .is_none_or(|icon| crate::app_icon::APP_ICONS.contains(&icon))
            && self
                .reader_popup_hover_delay
                .is_none_or(|delay| POPUP_HOVER_DELAYS.contains(&delay))
            && self
                .reader_popup_scan_length
                .is_none_or(|length| POPUP_SCAN_LENGTHS.contains(&length))
            && self
                .reader_popup_max_results
                .is_none_or(|count| POPUP_MAX_RESULTS.contains(&count))
            && self
                .reader_popup_child_levels
                .is_none_or(|levels| POPUP_CHILD_LEVELS.contains(&levels))
            && self
                .reader_popup_reading_position
                .as_deref()
                .is_none_or(|value| POPUP_READING_POSITIONS.contains(&value))
            && self
                .reader_popup_style
                .as_deref()
                .is_none_or(|value| POPUP_STYLES.contains(&value))
            && self
                .reader_popup_font
                .as_ref()
                .is_none_or(FontChoice::valid)
            && self
                .reader_popup_shortcut_preset
                .as_deref()
                .is_none_or(|value| POPUP_SHORTCUTS.contains(&value))
            && self
                .reader_popup_mouse_trigger
                .as_deref()
                .is_none_or(|value| POPUP_MOUSE_TRIGGERS.contains(&value))
            && self
                .reader_popup_close_behavior
                .as_deref()
                .is_none_or(|value| POPUP_CLOSE_BEHAVIORS.contains(&value))
            && self
                .reader_popup_custom_palette
                .as_ref()
                .is_none_or(ReaderPopupPalette::is_valid)
            && self
                .reader_popup_radius
                .is_none_or(|radius| (0..=28).contains(&radius))
            && self
                .reader_popup_font_size
                .is_none_or(|size| READER_POPUP_FONT_SIZES.contains(&size))
            && self.reader_popup_line_height.is_none_or(valid_line_height)
            && self
                .reader_popup_width
                .is_none_or(|size| valid_popup_dimension(size, 320))
            && self
                .reader_popup_height
                .is_none_or(|size| valid_popup_dimension(size, 200))
            && self
                .reader_popup_theme
                .as_deref()
                .is_none_or(|theme| READER_POPUP_THEMES.contains(&theme))
            && self.theme.as_deref().is_none_or(valid_theme)
            && self
                .app_custom_theme
                .as_ref()
                .is_none_or(AppCustomTheme::is_valid)
            && self.library_card_size.is_none_or(valid_library_card_size)
            && self
                .library_view
                .as_deref()
                .is_none_or(|view| LIBRARY_VIEWS.contains(&view))
            && self
                .library_sort
                .as_deref()
                .is_none_or(|sort| LIBRARY_SORTS.contains(&sort))
            && self
                .statistics_session_start
                .as_deref()
                .is_none_or(|mode| SESSION_START_MODES.contains(&mode))
            && self
                .statistics_jump_limit
                .is_none_or(|limit| STATISTICS_JUMP_LIMITS.contains(&limit))
            && self
                .statistics_idle_minutes
                .is_none_or(|minutes| STATISTICS_IDLE_MINUTES.contains(&minutes))
            && self
                .library_filter
                .as_deref()
                .is_none_or(|filter| LIBRARY_FILTERS.contains(&filter))
            && self
                .library_group
                .as_deref()
                .is_none_or(|group| LIBRARY_GROUPS.contains(&group))
            && self.accent_color.as_deref().is_none_or(valid_accent)
            && self.reader_wheel_step.is_none_or(valid_wheel_step)
            && self
                .reader_chapter_wheel_threshold
                .is_none_or(|steps| (1..=20).contains(&steps))
            && self
                .reader_font_size
                .is_none_or(|size| READER_FONT_SIZES.contains(&size))
            && self.reader_line_height.is_none_or(valid_line_height)
            && self
                .reader_font_family_group1
                .as_deref()
                .is_none_or(|font| READER_SERIF_FONTS.contains(&font))
            && self
                .reader_font_family_group2
                .as_deref()
                .is_none_or(|font| READER_SANS_FONTS.contains(&font))
            && self
                .reader_asian_font
                .as_ref()
                .is_none_or(FontChoice::valid)
            && self
                .reader_western_font
                .as_ref()
                .is_none_or(FontChoice::valid)
            && self
                .reader_background_blur_level
                .is_none_or(|level| BACKGROUND_BLUR_LEVELS.contains(&level))
            && self.reader_font_weight.is_none_or(valid_font_weight)
            && self
                .reader_western_font_weight
                .is_none_or(|weight| (1..=1000).contains(&weight))
            && self
                .reader_asian_font_weight
                .is_none_or(|weight| (1..=1000).contains(&weight))
            && self
                .reader_paragraph_indent
                .is_none_or(valid_paragraph_indent)
            && self
                .reader_paragraph_margin
                .is_none_or(valid_paragraph_margin)
            && self.reader_side_margin.is_none_or(valid_side_margin)
            && self
                .reader_letter_spacing
                .is_none_or(|spacing| READER_LETTER_SPACINGS.contains(&spacing))
            && self
                .reader_word_spacing
                .is_none_or(|spacing| READER_WORD_SPACINGS.contains(&spacing))
            && self.reader_max_width.is_none_or(valid_max_height)
            && self
                .reader_page_layout
                .as_deref()
                .is_none_or(|layout| ["single", "double"].contains(&layout))
            && self.reader_max_height.is_none_or(valid_max_height)
            && self
                .reader_writing_mode
                .as_deref()
                .is_none_or(valid_writing_mode)
            && self
                .reader_text_orientation
                .as_deref()
                .is_none_or(valid_text_orientation)
            && self
                .reader_blur_mode
                .as_deref()
                .is_none_or(|mode| ["all", "after-toc"].contains(&mode))
            && self
                .reader_furigana_style
                .as_deref()
                .is_none_or(|style| ["hide", "partial", "toggle", "full"].contains(&style))
            && self.reader_view_mode.as_deref().is_none_or(valid_view_mode)
            && self
                .reader_vn_paragraphs
                .is_none_or(|count| (1..=20).contains(&count))
            && self
                .reader_vn_text_speed
                .is_none_or(|speed| (0..=200).contains(&speed))
            && self
                .reader_custom_themes
                .as_deref()
                .is_none_or(valid_custom_themes)
            && self
                .reader_theme
                .as_deref()
                .is_none_or(|theme| valid_reader_theme(theme, self.reader_custom_themes.as_deref()))
            && self
                .word_audio_sources
                .as_deref()
                .is_none_or(crate::word_audio::valid_sources)
    }

    /// Keep each valid field of a stored record and drop the rest.
    pub(crate) fn from_stored(value: &Value) -> Self {
        let text = |name: &str| value.get(name).and_then(Value::as_str);
        let number = |name: &str| value.get(name).and_then(Value::as_i64);
        let custom_themes = value
            .get("readerCustomThemes")
            .and_then(stored_custom_themes);
        let flag = |name: &str| value.get(name).and_then(Value::as_bool);
        let choice = |name: &str, choices: &[&str]| {
            text(name)
                .filter(|chosen| choices.contains(chosen))
                .map(str::to_owned)
        };
        Self {
            reader_popup_shift_lookup: flag("readerPopupShiftLookup"),
            reader_popup_keyboard_shortcut: flag("readerPopupKeyboardShortcut"),
            reader_popup_click_lookup: flag("readerPopupClickLookup"),
            reader_popup_hover_lookup: flag("readerPopupHoverLookup"),
            reader_popup_cjk_only: flag("readerPopupCjkOnly"),
            reader_popup_shortcut_preset: choice("readerPopupShortcutPreset", &POPUP_SHORTCUTS),
            reader_popup_mouse_trigger: choice("readerPopupMouseTrigger", &POPUP_MOUSE_TRIGGERS),
            reader_popup_close_behavior: choice("readerPopupCloseBehavior", &POPUP_CLOSE_BEHAVIORS),
            reader_popup_hover_delay: number("readerPopupHoverDelay")
                .filter(|delay| POPUP_HOVER_DELAYS.contains(delay)),
            reader_popup_scan_length: number("readerPopupScanLength")
                .filter(|length| POPUP_SCAN_LENGTHS.contains(length)),
            reader_popup_max_results: number("readerPopupMaxResults")
                .filter(|count| POPUP_MAX_RESULTS.contains(count)),
            reader_popup_child_levels: number("readerPopupChildLevels")
                .filter(|levels| POPUP_CHILD_LEVELS.contains(levels)),
            reader_popup_reading_position: choice(
                "readerPopupReadingPosition",
                &POPUP_READING_POSITIONS,
            ),
            reader_popup_style: choice("readerPopupStyle", &POPUP_STYLES),
            reader_popup_font: FontChoice::from_stored(value.get("readerPopupFont"), None),
            reader_popup_enabled: flag("readerPopupEnabled"),
            reader_popup_mouse_selection: flag("readerPopupMouseSelection"),
            reader_popup_anki_action: flag("readerPopupAnkiAction"),
            reader_popup_voice_action: flag("readerPopupVoiceAction"),
            reader_popup_show_dictionary_names: flag("readerPopupShowDictionaryNames"),
            reader_popup_show_pitch: flag("readerPopupShowPitch"),
            reader_popup_show_frequency: flag("readerPopupShowFrequency"),
            reader_popup_pitch_sources: value
                .get("readerPopupPitchSources")
                .and_then(|v| serde_json::from_value::<SourceSelection>(v.clone()).ok())
                .filter(SourceSelection::is_valid),
            reader_popup_frequency_sources: value
                .get("readerPopupFrequencySources")
                .and_then(|v| serde_json::from_value::<SourceSelection>(v.clone()).ok())
                .filter(SourceSelection::is_valid),
            reader_popup_definition_sources: value
                .get("readerPopupDefinitionSources")
                .and_then(|v| serde_json::from_value::<SourceSelection>(v.clone()).ok())
                .filter(SourceSelection::is_valid),
            reader_popup_custom_palette: value
                .get("readerPopupCustomPalette")
                .and_then(|stored| {
                    serde_json::from_value::<ReaderPopupPalette>(stored.clone()).ok()
                })
                .filter(ReaderPopupPalette::is_valid),
            interface_language: choice("interfaceLanguage", &LANGUAGES),
            app_icon: choice("appIcon", &crate::app_icon::APP_ICONS),
            theme: text("theme")
                .filter(|theme| valid_theme(theme))
                .map(str::to_owned),
            app_custom_theme: value
                .get("appCustomTheme")
                .and_then(|stored| serde_json::from_value::<AppCustomTheme>(stored.clone()).ok())
                .filter(AppCustomTheme::is_valid),
            library_view: choice("libraryView", &LIBRARY_VIEWS),
            library_sort: choice("librarySort", &LIBRARY_SORTS),
            library_sort_reversed: flag("librarySortReversed"),
            library_filter: choice("libraryFilter", &LIBRARY_FILTERS),
            library_card_series: flag("libraryCardSeries"),
            library_card_language: flag("libraryCardLanguage"),
            library_card_last_read: flag("libraryCardLastRead"),
            library_card_kanji: flag("libraryCardKanji"),
            library_group: choice("libraryGroup", &LIBRARY_GROUPS),
            library_card_size: number("libraryCardSize")
                .filter(|size| valid_library_card_size(*size)),
            accent_color: text("accentColor")
                .filter(|color| valid_accent(color))
                .map(str::to_owned),
            reader_wheel_step: number("readerWheelStep").filter(|step| valid_wheel_step(*step)),
            middle_click_autoscroll: value.get("middleClickAutoscroll").and_then(Value::as_bool),
            reader_chapter_wheel_threshold: number("readerChapterWheelThreshold")
                .filter(|steps| (1..=20).contains(steps)),
            reader_font_size: number("readerFontSize")
                .filter(|size| READER_FONT_SIZES.contains(size)),
            reader_line_height: value
                .get("readerLineHeight")
                .and_then(Value::as_f64)
                .filter(|line_height| valid_line_height(*line_height)),
            reader_asian_font: FontChoice::from_stored(
                value.get("readerAsianFont"),
                text("readerFontFamilyGroup1").filter(|f| READER_SERIF_FONTS.contains(f)),
            ),
            reader_western_font: FontChoice::from_stored(
                value.get("readerWesternFont"),
                text("readerFontFamilyGroup2").filter(|f| READER_SANS_FONTS.contains(f)),
            ),
            reader_font_family_group1: text("readerFontFamilyGroup1")
                .filter(|font| READER_SERIF_FONTS.contains(font))
                .map(str::to_owned),
            reader_font_family_group2: text("readerFontFamilyGroup2")
                .filter(|font| READER_SANS_FONTS.contains(font))
                .map(str::to_owned),
            reader_font_weight: number("readerFontWeight")
                .filter(|weight| valid_font_weight(*weight)),
            reader_western_font_weight: if value.get("readerWesternFontWeight").is_none() {
                number("readerFontWeight").filter(|weight| valid_font_weight(*weight))
            } else {
                number("readerWesternFontWeight").filter(|weight| (1..=1000).contains(weight))
            },
            reader_asian_font_weight: if value.get("readerAsianFontWeight").is_none() {
                number("readerFontWeight").filter(|weight| valid_font_weight(*weight))
            } else {
                number("readerAsianFontWeight").filter(|weight| (1..=1000).contains(weight))
            },
            reader_paragraph_indent: value
                .get("readerParagraphIndent")
                .and_then(Value::as_f64)
                .filter(|indent| valid_paragraph_indent(*indent)),
            reader_paragraph_margin: number("readerParagraphMargin")
                .filter(|margin| valid_paragraph_margin(*margin)),
            reader_letter_spacing: number("readerLetterSpacing")
                .filter(|spacing| READER_LETTER_SPACINGS.contains(spacing)),
            reader_word_spacing: number("readerWordSpacing")
                .filter(|spacing| READER_WORD_SPACINGS.contains(spacing)),
            reader_side_margin: if value.get("readerMaxWidth").is_some() {
                None
            } else {
                number("readerSideMargin").filter(|margin| valid_side_margin(*margin))
            },
            reader_max_width: number("readerMaxWidth").filter(|width| valid_max_height(*width)),
            reader_page_layout: text("readerPageLayout")
                .filter(|layout| ["single", "double"].contains(layout))
                .map(str::to_owned),
            reader_max_height: number("readerMaxHeight").filter(|height| valid_max_height(*height)),
            reader_popup_theme: text("readerPopupTheme")
                .filter(|theme| READER_POPUP_THEMES.contains(theme))
                .map(str::to_owned),
            reader_popup_radius: number("readerPopupRadius")
                .filter(|radius| (0..=28).contains(radius)),
            reader_popup_font_size: number("readerPopupFontSize")
                .filter(|size| READER_POPUP_FONT_SIZES.contains(size)),
            reader_popup_line_height: value
                .get("readerPopupLineHeight")
                .and_then(Value::as_f64)
                .filter(|line_height| valid_line_height(*line_height)),
            reader_popup_width: number("readerPopupWidth")
                .filter(|size| valid_popup_dimension(*size, 320)),
            reader_popup_height: number("readerPopupHeight")
                .filter(|size| valid_popup_dimension(*size, 200)),
            reader_writing_mode: text("readerWritingMode")
                .filter(|mode| valid_writing_mode(mode))
                .map(str::to_owned),
            reader_text_orientation: text("readerTextOrientation")
                .filter(|orientation| valid_text_orientation(orientation))
                .map(str::to_owned),
            reader_show_reading_position: value
                .get("readerShowReadingPosition")
                .and_then(Value::as_bool),
            reader_show_percentage: value.get("readerShowPercentage").and_then(Value::as_bool),
            reader_show_chapter_position: value
                .get("readerShowChapterPosition")
                .and_then(Value::as_bool),
            reader_show_chapter_percentage: value
                .get("readerShowChapterPercentage")
                .and_then(Value::as_bool),
            reader_show_clock: value.get("readerShowClock").and_then(Value::as_bool),
            reader_show_reading_time: value.get("readerShowReadingTime").and_then(Value::as_bool),
            reader_show_reading_speed: value.get("readerShowReadingSpeed").and_then(Value::as_bool),
            statistics_enabled: value.get("statisticsEnabled").and_then(Value::as_bool),
            statistics_session_start: choice("statisticsSessionStart", &SESSION_START_MODES),
            statistics_jump_limit: number("statisticsJumpLimit")
                .filter(|limit| STATISTICS_JUMP_LIMITS.contains(limit)),
            statistics_idle_minutes: number("statisticsIdleMinutes")
                .filter(|minutes| STATISTICS_IDLE_MINUTES.contains(minutes)),
            reader_text_justification: value
                .get("readerTextJustification")
                .and_then(Value::as_bool),
            reader_pretty_text_wrap: value.get("readerPrettyTextWrap").and_then(Value::as_bool),
            reader_hide_furigana: value.get("readerHideFurigana").and_then(Value::as_bool),
            reader_furigana_style: choice(
                "readerFuriganaStyle",
                &["hide", "partial", "toggle", "full"],
            ),
            reader_blur_image: value.get("readerBlurImage").and_then(Value::as_bool),
            reader_background_blur: value.get("readerBackgroundBlur").and_then(Value::as_bool),
            reader_background_blur_level: number("readerBackgroundBlurLevel")
                .filter(|level| BACKGROUND_BLUR_LEVELS.contains(level)),
            reader_blur_mode: choice("readerBlurMode", &["all", "after-toc"]),
            reader_view_mode: text("readerViewMode")
                .filter(|mode| valid_view_mode(mode))
                .map(str::to_owned),
            reader_vn_paragraphs: number("readerVnParagraphs")
                .filter(|count| (1..=20).contains(count)),
            reader_vn_text_speed: number("readerVnTextSpeed")
                .filter(|speed| (0..=200).contains(speed)),
            reader_sidebar_pinned: value.get("readerSidebarPinned").and_then(Value::as_bool),
            // A custom theme stays chosen only while it is kept.
            reader_theme: text("readerTheme")
                .filter(|theme| valid_reader_theme(theme, custom_themes.as_deref()))
                .map(str::to_owned),
            reader_custom_themes: custom_themes,
            word_audio_sources: value
                .get("wordAudioSources")
                .and_then(|v| serde_json::from_value::<Vec<AudioSource>>(v.clone()).ok())
                .filter(|sources| crate::word_audio::valid_sources(sources)),
        }
    }
}

#[tauri::command]
pub async fn get_appearance_preferences(
    catalog: State<'_, CatalogState>,
) -> Result<AppearancePreferences, String> {
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || load(&database))
        .await
        .map_err(|error| format!("Preferences task failed: {error}"))?
}

#[tauri::command]
pub async fn save_appearance_preferences(
    app: AppHandle,
    catalog: State<'_, CatalogState>,
    preferences: AppearancePreferences,
) -> Result<bool, String> {
    let database = catalog.database.clone();
    let language = preferences.interface_language.clone();
    let icon = preferences.app_icon.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || save(&database, &preferences))
        .await
        .map_err(|error| format!("Preferences task failed: {error}"))??;
    // The tray menu follows the interface language at once, and the window and tray the icon.
    if saved {
        crate::window_lifecycle::relabel_tray(&app, language.as_deref().unwrap_or("en"));
        crate::app_icon::apply(&app, icon.as_deref());
    }
    Ok(saved)
}

/// The saved interface language, or English when none is saved or the record cannot be read.
pub(crate) fn interface_language(database: &Path) -> &'static str {
    load(database)
        .ok()
        .and_then(|preferences| preferences.interface_language)
        .and_then(|saved| LANGUAGES.into_iter().find(|language| *language == saved))
        .unwrap_or("en")
}

/// The saved word audio sources, when the record has them.
pub(crate) fn word_audio_sources(database: &Path) -> Option<Vec<AudioSource>> {
    load(database)
        .ok()
        .and_then(|preferences| preferences.word_audio_sources)
}

/// The saved app icon, when the record names one.
pub(crate) fn app_icon(database: &Path) -> Option<String> {
    load(database)
        .ok()
        .and_then(|preferences| preferences.app_icon)
}

fn load(database: &Path) -> Result<AppearancePreferences, String> {
    load_from(&open_catalog(database)?)
}

fn save(database: &Path, preferences: &AppearancePreferences) -> Result<bool, String> {
    if !preferences.is_valid() {
        return Ok(false);
    }
    save_to(&open_catalog(database)?, preferences)
}

fn load_from(connection: &Connection) -> Result<AppearancePreferences, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM preferences WHERE name = ?1",
            [RECORD_NAME],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    // Unreadable JSON is the same as nothing saved.
    Ok(stored
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| AppearancePreferences::from_stored(&value))
        .unwrap_or_default())
}

/// Replaces the whole record; the frontend always sends every preference it owns.
fn save_to(connection: &Connection, preferences: &AppearancePreferences) -> Result<bool, String> {
    if !preferences.is_valid() {
        return Ok(false);
    }
    let value = serde_json::to_string(preferences)
        .map_err(|error| format!("Preferences could not be encoded: {error}"))?;
    connection
        .execute(
            "INSERT INTO preferences (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET
               value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![RECORD_NAME, value],
        )
        .map(|written| written == 1)
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    #[test]
    fn vn_preferences_validate_independently_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let chosen = super::AppearancePreferences {
            reader_view_mode: Some("vn".into()),
            reader_vn_paragraphs: Some(3),
            reader_vn_text_speed: Some(80),
            ..Default::default()
        };
        assert!(super::save(&database, &chosen).unwrap());
        assert_eq!(super::load(&database).unwrap(), chosen);
        for (count, speed) in [(0, 80), (21, 80), (3, -1), (3, 201)] {
            assert!(!super::save(
                &database,
                &super::AppearancePreferences {
                    reader_vn_paragraphs: Some(count),
                    reader_vn_text_speed: Some(speed),
                    ..chosen.clone()
                }
            )
            .unwrap());
            assert_eq!(super::load(&database).unwrap(), chosen);
        }
        let loaded = super::AppearancePreferences::from_stored(&serde_json::json!({
            "readerViewMode": "vn", "readerVnParagraphs": 1.5, "readerVnTextSpeed": 0
        }));
        assert_eq!(loaded.reader_view_mode.as_deref(), Some("vn"));
        assert_eq!(loaded.reader_vn_paragraphs, None);
        assert_eq!(loaded.reader_vn_text_speed, Some(0));
        for (count, speed) in [(1, 0), (20, 200)] {
            assert!(super::save(
                &database,
                &super::AppearancePreferences {
                    reader_vn_paragraphs: Some(count),
                    reader_vn_text_speed: Some(speed),
                    ..chosen.clone()
                }
            )
            .unwrap());
        }
    }

    #[test]
    fn page_layout_and_monitor_sized_extents_persist_and_validate_independently() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for layout in ["single", "double"] {
            let chosen = super::AppearancePreferences {
                reader_page_layout: Some(layout.into()),
                reader_max_width: Some(7680),
                reader_max_height: Some(4320),
                ..Default::default()
            };
            assert!(super::save(&database, &chosen).unwrap());
            assert_eq!(super::load(&database).unwrap(), chosen);
            for (name, value) in [
                ("readerPageLayout", serde_json::json!("auto")),
                ("readerMaxWidth", serde_json::json!(90)),
                ("readerMaxWidth", serde_json::json!(1_000_010)),
                ("readerMaxHeight", serde_json::json!(4325)),
            ] {
                let mut invalid = serde_json::to_value(&chosen).unwrap();
                invalid[name] = value;
                let invalid = serde_json::from_value(invalid).unwrap();
                assert!(!super::save(&database, &invalid).unwrap());
                assert_eq!(super::load(&database).unwrap(), chosen);
            }
        }
        let loaded = super::AppearancePreferences::from_stored(&serde_json::json!({
            "readerMaxWidth": 7680, "readerMaxHeight": 4325, "readerPageLayout": "single"
        }));
        assert_eq!(loaded.reader_max_width, Some(7680));
        assert_eq!(loaded.reader_max_height, None);
        assert_eq!(loaded.reader_page_layout.as_deref(), Some("single"));
    }
    #[test]
    fn paragraph_choices_persist_independently_and_reject_malformed_saves() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for justify in [false, true] {
            for pretty in [false, true] {
                let chosen = super::AppearancePreferences {
                    reader_text_justification: Some(justify),
                    reader_pretty_text_wrap: Some(pretty),
                    ..Default::default()
                };
                assert!(super::save(&database, &chosen).unwrap());
                assert_eq!(super::load(&database).unwrap(), chosen);
                let saved = serde_json::to_value(&chosen).unwrap();
                assert_eq!(saved["readerTextJustification"], justify);
                assert_eq!(saved["readerPrettyTextWrap"], pretty);
                for (field, other) in [
                    ("readerTextJustification", "readerPrettyTextWrap"),
                    ("readerPrettyTextWrap", "readerTextJustification"),
                ] {
                    for bad in [
                        serde_json::json!("true"),
                        serde_json::json!(1),
                        serde_json::json!([]),
                        serde_json::json!({}),
                    ] {
                        let mut value = saved.clone();
                        value[field] = bad;
                        assert!(serde_json::from_value::<super::AppearancePreferences>(
                            value.clone()
                        )
                        .is_err());
                        assert_eq!(super::load(&database).unwrap(), chosen);
                        let loaded =
                            serde_json::to_value(super::AppearancePreferences::from_stored(&value))
                                .unwrap();
                        assert!(loaded.get(field).is_none());
                        assert_eq!(loaded[other], saved[other]);
                    }
                    let mut value = saved.clone();
                    value[field] = serde_json::Value::Null;
                    let loaded =
                        serde_json::to_value(super::AppearancePreferences::from_stored(&value))
                            .unwrap();
                    assert!(loaded.get(field).is_none());
                    assert_eq!(loaded[other], saved[other]);
                }
            }
        }
        let legacy =
            super::AppearancePreferences::from_stored(&serde_json::json!({"readerFontSize": 20}));
        assert!(legacy.reader_text_justification.is_none());
        assert!(legacy.reader_pretty_text_wrap.is_none());
        assert_eq!(legacy.reader_font_size, Some(20));
    }

    #[test]
    fn blur_modes_save_reopen_and_reject_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for mode in ["all", "after-toc"] {
            let chosen = super::AppearancePreferences {
                reader_blur_image: Some(true),
                reader_blur_mode: Some(mode.to_owned()),
                ..Default::default()
            };
            assert!(super::save(&database, &chosen).unwrap());
            assert_eq!(super::load(&database).unwrap(), chosen);
            assert_eq!(
                serde_json::to_value(&chosen).unwrap()["readerBlurMode"],
                mode
            );
            for invalid in ["", "ALL", "after", "toc"] {
                let rejected = super::AppearancePreferences {
                    reader_blur_mode: Some(invalid.to_owned()),
                    ..chosen.clone()
                };
                assert!(!super::save(&database, &rejected).unwrap());
                assert_eq!(super::load(&database).unwrap(), chosen);
            }
        }
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"readerBlurMode": null}),
            serde_json::json!({"readerBlurMode": true}),
            serde_json::json!({"readerBlurMode": 1}),
            serde_json::json!({"readerBlurMode": "invalid"}),
        ] {
            let mut value = invalid;
            value["readerBlurImage"] = serde_json::json!(true);
            let kept = super::AppearancePreferences::from_stored(&value);
            assert!(kept.reader_blur_mode.is_none());
            assert_eq!(kept.reader_blur_image, Some(true));
        }
        assert!(serde_json::from_value::<super::AppearancePreferences>(
            serde_json::json!({"readerBlurMode": true})
        )
        .is_err());
    }

    #[test]
    fn furigana_styles_reopen_and_reject_invalid_values_independently() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for style in ["hide", "partial", "toggle", "full"] {
            for enabled in [true, false] {
                let chosen = super::AppearancePreferences {
                    reader_hide_furigana: Some(enabled),
                    reader_furigana_style: Some(style.to_owned()),
                    ..Default::default()
                };
                assert!(super::save(&database, &chosen).unwrap());
                assert_eq!(super::load(&database).unwrap(), chosen);
                assert_eq!(
                    serde_json::to_value(&chosen).unwrap()["readerFuriganaStyle"],
                    style
                );
                for invalid in ["", "Full", "show", "hover"] {
                    let rejected = super::AppearancePreferences {
                        reader_furigana_style: Some(invalid.to_owned()),
                        ..chosen.clone()
                    };
                    assert!(!super::save(&database, &rejected).unwrap());
                    assert_eq!(super::load(&database).unwrap(), chosen);
                }
            }
        }
        for invalid in [
            serde_json::json!(null),
            serde_json::json!(false),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!("unknown"),
        ] {
            let kept = super::AppearancePreferences::from_stored(
                &serde_json::json!({"readerHideFurigana": true, "readerFuriganaStyle": invalid}),
            );
            assert_eq!(kept.reader_hide_furigana, Some(true));
            assert!(kept.reader_furigana_style.is_none());
        }
        let legacy = super::AppearancePreferences::from_stored(
            &serde_json::json!({"readerHideFurigana": true}),
        );
        assert_eq!(legacy.reader_hide_furigana, Some(true));
        assert!(legacy.reader_furigana_style.is_none());
        assert!(serde_json::from_value::<super::AppearancePreferences>(
            serde_json::json!({"readerFuriganaStyle": true})
        )
        .is_err());
    }
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn font_choices_migrate_and_validate_without_mutating_on_rejection() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let legacy = serde_json::json!({"readerFontFamilyGroup1":"georgia", "readerFontFamilyGroup2":"inter", "readerFontSize":20});
        let migrated = AppearancePreferences::from_stored(&legacy);
        assert_eq!(
            migrated.reader_asian_font,
            Some(FontChoice::Preset {
                id: "georgia".into()
            })
        );
        assert_eq!(
            migrated.reader_western_font,
            Some(FontChoice::Preset { id: "inter".into() })
        );
        assert!(save(&database, &migrated).unwrap());
        assert_eq!(load(&database).unwrap(), migrated);
        let mut chosen = migrated;
        chosen.reader_asian_font = Some(FontChoice::Google {
            id: "zen-old-mincho".into(),
        });
        chosen.reader_western_font = Some(FontChoice::System {
            family: "Arial".into(),
        });
        assert!(save(&database, &chosen).unwrap());
        assert_eq!(load(&database).unwrap(), chosen);
        chosen.reader_western_font = Some(FontChoice::Uploaded { id: "a".repeat(64) });
        assert!(save(&database, &chosen).unwrap());
        assert_eq!(load(&database).unwrap(), chosen);
        for bad in [
            FontChoice::System {
                family: "Arial; color:red".into(),
            },
            FontChoice::Google { id: "url".into() },
            FontChoice::Uploaded {
                id: "../font".into(),
            },
            FontChoice::Preset {
                id: "unknown".into(),
            },
        ] {
            let mut invalid = chosen.clone();
            invalid.reader_asian_font = Some(bad);
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
        }
        let value = serde_json::json!({"readerAsianFont":{"source":"system","family":"a; color:red"}, "readerWesternFont":{"source":"google","id":"literata"}, "readerFontSize":20});
        let kept = AppearancePreferences::from_stored(&value);
        assert!(kept.reader_asian_font.is_none());
        assert_eq!(
            kept.reader_western_font,
            Some(FontChoice::Google {
                id: "literata".into()
            })
        );
        assert_eq!(kept.reader_font_size, Some(20));
    }

    #[test]
    fn font_groups_validate_independently_and_persist_ordered_choices() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for first in READER_SERIF_FONTS {
            for second in READER_SANS_FONTS {
                saved.reader_font_family_group1 = Some(first.into());
                saved.reader_font_family_group2 = Some(second.into());
                saved.reader_asian_font = Some(FontChoice::Preset { id: first.into() });
                saved.reader_western_font = Some(FontChoice::Preset { id: second.into() });
                assert!(save(&database, &saved).unwrap());
                assert_eq!(load(&database).unwrap(), saved);
            }
        }
        for (field, other) in [
            ("readerFontFamilyGroup1", "readerFontFamilyGroup2"),
            ("readerFontFamilyGroup2", "readerFontFamilyGroup1"),
        ] {
            for bad in [
                serde_json::json!("unknown"),
                serde_json::json!("serif; color:red"),
                serde_json::json!(4),
                serde_json::json!([]),
                serde_json::json!({}),
                serde_json::json!(false),
            ] {
                let mut value = serde_json::to_value(&saved).unwrap();
                value[field] = bad;
                if let Ok(invalid) = serde_json::from_value::<AppearancePreferences>(value.clone())
                {
                    assert!(!save(&database, &invalid).unwrap());
                }
                assert_eq!(load(&database).unwrap(), saved);
                let kept =
                    serde_json::to_value(AppearancePreferences::from_stored(&value)).unwrap();
                assert!(kept.get(field).is_none());
                assert_eq!(kept[other], value[other]);
                assert_eq!(kept["readerFontSize"], 20);
            }
        }
        for value in [
            serde_json::json!({}),
            serde_json::json!({
                "readerFontFamilyGroup1": null, "readerFontFamilyGroup2": null
            }),
            serde_json::json!({"readerFontFamilyGroup1": "inter", "readerFontFamilyGroup2": "georgia"}),
        ] {
            let kept = AppearancePreferences::from_stored(&value);
            assert!(kept.reader_font_family_group1.is_none());
            assert!(kept.reader_font_family_group2.is_none());
        }
    }

    #[test]
    fn role_weights_migrate_validate_and_reopen_independently() {
        let migrated =
            AppearancePreferences::from_stored(&serde_json::json!({"readerFontWeight": 600}));
        assert_eq!(migrated.reader_western_font_weight, Some(600));
        assert_eq!(migrated.reader_asian_font_weight, Some(600));
        let mixed = AppearancePreferences::from_stored(
            &serde_json::json!({"readerFontWeight": 600, "readerWesternFontWeight": 450, "readerAsianFontWeight": null}),
        );
        assert_eq!(mixed.reader_western_font_weight, Some(450));
        assert_eq!(mixed.reader_asian_font_weight, None);
        let dir = tempdir().unwrap();
        let database = dir.path().join("library.sqlite3");
        let mut chosen = preferences("dark", "#2f8f83", 200, 20);
        chosen.reader_western_font_weight = Some(400);
        chosen.reader_asian_font_weight = Some(600);
        assert!(save(&database, &chosen).unwrap());
        assert_eq!(load(&database).unwrap(), chosen);
        for bad in [0, 1001] {
            for western in [true, false] {
                let mut invalid = chosen.clone();
                if western {
                    invalid.reader_western_font_weight = Some(bad);
                } else {
                    invalid.reader_asian_font_weight = Some(bad);
                }
                assert!(!save(&database, &invalid).unwrap());
                assert_eq!(load(&database).unwrap(), chosen);
            }
        }
    }

    fn preferences(
        theme: &str,
        accent: &str,
        wheel_step: i64,
        font_size: i64,
    ) -> AppearancePreferences {
        AppearancePreferences {
            reader_popup_shift_lookup: None,
            reader_show_reading_position: None,
            reader_show_percentage: None,
            reader_show_chapter_position: None,
            reader_show_chapter_percentage: None,
            reader_show_clock: None,
            reader_show_reading_time: None,
            reader_show_reading_speed: None,
            statistics_enabled: None,
            statistics_session_start: None,
            statistics_jump_limit: None,
            statistics_idle_minutes: None,
            reader_popup_keyboard_shortcut: None,
            reader_popup_click_lookup: None,
            reader_popup_hover_lookup: None,
            reader_popup_cjk_only: None,
            reader_popup_shortcut_preset: None,
            reader_popup_mouse_trigger: None,
            reader_popup_close_behavior: None,
            reader_popup_hover_delay: None,
            reader_popup_scan_length: None,
            reader_popup_max_results: None,
            reader_popup_child_levels: None,
            reader_popup_reading_position: None,
            reader_popup_style: None,
            reader_popup_font: None,
            reader_popup_enabled: None,
            reader_popup_mouse_selection: None,
            reader_popup_anki_action: None,
            reader_popup_voice_action: None,
            reader_popup_show_dictionary_names: None,
            reader_popup_show_pitch: None,
            reader_popup_show_frequency: None,
            reader_popup_pitch_sources: None,
            reader_popup_frequency_sources: None,
            reader_popup_definition_sources: None,
            reader_popup_custom_palette: None,
            interface_language: None,
            app_icon: None,
            theme: Some(theme.into()),
            app_custom_theme: None,
            library_view: None,
            library_sort: None,
            library_sort_reversed: None,
            library_filter: None,
            library_card_series: None,
            library_card_language: None,
            library_card_last_read: None,
            library_card_kanji: None,
            library_group: None,
            library_card_size: None,
            accent_color: Some(accent.into()),
            reader_wheel_step: Some(wheel_step),
            middle_click_autoscroll: None,
            reader_chapter_wheel_threshold: None,
            reader_font_size: Some(font_size),
            reader_line_height: None,
            reader_asian_font: None,
            reader_western_font: None,
            reader_font_family_group1: None,
            reader_font_family_group2: None,
            reader_font_weight: None,
            reader_western_font_weight: None,
            reader_asian_font_weight: None,
            reader_paragraph_indent: None,
            reader_paragraph_margin: None,
            reader_letter_spacing: None,
            reader_word_spacing: None,
            reader_side_margin: None,
            reader_max_width: None,
            reader_page_layout: None,
            reader_max_height: None,
            reader_popup_theme: None,
            reader_popup_radius: None,
            reader_popup_font_size: None,
            reader_popup_line_height: None,
            reader_popup_width: None,
            reader_popup_height: None,
            reader_writing_mode: None,
            reader_text_orientation: None,
            reader_text_justification: None,
            reader_pretty_text_wrap: None,
            reader_hide_furigana: None,
            reader_furigana_style: None,
            reader_blur_image: None,
            reader_background_blur: None,
            reader_background_blur_level: None,
            reader_blur_mode: None,
            reader_view_mode: None,
            reader_vn_paragraphs: None,
            reader_vn_text_speed: None,
            reader_sidebar_pinned: None,
            reader_theme: None,
            reader_custom_themes: None,
            word_audio_sources: None,
        }
    }

    #[test]
    fn background_blur_is_independent_validated_and_saved_across_reopen() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for blur in [true, false] {
            let preferences = AppearancePreferences {
                reader_background_blur: Some(blur),
                reader_blur_image: Some(!blur),
                ..Default::default()
            };
            assert!(save(&database, &preferences).unwrap());
            assert_eq!(load(&database).unwrap(), preferences);
            assert_eq!(
                serde_json::to_value(&preferences).unwrap()["readerBackgroundBlur"],
                blur
            );
        }
        for invalid in [
            serde_json::json!(1),
            serde_json::json!("true"),
            serde_json::json!({}),
        ] {
            let stored =
                serde_json::json!({ "readerBackgroundBlur": invalid, "readerBlurImage": true });
            assert_eq!(
                AppearancePreferences::from_stored(&stored).reader_background_blur,
                None
            );
            assert!(serde_json::from_value::<AppearancePreferences>(stored).is_err());
        }
        assert_eq!(load(&database).unwrap().reader_background_blur, Some(false));
        assert_eq!(
            AppearancePreferences::from_stored(&serde_json::json!({})).reader_background_blur,
            None
        );
        for level in [0, 1, 16, 40] {
            let chosen = AppearancePreferences {
                reader_background_blur_level: Some(level),
                reader_background_blur: Some(false),
                ..Default::default()
            };
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
        }
        for invalid in [-1, 41, i64::MAX] {
            let chosen = AppearancePreferences {
                reader_background_blur_level: Some(invalid),
                ..Default::default()
            };
            assert!(!save(&database, &chosen).unwrap());
            assert_eq!(
                load(&database).unwrap().reader_background_blur_level,
                Some(40)
            );
            let stored = serde_json::json!({"readerBackgroundBlurLevel": invalid, "readerBackgroundBlur": true});
            let loaded = AppearancePreferences::from_stored(&stored);
            assert_eq!(loaded.reader_background_blur_level, None);
            assert_eq!(loaded.reader_background_blur, Some(true));
        }
        for invalid in [
            serde_json::json!(1.5),
            serde_json::json!("16"),
            serde_json::json!(true),
        ] {
            let stored = serde_json::json!({"readerBackgroundBlurLevel": invalid});
            assert_eq!(
                AppearancePreferences::from_stored(&stored).reader_background_blur_level,
                None
            );
            assert!(serde_json::from_value::<AppearancePreferences>(stored).is_err());
        }
    }

    const DUSK_ID: &str = "0b8a3c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d";

    #[test]
    fn app_icon_saves_reopens_and_validates_independently() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(app_icon(&database), None);
        for icon in crate::app_icon::APP_ICONS {
            let chosen = AppearancePreferences {
                app_icon: Some(icon.into()),
                ..Default::default()
            };
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(app_icon(&database).as_deref(), Some(icon));
        }
        for invalid in ["pink", "", "Navy"] {
            let refused = AppearancePreferences {
                app_icon: Some(invalid.into()),
                ..Default::default()
            };
            assert!(!save(&database, &refused).unwrap());
            assert_eq!(app_icon(&database).as_deref(), Some("sunrise"));
        }
        let stored = serde_json::json!({ "appIcon": "pink", "theme": "light" });
        let loaded = AppearancePreferences::from_stored(&stored);
        assert_eq!(loaded.app_icon, None);
        assert_eq!(loaded.theme.as_deref(), Some("light"));
    }

    #[test]
    fn interface_language_saves_reopens_and_validates_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        // Nothing saved reads English.
        assert_eq!(interface_language(&database), "en");
        for language in crate::interface_text::LANGUAGES {
            let chosen = AppearancePreferences {
                interface_language: Some(language.into()),
                theme: Some("dark".into()),
                ..Default::default()
            };
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
            assert_eq!(interface_language(&database), language);
            assert_eq!(
                serde_json::to_value(&chosen).unwrap()["interfaceLanguage"],
                language
            );
            for invalid in ["fr", "pt", "zh", "zh-TW", "JA", ""] {
                assert!(!save(
                    &database,
                    &AppearancePreferences {
                        interface_language: Some(invalid.into()),
                        ..chosen.clone()
                    }
                )
                .unwrap());
                assert_eq!(load(&database).unwrap(), chosen);
            }
        }
        // A stored invalid language loads as absent and keeps the other fields.
        let connection = open_catalog(&database).unwrap();
        for record in [
            r#"{"interfaceLanguage":"fr","theme":"dark"}"#,
            r#"{"interfaceLanguage":7,"theme":"dark"}"#,
        ] {
            connection
                .execute(
                    "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                    [record],
                )
                .unwrap();
            let loaded = load_from(&connection).unwrap();
            assert_eq!(loaded.interface_language, None);
            assert_eq!(loaded.theme.as_deref(), Some("dark"));
            assert_eq!(interface_language(&database), "en");
        }
    }

    #[test]
    fn scrolling_choices_persist_and_validate_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for (enabled, threshold) in [(true, 1), (false, 3), (true, 20)] {
            let chosen = AppearancePreferences {
                middle_click_autoscroll: Some(enabled),
                reader_chapter_wheel_threshold: Some(threshold),
                ..Default::default()
            };
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
            let json = serde_json::to_value(&chosen).unwrap();
            assert_eq!(json["middleClickAutoscroll"], enabled);
            assert_eq!(json["readerChapterWheelThreshold"], threshold);
            for invalid in [0, 21, -1] {
                assert!(!save(
                    &database,
                    &AppearancePreferences {
                        reader_chapter_wheel_threshold: Some(invalid),
                        ..chosen.clone()
                    }
                )
                .unwrap());
                assert_eq!(load(&database).unwrap(), chosen);
            }
        }
        for invalid in [
            serde_json::json!({"middleClickAutoscroll": "no"}),
            serde_json::json!({"readerChapterWheelThreshold": 1.5}),
        ] {
            assert!(serde_json::from_value::<AppearancePreferences>(invalid).is_err());
        }
        let connection = open_catalog(&database).unwrap();
        for (record, enabled, threshold) in [
            (
                r#"{"middleClickAutoscroll":false,"readerChapterWheelThreshold":21}"#,
                Some(false),
                None,
            ),
            (
                r#"{"middleClickAutoscroll":1,"readerChapterWheelThreshold":4}"#,
                None,
                Some(4),
            ),
            (r#"{"theme":"dark"}"#, None, None),
        ] {
            connection
                .execute(
                    "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                    [record],
                )
                .unwrap();
            let loaded = load_from(&connection).unwrap();
            assert_eq!(loaded.middle_click_autoscroll, enabled);
            assert_eq!(loaded.reader_chapter_wheel_threshold, threshold);
        }
    }

    #[test]
    fn reader_footer_choices_save_reopen_and_validate_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let fields = [
            "readerShowReadingPosition",
            "readerShowPercentage",
            "readerShowChapterPosition",
            "readerShowChapterPercentage",
            "readerShowClock",
            "readerShowReadingTime",
            "readerShowReadingSpeed",
        ];
        let mut value = serde_json::to_value(preferences("dark", "#5874df", 100, 16)).unwrap();
        for field in fields {
            for enabled in [false, true] {
                value[field] = serde_json::json!(enabled);
                let saved: AppearancePreferences = serde_json::from_value(value.clone()).unwrap();
                assert!(save(&database, &saved).unwrap());
                assert_eq!(load(&database).unwrap(), saved);
                assert_eq!(
                    serde_json::to_value(load(&database).unwrap()).unwrap()[field],
                    enabled
                );
            }
            for invalid in [
                serde_json::json!("false"),
                serde_json::json!(0),
                serde_json::json!([]),
                serde_json::json!({}),
            ] {
                let mut bad = value.clone();
                bad[field] = invalid;
                assert!(serde_json::from_value::<AppearancePreferences>(bad.clone()).is_err());
                assert_eq!(
                    serde_json::to_value(load(&database).unwrap()).unwrap(),
                    value
                );
                let mut expected = value.clone();
                expected.as_object_mut().unwrap().remove(field);
                assert_eq!(
                    serde_json::to_value(AppearancePreferences::from_stored(&bad)).unwrap(),
                    expected
                );
            }
            for absent in [serde_json::json!({}), serde_json::json!({(field): null})] {
                assert!(
                    serde_json::to_value(AppearancePreferences::from_stored(&absent))
                        .unwrap()
                        .get(field)
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn popup_source_roles_validate_independently_and_save_reopen() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let fields = [
            "readerPopupDefinitionSources",
            "readerPopupFrequencySources",
            "readerPopupPitchSources",
        ];
        for field in fields {
            for choice in [
                serde_json::json!({"mode":"all"}),
                serde_json::json!({"mode":"none"}),
                serde_json::json!({"mode":"selected","ids":[]}),
                serde_json::json!({"mode":"selected","ids":[1,9007199254740991_i64]}),
            ] {
                let mut json =
                    serde_json::to_value(preferences("dark", "#5874df", 100, 16)).unwrap();
                json[field] = choice.clone();
                let saved: AppearancePreferences = serde_json::from_value(json).unwrap();
                save(&database, &saved).unwrap();
                assert_eq!(
                    serde_json::to_value(load(&database).unwrap()).unwrap()[field],
                    choice
                );
                for invalid in [
                    serde_json::json!({"mode":"selected","ids":[0]}),
                    serde_json::json!({"mode":"selected","ids":[1,1]}),
                    serde_json::json!({"mode":"selected","ids":[1.5]}),
                    serde_json::json!({"mode":"selected","ids":[9007199254740992_i64]}),
                    serde_json::json!({"mode":"selected","ids":(1..=129).collect::<Vec<_>>()}),
                    serde_json::json!({"mode":"unknown"}),
                    serde_json::json!({"mode":"all","ids":[]}),
                ] {
                    let mut json = serde_json::to_value(&saved).unwrap();
                    json[field] = invalid;
                    if let Ok(bad) = serde_json::from_value::<AppearancePreferences>(json.clone()) {
                        assert!(!save(&database, &bad).unwrap());
                    }
                    assert_eq!(load(&database).unwrap(), saved);
                    let kept =
                        serde_json::to_value(AppearancePreferences::from_stored(&json)).unwrap();
                    assert!(kept.get(field).is_none());
                    assert_eq!(
                        kept["theme"],
                        serde_json::to_value(&saved).unwrap()["theme"]
                    );
                }
            }
            assert!(
                serde_json::to_value(AppearancePreferences::from_stored(&serde_json::json!({})))
                    .unwrap()
                    .get(field)
                    .is_none()
            );
        }
    }

    #[test]
    fn retired_pitch_placement_is_ignored_and_visibility_defaults_independently() {
        let kept = AppearancePreferences::from_stored(&serde_json::json!({
            "readerPopupPitchBeforeDefinitions": false,
            "readerPopupShowPitch": false,
            "readerPopupShowFrequency": "false",
            "theme": "dark"
        }));
        assert_eq!(kept.reader_popup_show_pitch, Some(false));
        assert_eq!(kept.reader_popup_show_frequency, None);
        assert_eq!(kept.theme, Some("dark".into()));
        assert!(serde_json::to_value(&kept)
            .unwrap()
            .get("readerPopupPitchBeforeDefinitions")
            .is_none());
    }

    #[test]
    fn popup_enabled_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_enabled = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupEnabled"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupEnabled"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_enabled, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupEnabled": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_enabled,
                None
            );
        }
    }

    #[test]
    fn popup_style_and_font_persist_independently_and_reject_invalid_values() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = AppearancePreferences {
            reader_popup_radius: Some(7),
            ..Default::default()
        };
        for (style, font) in [
            (
                "dictionary",
                FontChoice::Google {
                    id: "zen-old-mincho".into(),
                },
            ),
            (
                "standard",
                FontChoice::System {
                    family: "Yu Mincho".into(),
                },
            ),
        ] {
            saved.reader_popup_style = Some(style.into());
            saved.reader_popup_font = Some(font);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            let stored = serde_json::to_value(&saved).unwrap();
            assert_eq!(stored["readerPopupStyle"], style);
        }
        for invalid in [
            AppearancePreferences {
                reader_popup_style: Some("compact".into()),
                ..saved.clone()
            },
            AppearancePreferences {
                reader_popup_font: Some(FontChoice::System {
                    family: "a; color:red".into(),
                }),
                ..saved.clone()
            },
            AppearancePreferences {
                reader_popup_font: Some(FontChoice::Google {
                    id: "missing".into(),
                }),
                ..saved.clone()
            },
        ] {
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        for (key, value) in [
            ("readerPopupStyle", serde_json::json!("Dictionary")),
            ("readerPopupStyle", serde_json::json!(1)),
            ("readerPopupFont", serde_json::json!("zen-old-mincho")),
            (
                "readerPopupFont",
                serde_json::json!({"source": "preset", "id": "missing"}),
            ),
        ] {
            let mut stored = serde_json::to_value(&saved).unwrap();
            stored[key] = value;
            let kept = AppearancePreferences::from_stored(&stored);
            assert_eq!(kept.reader_popup_radius, Some(7));
            if key == "readerPopupStyle" {
                assert_eq!(kept.reader_popup_style, None);
                assert_eq!(kept.reader_popup_font, saved.reader_popup_font);
            } else {
                assert_eq!(kept.reader_popup_font, None);
                assert_eq!(kept.reader_popup_style, saved.reader_popup_style);
            }
        }
    }

    #[test]
    fn popup_triggers_validate_independently_and_persist() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for (field, values) in [
            ("readerPopupShiftLookup", serde_json::json!([false, true])),
            (
                "readerPopupKeyboardShortcut",
                serde_json::json!([false, true]),
            ),
            ("readerPopupClickLookup", serde_json::json!([false, true])),
            ("readerPopupHoverLookup", serde_json::json!([false, true])),
            ("readerPopupCjkOnly", serde_json::json!([false, true])),
            (
                "readerPopupShortcutPreset",
                serde_json::json!(["shift-enter", "alt-x", "ctrl-space"]),
            ),
            (
                "readerPopupMouseTrigger",
                serde_json::json!(["left", "double", "shift-right", "middle"]),
            ),
            (
                "readerPopupCloseBehavior",
                serde_json::json!(["escape-outside", "outside", "persistent"]),
            ),
            ("readerPopupHoverDelay", serde_json::json!([0, 420, 1200])),
            ("readerPopupScanLength", serde_json::json!([1, 16, 64])),
            ("readerPopupMaxResults", serde_json::json!([1, 32, 64])),
            ("readerPopupChildLevels", serde_json::json!([0, 2, 5])),
            (
                "readerPopupReadingPosition",
                serde_json::json!(["beside", "above"]),
            ),
        ] {
            for value in values.as_array().unwrap() {
                let mut json = serde_json::to_value(&saved).unwrap();
                json[field] = value.clone();
                saved = serde_json::from_value(json).unwrap();
                assert!(save(&database, &saved).unwrap());
                assert_eq!(load(&database).unwrap(), saved);
                assert_eq!(
                    serde_json::to_value(load(&database).unwrap()).unwrap()[field],
                    *value
                );
            }
            for invalid in [
                serde_json::json!({}),
                serde_json::json!([]),
                serde_json::json!("unknown"),
                serde_json::json!(-1),
                serde_json::json!(1201),
                serde_json::json!(420.5),
            ] {
                let mut json = serde_json::to_value(&saved).unwrap();
                json[field] = invalid;
                if let Ok(preferences) =
                    serde_json::from_value::<AppearancePreferences>(json.clone())
                {
                    assert!(!save(&database, &preferences).unwrap());
                }
                assert_eq!(load(&database).unwrap(), saved);
                let kept = serde_json::to_value(AppearancePreferences::from_stored(&json)).unwrap();
                assert!(kept.get(field).is_none());
                assert_eq!(kept["theme"], "dark");
                json[field] = Value::Null;
                assert!(
                    serde_json::to_value(AppearancePreferences::from_stored(&json))
                        .unwrap()
                        .get(field)
                        .is_none()
                );
            }
        }
        assert_eq!(
            AppearancePreferences::from_stored(&serde_json::json!({})),
            AppearancePreferences::default()
        );
    }

    #[test]
    fn popup_mouse_selection_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_mouse_selection = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupMouseSelection"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupMouseSelection"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_mouse_selection, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupMouseSelection": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_mouse_selection,
                None
            );
        }
    }

    #[test]
    fn popup_anki_action_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_anki_action = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupAnkiAction"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupAnkiAction"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_anki_action, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupAnkiAction": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_anki_action,
                None
            );
        }
    }

    #[test]
    fn word_audio_sources_persist_and_invalid_ones_are_refused_or_dropped() {
        use crate::word_audio::AudioSource;
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(word_audio_sources(&database), None);
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        saved.word_audio_sources = Some(vec![
            AudioSource::List {
                url: "http://localhost:5050/?term={term}&reading={reading}".into(),
            },
            AudioSource::JapanesePod101,
        ]);
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        assert_eq!(word_audio_sources(&database), saved.word_audio_sources);
        // An empty list is a choice too: Voice then has nothing to play.
        saved.word_audio_sources = Some(vec![]);
        assert!(save(&database, &saved).unwrap());
        assert_eq!(word_audio_sources(&database), Some(vec![]));

        let mut invalid = saved.clone();
        invalid.word_audio_sources = Some(vec![AudioSource::Url {
            url: "file:///C:/audio/{term}.mp3".into(),
        }]);
        assert!(!save(&database, &invalid).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        for stored in [
            serde_json::json!([{"kind": "url", "url": "file:///C:/{term}"}]),
            serde_json::json!([{"kind": "jpod101"}, {"kind": "jpod101"}]),
            serde_json::json!([{"kind": "other"}]),
            serde_json::json!("jpod101"),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["wordAudioSources"] = stored;
            // A field Komori no longer has is ignored.
            value["wordAudioVoice"] = serde_json::json!(true);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.word_audio_sources, None);
            assert_eq!(kept.theme, saved.theme);
        }
    }

    #[test]
    fn popup_voice_action_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_voice_action = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupVoiceAction"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupVoiceAction"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_voice_action, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupVoiceAction": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_voice_action,
                None
            );
        }
    }

    #[test]
    fn popup_pitch_visibility_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_show_pitch = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupShowPitch"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupShowPitch"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_show_pitch, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupShowPitch": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_show_pitch,
                None
            );
        }
    }

    #[test]
    fn popup_frequency_visibility_persists_and_only_accepts_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_show_frequency = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupShowFrequency"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupShowFrequency"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_show_frequency, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupShowFrequency": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_show_frequency,
                None
            );
        }
    }

    #[test]
    fn popup_dictionary_names_persist_and_only_accept_booleans() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#2f8f83", 200, 20);
        for enabled in [false, true] {
            saved.reader_popup_show_dictionary_names = Some(enabled);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupShowDictionaryNames"],
                enabled
            );
        }
        for invalid in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let mut value = serde_json::to_value(&saved).unwrap();
            value["readerPopupShowDictionaryNames"] = invalid;
            assert!(serde_json::from_value::<AppearancePreferences>(value.clone()).is_err());
            assert_eq!(load(&database).unwrap(), saved);
            let kept = AppearancePreferences::from_stored(&value);
            assert_eq!(kept.reader_popup_show_dictionary_names, None);
            assert_eq!(kept.theme, saved.theme);
            assert_eq!(kept.reader_font_size, saved.reader_font_size);
        }
        for legacy in [
            serde_json::json!({}),
            serde_json::json!({"readerPopupShowDictionaryNames": null}),
        ] {
            assert_eq!(
                AppearancePreferences::from_stored(&legacy).reader_popup_show_dictionary_names,
                None
            );
        }
    }

    #[test]
    fn custom_popup_palette_validates_and_persists_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let palette = serde_json::json!({ "background": "#121826", "text": "#eaf0ff", "accent": "#80A0FF", "border": "#405070", "tag": "#253040", "css": "ignored" });
        let mut saved = AppearancePreferences::from_stored(&serde_json::json!({
            "readerPopupCustomPalette": palette, "readerPopupTheme": "custom", "readerPopupWidth": 800,
            "readerPopupHeight": 600, "readerPopupRadius": 7, "theme": "dark", "readerTheme": "sepia"
        }));
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        let serialized = serde_json::to_value(&saved).unwrap();
        assert_eq!(serialized["readerPopupCustomPalette"]["accent"], "#80A0FF");
        assert!(serialized["readerPopupCustomPalette"].get("css").is_none());
        for field in ["background", "text", "accent", "border", "tag"] {
            for value in [
                serde_json::json!(null),
                serde_json::json!(true),
                serde_json::json!(42),
                serde_json::json!("red"),
                serde_json::json!("#abc"),
                serde_json::json!("#1234567"),
                serde_json::json!("url(x)"),
            ] {
                let mut invalid = serialized.clone();
                invalid["readerPopupCustomPalette"][field] = value;
                if let Ok(request) =
                    serde_json::from_value::<AppearancePreferences>(invalid.clone())
                {
                    assert!(!save(&database, &request).unwrap());
                }
                assert_eq!(load(&database).unwrap(), saved);
                let kept = AppearancePreferences::from_stored(&invalid);
                assert_eq!(kept.reader_popup_custom_palette, None);
                assert_eq!(kept.reader_popup_theme.as_deref(), Some("custom"));
                assert_eq!(kept.reader_popup_radius, Some(7));
            }
            let mut missing = serialized.clone();
            missing["readerPopupCustomPalette"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(serde_json::from_value::<AppearancePreferences>(missing.clone()).is_err());
            assert_eq!(
                AppearancePreferences::from_stored(&missing).reader_popup_custom_palette,
                None
            );
        }
        for theme in READER_POPUP_THEMES {
            saved.reader_popup_theme = Some(theme.into());
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        assert_eq!(
            AppearancePreferences::from_stored(&serde_json::json!({})).reader_popup_custom_palette,
            None
        );
    }

    #[test]
    fn popup_text_size_and_line_height_persist_independently_and_reject_invalid_values() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = AppearancePreferences {
            reader_popup_radius: Some(7),
            ..Default::default()
        };
        for (size, line_height) in [(8, 1.0), (15, 1.6), (48, 3.0), (22, 2.05)] {
            saved.reader_popup_font_size = Some(size);
            saved.reader_popup_line_height = Some(line_height);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            let stored = serde_json::to_value(&saved).unwrap();
            assert_eq!(stored["readerPopupFontSize"], size);
            assert_eq!(stored["readerPopupLineHeight"], line_height);
        }
        for invalid in [
            AppearancePreferences {
                reader_popup_font_size: Some(7),
                ..saved.clone()
            },
            AppearancePreferences {
                reader_popup_font_size: Some(49),
                ..saved.clone()
            },
            AppearancePreferences {
                reader_popup_line_height: Some(0.95),
                ..saved.clone()
            },
            AppearancePreferences {
                reader_popup_line_height: Some(1.62),
                ..saved.clone()
            },
        ] {
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        for (key, value) in [
            ("readerPopupFontSize", serde_json::json!("15")),
            ("readerPopupFontSize", serde_json::json!(15.5)),
            ("readerPopupFontSize", serde_json::json!(60)),
            ("readerPopupLineHeight", serde_json::json!(null)),
            ("readerPopupLineHeight", serde_json::json!(3.05)),
            ("readerPopupLineHeight", serde_json::json!("1.6")),
        ] {
            let mut stored = serde_json::to_value(&saved).unwrap();
            stored[key] = value;
            let kept = AppearancePreferences::from_stored(&stored);
            assert_eq!(kept.reader_popup_radius, Some(7));
            if key == "readerPopupFontSize" {
                assert_eq!(kept.reader_popup_font_size, None);
                assert_eq!(
                    kept.reader_popup_line_height,
                    saved.reader_popup_line_height
                );
            } else {
                assert_eq!(kept.reader_popup_line_height, None);
                assert_eq!(kept.reader_popup_font_size, saved.reader_popup_font_size);
            }
        }
    }

    #[test]
    fn popup_radius_persists_independently_and_rejects_invalid_saves() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = AppearancePreferences {
            reader_popup_theme: Some("night".into()),
            reader_popup_width: Some(800),
            reader_popup_height: Some(600),
            ..Default::default()
        };
        for radius in 0..=28 {
            saved.reader_popup_radius = Some(radius);
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupRadius"],
                radius
            );
        }
        for radius in [-1, 29, i64::MAX] {
            let invalid = AppearancePreferences {
                reader_popup_radius: Some(radius),
                ..saved.clone()
            };
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        for value in [
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!("18"),
            serde_json::json!(18.5),
            serde_json::json!(-1),
            serde_json::json!(29),
        ] {
            let mut stored = serde_json::to_value(&saved).unwrap();
            stored["readerPopupRadius"] = value;
            let kept = AppearancePreferences::from_stored(&stored);
            assert_eq!(kept.reader_popup_radius, None);
            assert_eq!(kept.reader_popup_theme, saved.reader_popup_theme);
            assert_eq!(kept.reader_popup_width, saved.reader_popup_width);
            assert_eq!(kept.reader_popup_height, saved.reader_popup_height);
        }
        assert_eq!(
            AppearancePreferences::from_stored(&serde_json::json!({})).reader_popup_radius,
            None
        );
        saved.reader_popup_radius = None;
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
    }

    #[test]
    fn popup_themes_persist_independently_and_reject_invalid_saves() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let mut saved = preferences("dark", "#123456", 100, 16);
        saved.reader_theme = Some("sepia".into());
        for theme in READER_POPUP_THEMES {
            saved.reader_popup_theme = Some(theme.into());
            assert!(save(&database, &saved).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
            assert_eq!(
                serde_json::to_value(&saved).unwrap()["readerPopupTheme"],
                theme
            );
        }
        for theme in ["", "Night", "Custom", "unknown", " paper "] {
            let invalid = AppearancePreferences {
                reader_popup_theme: Some(theme.into()),
                ..saved.clone()
            };
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        for value in [
            serde_json::json!(null),
            serde_json::json!(123),
            serde_json::json!(true),
            serde_json::json!("Night"),
            serde_json::json!("Custom"),
        ] {
            let kept = AppearancePreferences::from_stored(
                &serde_json::json!({ "readerPopupTheme": value, "theme": "dark", "readerTheme": "sepia", "readerPopupWidth": 640 }),
            );
            assert_eq!(kept.reader_popup_theme, None);
            assert_eq!(kept.theme.as_deref(), Some("dark"));
            assert_eq!(kept.reader_theme.as_deref(), Some("sepia"));
            assert_eq!(kept.reader_popup_width, Some(640));
        }
        assert_eq!(
            AppearancePreferences::from_stored(&serde_json::json!({})).reader_popup_theme,
            None
        );
        saved.reader_popup_theme = None;
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
    }

    #[test]
    fn popup_sizes_persist_and_invalid_saves_leave_the_record_unchanged() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let saved = AppearancePreferences {
            reader_popup_width: Some(800),
            reader_popup_height: Some(600),
            ..Default::default()
        };
        save(&database, &saved).unwrap();
        assert_eq!(load(&database).unwrap(), saved);
        for size in [0, 319, 481, 1220] {
            let invalid = AppearancePreferences {
                reader_popup_width: Some(size),
                ..saved.clone()
            };
            assert!(!save(&database, &invalid).unwrap());
            let invalid = AppearancePreferences {
                reader_popup_height: Some(size),
                ..saved.clone()
            };
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        for (width, height) in [(320, 200), (1200, 1200)] {
            let limits = AppearancePreferences {
                reader_popup_width: Some(width),
                reader_popup_height: Some(height),
                ..Default::default()
            };
            save(&database, &limits).unwrap();
            assert_eq!(load(&database).unwrap(), limits);
        }
        let kept = AppearancePreferences::from_stored(
            &serde_json::json!({ "readerPopupWidth": 481, "readerPopupHeight": 600 }),
        );
        assert_eq!(kept.reader_popup_width, None);
        assert_eq!(kept.reader_popup_height, Some(600));
    }

    fn custom_theme(id: &str, name: &str) -> ReaderCustomTheme {
        ReaderCustomTheme {
            id: id.into(),
            name: name.into(),
            background: "#101820".into(),
            text: "#f0e6d2".into(),
            selection: "#445566".into(),
            highlight: "#445566".into(),
            footer_text: "#A09880".into(),
        }
    }

    fn with_themes(theme: &str, custom_themes: Vec<ReaderCustomTheme>) -> AppearancePreferences {
        AppearancePreferences {
            reader_theme: Some(theme.into()),
            reader_custom_themes: Some(custom_themes),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    /// A theme ID for each index, all valid and distinct.
    fn theme_id(index: usize) -> String {
        format!("0b8a3c2e-4d5f-4a6b-8c7d-9e0f1a2b{index:04x}")
    }

    fn with_line_height(line_height: f64) -> AppearancePreferences {
        AppearancePreferences {
            reader_line_height: Some(line_height),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_font_weight(weight: i64) -> AppearancePreferences {
        AppearancePreferences {
            reader_font_weight: Some(weight),
            reader_western_font_weight: Some(weight),
            reader_asian_font_weight: Some(weight),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_paragraph_indent(indent: f64) -> AppearancePreferences {
        AppearancePreferences {
            reader_paragraph_indent: Some(indent),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_paragraph_margin(margin: i64) -> AppearancePreferences {
        AppearancePreferences {
            reader_paragraph_margin: Some(margin),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_side_margin(margin: i64) -> AppearancePreferences {
        AppearancePreferences {
            reader_side_margin: Some(margin),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_max_height(height: i64) -> AppearancePreferences {
        AppearancePreferences {
            reader_max_height: Some(height),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_writing_mode(mode: &str) -> AppearancePreferences {
        AppearancePreferences {
            reader_writing_mode: Some(mode.into()),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_text_orientation(orientation: &str) -> AppearancePreferences {
        AppearancePreferences {
            reader_text_orientation: Some(orientation.into()),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    fn with_view_mode(mode: &str) -> AppearancePreferences {
        AppearancePreferences {
            reader_view_mode: Some(mode.into()),
            ..preferences("dark", "#2f8f83", 200, 20)
        }
    }

    #[test]
    fn saves_and_restores_the_latest_preferences_across_reopen() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        assert_eq!(load(&database).unwrap(), AppearancePreferences::default());

        assert!(save(&database, &preferences("light", "#5874df", 100, 16)).unwrap());
        assert!(save(&database, &preferences("dark", "#D06D76", 500, 28)).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#D06D76", 500, 28)
        );
        assert_eq!(
            serde_json::to_value(preferences("dark", "#d06d76", 500, 28)).unwrap(),
            serde_json::json!({
                "theme": "dark",
                "accentColor": "#d06d76",
                "readerWheelStep": 500,
                "readerFontSize": 28
            })
        );

        // A chosen line height is kept, and returning to the book's own removes it.
        assert!(save(&database, &with_line_height(1.65)).unwrap());
        assert_eq!(load(&database).unwrap(), with_line_height(1.65));
        assert_eq!(
            serde_json::to_value(with_line_height(1.65)).unwrap()["readerLineHeight"],
            serde_json::json!(1.65)
        );
        let book_own: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerLineHeight": null
        }))
        .unwrap();
        assert!(save(&database, &book_own).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen font weight is kept, and returning to the book's own removes it.
        assert!(save(&database, &with_font_weight(600)).unwrap());
        assert_eq!(load(&database).unwrap(), with_font_weight(600));
        assert_eq!(
            serde_json::to_value(with_font_weight(600)).unwrap()["readerFontWeight"],
            serde_json::json!(600)
        );
        let book_weights: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerFontWeight": null
        }))
        .unwrap();
        assert!(save(&database, &book_weights).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen paragraph indentation is kept, and returning to the book's own removes it.
        assert!(save(&database, &with_paragraph_indent(2.5)).unwrap());
        assert_eq!(load(&database).unwrap(), with_paragraph_indent(2.5));
        assert_eq!(
            serde_json::to_value(with_paragraph_indent(2.5)).unwrap()["readerParagraphIndent"],
            serde_json::json!(2.5)
        );
        let book_indent: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerParagraphIndent": null
        }))
        .unwrap();
        assert!(save(&database, &book_indent).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A pinned sidebar is kept, as is unpinning it.
        let pinned = AppearancePreferences {
            reader_sidebar_pinned: Some(true),
            ..preferences("dark", "#2f8f83", 200, 20)
        };
        assert!(save(&database, &pinned).unwrap());
        assert_eq!(load(&database).unwrap(), pinned);
        assert_eq!(
            serde_json::to_value(&pinned).unwrap()["readerSidebarPinned"],
            serde_json::json!(true)
        );
        let unpinned = AppearancePreferences {
            reader_sidebar_pinned: Some(false),
            ..preferences("dark", "#2f8f83", 200, 20)
        };
        assert!(save(&database, &unpinned).unwrap());
        assert_eq!(load(&database).unwrap(), unpinned);

        // Hidden furigana is kept, as is showing it again.
        for hide in [true, false] {
            let furigana = AppearancePreferences {
                reader_hide_furigana: Some(hide),
                ..preferences("dark", "#2f8f83", 200, 20)
            };
            assert!(save(&database, &furigana).unwrap());
            assert_eq!(load(&database).unwrap(), furigana);
            assert_eq!(
                serde_json::to_value(&furigana).unwrap()["readerHideFurigana"],
                serde_json::json!(hide)
            );
        }
        // Only a boolean is accepted from the frontend.
        assert!(
            serde_json::from_value::<AppearancePreferences>(serde_json::json!({
                "readerHideFurigana": "yes"
            }))
            .is_err()
        );

        // Blurred images are kept, as is showing them again.
        for blur in [true, false] {
            let images = AppearancePreferences {
                reader_blur_image: Some(blur),
                ..preferences("dark", "#2f8f83", 200, 20)
            };
            assert!(save(&database, &images).unwrap());
            assert_eq!(load(&database).unwrap(), images);
            assert_eq!(
                serde_json::to_value(&images).unwrap()["readerBlurImage"],
                serde_json::json!(blur)
            );
        }
        // Only a boolean is accepted from the frontend.
        assert!(
            serde_json::from_value::<AppearancePreferences>(serde_json::json!({
                "readerBlurImage": 1
            }))
            .is_err()
        );

        // A chosen paragraph margin is kept, and returning to the book's own removes it.
        for margin in [0, 24] {
            assert!(save(&database, &with_paragraph_margin(margin)).unwrap());
            assert_eq!(load(&database).unwrap(), with_paragraph_margin(margin));
        }
        assert_eq!(
            serde_json::to_value(with_paragraph_margin(24)).unwrap()["readerParagraphMargin"],
            serde_json::json!(24)
        );
        let book_paragraph_margin: AppearancePreferences =
            serde_json::from_value(serde_json::json!({
                "theme": "dark",
                "accentColor": "#2f8f83",
                "readerWheelStep": 200,
                "readerFontSize": 20,
                "readerParagraphMargin": null
            }))
            .unwrap();
        assert!(save(&database, &book_paragraph_margin).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen side margin is kept, and returning to automatic margins removes it.
        assert!(save(&database, &with_side_margin(96)).unwrap());
        assert_eq!(load(&database).unwrap(), with_side_margin(96));
        assert_eq!(
            serde_json::to_value(with_side_margin(96)).unwrap()["readerSideMargin"],
            serde_json::json!(96)
        );
        let automatic_margin: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerSideMargin": null
        }))
        .unwrap();
        assert!(save(&database, &automatic_margin).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen max height is kept, and returning to the full height removes it.
        assert!(save(&database, &with_max_height(720)).unwrap());
        assert_eq!(load(&database).unwrap(), with_max_height(720));
        assert_eq!(
            serde_json::to_value(with_max_height(720)).unwrap()["readerMaxHeight"],
            serde_json::json!(720)
        );
        let full_height: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerMaxHeight": null
        }))
        .unwrap();
        assert!(save(&database, &full_height).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen writing mode is kept, and returning to the book's own removes it.
        for mode in ["vertical", "horizontal"] {
            assert!(save(&database, &with_writing_mode(mode)).unwrap());
            assert_eq!(load(&database).unwrap(), with_writing_mode(mode));
        }
        assert_eq!(
            serde_json::to_value(with_writing_mode("vertical")).unwrap()["readerWritingMode"],
            serde_json::json!("vertical")
        );
        let book_mode: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerWritingMode": null
        }))
        .unwrap();
        assert!(save(&database, &book_mode).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A chosen text orientation is kept, and returning to the book's own removes it.
        for orientation in ["upright", "mixed"] {
            assert!(save(&database, &with_text_orientation(orientation)).unwrap());
            assert_eq!(load(&database).unwrap(), with_text_orientation(orientation));
        }
        assert_eq!(
            serde_json::to_value(with_text_orientation("upright")).unwrap()
                ["readerTextOrientation"],
            serde_json::json!("upright")
        );
        let book_orientation: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerTextOrientation": null
        }))
        .unwrap();
        assert!(save(&database, &book_orientation).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );

        // A view mode is kept, and a null one removes it, leaving books paginated.
        for mode in ["continuous", "semi-continuous", "paginated"] {
            assert!(save(&database, &with_view_mode(mode)).unwrap());
            assert_eq!(load(&database).unwrap(), with_view_mode(mode));
        }
        assert_eq!(
            serde_json::to_value(with_view_mode("continuous")).unwrap()["readerViewMode"],
            serde_json::json!("continuous")
        );
        let default_view: AppearancePreferences = serde_json::from_value(serde_json::json!({
            "theme": "dark",
            "accentColor": "#2f8f83",
            "readerWheelStep": 200,
            "readerFontSize": 20,
            "readerViewMode": null
        }))
        .unwrap();
        assert!(save(&database, &default_view).unwrap());
        assert_eq!(
            load(&database).unwrap(),
            preferences("dark", "#2f8f83", 200, 20)
        );
    }

    #[test]
    fn saves_app_themes_and_library_choices_and_keeps_valid_stored_ones() {
        let directory = tempdir().unwrap();
        let connection = open_catalog(&directory.path().join("library.sqlite3")).unwrap();
        let custom = AppCustomTheme {
            base: "dark".into(),
            background: "#101820".into(),
            surface: "#18222c".into(),
            text: "#f0e6d2".into(),
        };
        let chosen = AppearancePreferences {
            app_custom_theme: Some(custom.clone()),
            library_view: Some("list".into()),
            library_sort: Some("progress".into()),
            library_sort_reversed: Some(true),
            library_filter: Some("reading".into()),
            library_card_series: Some(false),
            library_card_language: Some(true),
            library_card_last_read: Some(true),
            library_card_kanji: Some(false),
            library_group: Some("series".into()),
            library_card_size: Some(240),
            ..preferences("custom", "#2f8f83", 200, 20)
        };
        assert!(save_to(&connection, &chosen).unwrap());
        assert_eq!(load_from(&connection).unwrap(), chosen);
        for theme in APP_THEMES {
            assert!(save_to(&connection, &preferences(theme, "#2f8f83", 200, 20)).unwrap());
        }
        assert!(save_to(&connection, &chosen).unwrap());

        for invalid in [
            AppearancePreferences {
                app_custom_theme: Some(AppCustomTheme {
                    base: "sepia".into(),
                    ..custom.clone()
                }),
                ..chosen.clone()
            },
            AppearancePreferences {
                app_custom_theme: Some(AppCustomTheme {
                    text: "red".into(),
                    ..custom.clone()
                }),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_view: Some("shelf".into()),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_sort: Some("author".into()),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_filter: Some("abandoned".into()),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_group: Some("author".into()),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_sort: Some("pages".into()),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_card_size: Some(90),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_card_size: Some(245),
                ..chosen.clone()
            },
            AppearancePreferences {
                library_card_size: Some(490),
                ..chosen.clone()
            },
            preferences("neon", "#2f8f83", 200, 20),
        ] {
            assert!(!save_to(&connection, &invalid).unwrap());
        }
        assert_eq!(load_from(&connection).unwrap(), chosen);

        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = ?2",
                params![
                    serde_json::json!({
                        "theme": "sakura",
                        "appCustomTheme": {
                            "base": "dark",
                            "background": "#000",
                            "surface": "#111111",
                            "text": "#eeeeee"
                        },
                        "libraryView": "list",
                        "librarySort": "author",
                        "libraryFilter": "completed",
                        "libraryCardSeries": "yes",
                        "libraryCardLastRead": false,
                        "libraryCardKanji": true,
                        "libraryGroup": "publisher",
                        "libraryCardSize": 135
                    })
                    .to_string(),
                    RECORD_NAME
                ],
            )
            .unwrap();
        let loaded = load_from(&connection).unwrap();
        assert_eq!(loaded.theme.as_deref(), Some("sakura"));
        assert_eq!(loaded.app_custom_theme, None);
        assert_eq!(loaded.library_view.as_deref(), Some("list"));
        assert_eq!(loaded.library_sort, None);
        assert_eq!(loaded.library_filter.as_deref(), Some("completed"));
        assert_eq!(loaded.library_card_series, None);
        assert_eq!(loaded.library_card_last_read, Some(false));
        assert_eq!(loaded.library_card_kanji, Some(true));
        assert_eq!(loaded.library_group, None);
        assert_eq!(loaded.library_card_size, None);
        // The retired Pages sort loads as no saved sort.
        let stored = serde_json::json!({ "librarySort": "pages", "libraryCardSize": 300 });
        let kept = AppearancePreferences::from_stored(&stored);
        assert_eq!(kept.library_sort, None);
        assert_eq!(kept.library_card_size, Some(300));
    }

    #[test]
    fn saves_and_restores_the_reader_theme_and_custom_themes() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        for preset in READER_PRESET_THEMES {
            let chosen = with_themes(preset, vec![]);
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
        }
        let dusk = custom_theme(DUSK_ID, "Dusk");
        let chosen = with_themes(DUSK_ID, vec![dusk.clone()]);
        assert!(save(&database, &chosen).unwrap());
        assert_eq!(load(&database).unwrap(), chosen);
        assert_eq!(
            serde_json::to_value(&chosen).unwrap()["readerCustomThemes"],
            serde_json::json!([{
                "id": DUSK_ID,
                "name": "Dusk",
                "background": "#101820",
                "text": "#f0e6d2",
                "selection": "#445566",
                "highlight": "#445566",
                "footerText": "#A09880"
            }])
        );
        assert_eq!(
            serde_json::to_value(&chosen).unwrap()["readerTheme"],
            serde_json::json!(DUSK_ID)
        );

        // An edit, a rename, and a deletion are each kept.
        let edited = ReaderCustomTheme {
            name: "夕暮れ".into(),
            background: "#223344".into(),
            ..dusk.clone()
        };
        let second = custom_theme(&theme_id(1), "Custom 1");
        let both = with_themes(&theme_id(1), vec![edited.clone(), second]);
        assert!(save(&database, &both).unwrap());
        assert_eq!(load(&database).unwrap(), both);
        let deleted = with_themes("paper", vec![edited]);
        assert!(save(&database, &deleted).unwrap());
        assert_eq!(load(&database).unwrap(), deleted);

        // The limit itself is accepted, as is the longest name.
        let full: Vec<_> = (0..READER_CUSTOM_THEME_LIMIT)
            .map(|index| custom_theme(&theme_id(index), &"名".repeat(40)))
            .collect();
        assert!(save(&database, &with_themes(&theme_id(31), full.clone())).unwrap());
        assert_eq!(load(&database).unwrap(), with_themes(&theme_id(31), full));

        // A theme missing a color is refused; anything else it carries, such as CSS, is dropped.
        assert!(
            serde_json::from_value::<ReaderCustomTheme>(serde_json::json!({
                "id": DUSK_ID,
                "name": "Dusk",
                "background": "#101820",
                "text": "#f0e6d2",
                "selection": "#445566"
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_invalid_themes_without_changing_the_saved_record() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let saved = with_themes(DUSK_ID, vec![custom_theme(DUSK_ID, "Dusk")]);
        assert!(save(&database, &saved).unwrap());
        let dusk = custom_theme(DUSK_ID, "Dusk");
        let too_many: Vec<_> = (0..=READER_CUSTOM_THEME_LIMIT)
            .map(|index| custom_theme(&theme_id(index), "Many"))
            .collect();
        for invalid in [
            with_themes("Paper", vec![]),
            with_themes("custom", vec![]),
            with_themes("", vec![]),
            // A custom theme is chosen only while it is kept.
            with_themes(DUSK_ID, vec![]),
            AppearancePreferences {
                reader_theme: Some(DUSK_ID.into()),
                ..preferences("dark", "#2f8f83", 200, 20)
            },
            with_themes("paper", too_many),
            with_themes("paper", vec![dusk.clone(), custom_theme(DUSK_ID, "Twin")]),
            with_themes("paper", vec![custom_theme("paper", "Dusk")]),
            with_themes("paper", vec![custom_theme(&DUSK_ID.to_uppercase(), "Dusk")]),
            with_themes(
                "paper",
                vec![custom_theme(&DUSK_ID.replace('-', ""), "Dusk")],
            ),
            with_themes("paper", vec![custom_theme(DUSK_ID, "")]),
            with_themes("paper", vec![custom_theme(DUSK_ID, " Dusk")]),
            with_themes("paper", vec![custom_theme(DUSK_ID, "Dusk\n")]),
            with_themes("paper", vec![custom_theme(DUSK_ID, "Tab\there")]),
            with_themes("paper", vec![custom_theme(DUSK_ID, &"x".repeat(41))]),
            with_themes(
                "paper",
                vec![ReaderCustomTheme {
                    background: "white".into(),
                    ..dusk.clone()
                }],
            ),
            with_themes(
                "paper",
                vec![ReaderCustomTheme {
                    text: "#fff".into(),
                    ..dusk.clone()
                }],
            ),
            with_themes(
                "paper",
                vec![ReaderCustomTheme {
                    selection: "#44556g".into(),
                    ..dusk.clone()
                }],
            ),
            with_themes(
                "paper",
                vec![ReaderCustomTheme {
                    footer_text: "red; }".into(),
                    ..dusk.clone()
                }],
            ),
            with_themes(
                "paper",
                vec![ReaderCustomTheme {
                    highlight: "red; }".into(),
                    ..dusk.clone()
                }],
            ),
        ] {
            assert!(!save(&database, &invalid).unwrap());
        }
        assert_eq!(load(&database).unwrap(), saved);
    }

    #[test]
    fn legacy_highlight_loads_as_selection_and_edits_persist_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        let dusk = custom_theme(DUSK_ID, "Dusk");
        let mut legacy = serde_json::to_value(&dusk).unwrap();
        legacy.as_object_mut().unwrap().remove("highlight");
        // The command requires Highlight; only stored old records get the fallback.
        assert!(serde_json::from_value::<ReaderCustomTheme>(legacy.clone()).is_err());
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES ('appearance', ?1)",
                [
                    serde_json::json!({"readerTheme": DUSK_ID, "readerCustomThemes": [legacy]})
                        .to_string(),
                ],
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            load(&database).unwrap(),
            AppearancePreferences {
                reader_theme: Some(DUSK_ID.into()),
                reader_custom_themes: Some(vec![dusk.clone()]),
                ..AppearancePreferences::default()
            }
        );
        let mut edited = dusk;
        edited.highlight = "#abcdef".into();
        let saved = with_themes(DUSK_ID, vec![edited.clone()]);
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        edited.selection = "#112233".into();
        let saved = with_themes(DUSK_ID, vec![edited.clone()]);
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!(123),
            serde_json::json!("#12345"),
            serde_json::json!("red; }"),
        ] {
            let mut theme = serde_json::to_value(&edited).unwrap();
            theme["highlight"] = invalid;
            assert_eq!(
                stored_custom_themes(&serde_json::json!([theme])),
                Some(vec![])
            );
        }
    }

    #[test]
    fn stored_themes_are_kept_one_by_one() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        let other = "1c9b3c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d";
        let record = serde_json::json!({
            "readerTheme": DUSK_ID,
            "readerCustomThemes": [
                {"id": DUSK_ID, "name": "", "background": "#101820", "text": "#f0e6d2", "selection": "#445566", "footerText": "#a09880"},
                {"id": other, "name": "Kept", "background": "#101820", "text": "#f0e6d2", "selection": "#445566", "footerText": "#a09880", "css": "body {}"},
                {"id": other, "name": "Twin", "background": "#101820", "text": "#f0e6d2", "selection": "#445566", "footerText": "#a09880"},
                {"id": "paper", "name": "Paper", "background": "#101820", "text": "#f0e6d2", "selection": "#445566", "footerText": "#a09880"},
                "Dusk",
                null
            ]
        });
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES ('appearance', ?1)",
                [record.to_string()],
            )
            .unwrap();
        // The chosen theme was not kept, so the frontend's default applies.
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                reader_custom_themes: Some(vec![ReaderCustomTheme {
                    id: other.into(),
                    name: "Kept".into(),
                    background: "#101820".into(),
                    text: "#f0e6d2".into(),
                    selection: "#445566".into(),
                    highlight: "#445566".into(),
                    footer_text: "#a09880".into(),
                }]),
                ..AppearancePreferences::default()
            }
        );

        // Past the limit, the first themes are kept.
        let many: Vec<_> = (0..40)
            .map(|index| serde_json::to_value(custom_theme(&theme_id(index), "Many")).unwrap())
            .collect();
        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                [serde_json::json!({
                    "readerTheme": theme_id(39),
                    "readerCustomThemes": many,
                })
                .to_string()],
            )
            .unwrap();
        let loaded = load_from(&connection).unwrap();
        assert_eq!(loaded.reader_theme, None);
        let kept = loaded.reader_custom_themes.unwrap();
        assert_eq!(kept.len(), READER_CUSTOM_THEME_LIMIT);
        assert_eq!(kept[31].id, theme_id(31));

        for (theme, themes) in [
            (serde_json::json!("sepia"), serde_json::json!({})),
            (serde_json::json!(DUSK_ID), serde_json::json!("[]")),
            (serde_json::json!(7), serde_json::json!(null)),
        ] {
            connection
                .execute(
                    "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                    [
                        serde_json::json!({ "readerTheme": theme, "readerCustomThemes": themes })
                            .to_string(),
                    ],
                )
                .unwrap();
            assert_eq!(
                load_from(&connection).unwrap(),
                AppearancePreferences {
                    reader_theme: theme
                        .as_str()
                        .filter(|theme| *theme == "sepia")
                        .map(str::to_owned),
                    ..AppearancePreferences::default()
                }
            );
        }
    }

    #[test]
    fn rejects_invalid_preferences_without_changing_the_saved_record() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let saved = preferences("dark", "#2f8f83", 200, 20);
        assert!(save(&database, &saved).unwrap());
        for invalid in [
            preferences("sepia", "#2f8f83", 200, 20),
            preferences("dark", "red", 200, 20),
            preferences("dark", "#2f8f8", 200, 20),
            preferences("dark", "#2f8f8z", 200, 20),
            preferences("dark", "#2f8f83", 0, 20),
            preferences("dark", "#2f8f83", 2010, 20),
            preferences("dark", "#2f8f83", 200, 7),
            preferences("dark", "#2f8f83", 200, 73),
            preferences("dark", "#2f8f83", 105, 20),
            with_line_height(0.95),
            with_line_height(3.05),
            with_line_height(1.62),
            with_line_height(f64::NAN),
            with_font_weight(0),
            with_font_weight(1000),
            with_font_weight(450),
            with_paragraph_indent(-0.5),
            with_paragraph_indent(20.5),
            with_paragraph_indent(1.25),
            with_paragraph_indent(f64::NAN),
            with_paragraph_margin(-2),
            with_paragraph_margin(202),
            with_paragraph_margin(15),
            with_side_margin(-4),
            with_side_margin(404),
            with_side_margin(42),
            with_max_height(0),
            with_max_height(90),
            with_max_height(1_000_010),
            with_max_height(725),
            with_writing_mode("vertical-rl"),
            with_writing_mode("Vertical"),
            with_writing_mode(""),
            with_text_orientation("sideways"),
            with_text_orientation("Upright"),
            with_text_orientation(""),
            with_view_mode("scrolled"),
            with_view_mode("Continuous"),
            with_view_mode("semiContinuous"),
            with_view_mode("semi continuous"),
            with_view_mode(""),
        ] {
            assert!(!save(&database, &invalid).unwrap());
        }
        assert_eq!(load(&database).unwrap(), saved);
        // The range limits themselves are accepted.
        assert!(save(&database, &preferences("light", "#000000", 10, 8)).unwrap());
        assert!(save(&database, &preferences("light", "#ffffff", 2000, 72)).unwrap());
        assert!(save(&database, &with_line_height(1.0)).unwrap());
        assert!(save(&database, &with_line_height(3.0)).unwrap());
        assert!(save(&database, &with_font_weight(100)).unwrap());
        assert!(save(&database, &with_font_weight(900)).unwrap());
        assert!(save(&database, &with_paragraph_indent(0.0)).unwrap());
        assert!(save(&database, &with_paragraph_indent(20.0)).unwrap());
        assert!(save(&database, &with_paragraph_margin(0)).unwrap());
        assert!(save(&database, &with_paragraph_margin(200)).unwrap());
        assert!(save(&database, &with_side_margin(0)).unwrap());
        assert!(save(&database, &with_side_margin(400)).unwrap());
        assert!(save(&database, &with_max_height(100)).unwrap());
        assert!(save(&database, &with_max_height(4000)).unwrap());
    }

    #[test]
    fn reader_text_spacing_saves_reopens_and_validates_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let spacing = |letter: Option<i64>, word: Option<i64>| AppearancePreferences {
            reader_letter_spacing: letter,
            reader_word_spacing: word,
            ..preferences("dark", "#2f8f83", 200, 20)
        };
        for (letter, word) in [(-10, -20), (0, 0), (3, 12), (60, 120)] {
            let chosen = spacing(Some(letter), Some(word));
            assert!(save(&database, &chosen).unwrap());
            assert_eq!(load(&database).unwrap(), chosen);
            let value = serde_json::to_value(&chosen).unwrap();
            assert_eq!(value["readerLetterSpacing"], serde_json::json!(letter));
            assert_eq!(value["readerWordSpacing"], serde_json::json!(word));
        }
        let kept = spacing(Some(4), Some(8));
        assert!(save(&database, &kept).unwrap());
        for invalid in [
            spacing(Some(-11), None),
            spacing(Some(61), None),
            spacing(None, Some(-21)),
            spacing(None, Some(121)),
        ] {
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), kept);
        }
        for fractional in [
            serde_json::json!({ "readerLetterSpacing": 1.5 }),
            serde_json::json!({ "readerWordSpacing": "4" }),
        ] {
            assert!(serde_json::from_value::<AppearancePreferences>(fractional).is_err());
        }

        // A stored invalid spacing loads as absent and keeps the other one.
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                [r#"{"readerLetterSpacing":2.5,"readerWordSpacing":16,"readerShowReadingSpeed":true}"#],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                reader_word_spacing: Some(16),
                reader_show_reading_speed: Some(true),
                ..AppearancePreferences::default()
            }
        );
        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                [r#"{"readerLetterSpacing":-4,"readerWordSpacing":500}"#],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                reader_letter_spacing: Some(-4),
                ..AppearancePreferences::default()
            }
        );
    }

    #[test]
    fn statistics_choices_save_reopen_and_validate_independently() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let saved = AppearancePreferences {
            statistics_enabled: Some(false),
            statistics_session_start: Some("manual".into()),
            statistics_jump_limit: Some(0),
            statistics_idle_minutes: Some(0),
            library_sort: Some("words".into()),
            ..AppearancePreferences::default()
        };
        assert!(save(&database, &saved).unwrap());
        assert_eq!(load(&database).unwrap(), saved);
        for invalid in [
            AppearancePreferences {
                statistics_session_start: Some("sometimes".into()),
                ..AppearancePreferences::default()
            },
            AppearancePreferences {
                statistics_jump_limit: Some(-1),
                ..AppearancePreferences::default()
            },
            AppearancePreferences {
                statistics_jump_limit: Some(100_001),
                ..AppearancePreferences::default()
            },
            AppearancePreferences {
                statistics_idle_minutes: Some(121),
                ..AppearancePreferences::default()
            },
        ] {
            assert!(!save(&database, &invalid).unwrap());
            assert_eq!(load(&database).unwrap(), saved);
        }
        assert!(serde_json::from_value::<AppearancePreferences>(
            serde_json::json!({ "statisticsEnabled": "no" })
        )
        .is_err());

        // A stored invalid choice loads as absent and keeps the others.
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                [r#"{"statisticsEnabled":1,"statisticsSessionStart":"first-read","statisticsJumpLimit":2.5}"#],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                statistics_session_start: Some("first-read".into()),
                ..AppearancePreferences::default()
            }
        );
    }

    #[test]
    fn a_stored_invalid_field_loads_as_absent_and_keeps_the_others() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection
            .execute(
                "INSERT INTO preferences (name, value) VALUES ('appearance', ?1)",
                [r##"{"theme":"sepia","accentColor":"#7a68d8","readerWheelStep":"fast","readerFontSize":24,"readerLineHeight":3.5,"readerFontWeight":950,"readerParagraphIndent":0.3,"readerParagraphMargin":7,"readerSideMargin":30,"readerMaxHeight":95,"readerWritingMode":"tate","readerTextOrientation":"sideways-right","readerHideFurigana":1,"readerBlurImage":"on","readerViewMode":"scroll","readerSidebarPinned":"yes","future":true}"##],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                accent_color: Some("#7a68d8".into()),
                reader_font_size: Some(24),
                ..AppearancePreferences::default()
            }
        );
        connection
            .execute(
                "UPDATE preferences SET value = ?1 WHERE name = 'appearance'",
                [r#"{"theme":"dark","readerWheelSpeed":3,"readerLineHeight":1.85,"readerFontWeight":700,"readerParagraphIndent":0,"readerParagraphMargin":12,"readerSideMargin":160,"readerMaxHeight":900,"readerWritingMode":"horizontal","readerTextOrientation":"upright","readerHideFurigana":true,"readerBlurImage":true,"readerViewMode":"continuous","readerSidebarPinned":true}"#],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences {
                theme: Some("dark".into()),
                reader_line_height: Some(1.85),
                reader_font_weight: Some(700),
                reader_western_font_weight: Some(700),
                reader_asian_font_weight: Some(700),
                reader_paragraph_indent: Some(0.0),
                reader_paragraph_margin: Some(12),
                reader_side_margin: Some(160),
                reader_max_height: Some(900),
                reader_writing_mode: Some("horizontal".into()),
                reader_text_orientation: Some("upright".into()),
                reader_hide_furigana: Some(true),
                reader_blur_image: Some(true),
                reader_view_mode: Some("continuous".into()),
                reader_sidebar_pinned: Some(true),
                ..AppearancePreferences::default()
            }
        );
        connection
            .execute(
                "UPDATE preferences SET value = 'not json' WHERE name = 'appearance'",
                [],
            )
            .unwrap();
        assert_eq!(
            load_from(&connection).unwrap(),
            AppearancePreferences::default()
        );
    }

    #[test]
    fn a_version_three_catalog_gains_preferences_and_keeps_its_books() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("library.sqlite3");
        let connection = open_catalog(&database).unwrap();
        connection
            .execute_batch(
                "INSERT INTO books (id, source_path, file_name)
                   VALUES ('11111111-1111-4111-8111-111111111111', 'C:/private/a.epub', 'a.epub');
                 DROP TABLE preferences;
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        drop(connection);

        let migrated = open_catalog(&database).unwrap();
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        let books: i64 = migrated
            .query_row("SELECT count(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(books, 1);
        assert!(save_to(&migrated, &preferences("dark", "#5874df", 100, 18)).unwrap());
    }
}
