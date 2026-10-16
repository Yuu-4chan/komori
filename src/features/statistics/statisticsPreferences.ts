import type { MessageKey } from "../../i18n/i18n";

/** When a Reader session starts counting: as the book opens, at the first forward move, or by `P`. */
export type SessionStartMode = "auto" | "first-read" | "manual";

/** How Komori records reading statistics; saved with the appearance record. */
export interface StatisticsPreferences {
  /** Off records no sessions at all. */
  statisticsEnabled: boolean;
  statisticsSessionStart: SessionStartMode;
  /**
   * A move further than this, in the book's unit (characters or words), forward or back, stops
   * an automatic session and pauses a manual one; 0 never stops one.
   */
  statisticsJumpLimit: number;
  /**
   * Minutes without reading forward after which a session stops counting and drops that
   * stretch, until the next forward move; 0 never stops one.
   */
  statisticsIdleMinutes: number;
}

export const sessionStartModes: readonly { value: SessionStartMode; label: MessageKey }[] = [
  { value: "auto", label: "statisticsSettings.startAuto" },
  { value: "first-read", label: "statisticsSettings.startFirstRead" },
  { value: "manual", label: "statisticsSettings.startManual" },
];

export const statisticsJumpLimit = { min: 0, max: 100_000, step: 100, default: 5000 } as const;
export const statisticsIdleMinutes = { min: 0, max: 120, step: 1, default: 5 } as const;

export const defaultStatistics: StatisticsPreferences = {
  statisticsEnabled: true,
  statisticsSessionStart: "auto",
  statisticsJumpLimit: statisticsJumpLimit.default,
  statisticsIdleMinutes: statisticsIdleMinutes.default,
};

const validJumpLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= statisticsJumpLimit.min &&
  value <= statisticsJumpLimit.max;

const validIdleMinutes = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= statisticsIdleMinutes.min &&
  value <= statisticsIdleMinutes.max;

/** The valid fields of `value`, each on its own. */
export function normalizeStatistics(value: unknown): Partial<StatisticsPreferences> {
  if (!value || typeof value !== "object") return {};
  const { statisticsEnabled, statisticsSessionStart, statisticsJumpLimit, statisticsIdleMinutes } =
    value as Record<string, unknown>;
  return {
    ...(typeof statisticsEnabled === "boolean" && { statisticsEnabled }),
    ...(sessionStartModes.some(({ value }) => value === statisticsSessionStart) && {
      statisticsSessionStart: statisticsSessionStart as SessionStartMode,
    }),
    ...(validJumpLimit(statisticsJumpLimit) && { statisticsJumpLimit }),
    ...(validIdleMinutes(statisticsIdleMinutes) && { statisticsIdleMinutes }),
  };
}
