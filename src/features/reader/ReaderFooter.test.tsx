import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { defaultReaderFooter, readerFooterChoices } from "./footerPreferences";
import { en } from "../../i18n/messages/en";
import { ReaderReadingStatus } from "./ReaderReadingStatus";
import { ReaderShell } from "./ReaderShell";
import type { ReaderBookProgress, ReaderRendererFactory } from "./renderer";

afterEach(() => vi.useRealTimers());

describe("Reader footer", () => {
  it("keeps independent legacy defaults and rejects each malformed loaded choice", () => {
    expect(normalizeAppearancePreferences({})).toEqual({});
    expect(defaultAppearance).toMatchObject(defaultReaderFooter);
    for (const { key } of readerFooterChoices) {
      for (const enabled of [false, true]) {
        expect(normalizeAppearancePreferences({ [key]: enabled })).toEqual({ [key]: enabled });
      }
      for (const invalid of [undefined, null, "false", 0, [], {}]) {
        expect(
          normalizeAppearancePreferences({
            ...defaultReaderFooter,
            [key]: invalid,
            readerFontSize: 20,
          }),
        ).toEqual({
          ...Object.fromEntries(
            Object.entries(defaultReaderFooter).filter(([name]) => name !== key),
          ),
          readerFontSize: 20,
        });
      }
    }
  });

  it("ignores invalid setter fields while saving valid fields independently", async () => {
    const save = vi.fn(async () => {});
    function Probe() {
      const appearance = useAppearance();
      return (
        <button
          onClick={() =>
            appearance.setReaderFooter({
              readerShowClock: "true" as never,
              readerShowPercentage: false,
            })
          }
        >
          Change
        </button>
      );
    }
    render(
      <AppearanceProvider store={{ load: async () => ({}), save }}>
        <Probe />
      </AppearanceProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Change" }));
    expect(save).toHaveBeenLastCalledWith({ ...defaultAppearance, readerShowPercentage: false });
  });

  it.each(
    (["paginated", "continuous", "semi-continuous"] as const).flatMap((viewMode) =>
      (["horizontal", "vertical"] as const).map((writingMode) => ({ viewMode, writingMode })),
    ),
  )(
    "saves keyboard/pointer choices without reflow in $viewMode / $writingMode",
    async ({ viewMode, writingMode }) => {
      const mount = vi.fn(
        async (...args: Parameters<ReturnType<ReaderRendererFactory>["mount"]>) => {
          args[6]?.({
            unit: "characters",
            current: 25,
            total: 100,
            chapter: { current: 10, total: 20 },
          });
          return "ready" as const;
        },
      );
      const setPresentation = vi.fn(async () => {});
      const factory: ReaderRendererFactory = () => ({
        mount,
        setPresentation,
        advancePage: vi.fn(async () => {}),
        retreatPage: vi.fn(async () => {}),
        dispose: vi.fn(),
      });
      let saved: Partial<AppearancePreferences> = {
        readerViewMode: viewMode,
        readerWritingMode: writingMode,
      };
      const save = vi.fn(async (value: AppearancePreferences) => {
        saved = value;
      });
      const tree = () => (
        <MemoryRouter>
          <AppearanceProvider store={{ load: async () => saved, save }}>
            <ReaderShell rendererFactory={factory} />
          </AppearanceProvider>
        </MemoryRouter>
      );
      const result = render(tree());
      const user = userEvent.setup();
      await screen.findByText("Reader ready");
      expect(screen.getByRole("group", { name: "Reading status" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      for (const { key, label } of readerFooterChoices) {
        const toggle = screen.getByRole("button", { name: en[label] });
        expect(toggle).toHaveAttribute("aria-pressed", String(defaultReaderFooter[key]));
        toggle.focus();
        await user.keyboard(" ");
        await waitFor(() => expect(saved[key]).toBe(!defaultReaderFooter[key]));
        await user.click(toggle);
        await waitFor(() => expect(saved[key]).toBe(defaultReaderFooter[key]));
      }
      // The empty pill disappears, rather than leaving separators or a blank group.
      for (const { label, key } of readerFooterChoices.filter(
        ({ key }) => defaultReaderFooter[key],
      )) {
        await user.click(screen.getByRole("button", { name: en[label] }));
        expect(saved[key]).toBe(false);
      }
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
      expect(mount).toHaveBeenCalledOnce();
      expect(setPresentation).not.toHaveBeenCalled();
      result.unmount();
      const reopened = render(tree());
      await screen.findByText("Reader ready");
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      for (const { label } of readerFooterChoices)
        expect(screen.getByRole("button", { name: en[label] })).toHaveAttribute(
          "aria-pressed",
          "false",
        );
      reopened.unmount();
    },
  );

  it("handles all progress combinations, missing chapters and later counts without changing calculations", async () => {
    let publish!: (progress: ReaderBookProgress) => void;
    const factory: ReaderRendererFactory = () => ({
      mount: async (...args) => {
        publish = args[6]!;
        return "ready";
      },
      advancePage: vi.fn(async () => {}),
      retreatPage: vi.fn(async () => {}),
      dispose: vi.fn(),
    });
    render(
      <MemoryRouter>
        <AppearanceProvider store={null}>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await screen.findByText("Reader ready");
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    const keys = ["Reading position", "Percentage", "Chapter position", "Chapter percentage"];
    const toggles = keys.map((label) => screen.getByRole("button", { name: label }));
    const area = within(document.querySelector(".reader-reading-area") as HTMLElement);
    for (const unit of ["characters", "words"] as const) {
      act(() => publish({ unit, current: 19, total: 100, chapter: { current: 3, total: 20 } }));
      for (let mask = 0; mask < 16; mask++) {
        for (const [index, toggle] of toggles.entries()) {
          if (toggle.getAttribute("aria-pressed") !== String(!!(mask & (1 << index))))
            fireEvent.click(toggle);
        }
        expect(!!area.queryByRole("contentinfo")).toBe(mask !== 0);
        const footer = area.queryByRole("contentinfo");
        if (footer) {
          expect(within(footer).queryAllByLabelText(/^(Reading|Chapter) position:/)).toHaveLength(
            Number(!!(mask & 1)) + Number(!!(mask & 4)),
          );
          expect(within(footer).queryAllByLabelText(/^(Book|Chapter) percentage:/)).toHaveLength(
            Number(!!(mask & 2)) + Number(!!(mask & 8)),
          );
          if (mask & 2)
            expect(within(footer).getByLabelText("Book percentage: 19%")).toHaveTextContent("19%");
          if (mask & 8)
            expect(within(footer).getByLabelText("Chapter percentage: 15%")).toHaveTextContent(
              "Chapter 15%",
            );
        }
      }
    }
    act(() =>
      publish({ unit: "words", current: 100, total: 100, chapter: { current: 0, total: 0 } }),
    );
    expect(screen.queryByRole("group", { name: "Chapter progress" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Book percentage: 100%")).toHaveTextContent("100%");
    act(() => publish({ unit: "words", current: 0, total: 0, chapter: { current: 0, total: 0 } }));
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });
});

describe("Reader upper status", () => {
  it("refreshes local time, suspends hidden clocks, catches up and removes timers/listeners", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 12, 59, 58));
    let elapsed = 0;
    const readingMs = () => elapsed;
    const view = render(
      <ReaderReadingStatus clock={false} readingTime={true} readingMs={readingMs} />,
    );
    expect(screen.getByLabelText("Reading time this session: 0m 00s")).toHaveTextContent("0m 00s");
    // The session's time refreshes each second while shown.
    elapsed = 65 * 60 * 1000;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText("Reading time this session: 1h 05m 00s")).toBeInTheDocument();
    view.rerender(<ReaderReadingStatus clock readingTime readingMs={readingMs} />);
    expect(screen.getByLabelText("Local time: 12:59")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByLabelText("Local time: 13:00")).toBeInTheDocument();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date(2026, 9, 1, 14, 5));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByLabelText("Local time: 14:05")).toBeInTheDocument();
    view.rerender(<ReaderReadingStatus clock={false} readingTime={false} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<ReaderReadingStatus clock readingTime={false} readingMs={readingMs} />);
    const remove = vi.spyOn(document, "removeEventListener");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    visibility.mockRestore();
    remove.mockRestore();
  });
});
