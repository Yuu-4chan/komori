import { useContext, type ReactNode } from "react";

import { MobileHeaderContext } from "./mobileHeader";

interface PageHeaderProps {
  actions?: ReactNode;
  description: string;
  title: string;
}

export function PageHeader({ actions, description, title }: PageHeaderProps) {
  const MobileHeader = useContext(MobileHeaderContext);
  if (MobileHeader) return <MobileHeader actions={actions} title={title} />;
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
