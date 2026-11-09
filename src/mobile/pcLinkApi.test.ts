import { beforeEach, describe, expect, it, vi } from "vitest";

import { pcSession } from "./pcLibrarySession";
import type { PcSync } from "./pcLinkApi";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

const { syncPc } = await import("./pcLinkApi");

const quiet: PcSync = {
  address: "192.168.0.10",
  port: 39_217,
  paired: true,
  pcName: "KOMORI-PC",
  syncOn: true,
  lastSynced: null,
  changed: false,
  sent: false,
  moved: [],
};

beforeEach(() => pcSession.reset());

describe("a sync with the PC", () => {
  it("leaves the PC's listing current unless it sent, took or moved something", async () => {
    const cases: [PcSync, boolean][] = [
      [quiet, false],
      [{ ...quiet, sent: true }, true],
      [{ ...quiet, changed: true }, true],
      [{ ...quiet, moved: ["phone-1"] }, true],
    ];
    for (const [result, stale] of cases) {
      pcSession.set({ listedAt: 1_000 });
      invoke.mockResolvedValueOnce(result);
      expect(await syncPc()).toEqual(result);
      expect(invoke).toHaveBeenLastCalledWith("sync_pc");
      expect(pcSession.get().listedAt === 0).toBe(stale);
    }
  });
});
