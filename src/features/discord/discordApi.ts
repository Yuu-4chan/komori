import { invoke, isTauri } from "@tauri-apps/api/core";
import { registerWindowFlush } from "../../app/windowLifecycle";

export interface DiscordPreferences {
  enabled: boolean;
  showBookTitle: boolean;
  showBookProgress: boolean;
  showChapterProgress: boolean;
  showReadingSpeed: boolean;
}
export const defaultDiscordPreferences: DiscordPreferences = {
  enabled: false,
  showBookTitle: true,
  showBookProgress: true,
  showChapterProgress: true,
  showReadingSpeed: true,
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
