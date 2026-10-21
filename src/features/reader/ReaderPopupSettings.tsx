import { ChatTextIcon, CursorClickIcon, ListMagnifyingGlassIcon } from "@phosphor-icons/react";
import { PopupSourceSettings } from "./PopupSourceSettings";
import { ReaderLookupPreview } from "./ReaderLookupPreview";
import { PopupAppearanceSettings } from "./PopupAppearanceSettings";

import { Card } from "../../components/ui/Card";
import { Stepper } from "../../components/ui/Stepper";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { Select } from "../../components/ui/Select";
import { lookupPopupStyles } from "./lookupPopup";
import {
  childLevelsRange,
  hoverDelayRange,
  maxResultsRange,
  mouseTriggers,
  popupCloseBehaviors,
  scanLengthRange,
  shortcutPresets,
} from "./lookupTriggers";
import { useAppearance } from "../appearance/AppearanceProvider";
import { useI18n } from "../../i18n/i18n";

/**
 * Settings > Reader popup, in order: the popup's behavior and content, its appearance, the real
 * popup previewed, its dictionary sources, then how lookups start and what a scan reads.
 */
export function ReaderPopupSettings({
  onDictionarySettings = () => {},
}: {
  onDictionarySettings?: () => void;
}) {
  const triggers = useAppearance();
  const { t } = useI18n();
  const { setReaderPopupTriggers } = triggers;
  const {
    readerPopupShowFrequency,
    setReaderPopupShowFrequency,
    readerPopupShowPitch,
    setReaderPopupShowPitch,
    readerPopupShowDictionaryNames,
    setReaderPopupShowDictionaryNames,
    readerPopupAnkiAction,
    setReaderPopupAnkiAction,
    readerPopupVoiceAction,
    setReaderPopupVoiceAction,
    readerPopupEnabled,
    setReaderPopupEnabled,
    readerPopupMouseSelection,
    setReaderPopupMouseSelection,
    readerPopupStyle,
    setReaderPopupStyle,
  } = useAppearance();
  // The dictionary style shows none of the voice, pitch, frequency or Anki its switches add.
  const dictionaryStyle = readerPopupStyle === "dictionary";
  return (
    <div className="settings-popup">
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <ChatTextIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("popupSettings.title")}</h2>
            <p>{t("popupSettings.description")}</p>
          </div>
        </div>
        <div className="settings-list">
          <ToggleSetting
            label={t("popupSettings.enable")}
            description={t("popupSettings.enableHint")}
            checked={readerPopupEnabled}
            onChange={setReaderPopupEnabled}
          />
          <div className="settings-field">
            <Select
              label={t("popupSettings.style")}
              value={readerPopupStyle}
              options={lookupPopupStyles.map((style) => ({
                value: style,
                label: t(`popupSettings.style.${style}`),
              }))}
              onChange={setReaderPopupStyle}
            />
            <p className="settings-field__hint">{t("popupSettings.styleHint")}</p>
          </div>
          <ToggleSetting
            label={t("popupSettings.names")}
            description={t("popupSettings.namesHint")}
            checked={readerPopupShowDictionaryNames}
            onChange={setReaderPopupShowDictionaryNames}
          />
          <ToggleSetting
            label={t("popupSettings.anki")}
            description={t("popupSettings.ankiHint")}
            checked={readerPopupAnkiAction}
            onChange={setReaderPopupAnkiAction}
            disabled={dictionaryStyle}
          />
          <ToggleSetting
            label={t("popupSettings.voice")}
            description={t("popupSettings.voiceHint")}
            checked={readerPopupVoiceAction}
            onChange={setReaderPopupVoiceAction}
            disabled={dictionaryStyle}
          />
          <ToggleSetting
            label={t("popupSettings.pitch")}
            description={t("popupSettings.pitchHint")}
            checked={readerPopupShowPitch}
            onChange={setReaderPopupShowPitch}
            disabled={dictionaryStyle}
          />
          <ToggleSetting
            label={t("popupSettings.frequency")}
            description={t("popupSettings.frequencyHint")}
            checked={readerPopupShowFrequency}
            onChange={setReaderPopupShowFrequency}
            disabled={dictionaryStyle}
          />
        </div>
      </Card>
      <PopupAppearanceSettings />
      <ReaderLookupPreview />
      <PopupSourceSettings onDictionarySettings={onDictionarySettings} />
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <CursorClickIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("popupSettings.triggers")}</h2>
            <p>{t("popupSettings.triggersDescription")}</p>
          </div>
        </div>
        <div className="settings-list" role="group" aria-label={t("popupSettings.triggers")}>
          <ToggleSetting
            label={t("popupSettings.keyboard")}
            description={t("popupSettings.keyboardHint")}
            checked={triggers.readerPopupKeyboardShortcut}
            onChange={(value) => setReaderPopupTriggers({ readerPopupKeyboardShortcut: value })}
          />
          <ToggleSetting
            label={t("popupSettings.mouseSelection")}
            description={t("popupSettings.mouseSelectionHint")}
            checked={readerPopupMouseSelection}
            onChange={setReaderPopupMouseSelection}
          />
          <ToggleSetting
            label={t("popupSettings.click")}
            description={t("popupSettings.clickHint")}
            checked={triggers.readerPopupClickLookup}
            onChange={(value) => setReaderPopupTriggers({ readerPopupClickLookup: value })}
          />
          <ToggleSetting
            label={t("popupSettings.hover")}
            description={t("popupSettings.hoverHint")}
            checked={triggers.readerPopupHoverLookup}
            onChange={(value) => setReaderPopupTriggers({ readerPopupHoverLookup: value })}
          />
          <ToggleSetting
            label={t("popupSettings.shift")}
            description={t("popupSettings.shiftHint")}
            checked={triggers.readerPopupShiftLookup}
            onChange={(value) => setReaderPopupTriggers({ readerPopupShiftLookup: value })}
          />
          <div className="settings-field">
            <Select
              label={t("popupSettings.shortcutPreset")}
              value={triggers.readerPopupShortcutPreset}
              options={shortcutPresets}
              onChange={(value) => setReaderPopupTriggers({ readerPopupShortcutPreset: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.shortcutPresetHint")}</p>
          </div>
          <div className="settings-field">
            <Stepper
              label={t("popupSettings.scanDelay")}
              value={triggers.readerPopupHoverDelay}
              {...hoverDelayRange}
              unit={t("unit.ms")}
              onChange={(value) => setReaderPopupTriggers({ readerPopupHoverDelay: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.scanDelayHint")}</p>
          </div>
          <div className="settings-field">
            <Select
              label={t("popupSettings.mouseTrigger")}
              value={triggers.readerPopupMouseTrigger}
              options={mouseTriggers.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={(value) => setReaderPopupTriggers({ readerPopupMouseTrigger: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.mouseTriggerHint")}</p>
          </div>
          <div className="settings-field">
            <Select
              label={t("popupSettings.closeBehavior")}
              value={triggers.readerPopupCloseBehavior}
              options={popupCloseBehaviors.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={(value) => setReaderPopupTriggers({ readerPopupCloseBehavior: value })}
            />
          </div>
        </div>
      </Card>
      <Card className="settings-card settings-card--wide">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <ListMagnifyingGlassIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2>{t("popupSettings.scanning")}</h2>
            <p>{t("popupSettings.scanningDescription")}</p>
          </div>
        </div>
        <div className="settings-list">
          <ToggleSetting
            label={t("popupSettings.cjkOnly")}
            description={t("popupSettings.cjkOnlyHint")}
            checked={triggers.readerPopupCjkOnly}
            onChange={(value) => setReaderPopupTriggers({ readerPopupCjkOnly: value })}
          />
          <div className="settings-field">
            <Stepper
              label={t("popupSettings.scanLength")}
              value={triggers.readerPopupScanLength}
              {...scanLengthRange}
              unit={t("unit.characters")}
              onChange={(value) => setReaderPopupTriggers({ readerPopupScanLength: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.scanLengthHint")}</p>
          </div>
          <div className="settings-field">
            <Stepper
              label={t("popupSettings.maxResults")}
              value={triggers.readerPopupMaxResults}
              {...maxResultsRange}
              onChange={(value) => setReaderPopupTriggers({ readerPopupMaxResults: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.maxResultsHint")}</p>
          </div>
          <div className="settings-field">
            <Stepper
              label={t("popupSettings.childLevels")}
              value={triggers.readerPopupChildLevels}
              {...childLevelsRange}
              format={(value) => (value === 0 ? t("common.off") : String(value))}
              onChange={(value) => setReaderPopupTriggers({ readerPopupChildLevels: value })}
            />
            <p className="settings-field__hint">{t("popupSettings.childLevelsHint")}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
