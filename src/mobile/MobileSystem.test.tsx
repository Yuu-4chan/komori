import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushPendingWrites } from "../app/windowLifecycle";
import { MobileSystem } from "./MobileShell";
import { autoSync } from "./pcLinkApi";

vi.mock("../app/windowLifecycle", () => ({ flushPendingWrites: vi.fn(async () => true) }));
vi.mock("./pcLinkApi", () => ({ autoSync: vi.fn(async () => null) }));
vi.mock("./system", () => ({
  systemBarIcons: vi.fn(),
  useBackButton: vi.fn(),
  watchKeyboard: vi.fn(() => () => {}),
  watchSafeArea: vi.fn(() => () => {}),
}));

let state: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
async function show(next: DocumentVisibilityState) {
  state = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

afterEach(() => {
  state = "visible";
  vi.clearAllMocks();
});

describe("MobileSystem", () => {
  it("syncs with the PC on starting, after saving on going to the background, and on coming back", async () => {
    render(<MobileSystem />);
    expect(autoSync).toHaveBeenCalledTimes(1);

    await show("hidden");
    expect(flushPendingWrites).toHaveBeenCalledTimes(1);
    expect(autoSync).toHaveBeenCalledTimes(2);
    // The place read last is saved before the sync sends it.
    expect(vi.mocked(flushPendingWrites).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(autoSync).mock.invocationCallOrder[1]!,
    );

    await show("visible");
    expect(flushPendingWrites).toHaveBeenCalledTimes(1);
    expect(autoSync).toHaveBeenCalledTimes(3);
  });
});
