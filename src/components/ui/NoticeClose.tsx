import { useEffect, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";

import { useI18n } from "../../i18n/i18n";
import { IconButton } from "./IconButton";

/** Closes a notice, at the end of its row. */
/** How long a notice with nothing to act on stays. */
const NOTICE_TIME_MS = 6000;

/** Closes a notice on its own while `passing`: one that only says all went well. */
export function useNoticeTimeout(passing: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!passing) return;
    const timeout = setTimeout(() => close.current(), NOTICE_TIME_MS);
    return () => clearTimeout(timeout);
  }, [passing]);
}

export function NoticeClose({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <IconButton
      className="library-notice__close"
      compact
      label={t("common.close")}
      onClick={onClose}
      quiet
    >
      <XIcon aria-hidden="true" weight="bold" />
    </IconButton>
  );
}
