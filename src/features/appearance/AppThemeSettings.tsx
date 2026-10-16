import { PaintBrushIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

import { appIcons, appIconSvg } from "../../brand/appIcons";
import logo from "../../brand/komori.svg?raw";
import { Card } from "../../components/ui/Card";
import { ColorField } from "../../components/ui/ColorField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Select } from "../../components/ui/Select";
import { useI18n } from "../../i18n/i18n";
import { interfaceLanguageNames, interfaceLanguages } from "../../i18n/languages";
import { useAppearance } from "./AppearanceProvider";
import {
  appPresetThemes,
  type AppThemeBase,
  type AppThemeColors,
  type AppThemeId,
} from "./appThemes";

const appIconImages = new Map(
  appIcons.map(({ id }) => [
    id,
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(appIconSvg(logo, id))}`,
  ]),
);

/** A small drawing of the theme: sidebar, page, a card, text lines, and the accent. */
function ThemePreview({ colors, accent }: { colors: AppThemeColors; accent: string }) {
  const light = colors.base === "light";
  const style = {
    "--preview-background": colors.background,
    "--preview-surface": colors.surface,
    "--preview-card": `color-mix(in srgb, ${colors.surface} ${light ? 45 : 94}%, ${light ? "#ffffff" : colors.text})`,
    "--preview-text": colors.text,
    "--preview-muted": `color-mix(in srgb, ${colors.text} 35%, ${colors.surface})`,
    "--preview-accent": accent,
  } as CSSProperties;
  return (
    <span aria-hidden="true" className="app-theme-preview" style={style}>
      <span className="app-theme-preview__sidebar">
        <i />
        <i />
        <i />
      </span>
      <span className="app-theme-preview__page">
        <b />
        <span className="app-theme-preview__card">
          <i />
          <i />
        </span>
        <span className="app-theme-preview__card">
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}

/**
 * The application theme gallery: presets drawn as small previews, each with its own accent,
 * and the custom theme with its editor, where the accent is one of its colors.
 */
export function AppThemeSettings() {
  const {
    accentColor,
    appCustomTheme,
    appIcon,
    setAppIcon,
    interfaceLanguage,
    setAccentColor,
    setInterfaceLanguage,
    setTheme,
    theme,
    updateAppCustomTheme,
  } = useAppearance();
  const { t } = useI18n();

  function startFrom(id: AppThemeId) {
    const preset = appPresetThemes.find((candidate) => candidate.id === id);
    if (!preset) return;
    const { base, background, surface, text } = preset;
    updateAppCustomTheme({ base, background, surface, text });
    setAccentColor(preset.accent);
  }

  return (
    <>
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <PaintBrushIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("appearance.title")}</h2>
            <p>{t("appearance.description")}</p>
          </div>
        </div>
        <div className="settings-list">
          <div className="settings-field">
            <Select
              label={t("appearance.language")}
              value={interfaceLanguage}
              options={interfaceLanguages.map((language) => ({
                value: language,
                label: interfaceLanguageNames[language],
              }))}
              onChange={setInterfaceLanguage}
            />
          </div>
          <div className="settings-field app-icon-field">
            <span className="app-icon-field__label" id="app-icon-label">
              {t("appearance.appIcon")}
            </span>
            <div className="app-icon-grid" role="radiogroup" aria-labelledby="app-icon-label">
              {appIcons.map(({ id }) => (
                <button
                  aria-checked={appIcon === id}
                  aria-label={t(`appIcon.${id}`)}
                  className="app-icon-option"
                  key={id}
                  onClick={() => setAppIcon(id)}
                  role="radio"
                  title={t(`appIcon.${id}`)}
                  type="button"
                >
                  <img alt="" src={appIconImages.get(id)} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="app-theme-grid" role="radiogroup" aria-label={t("appearance.theme")}>
          {appPresetThemes.map((preset) => (
            <button
              aria-checked={theme === preset.id}
              aria-label={t("appearance.themeName", { name: t(preset.label) })}
              className="app-theme-option"
              key={preset.id}
              onClick={() => setTheme(preset.id)}
              role="radio"
              type="button"
            >
              <ThemePreview accent={preset.accent} colors={preset} />
              <span className="app-theme-option__label">
                {t(preset.label)}
                <small>{t(preset.base === "light" ? "common.light" : "common.dark")}</small>
              </span>
            </button>
          ))}
          <button
            aria-checked={theme === "custom"}
            aria-label={t("appearance.customTheme")}
            className="app-theme-option"
            onClick={() => setTheme("custom")}
            role="radio"
            type="button"
          >
            <ThemePreview accent={accentColor} colors={appCustomTheme} />
            <span className="app-theme-option__label">
              {t("appearance.custom")}
              <small>{t("appearance.yourColors")}</small>
            </span>
          </button>
        </div>

        {theme === "custom" ? (
          <div className="app-theme-editor" aria-label={t("appearance.customColors")} role="group">
            <div className="app-theme-editor__row">
              <span className="app-theme-editor__label">{t("appearance.base")}</span>
              <SegmentedControl<AppThemeBase>
                label={t("appearance.customBase")}
                onChange={(base) => updateAppCustomTheme({ base })}
                options={[
                  { label: t("common.light"), value: "light" },
                  { label: t("common.dark"), value: "dark" },
                ]}
                value={appCustomTheme.base}
              />
            </div>
            <div className="app-theme-editor__colors">
              <ColorField
                label={t("appearance.background")}
                onChange={(background) => updateAppCustomTheme({ background })}
                value={appCustomTheme.background}
              />
              <ColorField
                label={t("appearance.surface")}
                onChange={(surface) => updateAppCustomTheme({ surface })}
                value={appCustomTheme.surface}
              />
              <ColorField
                label={t("appearance.text")}
                onChange={(text) => updateAppCustomTheme({ text })}
                value={appCustomTheme.text}
              />
              <ColorField
                label={t("appearance.accent")}
                onChange={setAccentColor}
                value={accentColor}
              />
            </div>
            <div className="app-theme-editor__row app-theme-editor__row--wrap">
              <span className="app-theme-editor__label">{t("appearance.startFrom")}</span>
              <div className="app-theme-editor__presets">
                {appPresetThemes.map((preset) => (
                  <button
                    className="app-theme-editor__preset"
                    key={preset.id}
                    onClick={() => startFrom(preset.id)}
                    style={{ "--swatch-color": preset.accent } as CSSProperties}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      style={{ background: preset.background, borderColor: preset.text }}
                    />
                    {t(preset.label)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
