import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "article" | "section";
  children: ReactNode;
}

export function Card({ as: Element = "section", children, className, ...props }: CardProps) {
  return (
    <Element className={["card", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </Element>
  );
}
