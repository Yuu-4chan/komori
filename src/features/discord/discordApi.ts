import { invoke, isTauri } from "@tauri-apps/api/core";
import { registerWindowFlush } from "../../app/windowLifecycle";

export interface DiscordPreferences {
  enabled: boolean;
  showBookTitle: boolean;
  showBookProgress: boolean;
  showChapterProgress: boolean;
  showReadingSpeed: boolean;
  showBrowsing: boolean;
}
export const defaultDiscordPreferences: DiscordPreferences = {
  enabled: false,
  showBookTitle: true,
  showBookProgress: true,
  showChapterProgress: true,
  showReadingSpeed: true,
  showBrowsing: true,
};

/**
 * What the Reader shows of the open book, in the interface language. Native code shows each
 * text only while its choice is on, and Idle once `position` has not changed for 5 minutes.
 */
export interface DiscordReading {
  book: string;
  title: string;
  bookProgress: string | null;
  chapterProgress: string | null;
  readingSpeed: string | null;
  position: number;
}

/** A page outside the Reader. */
export type DiscordPage = "library" | "dictionary" | "statistics" | "settings";

/**
 * The page open outside the Reader. Native code shows it while that choice is on, and Idle once
 * `activity`, a count of the reader's actions on it, has not changed for 5 minutes.
 */
export interface DiscordBrowsing {
  page: DiscordPage;
  activity: number;
}

export async function getDiscordPreferences(): Promise<DiscordPreferences> {
  if (!isTauri()) throw Error("The Discord status needs the Komori desktop app.");
  return invoke("get_discord_preferences");
}
export async function saveDiscordPreferences(
  changes: Partial<DiscordPreferences>,
): Promise<DiscordPreferences> {
  if (!isTauri()) throw Error("The Discord status needs the Komori desktop app.");
  const writing = invoke<DiscordPreferences>("save_discord_preferences", { changes });
  const stop = registerWindowFlush(() => writing);
  try {
    return await writing;
  } finally {
    stop();
  }
}
/** Reports the open book, or none; a status that cannot be reported is not retried. */
export function reportDiscordReading(reading: DiscordReading | null): void {
  if (!isTauri()) return;
  void invoke("set_discord_activity", { reading }).catch(() => {});
}
/** Reports the page open outside the Reader, or none; a status that cannot be reported is not retried. */
export function reportDiscordBrowsing(browsing: DiscordBrowsing | null): void {
  if (!isTauri()) return;
  void invoke("set_discord_browsing", { browsing }).catch(() => {});
}
