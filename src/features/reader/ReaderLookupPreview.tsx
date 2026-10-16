import { useI18n } from "../../i18n/i18n";
import { useNavigate } from "react-router-dom";
import { EyeIcon } from "@phosphor-icons/react";
import { Card } from "../../components/ui/Card";
import { useAppearance } from "../appearance/AppearanceProvider";
import { useDefinitionSources } from "../dictionary/definitionSources";
import { ReaderLookupPopup } from "./ReaderLookupPopup";

/** The word every popup preview looks up. */
const previewQuery = "読む";

/**
 * The real lookup popup for 読む, in the saved popup design and content settings, with the
 * imported dictionaries, even while Reader lookup is disabled. With no dictionary to define it, it
 * offers to get one, as the Reader's popup does.
 */
export function ReaderLookupPreview() {
  const appearance = useAppearance();
  const navigate = useNavigate();
  const definitionSources = useDefinitionSources();
  const { t } = useI18n();
  return (
    <Card className="settings-card settings-card--wide">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <EyeIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("popupPreview.title")}</h2>
          <p>{t("popupPreview.description", { query: previewQuery })}</p>
        </div>
      </div>
      <ReaderLookupPopup
        preview
        query={previewQuery}
        definitionSources={definitionSources}
        placement={{
          left: 0,
          top: 0,
          width: appearance.readerPopupWidth,
          height: appearance.readerPopupHeight,
        }}
        onSearchTerm={(term) => navigate(`/dictionary?q=${encodeURIComponent(term)}`)}
      />
    </Card>
  );
}
