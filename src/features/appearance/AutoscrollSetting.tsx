import { ToggleSetting } from "../../components/ui/ToggleSetting";
import { useAppearance } from "./AppearanceProvider";
import { useI18n } from "../../i18n/i18n";

export function AutoscrollSetting() {
  const { middleClickAutoscroll, setMiddleClickAutoscroll } = useAppearance();
  const { t } = useI18n();
  return (
    <ToggleSetting
      label={t("autoscroll.label")}
      description={t("autoscroll.hint")}
      checked={middleClickAutoscroll}
      onChange={setMiddleClickAutoscroll}
    />
  );
}
