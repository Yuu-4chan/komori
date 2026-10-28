import { useI18n, type MessageKey } from "../../i18n/i18n";
import { TrashIcon } from "@phosphor-icons/react";
import { useRef } from "react";

import { Button } from "../../components/ui/Button";
import { ColorField } from "../../components/ui/ColorField";
import { TextField } from "../../components/ui/TextField";
import {
  isThemeName,
  defaultReaderTheme,
  readerCustomThemeLimit,
  presetThemeLabel,
  readerPresetThemes,
  readerThemeNameMaxLength,
  type ReaderCustomTheme,
  type ReaderThemeColors,
} from "./readerThemes";

type ReaderCustomThemeChange = Partial<ReaderThemeColors & { name: string }>;

export interface ReaderThemeSectionProps {
  /** The chosen theme's ID: a preset's or a custom theme's. */
  theme: string;
  customThemes: readonly ReaderCustomTheme[];
  onThemeChange: (theme: string) => void;
  /** Creates a custom theme from the shown theme's colors and chooses it. */
  onCreateCustomTheme: () => void;
  onCustomThemeChange: (id: string, change: ReaderCustomThemeChange) => void;
  onDeleteCustomTheme: (id: string) => void;
}

const colorFields: { key: keyof ReaderThemeColors; label: MessageKey }[] = [
  { key: "background", label: "appearance.background" },
  { key: "text", label: "appearance.text" },
  { key: "highlight", label: "readerTheme.highlight" },
  { key: "selection", label: "readerTheme.selection" },
  { key: "footerText", label: "readerTheme.footerText" },
];

/**
 * The Theme section: its preset swatches, a swatch for each saved custom theme,
 * and the Custom swatch, which creates a new theme. The chosen custom theme is edited,
 * renamed, and deleted below them.
 */
export function ReaderThemeSection({
  theme,
  customThemes,
  onThemeChange,
  onCreateCustomTheme,
  onCustomThemeChange,
  onDeleteCustomTheme,
}: ReaderThemeSectionProps) {
  const custom = customThemes.find((candidate) => candidate.id === theme);
  // A chosen theme that no longer exists shows the default, as the Reader does.
  const chosen =
    custom || readerPresetThemes.some((preset) => preset.id === theme) ? theme : defaultReaderTheme;
  const full = customThemes.length >= readerCustomThemeLimit;
  const defaultThemeRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  return (
    <section className="reader-appearance-card" aria-labelledby="reader-appearance-theme">
      <h3 className="reader-appearance-card__title" id="reader-appearance-theme">
        {t("readerTheme.title")}
      </h3>
      <div className="reader-theme-grid">
        {[...readerPresetThemes, ...customThemes].map((option) => (
          <button
            key={option.id}
            ref={option.id === defaultReaderTheme ? defaultThemeRef : undefined}
            type="button"
            className={
              option.id === chosen
                ? "reader-theme-swatch reader-theme-swatch--active"
                : "reader-theme-swatch"
            }
            aria-pressed={option.id === chosen}
            onClick={() => onThemeChange(option.id)}
          >
            <span
              className="reader-theme-swatch__preview"
              style={{ background: option.background, color: option.text }}
              aria-hidden="true"
            >
              あ
            </span>
            <small>{"label" in option ? presetThemeLabel(option) : option.name}</small>
          </button>
        ))}
        <button
          type="button"
          className="reader-theme-swatch reader-theme-swatch--new"
          disabled={full}
          title={
            full ? t("readerTheme.limit", { count: readerCustomThemeLimit }) : t("readerTheme.new")
          }
          onClick={onCreateCustomTheme}
        >
          <span className="reader-theme-swatch__preview" aria-hidden="true">
            あ
          </span>
          <small>
            {t("appearance.custom")}
            <span className="visually-hidden">{t("readerTheme.newSuffix")}</span>
          </small>
        </button>
      </div>
      {custom && (
        <div className="reader-custom-theme" key={custom.id}>
          <div className="reader-custom-theme-grid">
            <TextField
              label={t("readerTheme.name")}
              value={custom.name}
              maxLength={readerThemeNameMaxLength}
              accepts={isThemeName}
              onChange={(name) => onCustomThemeChange(custom.id, { name })}
            />
            {colorFields.map(({ key, label }) => (
              <ColorField
                key={key}
                label={t(label)}
                value={custom[key]}
                onChange={(color) => onCustomThemeChange(custom.id, { [key]: color })}
              />
            ))}
          </div>
          <Button
            tone="secondary"
            className="reader-custom-theme__delete"
            icon={<TrashIcon aria-hidden="true" weight="bold" />}
            onClick={() => {
              onDeleteCustomTheme(custom.id);
              // Focus follows the Reader's default theme after deletion.
              defaultThemeRef.current?.focus();
            }}
          >
            {t("readerTheme.delete")}
          </Button>
        </div>
      )}
    </section>
  );
}
