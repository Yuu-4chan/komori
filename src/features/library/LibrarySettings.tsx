import { Stepper } from "../../components/ui/Stepper";
import { useAppearance } from "../appearance/AppearanceProvider";
import { LibraryFolders } from "./LibraryFolders";
import { libraryCardSize } from "./libraryView";
import { useI18n } from "../../i18n/i18n";

/** Settings > General's Library card: how big the Library's grid cards are, and book folders. */
export function LibrarySettings() {
  const { library, updateLibrary } = useAppearance();
  const { t } = useI18n();
  return (
    <LibraryFolders>
      <div className="settings-field">
        <Stepper
          label={t("librarySettings.cardSize")}
          value={library.cardSize}
          {...libraryCardSize}
          unit={t("unit.px")}
          onChange={(cardSize) => updateLibrary({ cardSize })}
        />
        <p className="settings-field__hint">{t("librarySettings.cardSizeHint")}</p>
      </div>
    </LibraryFolders>
  );
}
