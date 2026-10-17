import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderHook, waitFor } from "@testing-library/react";
import { useAsianFontFallback } from "./readerFonts";
import { defaultAsianFont, googleFontUrl } from "./fontChoices";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

it("reads a saved Yu Mincho in the included Zen Old Mincho on a computer without it", async () => {
  const zen = {
    id: "zen-old-mincho",
    family: "Zen Old Mincho",
    source: "google",
    available: true,
    bundled: true,
    url: googleFontUrl("zen-old-mincho"),
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_system_font") return { family: "Yu Mincho", available: false };
    if (command === "list_reader_fonts") return [zen];
    throw Error(`Unexpected ${command}`);
  });
  const mincho = { source: "preset", id: "yu-mincho" } as const;
  const chosen = { source: "google", id: "klee-one-600" } as const;
  const other = renderHook(() => useAsianFontFallback(chosen));
  const standard = renderHook(() => useAsianFontFallback(defaultAsianFont));
  const first = renderHook(() => useAsianFontFallback(mincho));
  const second = renderHook(() => useAsianFontFallback(mincho));
  await waitFor(() =>
    expect(first.result.current).toEqual({ source: "google", id: "zen-old-mincho" }),
  );
  expect(second.result.current).toEqual({ source: "google", id: "zen-old-mincho" });
  expect(other.result.current).toBe(chosen);
  // The default, the included Noto Sans JP, needs no stand-in.
  expect(standard.result.current).toBe(defaultAsianFont);
  const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
  expect(calls.filter((command) => command === "check_system_font")).toHaveLength(1);
  expect(calls).not.toContain("download_reader_font");
  expect(invoke).toHaveBeenCalledWith("check_system_font", { family: "Yu Mincho" });
});
