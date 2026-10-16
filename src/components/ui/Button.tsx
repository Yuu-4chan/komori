import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  icon?: ReactNode;
  tone?: "primary" | "secondary" | "quiet" | "danger";
}

export function Button({
  children,
  className,
  icon,
  tone = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={["button", `button--${tone}`, className].filter(Boolean).join(" ")}
      type={type}
      {...props}
    >
      {icon ? <span className="button__icon">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}
