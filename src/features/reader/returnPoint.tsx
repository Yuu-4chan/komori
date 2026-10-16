import { ArrowCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { useI18n } from "../../i18n/i18n";
import type { ReaderBookmarkLocator } from "./renderer";

/** Where reading was before a far jump, offered back until dismissed. */
export interface ReturnPoint {
  locator: ReaderBookmarkLocator;
  /** Book units before the place, and the book's total, for its percentage. */
  current: number;
  total: number;
}

/** A jump is far once it moves at least 1% of the book, and never less than 1,000 units. */
export function isFarJump(from: number, to: number, total: number): boolean {
  if (![from, to, total].every(Number.isFinite) || total <= 0) return false;
  return Math.abs(to - from) >= Math.max(1000, total * 0.01);
}

/** The pill above the progress pill that returns to the place before a far jump. */
export function ReaderReturnPoint({
  point,
  busy,
  onReturn,
  onDismiss,
}: {
  point: ReturnPoint;
  busy: boolean;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const percent = Math.floor((Math.min(point.current, point.total) / point.total) * 100);
  return (
    <div className="reader-return-point" role="group" aria-label={t("reader.returnPoint")}>
      <button
        type="button"
        className="reader-return-point__back"
        disabled={busy}
        onClick={onReturn}
      >
        <ArrowCounterClockwiseIcon aria-hidden="true" size={14} weight="bold" />
        {t("reader.returnTo", { percent })}
      </button>
      <button
        type="button"
        className="reader-return-point__dismiss"
        aria-label={t("reader.dismissReturn")}
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" size={12} weight="bold" />
      </button>
    </div>
  );
}
