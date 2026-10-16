import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  action?: ReactNode;
  description: string;
  icon: Icon;
  title: string;
}

export function EmptyState({ action, description, icon: EmptyIcon, title }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <EmptyIcon aria-hidden="true" weight="duotone" />
      </span>
      <div className="empty-state__copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
