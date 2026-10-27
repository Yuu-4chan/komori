import { useI18n, type MessageKey } from "../../i18n/i18n";
import { ReaderBackgroundControls } from "./ReaderBackground";
import { ReaderPanelHeading } from "./ReaderPanelHeading";
import { ChoiceField } from "../../components/ui/ChoiceField";
import { ReaderFontControls } from "./ReaderFontControls";
import { Stepper, type StepperSource } from "../../components/ui/Stepper";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { Select } from "../../components/ui/Select";
import { readerFooterChoices, type ReaderFooterPreferences } from "./footerPreferences";
import { readerWheelStep, readerChapterWheelThreshold as thresholdRange } from "./navigationInput";
import { useAppearance } from "../appearance/AppearanceProvider";
import {
  readerFontSize,
  readerFuriganaStyles,
  type ReaderFuriganaStyle,
  readerVnParagraphs as vnParagraphRange,
  readerVnTextSpeed as vnSpeedRange,
  readerLetterSpacing,
  readerLineHeight,
  readerMaxHeight,
  readerParagraphIndent,
  readerParagraphMargin,
  readerSideMargin,
  readerWordSpacing,
  readerMaxWidth,
  type ReaderBlurMode,
  type ReaderTextOrientation,
  type ReaderPageLayout,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "./presentation";
import type { ReaderImageBlurBoundary } from "./renderer";
import { ReaderThemeSection, type ReaderThemeSectionProps } from "./ReaderThemeSection";

export interface ReaderAppearancePanelProps extends ReaderThemeSectionProps {
  footer: ReaderFooterPreferences;
  onFooterChange: (patch: Partial<ReaderFooterPreferences>) => void;
  fontSize: number;
  onFontSizeChange: (fontSize: number) => void;
  /** The line height as a multiple of the font size. */
  lineHeight: number;
  onLineHeightChange: (lineHeight: number) => void;
  /** The space between characters and at word spaces in pixels; 0 keeps the book's. */
  letterSpacing: number;
  onLetterSpacingChange: (letterSpacing: number) => void;
  wordSpacing: number;
  onWordSpacingChange: (wordSpacing: number) => void;
  /** The paragraph indentation in em. */
  paragraphIndent: number;
  onParagraphIndentChange: (paragraphIndent: number) => void;
  /** The space before and after each paragraph in pixels. */
  paragraphMargin: number;
  onParagraphMarginChange: (paragraphMargin: number) => void;
  /** The space left and right of each page's text in pixels. */
  pageMargin: number;
  onPageMarginChange: (pageMargin: number) => void;
  /** Maximum text width per page in CSS pixels. */
  maxWidth: number;
  monitor: { width: number; height: number } | null;
  pageLayout: ReaderPageLayout;
  onPageLayoutChange: (layout: ReaderPageLayout) => void;
  onMaxWidthChange: (maxWidth: number) => void;
  /** The tallest the reading area may be in pixels. */
  maxHeight: number;
  /** Receives whether the height was stepped or typed. */
  onMaxHeightChange: (maxHeight: number, source: StepperSource) => void;
  writingMode: ReaderWritingMode;
  onWritingModeChange: (writingMode: ReaderWritingMode) => void;
  /** How vertical text stands. */
  textOrientation: ReaderTextOrientation;
  onTextOrientationChange: (textOrientation: ReaderTextOrientation) => void;
  /** Independent prose paragraph composition choices. */
  textJustification: boolean;
  onTextJustificationChange: (justify: boolean) => void;
  prettyTextWrap: boolean;
  onPrettyTextWrapChange: (pretty: boolean) => void;
  /** Whether every book's furigana is hidden. */
  hideFurigana: boolean;
  onHideFuriganaChange: (hideFurigana: boolean) => void;
  furiganaStyle?: ReaderFuriganaStyle;
  onFuriganaStyleChange?: (style: ReaderFuriganaStyle) => void;
  /** Whether book images are blurred within the chosen scope. */
  blurMode: ReaderBlurMode;
  onBlurModeChange: (mode: ReaderBlurMode) => void;
  imageBlurBoundary?: ReaderImageBlurBoundary;
  blurImage: boolean;
  onBlurImageChange: (blurImage: boolean) => void;
  /** Whether books turn pages or scroll continuously. */
  viewMode: ReaderViewMode;
  vnNotice?: "fixed-layout" | "whole-section" | "instant-text";
  onViewModeChange: (viewMode: ReaderViewMode) => void;
  /** How far one mouse wheel step scrolls a continuous book, in pixels. */
  wheelStep: number;
  onWheelStepChange: (wheelStep: number) => void;
}

const viewModeOptions: { value: ReaderViewMode; label: MessageKey }[] = [
  { value: "continuous", label: "appearancePanel.continuous" },
  { value: "semi-continuous", label: "appearancePanel.semiContinuous" },
  { value: "paginated", label: "appearancePanel.paginated" },
  { value: "vn", label: "appearancePanel.vn" },
];

const writingModeOptions: { value: ReaderWritingMode; label: MessageKey }[] = [
  { value: "horizontal", label: "appearancePanel.horizontal" },
  { value: "vertical", label: "appearancePanel.vertical" },
];

const textOrientationOptions: { value: ReaderTextOrientation; label: MessageKey }[] = [
  { value: "mixed", label: "appearancePanel.mixed" },
  { value: "upright", label: "appearancePanel.upright" },
];

/**
 * The in-reader Appearance panel. Its Theme section, complete Typography controls, Page flow's
 * view mode, writing mode, text orientation, paragraph margin, margin, max height, and
 * wheel step, Reader footer visibility, Text behavior's paragraph layout and Hide furigana, and Images' Blur image and mode exist so far.
 */
export function ReaderAppearancePanel({
  footer,
  onFooterChange,
  fontSize,
  onFontSizeChange,
  lineHeight,
  onLineHeightChange,
  letterSpacing,
  onLetterSpacingChange,
  wordSpacing,
  onWordSpacingChange,
  paragraphIndent,
  onParagraphIndentChange,
  paragraphMargin,
  onParagraphMarginChange,
  pageMargin,
  onPageMarginChange,
  maxWidth,
  onMaxWidthChange,
  monitor,
  pageLayout,
  onPageLayoutChange,
  maxHeight,
  onMaxHeightChange,
  writingMode,
  onWritingModeChange,
  textOrientation,
  onTextOrientationChange,
  textJustification,
  onTextJustificationChange,
  prettyTextWrap,
  onPrettyTextWrapChange,
  hideFurigana,
  onHideFuriganaChange,
  furiganaStyle = "hide",
  onFuriganaStyleChange,
  blurImage,
  onBlurImageChange,
  blurMode,
  onBlurModeChange,
  imageBlurBoundary,
  viewMode,
  vnNotice,
  onViewModeChange,
  wheelStep,
  onWheelStepChange,
  ...theme
}: ReaderAppearancePanelProps) {
  const {
    readerChapterWheelThreshold,
    setReaderChapterWheelThreshold,
    readerVnParagraphs,
    setReaderVnParagraphs,
    readerVnTextSpeed,
    setReaderVnTextSpeed,
  } = useAppearance();
  const { t } = useI18n();
  const translated = <T extends string>(options: { value: T; label: MessageKey }[]) =>
    options.map((option) => ({ value: option.value, label: t(option.label) }));
  return (
    <div className="reader-appearance-panel">
      <ReaderPanelHeading eyebrow={t("appearancePanel.eyebrow")} title={t("sidebar.appearance")} />
      <ReaderThemeSection {...theme} />
      <ReaderBackgroundControls />
      <section className="reader-appearance-card" aria-labelledby="reader-appearance-typography">
        <h3 className="reader-appearance-card__title" id="reader-appearance-typography">
          {t("appearancePanel.typography")}
        </h3>
        <div className="reader-appearance-rows">
          <ReaderFontControls />
          <Stepper
            label={t("appearancePanel.fontSize")}
            value={fontSize}
            min={readerFontSize.min}
            max={readerFontSize.max}
            step={readerFontSize.step}
            unit={t("unit.px")}
            onChange={onFontSizeChange}
          />
          <Stepper
            label={t("appearancePanel.lineHeight")}
            value={lineHeight}
            min={readerLineHeight.min}
            max={readerLineHeight.max}
            step={readerLineHeight.step}
            format={(value) => value.toFixed(2)}
            onChange={onLineHeightChange}
          />
          <Stepper
            label={t("appearancePanel.paragraphIndent")}
            value={paragraphIndent}
            min={readerParagraphIndent.min}
            max={readerParagraphIndent.max}
            step={readerParagraphIndent.step}
            unit={t("unit.em")}
            onChange={onParagraphIndentChange}
          />
          <Stepper
            label={t("appearancePanel.letterSpacing")}
            value={letterSpacing}
            min={readerLetterSpacing.min}
            max={readerLetterSpacing.max}
            step={readerLetterSpacing.step}
            unit={t("unit.px")}
            onChange={onLetterSpacingChange}
          />
          <Stepper
            label={t("appearancePanel.wordSpacing")}
            value={wordSpacing}
            min={readerWordSpacing.min}
            max={readerWordSpacing.max}
            step={readerWordSpacing.step}
            unit={t("unit.px")}
            onChange={onWordSpacingChange}
          />
        </div>
      </section>
      <section className="reader-appearance-card" aria-labelledby="reader-appearance-page-flow">
        <h3 className="reader-appearance-card__title" id="reader-appearance-page-flow">
          {t("appearancePanel.pageFlow")}
        </h3>
        <div className="reader-appearance-rows">
          <div className="reader-view-choice">
            <ChoiceField
              label={t("appearancePanel.viewMode")}
              value={viewMode}
              options={translated(viewModeOptions)}
              onChange={onViewModeChange}
            />
          </div>
          <ChoiceField
            label={t("appearancePanel.writingMode")}
            value={writingMode}
            options={translated(writingModeOptions)}
            onChange={onWritingModeChange}
          />
          {viewMode === "paginated" && writingMode !== "vertical" && (
            <ChoiceField
              label={t("appearancePanel.pages")}
              value={pageLayout}
              options={[
                { value: "single", label: t("appearancePanel.single") },
                { value: "double", label: t("appearancePanel.double") },
              ]}
              onChange={onPageLayoutChange}
            />
          )}
          {/* Only what applies shows: orientation for vertical text, the wheel step for the
              views it scrolls, blur choices with their blur. */}
          {writingMode === "vertical" && (
            <ChoiceField
              label={t("appearancePanel.textOrientation")}
              value={textOrientation}
              options={translated(textOrientationOptions)}
              onChange={onTextOrientationChange}
            />
          )}
          <Stepper
            label={t("appearancePanel.paragraphMargin")}
            value={paragraphMargin}
            min={readerParagraphMargin.min}
            max={readerParagraphMargin.max}
            step={readerParagraphMargin.step}
            unit={t("unit.px")}
            onChange={onParagraphMarginChange}
          />
          <Stepper
            label={t("appearancePanel.pageMargin")}
            value={pageMargin}
            min={readerSideMargin.min}
            max={readerSideMargin.max}
            step={readerSideMargin.step}
            unit={t("unit.px")}
            onChange={onPageMarginChange}
          />
          <Stepper
            label={t("appearancePanel.maxWidth")}
            value={maxWidth}
            min={readerMaxWidth.min}
            max={monitor ? Math.max(100, Math.ceil(monitor.width / 10) * 10) : readerMaxWidth.max}
            step={readerMaxWidth.step}
            unit={t("unit.px")}
            onChange={onMaxWidthChange}
          />
          <Stepper
            label={t("appearancePanel.maxHeight")}
            value={maxHeight}
            min={readerMaxHeight.min}
            max={monitor ? Math.max(100, Math.ceil(monitor.height / 10) * 10) : readerMaxHeight.max}
            step={readerMaxHeight.step}
            unit={t("unit.px")}
            onChange={onMaxHeightChange}
          />
          {(viewMode === "continuous" || viewMode === "semi-continuous") && (
            <Stepper
              label={t("appearancePanel.wheelStep")}
              value={wheelStep}
              min={readerWheelStep.min}
              max={readerWheelStep.max}
              step={readerWheelStep.step}
              unit={t("unit.px")}
              onChange={onWheelStepChange}
            />
          )}
          {viewMode === "vn" && (
            <>
              <Stepper
                label={t("appearancePanel.vnParagraphs")}
                value={readerVnParagraphs}
                {...vnParagraphRange}
                onChange={setReaderVnParagraphs}
              />
              <Stepper
                label={t("appearancePanel.revealSpeed")}
                value={readerVnTextSpeed}
                {...vnSpeedRange}
                unit={t("unit.charsPerSecond")}
                onChange={setReaderVnTextSpeed}
              />
            </>
          )}
          {(viewMode === "paginated" || viewMode === "semi-continuous") && (
            <Stepper
              label={t("appearancePanel.chapterThreshold")}
              value={readerChapterWheelThreshold}
              min={thresholdRange.min}
              max={thresholdRange.max}
              step={thresholdRange.step}
              unit={t("unit.steps")}
              onChange={setReaderChapterWheelThreshold}
            />
          )}
        </div>
        {viewMode === "vn" && vnNotice && (
          <>
            <p className="reader-appearance-card__hint" role="status">
              {t(
                vnNotice === "fixed-layout"
                  ? "appearancePanel.vnFixed"
                  : vnNotice === "whole-section"
                    ? "appearancePanel.vnWhole"
                    : "appearancePanel.vnInstant",
              )}
            </p>
          </>
        )}
      </section>
      <section className="reader-appearance-card" aria-labelledby="reader-appearance-footer">
        <h3 className="reader-appearance-card__title" id="reader-appearance-footer">
          {t("appearancePanel.footer")}
        </h3>
        <div className="reader-appearance-rows">
          {readerFooterChoices.map(({ key, label }) => (
            <ToggleSetting
              key={key}
              label={t(label)}
              checked={footer[key]}
              onChange={(checked) => onFooterChange({ [key]: checked })}
            />
          ))}
        </div>
      </section>
      <section className="reader-appearance-card" aria-labelledby="reader-appearance-text-behavior">
        <h3 className="reader-appearance-card__title" id="reader-appearance-text-behavior">
          {t("appearancePanel.textBehavior")}
        </h3>
        <div className="reader-appearance-rows">
          <ToggleSetting
            label={t("appearancePanel.justification")}
            checked={textJustification}
            onChange={onTextJustificationChange}
          />
          <ToggleSetting
            label={t("appearancePanel.prettyWrap")}
            checked={prettyTextWrap}
            onChange={onPrettyTextWrapChange}
          />
          <ToggleSetting
            label={t("appearancePanel.hideFurigana")}
            checked={hideFurigana}
            onChange={onHideFuriganaChange}
          />
          {hideFurigana && (
            <Select
              label={t("appearancePanel.furiganaStyle")}
              value={furiganaStyle}
              options={readerFuriganaStyles.map((value) => ({
                value,
                label: t(`furigana.${value}`),
              }))}
              onChange={(style) => onFuriganaStyleChange?.(style)}
            />
          )}
        </div>
        {prettyTextWrap &&
          typeof CSS !== "undefined" &&
          CSS.supports &&
          !CSS.supports("text-wrap", "pretty") && (
            <p className="reader-appearance-card__hint" role="status">
              {t("appearancePanel.prettyWrapUnsupported")}
            </p>
          )}
      </section>
      <section className="reader-appearance-card" aria-labelledby="reader-appearance-images">
        <h3 className="reader-appearance-card__title" id="reader-appearance-images">
          {t("sidebar.images")}
        </h3>
        <div className="reader-appearance-rows">
          <ToggleSetting
            label={t("appearancePanel.blurImage")}
            checked={blurImage}
            onChange={onBlurImageChange}
          />
          {blurImage && (
            <ChoiceField
              label={t("appearancePanel.blurMode")}
              value={blurMode}
              options={[
                { value: "all", label: t("appearancePanel.blurAll") },
                { value: "after-toc", label: t("appearancePanel.blurAfterToc") },
              ]}
              onChange={onBlurModeChange}
            />
          )}
        </div>
        {blurImage &&
          imageBlurBoundary &&
          (imageBlurBoundary === "fixed-layout" ? (
            <p className="reader-appearance-card__hint" role="status">
              {t("appearancePanel.blurFixed")}
            </p>
          ) : (
            blurMode === "after-toc" && (
              <p className="reader-appearance-card__hint" role="status">
                {t(
                  imageBlurBoundary === "available"
                    ? "appearancePanel.blurBoundary"
                    : "appearancePanel.blurNoBoundary",
                )}
              </p>
            )
          ))}
      </section>
    </div>
  );
}
