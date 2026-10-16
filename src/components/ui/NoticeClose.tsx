import { XIcon } from "@phosphor-icons/react";

import { useI18n } from "../../i18n/i18n";
import { IconButton } from "./IconButton";

/** Closes a notice, at the end of its row. */
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
