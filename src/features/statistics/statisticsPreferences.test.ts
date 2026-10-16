import { describe, expect, it } from "vitest";

import {
  defaultAppearance,
  normalizeAppearancePreferences,
} from "../appearance/appearancePreferences";
import { normalizeStatistics } from "./statisticsPreferences";

describe("statistics preferences", () => {
  it("default to recording automatic sessions with a 5,000 unit jump limit", () => {
    expect(defaultAppearance).toMatchObject({
      statisticsEnabled: true,
      statisticsSessionStart: "auto",
      statisticsJumpLimit: 5_000,
    });
  });

  it("keep each valid field on its own and drop invalid ones", () => {
    expect(
      normalizeStatistics({
        statisticsEnabled: false,
        statisticsSessionStart: "first-read",
        statisticsJumpLimit: 0,
      }),
    ).toEqual({
      statisticsEnabled: false,
      statisticsSessionStart: "first-read",
      statisticsJumpLimit: 0,
    });
    expect(
      normalizeStatistics({
        statisticsEnabled: "no",
        statisticsSessionStart: "sometimes",
        statisticsJumpLimit: 100_001,
      }),
    ).toEqual({});
    expect(
      normalizeStatistics({ statisticsJumpLimit: 2.5, statisticsSessionStart: "manual" }),
    ).toEqual({ statisticsSessionStart: "manual" });
    expect(normalizeAppearancePreferences({ statisticsSessionStart: "manual" })).toMatchObject({
      statisticsSessionStart: "manual",
    });
  });
});
