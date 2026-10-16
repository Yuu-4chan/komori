import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { ReaderShell } from "./ReaderShell";

vi.mock("./useReaderMonitor", () => ({ useReaderMonitor: () => ({ width: 7680, height: 4320 }) }));

describe("Reader page layout", () => {
  it("shows counted contents captions as accessible descriptions and keeps unavailable entries honest", async () => {
    const factory = () => ({
      mount: async (
        _host: HTMLElement,
        _signal: AbortSignal,
        _turns: unknown,
        _document: unknown,
        contents?: (entries: import("./renderer").ReaderContentsEntry[]) => void,
      ) => {
        contents?.([
          {
            id: "first",
            label: "Chapter",
            navigable: true,
            children: [],
            location: { current: 4400, total: 20000, unit: "characters" },
          },
          { id: "second", label: "Missing", navigable: true, children: [], location: null },
        ]);
        return "ready" as const;
      },
      advancePage: async () => {},
      retreatPage: async () => {},
      dispose: vi.fn(),
    });
    render(
      <MemoryRouter>
        <AppearanceProvider store={null}>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    expect(screen.getByRole("button", { name: "Chapter" })).toHaveAccessibleDescription(
      "4,400 / 20,000 Ch.",
    );
    expect(screen.getByRole("button", { name: "Missing" })).toHaveAccessibleDescription(
      "Location unavailable",
    );
  });
  it("migrates retired margins independently and gives explicit width priority", () => {
    expect(normalizeAppearancePreferences({ readerSideMargin: 40, readerMaxHeight: 4320 })).toEqual(
      { readerMaxWidth: 1120, readerMaxHeight: 4320 },
    );
    expect(
      normalizeAppearancePreferences({
        readerSideMargin: 400,
        readerMaxWidth: 7680,
        readerPageLayout: "single",
      }),
    ).toEqual({ readerMaxWidth: 7680, readerPageLayout: "single" });
    expect(
      normalizeAppearancePreferences({
        readerSideMargin: 40,
        readerMaxWidth: "wide",
        readerPageLayout: "auto",
        readerMaxHeight: 4320,
      }),
    ).toEqual({ readerMaxHeight: 4320 });
  });

  it("offers pages only for horizontal text, keeping the saved choice for it", async () => {
    const user = userEvent.setup();
    let saved: Partial<AppearancePreferences> = { readerPageLayout: "single" };
    const store = {
      load: async () => saved,
      save: vi.fn(async (value: AppearancePreferences) => {
        saved = value;
      }),
    };
    const setPresentation = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <AppearanceProvider store={store}>
          <ReaderShell
            rendererFactory={() => ({
              mount: async () => "ready" as const,
              setPresentation,
              advancePage: async () => {},
              retreatPage: async () => {},
              dispose: vi.fn(),
            })}
          />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    expect(screen.getByRole("button", { name: "Single" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Vertical" }));
    expect(screen.queryByRole("button", { name: "Single" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Double" })).toBeNull();
    await waitFor(() => expect(saved).toMatchObject({ readerWritingMode: "vertical" }));
    expect(saved).toMatchObject({ readerPageLayout: "single" });
    await user.click(screen.getByRole("button", { name: "Horizontal" }));
    expect(screen.getByRole("button", { name: "Single" })).toHaveAttribute("aria-pressed", "true");
    expect(setPresentation).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageLayout: "single", writingMode: "horizontal" }),
    );
  });

  it("saves pages and monitor-sized dimensions through real controls, keeps one renderer and restores on reopen", async () => {
    const user = userEvent.setup();
    let saved: Partial<AppearancePreferences> = {};
    const store = {
      load: async () => saved,
      save: vi.fn(async (value: AppearancePreferences) => {
        saved = value;
      }),
    };
    const mount = vi.fn(async () => "ready" as const);
    const setPresentation = vi.fn(async () => undefined);
    const factory = () => ({
      mount,
      setPresentation,
      advancePage: async () => {},
      retreatPage: async () => {},
      dispose: vi.fn(),
    });
    const open = () =>
      render(
        <MemoryRouter>
          <AppearanceProvider store={store}>
            <ReaderShell rendererFactory={factory} />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const first = open();
    await screen.findByText("Reader ready");
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    await user.click(screen.getByRole("button", { name: "Single" }));
    for (const [label, value] of [
      ["Maximum text width", "7680"],
      ["Reader max height", "4320"],
    ]) {
      const input = screen.getByRole("textbox", { name: label });
      await user.click(input);
      await user.keyboard(value + "{Enter}");
      expect(screen.getByRole("button", { name: `Increase ${label}` })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    await waitFor(() =>
      expect(saved).toMatchObject({
        readerPageLayout: "single",
        readerMaxWidth: 7680,
        readerMaxHeight: 4320,
      }),
    );
    expect(saved).not.toHaveProperty("readerSideMargin");
    expect(setPresentation).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageLayout: "single", maxWidth: 7680, maxHeight: 4320 }),
    );
    expect(mount).toHaveBeenCalledOnce();
    first.unmount();
    open();
    await screen.findByText("Reader ready");
    expect((mount.mock.lastCall as unknown[] | undefined)?.[7]).toMatchObject({
      pageLayout: "single",
      maxWidth: 7680,
      maxHeight: 4320,
    });
  });
});
