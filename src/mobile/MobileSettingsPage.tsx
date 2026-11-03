import { CaretRightIcon, GearSixIcon, InfoIcon } from "@phosphor-icons/react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { version } from "../../package.json";
import { BrandMark } from "../brand/BrandMark";
import { AppThemeSettings } from "../features/appearance/AppThemeSettings";
import { useI18n } from "../i18n/i18n";
import { MobilePageHeader } from "./MobileShell";

const sections = [
  { id: "general", label: "settings.general", icon: GearSixIcon },
  { id: "about", label: "settings.about", icon: InfoIcon },
] as const;

/**
 * Settings on the phone: a list of its sections, each opening as its own page that Back
 * leaves. General holds the interface language and the application theme; About, the version.
 */
export function MobileSettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const section = sections.find(({ id }) => id === searchParams.get("section"));

  if (!section)
    return (
      <div className="mobile-page mobile-settings">
        <MobilePageHeader back title={t("settings.title")} />
        <nav aria-label={t("settings.categories")} className="mobile-group">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              className="mobile-row"
              key={id}
              onClick={() => navigate(`/settings?section=${id}`)}
              type="button"
            >
              <span aria-hidden="true" className="mobile-row__icon">
                <Icon weight="fill" />
              </span>
              <span className="mobile-row__label">{t(label)}</span>
              <CaretRightIcon aria-hidden="true" className="mobile-row__chevron" weight="bold" />
            </button>
          ))}
        </nav>
        <p className="mobile-settings__version">{t("settings.version", { version })}</p>
      </div>
    );

  return (
    <div className={`mobile-page mobile-settings mobile-settings--${section.id}`}>
      <MobilePageHeader back title={t(section.label)} />
      {section.id === "general" ? (
        <AppThemeSettings />
      ) : (
        <div className="mobile-about">
          <BrandMark className="mobile-about__brand" />
          <p>{t("settings.version", { version })}</p>
        </div>
      )}
    </div>
  );
}
