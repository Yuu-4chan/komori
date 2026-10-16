export function ReaderPanelHeading({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children?: string;
}) {
  return (
    <header className="reader-subpanel-heading">
      <span className="reader-subpanel-heading__eyebrow">{eyebrow}</span>
      <h2 id={id}>{title}</h2>
      {children ? <p>{children}</p> : null}
    </header>
  );
}
