import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/Button";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { i18n } from "../i18n/i18n";

/** The app's last resort: a render failure anywhere leaves a Reload action, not a blank window. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallback={<AppFailure />}>{children}</ErrorBoundary>;
}

function AppFailure() {
  // Outside the providers; the module translator still follows the interface language.
  const t = i18n().t;
  return (
    <main className="app-failure">
      <div className="empty-state">
        <span className="empty-state__icon">
          <WarningCircleIcon aria-hidden="true" weight="duotone" />
        </span>
        <h2>{t("app.failed")}</h2>
        <Button onClick={() => window.location.reload()}>{t("app.reload")}</Button>
      </div>
    </main>
  );
}
