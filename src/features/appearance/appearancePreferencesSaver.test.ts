import { describe, expect, it, vi } from "vitest";

import {
  AppearancePreferencesSaver,
  defaultAppearance,
  type AppearancePreferences,
} from "./appearancePreferences";

const choice = (readerFontSize: number): AppearancePreferences => ({
  ...defaultAppearance,
  readerFontSize,
});

describe("appearance preferences saver", () => {
  it("keeps a failed choice pending, retries it on flush and reports the outcome", async () => {
    const save = vi
      .fn<(preferences: AppearancePreferences) => Promise<void>>()
      .mockRejectedValueOnce(Error("busy"))
      .mockResolvedValue(undefined);
    const saver = new AppearancePreferencesSaver({ load: async () => ({}), save });
    saver.save(choice(20));
    await expect(saver.flush()).resolves.toBe(false);
    await expect(saver.flush()).resolves.toBe(true);
    expect(save.mock.calls.map(([preferences]) => preferences.readerFontSize)).toEqual([20, 20]);
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("writes the newest choice after a failure without a retry loop", async () => {
    const save = vi
      .fn<(preferences: AppearancePreferences) => Promise<void>>()
      .mockRejectedValueOnce(Error("busy"))
      .mockResolvedValue(undefined);
    const saver = new AppearancePreferencesSaver({ load: async () => ({}), save });
    saver.save(choice(20));
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    saver.save(choice(22));
    await expect(saver.flush()).resolves.toBe(true);
    expect(save.mock.calls.map(([preferences]) => preferences.readerFontSize)).toEqual([20, 22]);
  });
});
