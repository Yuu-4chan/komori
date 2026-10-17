import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderHook, waitFor } from "@testing-library/react";
import { useAsianFontFallback } from "./readerFonts";
import { defaultAsianFont, googleFontUrl } from "./fontChoices";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

it("downloads Noto Serif JP once and reads with it when the default Yu Mincho is missing", async () => {
  const noto = {
    id: "noto-serif-jp",
    family: "Noto Serif JP",
    source: "google",
    available: true,
    url: googleFontUrl("noto-serif-jp"),
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_system_font") return { family: "Yu Mincho", available: false };
    if (command === "list_reader_fonts") return [];
    if (command === "download_reader_font") return [noto];
    throw Error(`Unexpected ${command}`);
  });
  const chosen = { source: "google", id: "klee-one-600" } as const;
  const other = renderHook(() => useAsianFontFallback(chosen));
  const first = renderHook(() => useAsianFontFallback(defaultAsianFont));
  const second = renderHook(() => useAsianFontFallback(defaultAsianFont));
  await waitFor(() =>
    expect(first.result.current).toEqual({ source: "google", id: "noto-serif-jp" }),
  );
  expect(second.result.current).toEqual({ source: "google", id: "noto-serif-jp" });
  expect(other.result.current).toBe(chosen);
  const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
  expect(calls.filter((command) => command === "check_system_font")).toHaveLength(1);
  expect(calls.filter((command) => command === "download_reader_font")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("check_system_font", { family: "Yu Mincho" });
});
