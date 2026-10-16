import type { MessageKey } from "../i18n/i18n";
import { BooksIcon, ChartBarIcon, TranslateIcon, type Icon } from "@phosphor-icons/react";

export interface NavigationItem {
  label: MessageKey;
  path: string;
  icon: Icon;
}

/** The dock's destinations, in its order; Settings sits beside the search in the top bar. */
export const navigationItems: NavigationItem[] = [
  { label: "shell.dictionary", path: "/dictionary", icon: TranslateIcon },
  { label: "shell.library", path: "/library", icon: BooksIcon },
  { label: "shell.statistics", path: "/statistics", icon: ChartBarIcon },
];
