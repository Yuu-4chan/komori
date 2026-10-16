import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  label: string;
  compact?: boolean;
  quiet?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  children,
  className,
  label,
  compact = false,
  quiet = false,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={[
        "icon-button",
        compact && "icon-button--compact",
        quiet && "icon-button--quiet",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={label}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
