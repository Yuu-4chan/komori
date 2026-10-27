import { PaletteIcon } from "@phosphor-icons/react";

import { Card } from "../../components/ui/Card";
import { ColorField } from "../../components/ui/ColorField";
import { Select } from "../../components/ui/Select";
import { Stepper } from "../../components/ui/Stepper";
import { useAppearance } from "../appearance/AppearanceProvider";
import { useI18n } from "../../i18n/i18n";
import {
  lookupPopupFontSize,
  lookupPopupHeight,
  lookupPopupLineHeight,
  lookupPopupRadius,
  lookupPopupWidth,
} from "./lookupPopup";
import { readingPositions } from "./lookupTriggers";
import { FontPicker } from "./ReaderFontControls";
import { popupPaletteFields, popupThemes } from "./popupThemes";
import { resolveReaderTheme } from "./readerThemes";

/**
 * Everything that shapes how the lookup popup looks, in Settings > Reader popup: its palette and
 * custom colors, corners, size, text size, font and spacing, and where readings sit.
 */
export function PopupAppearanceSettings() {
  const {
    readerPopupCustomPalette,
    setReaderPopupCustomPalette,
    readerPopupRadius,
    setReaderPopupRadius,
    readerPopupFontSize,
    setReaderPopupFontSize,
    readerPopupLineHeight,
    setReaderPopupLineHeight,
    readerPopupTheme,
    setReaderPopupTheme,
    readerPopupWidth,
    readerPopupHeight,
    setReaderPopupWidth,
    setReaderPopupHeight,
    readerPopupReadingPosition,
    setReaderPopupTriggers,
    readerPopupFont,
    setReaderPopupFont,
    readerPopupStyle,
    readerTheme,
    readerCustomThemes,
  } = useAppearance();
  const page = resolveReaderTheme(readerTheme, readerCustomThemes);
  const dictionaryStyle = readerPopupStyle === "dictionary";
  const { t } = useI18n();
  return (
    <Card className="settings-card settings-card--wide">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <PaletteIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("popupSettings.appearanceTitle")}</h2>
          <p>{t("popupSettings.appearanceDescription")}</p>
        </div>
      </div>
      <div className="lookup-theme-grid" role="group" aria-label={t("popupSettings.theme")}>
        {popupThemes.map(({ id, label, description }) => (
          <button
            key={id}
            type="button"
            aria-label={t(label)}
            aria-description={t(description)}
            className="lookup-theme-card"
            aria-pressed={readerPopupTheme === id}
            onClick={() => setReaderPopupTheme(id)}
          >
            <span
              aria-hidden="true"
              className={`lookup-theme-card__preview lookup-theme-card__preview--${id}`}
              style={
                id === "custom"
                  ? {
                      background: readerPopupCustomPalette.background,
                      borderColor: readerPopupCustomPalette.border,
                    }
                  : id === "reader"
                    ? {
                        background: `radial-gradient(circle at 78% 22%, ${page.highlight}, transparent 18%), ${page.background}`,
                        borderColor: page.footerText,
                      }
                    : undefined
              }
            />
            <strong>{t(label)}</strong>
            <small>{t(description)}</small>
          </button>
        ))}
      </div>
      {readerPopupTheme === "custom" && (
        <div
          className="settings-color-grid"
          role="group"
          aria-label={t("popupSettings.customColors")}
        >
          {popupPaletteFields.map((field) => (
            <ColorField
              key={field}
              label={t(`popupSettings.color.${field}`)}
              value={readerPopupCustomPalette[field]}
              onChange={(color) =>
                setReaderPopupCustomPalette({ ...readerPopupCustomPalette, [field]: color })
              }
            />
          ))}
          <p className="settings-field__hint">{t("popupSettings.colorsHint")}</p>
        </div>
      )}
      <div className="settings-list">
        <div className="settings-field">
          <Stepper
            label={t("popupSettings.width")}
            value={readerPopupWidth}
            {...lookupPopupWidth}
            unit={t("unit.px")}
            onChange={setReaderPopupWidth}
          />
          <p className="settings-field__hint">{t("popupSettings.widthHint")}</p>
        </div>
        <div className="settings-field">
          <Stepper
            label={t("popupSettings.height")}
            value={readerPopupHeight}
            {...lookupPopupHeight}
            unit={t("unit.px")}
            onChange={setReaderPopupHeight}
          />
        </div>
        <div className="settings-field">
          <Stepper
            label={t("popupSettings.fontSize")}
            value={readerPopupFontSize}
            {...lookupPopupFontSize}
            unit={t("unit.px")}
            onChange={setReaderPopupFontSize}
          />
        </div>
        <div className="settings-field">
          <FontPicker
            label={t("popupSettings.font")}
            category="asian"
            value={readerPopupFont}
            onChange={setReaderPopupFont}
          />
          <p className="settings-field__hint">{t("popupSettings.fontHint")}</p>
        </div>
        <div className="settings-field">
          <Stepper
            label={t("popupSettings.lineHeight")}
            value={readerPopupLineHeight}
            {...lookupPopupLineHeight}
            format={(value) => value.toFixed(2)}
            onChange={setReaderPopupLineHeight}
          />
        </div>
        <div className="settings-field">
          <Stepper
            label={t("popupSettings.radius")}
            value={readerPopupRadius}
            {...lookupPopupRadius}
            unit={t("unit.px")}
            onChange={setReaderPopupRadius}
          />
          <p className="settings-field__hint">{t("popupSettings.radiusHint")}</p>
        </div>
        <div className="settings-field">
          <Select
            label={t("popupSettings.readingPosition")}
            value={readerPopupReadingPosition}
            options={readingPositions.map((option) => ({ ...option, label: t(option.label) }))}
            onChange={(value) => setReaderPopupTriggers({ readerPopupReadingPosition: value })}
            disabled={dictionaryStyle}
          />
          <p className="settings-field__hint">
            {t(
              dictionaryStyle
                ? "popupSettings.readingPositionDictionary"
                : "popupSettings.readingPositionHint",
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}
