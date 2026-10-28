import { useI18n } from "../../i18n/i18n";
import {
  CaretLeftIcon,
  CaretRightIcon,
  MapPinIcon,
  XIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
  ArrowClockwiseIcon,
  ArrowsInIcon,
  CopyIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogCaption } from "../../components/layout/WindowControls";
import { IconButton } from "../../components/ui/IconButton";
import { imageCaption, useImageResource, type ImageResourceProps } from "./ReaderImagesPanel";
import type { ReaderImage } from "./renderer";
import { copyBookImage, imageBlob, saveBookImage } from "./bookImageActions";
import { WheelStepCounter, wheelSteps } from "./navigationInput";

export interface ImageViewerSession {
  items: ReaderImage[];
  index: number;
  signal: AbortSignal;
}

/**
 * The image viewer. Opened from a book's image it is modal over the whole window; opened
 * from the sidebar's images it is docked beside the sidebar, which stays open, so another
 * image there shows in it at once (`pick`).
 */
export function ReaderImageViewer({
  session,
  navigationBusy,
  fileName = "",
  docked = false,
  container,
  pick,
  onIndexChange,
  onJump,
  onClose,
  ...resources
}: ImageResourceProps & {
  session: ImageViewerSession;
  /** The suggested name of a saved image, before its number. */
  fileName?: string;
  navigationBusy: boolean;
  /** Beside the sidebar and not modal, rendered in `container`. */
  docked?: boolean;
  container?: Element | null;
  /** Another of the session's images chosen while the viewer shows. */
  pick?: { index: number };
  onIndexChange?: (index: number) => void;
  onJump: (id: string, signal: AbortSignal, settled: (success: boolean) => void) => boolean;
  onClose: (jumped?: boolean) => void;
}) {
  const [index, setIndex] = useState(session.index);
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [retry, setRetry] = useState(0);
  const [jumpError, setJumpError] = useState(false);
  const [imageNotice, setImageNotice] = useState("");
  const [area, setArea] = useState({ width: 920, height: 610 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const jumped = useRef(false);
  const controller = useRef(new AbortController());
  /** The latest `step`, for the native wheel listener. */
  const browse = useRef<(direction: number) => void>(() => {});
  const item = session.items[index];
  const { resource, error } = useImageResource(
    item.id,
    "viewer",
    true,
    retry,
    resources.loadImage,
    resources.releaseImage,
  );
  const rotated = rotation % 180 !== 0;
  const scale = resource
    ? Math.min(
        area.width / (rotated ? resource.height : resource.width),
        area.height / (rotated ? resource.width : resource.height),
      ) * zoom
    : 1;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setArea({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(stage);
    // React's wheel listener is passive. A native listener can consume Ctrl+wheel
    // without zooming/reflowing the application behind the modal.
    const steps = new WheelStepCounter();
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        setZoom((value) => Math.max(0.5, Math.min(4, value + (event.deltaY < 0 ? 0.25 : -0.25))));
        return;
      }
      // An image larger than the stage scrolls; otherwise the wheel browses images.
      if (event.altKey || event.metaKey || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1)
        return;
      event.preventDefault();
      const pages = steps.consume(wheelSteps(event.deltaY, event.deltaMode));
      if (pages) browse.current(Math.sign(pages));
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer?.disconnect();
      stage.removeEventListener("wheel", wheel);
    };
  }, []);
  useEffect(() => {
    controller.current = new AbortController();
    const dialog = dialogRef.current;
    returnFocus.current = document.activeElement as HTMLElement | null;
    // Docked, the sidebar's images stay usable beside the viewer, which still takes the keys.
    if (docked && typeof dialog?.show === "function") dialog.show();
    else if (!docked && typeof dialog?.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
    dialog?.querySelector<HTMLButtonElement>("[data-viewer-close]")?.focus();
    const abort = () => controller.current.abort();
    const signal = controller.current;
    session.signal.addEventListener("abort", abort, { once: true });
    return () => {
      session.signal.removeEventListener("abort", abort);
      signal.abort();
      // A docked viewer returns focus only when it had it, not when the reader moved on.
      const focused = document.activeElement;
      const held = !focused || focused === document.body || !!dialog?.contains(focused);
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      if ((!docked || held) && !jumped.current && returnFocus.current?.isConnected)
        returnFocus.current.focus({ preventScroll: true });
    };
    // The session alone decides how the viewer opens.
  }, [session]);
  const show = (next: number) => {
    setIndex(Math.max(0, Math.min(session.items.length - 1, next)));
    setZoom(1);
    setRotation(0);
    setJumpError(false);
    setImageNotice("");
    if (stageRef.current) {
      stageRef.current.scrollLeft = 0;
      stageRef.current.scrollTop = 0;
    }
  };
  const step = (direction: number) => {
    if (navigationBusy || index + direction < 0 || index + direction >= session.items.length)
      return;
    show(index + direction);
  };
  useEffect(() => {
    if (!pick) return;
    // Focus returns to the image last chosen in the sidebar.
    const dialog = dialogRef.current;
    const chosen = document.activeElement as HTMLElement | null;
    if (chosen && chosen !== document.body && !dialog?.contains(chosen))
      returnFocus.current = chosen;
    show(pick.index);
    dialog?.querySelector<HTMLButtonElement>("[data-viewer-close]")?.focus();
    // Only a new pick shows another image.
  }, [pick]);
  useEffect(() => onIndexChange?.(index), [index, onIndexChange]);
  browse.current = step;
  const copyImage = () => {
    if (!resource) return;
    void imageBlob(resource)
      .then(copyBookImage)
      .then(
        () => setImageNotice(t("imageActions.copied")),
        () => setImageNotice(t("imageActions.copyFailed")),
      );
  };
  const saveImage = () => {
    if (!resource) return;
    void imageBlob(resource)
      .then((blob) => saveBookImage(blob, `${fileName} ${index + 1}`.trim()))
      .then(
        (status) =>
          setImageNotice(
            status === "saved"
              ? t("imageActions.saved")
              : status === "failed"
                ? t("imageActions.saveFailed")
                : "",
          ),
        () => setImageNotice(t("imageActions.saveFailed")),
      );
  };
  const changeZoom = (delta: number) =>
    setZoom((value) => Math.max(0.5, Math.min(4, value + delta)));
  return createPortal(
    <dialog
      ref={dialogRef}
      className={docked ? "reader-image-viewer reader-image-viewer--docked" : "reader-image-viewer"}
      aria-label={t("viewer.label")}
      aria-modal={docked ? undefined : "true"}
      aria-describedby="reader-image-keys"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1);
        } else if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          changeZoom(0.25);
        } else if (event.key === "-") {
          event.preventDefault();
          changeZoom(-0.25);
        } else if (event.key.toLowerCase() === "r") {
          event.preventDefault();
          setRotation((value) => (value + 90) % 360);
        } else if (event.key === "0") {
          event.preventDefault();
          setZoom(1);
          setRotation(0);
        } else if (event.key === "Tab" && !docked) {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("*"),
          ).filter((control) => control.tabIndex >= 0 && !(control as HTMLButtonElement).disabled);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <DialogCaption />
      <div className="reader-image-viewer__stage">
        <p id="reader-image-keys" className="visually-hidden">
          {t("viewer.keys")}
        </p>
        <div
          className="reader-image-viewer__toolbar"
          role="group"
          aria-label={t("viewer.controls")}
        >
          <IconButton
            label={t("viewer.zoomOut")}
            disabled={zoom <= 0.5}
            onClick={() => changeZoom(-0.25)}
          >
            <MagnifyingGlassMinusIcon />
          </IconButton>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <IconButton
            label={t("viewer.zoomIn")}
            disabled={zoom >= 4}
            onClick={() => changeZoom(0.25)}
          >
            <MagnifyingGlassPlusIcon />
          </IconButton>
          <IconButton
            label={t("viewer.rotate")}
            onClick={() => setRotation((value) => (value + 90) % 360)}
          >
            <ArrowClockwiseIcon />
          </IconButton>
          <IconButton
            label={t("viewer.reset")}
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
          >
            <ArrowsInIcon />
          </IconButton>
          <IconButton label={t("imageActions.copy")} disabled={!resource} onClick={copyImage}>
            <CopyIcon />
          </IconButton>
          <IconButton label={t("imageActions.save")} disabled={!resource} onClick={saveImage}>
            <DownloadSimpleIcon />
          </IconButton>
          <IconButton data-viewer-close label={t("viewer.close")} onClick={() => onClose()}>
            <XIcon />
          </IconButton>
        </div>
        <div className="reader-image-viewer__image-wrap">
          <IconButton
            className="reader-image-viewer__nav reader-image-viewer__nav--previous"
            label={t("viewer.previous")}
            disabled={index === 0 || navigationBusy}
            onClick={() => step(-1)}
          >
            <CaretLeftIcon weight="bold" />
          </IconButton>
          <div
            ref={stageRef}
            className="reader-image-viewer__art"
            tabIndex={0}
            role="group"
            aria-label={t("viewer.panArea")}
            onPointerDown={(event) => {
              if (event.button !== 0 || !resource) return;
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: event.currentTarget.scrollLeft,
                top: event.currentTarget.scrollTop,
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start) return;
              event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
              event.currentTarget.scrollTop = start.top + start.y - event.clientY;
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
          >
            {resource ? (
              <div
                className="reader-image-viewer__canvas"
                style={{
                  width: Math.max(area.width, (rotated ? resource.height : resource.width) * scale),
                  height: Math.max(
                    area.height,
                    (rotated ? resource.width : resource.height) * scale,
                  ),
                }}
              >
                <img
                  draggable={false}
                  src={resource.url}
                  alt={item.alt || t("viewer.image", { index: index + 1 })}
                  style={{
                    width: resource.width * scale,
                    height: resource.height * scale,
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  }}
                />
              </div>
            ) : (
              <p role="status">{t(error ? "viewer.displayFailed" : "images.loading")}</p>
            )}
            {error && (
              <button type="button" onClick={() => setRetry((value) => value + 1)}>
                {t("viewer.retry")}
              </button>
            )}
          </div>
          <IconButton
            className="reader-image-viewer__nav reader-image-viewer__nav--next"
            label={t("viewer.next")}
            disabled={index === session.items.length - 1 || navigationBusy}
            onClick={() => step(1)}
          >
            <CaretRightIcon weight="bold" />
          </IconButton>
        </div>
        <div className="reader-image-viewer__details">
          <span className="reader-image-viewer__meta" role="status">
            {t("viewer.position", { index: index + 1, count: session.items.length })} ·{" "}
            {imageCaption(item)}
          </span>
          <button
            className="reader-image-viewer__location"
            type="button"
            disabled={navigationBusy}
            onClick={() => {
              setJumpError(false);
              if (
                !onJump(item.id, controller.current.signal, (success) => {
                  if (controller.current.signal.aborted) return;
                  if (success) {
                    jumped.current = true;
                    onClose(true);
                  } else setJumpError(true);
                })
              )
                setJumpError(true);
            }}
          >
            <MapPinIcon weight="fill" /> {t("viewer.goTo")}
          </button>
          {jumpError && <p role="alert">{t("viewer.jumpFailed")}</p>}
          {imageNotice && <p role="status">{imageNotice}</p>}
        </div>
      </div>
    </dialog>,
    (docked && container) || document.body,
  );
}
