import { HardDrivesIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Card } from "../../components/ui/Card";
import { BackupSettings } from "../backup/BackupSettings";
import { getDictionaryStoreSize } from "../dictionary/dictionaryApi";
import { getLibraryStoreSize } from "../library/libraryApi";
import { formatSize } from "./formatSize";
import { useBulkOperation } from "../operations/bulkOperation";
import { useI18n } from "../../i18n/i18n";

type Store = "library" | "dictionaries";
type Sizes = Record<Store, number | null>;

/**
 * Settings > Storage: Komori's disk use, then its backups and snapshots. Removing books or
 * dictionaries gives their space back on its own, so the sizes are read again after each.
 */
export function StorageSettings() {
  const libraryOperation = useBulkOperation("library");
  const { t } = useI18n();
  const dictionaryOperation = useBulkOperation("dictionaries");
  const pending = Boolean(libraryOperation?.active || dictionaryOperation?.active);
  const [sizes, setSizes] = useState<Sizes>({ library: null, dictionaries: null });

  useEffect(() => {
    if (pending) return;
    let active = true;
    const read = (store: Store, size: Promise<number>) =>
      size.then(
        (value) => active && setSizes((current) => ({ ...current, [store]: value })),
        () => undefined,
      );
    void read("library", getLibraryStoreSize());
    void read("dictionaries", getDictionaryStoreSize());
    return () => {
      active = false;
    };
  }, [pending, libraryOperation?.operationId, dictionaryOperation?.operationId]);

  return (
    <>
      <Card className="settings-card settings-card--wide" aria-labelledby="storage-title">
        <div className="settings-card__heading">
          <span className="settings-card__icon">
            <HardDrivesIcon aria-hidden="true" weight="duotone" />
          </span>
          <div>
            <h2 id="storage-title">{t("storage.title")}</h2>
            <p>{t("storage.description")}</p>
          </div>
        </div>
        <dl className="storage-sizes">
          <div>
            <dt>{t("storage.library")}</dt>
            <dd>{sizes.library === null ? t("storage.unavailable") : formatSize(sizes.library)}</dd>
          </div>
          <div>
            <dt>{t("storage.dictionaries")}</dt>
            <dd>
              {sizes.dictionaries === null
                ? t("storage.unavailable")
                : formatSize(sizes.dictionaries)}
            </dd>
          </div>
        </dl>
      </Card>
      <BackupSettings />
    </>
  );
}
