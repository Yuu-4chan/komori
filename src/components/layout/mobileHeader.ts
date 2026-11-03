import { createContext, type ComponentType, type ReactNode } from "react";

export interface MobileHeaderProps {
  title: string;
  /** Below the title, such as the Library's count of books. */
  summary?: ReactNode;
  /** After Settings, such as the Library's Add books. */
  actions?: ReactNode;
  /** A page opened from another, such as a Settings section, heads itself with Back instead. */
  back?: boolean;
}

/**
 * The phone's page heading, which Komori's mobile frame provides; without it, as on the PC,
 * each page keeps its own header.
 */
export const MobileHeaderContext = createContext<ComponentType<MobileHeaderProps> | null>(null);
