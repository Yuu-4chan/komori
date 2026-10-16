/** Chrome-only visibility choices; none change the book's presentation. */
export interface ReaderFooterPreferences {
  readerShowReadingPosition: boolean;
  readerShowPercentage: boolean;
  readerShowChapterPosition: boolean;
  readerShowChapterPercentage: boolean;
  readerShowClock: boolean;
  readerShowReadingTime: boolean;
  readerShowReadingSpeed: boolean;
}

export const defaultReaderFooter: ReaderFooterPreferences = {
  readerShowReadingPosition: true,
  readerShowPercentage: true,
  readerShowChapterPosition: false,
  readerShowChapterPercentage: false,
  readerShowClock: true,
  readerShowReadingTime: false,
  readerShowReadingSpeed: false,
};

export const readerFooterChoices = [
  { key: "readerShowReadingPosition", label: "footerChoice.readingPosition" },
  { key: "readerShowPercentage", label: "footerChoice.percentage" },
  { key: "readerShowReadingTime", label: "footerChoice.readingTime" },
  { key: "readerShowReadingSpeed", label: "footerChoice.readingSpeed" },
  { key: "readerShowClock", label: "footerChoice.clock" },
  { key: "readerShowChapterPosition", label: "footerChoice.chapterPosition" },
  { key: "readerShowChapterPercentage", label: "footerChoice.chapterPercentage" },
] as const;

export function normalizeReaderFooter(value: unknown): Partial<ReaderFooterPreferences> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    readerFooterChoices
      .filter(({ key }) => typeof record[key] === "boolean")
      .map(({ key }) => [key, record[key]]),
  );
}
