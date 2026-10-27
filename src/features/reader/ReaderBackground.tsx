import { useI18n } from "../../i18n/i18n";
import { Stepper } from "../../components/ui/Stepper";
import { backgroundBlurLevel } from "./backgroundAppearance";
import { useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../../components/ui/Button";
import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useAppearance } from "../appearance/AppearanceProvider";
import {
  readerBackgroundStore,
  useReaderBackground,
  type ReaderBackground,
} from "./backgroundResource";

export function ReaderBackgroundControls() {
  const state = useReaderBackground();
  const {
    readerBackgroundBlur,
    setReaderBackgroundBlur,
    readerBackgroundBlurLevel,
    setReaderBackgroundBlurLevel,
  } = useAppearance();
  const disabled = !!state.pending || !isTauri();
  const { t } = useI18n();
  return (
    <section className="reader-appearance-card" aria-labelledby="reader-background-heading">
      <h3 className="reader-appearance-card__title" id="reader-background-heading">
        {t("background.title")}
      </h3>
      <div className="reader-appearance-rows">
        <div className="reader-background-row">
          <span>{t("background.image")}</span>
          <div className="reader-background-actions">
            <Button
              tone="secondary"
              aria-label={t(state.image ? "background.replaceLabel" : "background.chooseLabel")}
              disabled={disabled}
              onClick={() => void readerBackgroundStore.change("choose")}
            >
              {t(state.image ? "background.replace" : "background.choose")}
            </Button>
            <Button
              tone="secondary"
              aria-label={t("background.removeLabel")}
              disabled={disabled || (!state.image && !state.error)}
              onClick={() => void readerBackgroundStore.change("remove")}
            >
              {t("common.remove")}
            </Button>
          </div>
        </div>
        {/* The blur and its level show only for an image to blur. */}
        {state.image && (
          <ToggleSetting
            label={t("background.blur")}
            checked={readerBackgroundBlur}
            onChange={setReaderBackgroundBlur}
          />
        )}
        {state.image && readerBackgroundBlur && (
          <Stepper
            label={t("background.blurLevel")}
            value={readerBackgroundBlurLevel}
            min={backgroundBlurLevel.min}
            max={backgroundBlurLevel.max}
            step={backgroundBlurLevel.step}
            unit={t("unit.px")}
            onChange={setReaderBackgroundBlurLevel}
          />
        )}
      </div>
      <p className="reader-appearance-card__hint" role="status">
        {!isTauri()
          ? t("background.desktopOnly")
          : state.pending === "load"
            ? t("background.loading")
            : state.pending === "choose"
              ? t("background.choosing")
              : state.pending === "remove"
                ? t("background.removing")
                : ""}
      </p>
      {state.error && (
        <div role="alert">
          <p className="reader-appearance-card__hint">{t(state.error)}</p>
          <Button
            tone="secondary"
            disabled={disabled}
            onClick={() => void readerBackgroundStore.load()}
          >
            {t("background.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ReaderBackgroundSurface() {
  const { image, imageFailed, attempt } = useReaderBackground();
  const { readerBackgroundBlur, readerBackgroundBlurLevel } = useAppearance();
  return image && !imageFailed ? (
    <BackgroundImage
      key={`${image.revision}/${attempt}`}
      image={image}
      attempt={attempt}
      blur={readerBackgroundBlur}
      level={readerBackgroundBlurLevel}
    />
  ) : null;
}
function BackgroundImage({
  image,
  attempt,
  blur,
  level,
}: {
  image: ReaderBackground;
  attempt: number;
  blur: boolean;
  level: number;
}) {
  const [ready, setReady] = useState(false);
  return (
    <div
      className={`reader-background${blur ? " reader-background--blur" : ""}`}
      style={{ "--reader-background-blur": `${level}px` } as CSSProperties}
      data-ready={ready}
      aria-hidden="true"
    >
      <img
        src={image.url}
        alt=""
        draggable={false}
        onLoad={() => setReady(true)}
        onError={() => readerBackgroundStore.failed(image.revision, attempt)}
      />
    </div>
  );
}
