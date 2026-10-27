import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { ReaderShell } from "./ReaderShell";
import type { ReaderRendererFactory } from "./renderer";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onResized: async () => () => {},
    isMinimized: async () => false,
    isFocused: async () => true,
    onFocusChanged: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./useReaderMonitor", () => ({ useReaderMonitor: () => null }));
vi.mock("../../components/layout/WindowControls", () => ({ WindowControls: () => null }));
const api = vi.hoisted(() => ({ get: vi.fn(), choose: vi.fn(), remove: vi.fn() }));
vi.mock("./backgroundResource", async (original) => {
  const actual = await original<typeof import("./backgroundResource")>();
  const store = new actual.ReaderBackgroundStore(api);
  return {
    ...actual,
    readerBackgroundStore: store,
    useReaderBackground: () => useSyncExternalStore(store.subscribe, store.snapshot),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn(async () => []) }));
import { readerBackgroundStore } from "./backgroundResource";
const image = {
  revision: "11111111-1111-4111-8111-111111111111",
  url: "http://komori-background.localhost/11111111-1111-4111-8111-111111111111",
};

describe("Reader background appearance", () => {
  it("defaults blur off, validates stored booleans and ignores an invalid setter", async () => {
    expect(defaultAppearance.readerBackgroundBlur).toBe(false);
    expect(defaultAppearance.readerBackgroundBlurLevel).toBe(16);
    for (const invalid of [null, "16", -1, 41, 0.5, NaN, Infinity])
      expect(
        normalizeAppearancePreferences({
          readerBackgroundBlurLevel: invalid,
          readerBackgroundBlur: true,
        }),
      ).toEqual({ readerBackgroundBlur: true });
    for (const readerBackgroundBlurLevel of [0, 1, 16, 40])
      expect(normalizeAppearancePreferences({ readerBackgroundBlurLevel })).toEqual({
        readerBackgroundBlurLevel,
      });
    for (const invalid of [null, "true", 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({ readerBackgroundBlur: invalid, readerBlurImage: true }),
      ).toEqual({ readerBlurImage: true });
    }
    for (const readerBackgroundBlur of [true, false])
      expect(normalizeAppearancePreferences({ readerBackgroundBlur })).toEqual({
        readerBackgroundBlur,
      });
    const save = vi.fn(async (_preferences: AppearancePreferences) => {});
    function Probe() {
      const prefs = useAppearance();
      return (
        <button
          onClick={() => {
            prefs.setReaderBackgroundBlur(1 as never);
            prefs.setReaderBackgroundBlurLevel(41);
            prefs.setReaderBackgroundBlurLevel(0.5);
          }}
        >
          Invalid
        </button>
      );
    }
    render(
      <AppearanceProvider store={{ load: async () => ({}), save }}>
        <Probe />
      </AppearanceProvider>,
    );
    await userEvent.click(await screen.findByText("Invalid"));
    expect(save).not.toHaveBeenCalled();
  });
  it("chooses, retries display failure, toggles saved blur, changes every view/mode without remounting, and removes", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue(image);
    api.choose.mockResolvedValue(image);
    api.remove.mockResolvedValue(undefined);
    const mount = vi.fn(async () => "ready" as const);
    const updatePresentation = vi.fn(async () => {});
    const factory: ReaderRendererFactory = () => ({
      mount,
      updatePresentation,
      advancePage: async () => {},
      retreatPage: async () => {},
      dispose: vi.fn(),
    });
    const save = vi.fn(async (_preferences: AppearancePreferences) => {});
    const { container, unmount } = render(
      <MemoryRouter>
        <AppearanceProvider store={{ load: async () => ({}), save }}>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    // With no image there is nothing to blur.
    expect(screen.queryByRole("button", { name: "Blur background" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose background image" }));
    expect(api.choose).toHaveBeenCalledOnce();
    let img = container.querySelector<HTMLImageElement>(".reader-background img")!;
    expect(img.src).toBe(image.url);
    fireEvent.load(img);
    expect(img.parentElement).toHaveAttribute("data-ready", "true");
    expect(
      screen.queryByRole("textbox", { name: "Background blur level" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Blur background" }));
    await waitFor(() =>
      expect(save.mock.lastCall?.[0]).toMatchObject({ readerBackgroundBlur: true }),
    );
    expect(container.querySelector(".reader-background--blur")).not.toBeNull();
    const level = screen.getByRole("textbox", { name: "Background blur level" });
    for (const radius of [0, 7, 40]) {
      await user.clear(level);
      await user.type(level, `${radius}{Enter}`);
      await waitFor(() =>
        expect(save.mock.lastCall?.[0]).toMatchObject({ readerBackgroundBlurLevel: radius }),
      );
      expect(
        container
          .querySelector<HTMLElement>(".reader-background")!
          .style.getPropertyValue("--reader-background-blur"),
      ).toBe(`${radius}px`);
    }
    expect(mount).toHaveBeenCalledOnce();
    expect(updatePresentation).not.toHaveBeenCalled();
    fireEvent.error(img);
    expect(container.querySelector(".reader-background")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not display");
    await user.click(screen.getByRole("button", { name: "Retry background" }));
    img = container.querySelector<HTMLImageElement>(".reader-background img")!;
    fireEvent.load(img);
    expect(screen.queryByText("Could not display the background. Retry or replace it.")).toBeNull();
    for (const mode of ["Continuous", "Semi-continuous", "Paginated"]) {
      await user.click(screen.getByRole("button", { name: mode }));
      for (const writing of ["Vertical", "Horizontal"]) {
        await user.click(screen.getByRole("button", { name: writing }));
        expect(container.querySelector(".reader-background img")).toHaveAttribute("src", image.url);
      }
    }
    expect(mount).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Remove background image" }));
    expect(api.remove).toHaveBeenCalledOnce();
    expect(container.querySelector(".reader-background")).toBeNull();
    // Removed, the row offers Choose again and Remove has nothing left to remove.
    expect(screen.getByRole("button", { name: "Choose background image" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove background image" })).toBeDisabled();
    // A Reader remount reloads saved blur and the resource independently.
    await act(async () => readerBackgroundStore.load());
    unmount();
    const reopened = render(
      <MemoryRouter>
        <AppearanceProvider
          store={{
            load: async () => ({ readerBackgroundBlur: true, readerBackgroundBlurLevel: 7 }),
            save,
          }}
        >
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    const restored = reopened.container.querySelector<HTMLElement>(".reader-background--blur")!;
    expect(restored.style.getPropertyValue("--reader-background-blur")).toBe("7px");
    expect(mount).toHaveBeenCalledTimes(2);
  });
});
