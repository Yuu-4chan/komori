import { useI18n } from "../../i18n/i18n";
import { ReaderPanelHeading } from "./ReaderPanelHeading";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import type {
  ReaderImage,
  ReaderImageResource,
  ReaderImages,
  ReaderRendererFactory,
} from "./renderer";

export interface ImageResourceProps {
  loadImage: (
    id: string,
    size: "thumbnail" | "viewer",
    signal: AbortSignal,
  ) => Promise<ReaderImageResource>;
  releaseImage: (url: string) => void;
}

export interface ReaderImagesPanelProps extends ImageResourceProps {
  ready: boolean;
  session?: ReaderRendererFactory;
  listImages: (signal: AbortSignal) => Promise<ReaderImages>;
  onOpen: (items: ReaderImage[], index: number, signal: AbortSignal) => void;
  /** The image the docked viewer shows, marked among the thumbnails. */
  current?: number;
}

export function ReaderImagesPanel({
  ready,
  session,
  listImages,
  onOpen,
  current,
  ...resources
}: ReaderImagesPanelProps) {
  const [result, setResult] = useState<ReaderImages | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setResult(null);
    setError(false);
    if (ready)
      void listImages(controller.signal).then(
        (value) => {
          if (!controller.signal.aborted) setResult(value);
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      );
    return () => controller.abort();
  }, [ready, session, listImages, retry]);
  const { t, tp } = useI18n();
  return (
    <section className="reader-images-panel" aria-labelledby="reader-images-heading">
      <ReaderPanelHeading
        id="reader-images-heading"
        eyebrow={t("images.eyebrow")}
        title={t("sidebar.images")}
      />
      <p role="status">
        {!ready
          ? t("images.needsBook")
          : error
            ? t("images.loadFailed")
            : !result
              ? t("images.finding")
              : !result.items.length
                ? t("images.none")
                : tp("images.count", result.items.length)}
      </p>
      {error && (
        <Button tone="secondary" onClick={() => setRetry((value) => value + 1)}>
          {t("images.retry")}
        </Button>
      )}
      {result?.truncated && <p>{t("images.truncated")}</p>}
      {!!result?.failedSections && <p role="status">{t("images.sectionsFailed")}</p>}
      <div className="reader-image-stack">
        {result?.items.map((item, index) => (
          <ImageCard
            key={item.id}
            item={item}
            index={index}
            current={index === current}
            {...resources}
            onOpen={() => {
              const signal = request.current?.signal;
              if (signal && !signal.aborted) onOpen(result.items, index, signal);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function ImageCard({
  item,
  index,
  current,
  onOpen,
  loadImage,
  releaseImage,
}: ImageResourceProps & {
  item: ReaderImage;
  index: number;
  current: boolean;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // The viewer's arrows keep the image it shows in view here.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const { t } = useI18n();
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: ref.current.closest(".reader-sidebar__content"),
      rootMargin: "240px",
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { resource, error } = useImageResource(
    item.id,
    "thumbnail",
    visible,
    retry,
    loadImage,
    releaseImage,
  );
  return (
    <div className="reader-image-card-wrap">
      <button
        ref={ref}
        type="button"
        className={current ? "reader-image-card reader-image-card--current" : "reader-image-card"}
        aria-current={current || undefined}
        aria-label={t("images.open", { index: index + 1, name: item.alt || item.label })}
        onClick={onOpen}
      >
        <div className="reader-image-art">
          {resource ? (
            <img src={resource.url} alt={item.alt} />
          ) : (
            <span>{t(error ? "images.unavailable" : "images.loading")}</span>
          )}
        </div>
        <span className="reader-image-card__meta">{imageCaption(item)}</span>
      </button>
      {error && (
        <Button tone="secondary" onClick={() => setRetry((value) => value + 1)}>
          {t("images.retryThumbnail", { index: index + 1 })}
        </Button>
      )}
    </div>
  );
}

/** The image's chapter, or its section when no chapter precedes it. */
export function imageCaption(item: ReaderImage): string {
  return item.label;
}

export function useImageResource(
  id: string,
  size: "thumbnail" | "viewer",
  enabled: boolean,
  retry: number,
  loadImage: ImageResourceProps["loadImage"],
  releaseImage: ImageResourceProps["releaseImage"],
) {
  const [loaded, setLoaded] = useState<{
    id: string;
    size: "thumbnail" | "viewer";
    retry: number;
    loadImage: ImageResourceProps["loadImage"];
    resource: ReaderImageResource;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let owned: string | undefined;
    setLoaded(null);
    setError(false);
    if (enabled)
      void loadImage(id, size, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) releaseImage(result.url);
          else {
            owned = result.url;
            setLoaded({ id, size, retry, loadImage, resource: result });
          }
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      );
    return () => {
      controller.abort();
      if (owned) releaseImage(owned);
    };
  }, [id, size, enabled, retry, loadImage, releaseImage]);
  // A changed caption/selection must never paint the preceding, soon-to-be-revoked URL
  // in the frame before the effect cancels it and starts the replacement request.
  const current =
    enabled &&
    loaded?.id === id &&
    loaded.size === size &&
    loaded.retry === retry &&
    loaded.loadImage === loadImage;
  return { resource: current ? loaded.resource : null, error };
}
