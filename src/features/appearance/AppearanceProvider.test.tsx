import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import { defaultAppCustomTheme } from "./appThemes";
import { defaultPopupPalette } from "../reader/popupThemes";
import {
  normalizeAppearancePreferences,
  defaultAppearance,
  type AppearancePreferences,
  type AppearancePreferencesStore,
} from "./appearancePreferences";

function Probe() {
  const appearance = useAppearance();
  return (
    <div>
      <p>
        {appearance.theme} {appearance.accentColor} wheel {appearance.readerWheelStep} font{" "}
        {appearance.readerFontSize}
      </p>
      <p>line {appearance.readerLineHeight}</p>
      <p>
        reader size {appearance.readerMaxWidth} x {appearance.readerMaxHeight}
      </p>
      <p>weight {appearance.readerFontWeight}</p>
      <p>popup {appearance.readerPopupTheme}</p>
      <p>popup voice {String(appearance.readerPopupVoiceAction)}</p>
      <p>frequency shown {String(appearance.readerPopupShowFrequency)}</p>
      <button onClick={() => appearance.setReaderPopupShowFrequency("false" as never)}>
        Bad frequency
      </button>
      <p>pitch shown {String(appearance.readerPopupShowPitch)}</p>
      <button onClick={() => appearance.setReaderPopupShowPitch("false" as never)}>
        Bad pitch
      </button>
      <p>popup names {String(appearance.readerPopupShowDictionaryNames)}</p>
      <button onClick={() => appearance.setReaderPopupShowDictionaryNames("false" as never)}>
        Bad names
      </button>
      <button onClick={() => appearance.setReaderPopupVoiceAction("false" as never)}>
        Bad voice
      </button>
      <p>popup enabled {String(appearance.readerPopupEnabled)}</p>
      <button onClick={() => appearance.setReaderPopupEnabled("false" as never)}>
        Bad enabled
      </button>
      <p>mouse selection {String(appearance.readerPopupMouseSelection)}</p>
      <button onClick={() => appearance.setReaderPopupMouseSelection("false" as never)}>
        Bad mouse
      </button>
      <p>radius {appearance.readerPopupRadius}</p>
      <button onClick={() => appearance.setReaderPopupRadius(28)}>Roundest popup</button>
      <button onClick={() => appearance.setReaderPopupRadius(18.5)}>Bad radius</button>
      <button onClick={() => appearance.setReaderPopupTheme("night")}>Night popup</button>
      <button onClick={() => appearance.setReaderPopupTheme("application")}>
        Application popup
      </button>
      <button onClick={() => appearance.setReaderPopupTheme("unknown" as never)}>Bad popup</button>
      <button onClick={() => appearance.setTheme("dark")}>Dark</button>
      <button onClick={() => appearance.setReaderWheelStep(333)}>Farther</button>
      <button onClick={() => appearance.setReaderWheelStep(0)}>Nearest</button>
      <button onClick={() => appearance.setReaderFontSize(appearance.readerFontSize + 1)}>
        Larger
      </button>
      <button onClick={() => appearance.setReaderFontSize(500)}>Huge</button>
      <button onClick={() => appearance.setAccentColor("not a color")}>Bad accent</button>
      <button onClick={() => appearance.setReaderLineHeight(1.8 + 0.05)}>Looser</button>
      <button onClick={() => appearance.setReaderLineHeight(9)}>Loosest</button>
      <button onClick={() => appearance.setReaderFontWeight(649)}>Heavier</button>
      <button onClick={() => appearance.setReaderFontWeight(2000)}>Heaviest</button>
      <p>indent {appearance.readerParagraphIndent}</p>
      <button onClick={() => appearance.setReaderParagraphIndent(1.2 + 0.1 + 0.1)}>Deeper</button>
      <button onClick={() => appearance.setReaderParagraphIndent(-3)}>Flush</button>
      <button onClick={() => appearance.setReaderParagraphIndent(99)}>Deepest</button>
      <p>spacing {appearance.readerParagraphMargin}</p>
      <button onClick={() => appearance.setReaderParagraphMargin(12.9)}>Spaced</button>
      <button onClick={() => appearance.setReaderParagraphMargin(-6)}>Unspaced</button>
      <button onClick={() => appearance.setReaderParagraphMargin(900)}>Most spaced</button>
      <p>margin {appearance.readerMaxWidth}</p>
      <button onClick={() => appearance.setReaderMaxWidth(611)}>Wider</button>
      <button onClick={() => appearance.setReaderMaxWidth(-8)}>No margin</button>
      <button onClick={() => appearance.setReaderMaxWidth(2_000_000)}>Widest</button>
      <p>height {appearance.readerMaxHeight}</p>
      <button onClick={() => appearance.setReaderMaxHeight(724)}>Shorter</button>
      <button onClick={() => appearance.setReaderMaxHeight(20)}>Shortest</button>
      <button onClick={() => appearance.setReaderMaxHeight(9000)}>Tallest</button>
      <p>mode {appearance.readerWritingMode}</p>
      <button onClick={() => appearance.setReaderWritingMode("vertical")}>Tate</button>
      <button onClick={() => appearance.setReaderWritingMode("horizontal")}>Yoko</button>
      <button onClick={() => appearance.setReaderWritingMode("sideways" as never)}>Sideways</button>
      <p>orientation {appearance.readerTextOrientation}</p>
      <button onClick={() => appearance.setReaderTextOrientation("upright")}>Upright</button>
      <button onClick={() => appearance.setReaderTextOrientation("mixed")}>Mixed</button>
      <button onClick={() => appearance.setReaderTextOrientation("sideways" as never)}>
        Sideways text
      </button>
      <p>furigana {appearance.readerHideFurigana ? "hidden" : "shown"}</p>
      <p>furigana style {appearance.readerFuriganaStyle}</p>
      {(["hide", "partial", "toggle", "full", "invalid"] as const).map((style) => (
        <button key={style} onClick={() => appearance.setReaderFuriganaStyle(style as never)}>
          Furigana style {style}
        </button>
      ))}
      <button onClick={() => appearance.setReaderHideFurigana(!appearance.readerHideFurigana)}>
        Furigana
      </button>
      <p>images {appearance.readerBlurImage ? "blurred" : "clear"}</p>
      <button onClick={() => appearance.setReaderBlurImage(!appearance.readerBlurImage)}>
        Blur
      </button>
      <p>blur mode {appearance.readerBlurMode}</p>
      <button onClick={() => appearance.setReaderBlurMode("after-toc")}>After ToC</button>
      <button onClick={() => appearance.setReaderBlurMode("all")}>All images</button>
      <button onClick={() => appearance.setReaderBlurMode("invalid" as never)}>
        Bad blur mode
      </button>
      <p>view {appearance.readerViewMode}</p>
      <button onClick={() => appearance.setReaderViewMode("continuous")}>Continuous</button>
      <button onClick={() => appearance.setReaderViewMode("semi-continuous")}>
        Semi-continuous
      </button>
      <button onClick={() => appearance.setReaderViewMode("paginated")}>Paginated</button>
      <button onClick={() => appearance.setReaderViewMode("scroll" as never)}>Invalid view</button>
      <p>
        reader theme {appearance.readerTheme}:{" "}
        {appearance.readerCustomThemes
          .map(
            (theme) =>
              `${theme.name} ${theme.background} ${theme.text} ${theme.selection} ${theme.footerText}`,
          )
          .join(", ")}
      </p>
      <button onClick={() => appearance.setReaderTheme("sepia")}>Sepia</button>
      <button onClick={() => appearance.setReaderTheme(customId)}>Unknown theme</button>
      <button onClick={() => appearance.setReaderTheme("custom")}>Invalid theme</button>
      <button onClick={() => appearance.createReaderCustomTheme()}>New theme</button>
      <button
        onClick={() =>
          appearance.updateReaderCustomTheme(appearance.readerTheme, {
            name: "Evening",
            background: "#ABCDEF",
            text: "red",
          })
        }
      >
        Rename
      </button>
      <button
        onClick={() =>
          appearance.updateReaderCustomTheme(appearance.readerTheme, {
            name: " Padded",
            text: "#12345",
          })
        }
      >
        Bad edit
      </button>
      <button
        onClick={() =>
          appearance.readerCustomThemes[0] &&
          appearance.setReaderTheme(appearance.readerCustomThemes[0].id)
        }
      >
        First custom
      </button>
      <button onClick={() => appearance.deleteReaderCustomTheme(appearance.readerTheme)}>
        Delete theme
      </button>
      <p>sidebar {appearance.readerSidebarPinned ? "pinned" : "floating"}</p>
      <button onClick={() => appearance.setReaderSidebarPinned(!appearance.readerSidebarPinned)}>
        Pin
      </button>
    </div>
  );
}

const customId = "0b8a3c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d";
const customTheme = {
  id: customId,
  name: "Dusk",
  background: "#101820",
  text: "#f0e6d2",
  selection: "#445566",
  highlight: "#778899",
  footerText: "#a09880",
};

function fakeStore(load: () => Promise<Partial<AppearancePreferences>>) {
  const saved: AppearancePreferences[] = [];
  let release: (() => void) | undefined;
  const store = {
    load: vi.fn(load),
    save: vi.fn(async (preferences: AppearancePreferences) => {
      saved.push(preferences);
    }),
  } satisfies AppearancePreferencesStore;
  return {
    store,
    saved,
    holdWrites() {
      store.save.mockImplementation(async (preferences) => {
        saved.push(preferences);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
    },
    releaseWrite: () => release?.(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--accent-base");
});

const defaultLibraryDisplay = {
  libraryView: "grid",
  librarySort: "title",
  librarySortReversed: false,
  libraryFilter: "all",
  libraryCardSeries: true,
  libraryCardLanguage: true,
  libraryCardLastRead: true,
};

describe("Appearance preferences", () => {
  it("defaults the Reader size to this computer's monitor where nothing was saved", async () => {
    const fake = fakeStore(async () => ({ readerMaxHeight: 1200 }));
    const store = {
      ...fake.store,
      installDefaults: vi.fn(async () => ({ readerMaxWidth: 2560, readerMaxHeight: 1440 })),
    };
    render(
      <AppearanceProvider store={store}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(await screen.findByText("reader size 2560 x 1200")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("keeps the built-in Reader size when the monitor cannot be read", async () => {
    const fake = fakeStore(async () => ({}));
    const store = {
      ...fake.store,
      installDefaults: vi.fn(async () => Promise.reject(new Error())),
    };
    render(
      <AppearanceProvider store={store}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(
      await screen.findByText(
        `reader size ${defaultAppearance.readerMaxWidth} x ${defaultAppearance.readerMaxHeight}`,
      ),
    ).toBeInTheDocument();
  });
  it("refuses a non-boolean popup enabled change", async () => {
    const fake = fakeStore(async () => ({ readerPopupEnabled: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("popup enabled false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad enabled" }));
    expect(screen.getByText("popup enabled false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("refuses a non-boolean mouse selection change", async () => {
    const fake = fakeStore(async () => ({ readerPopupMouseSelection: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("mouse selection false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad mouse" }));
    expect(screen.getByText("mouse selection false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("refuses a non-boolean popup pitch-visibility change", async () => {
    const fake = fakeStore(async () => ({ readerPopupShowPitch: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("pitch shown false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad pitch" }));
    expect(screen.getByText("pitch shown false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("refuses a non-boolean popup frequency-visibility change", async () => {
    const fake = fakeStore(async () => ({ readerPopupShowFrequency: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("frequency shown false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad frequency" }));
    expect(screen.getByText("frequency shown false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("refuses a non-boolean popup dictionary-name change", async () => {
    const fake = fakeStore(async () => ({ readerPopupShowDictionaryNames: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("popup names false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad names" }));
    expect(screen.getByText("popup names false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("refuses a non-boolean popup voice change", async () => {
    const fake = fakeStore(async () => ({ readerPopupVoiceAction: false }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("popup voice false");
    await userEvent.setup().click(screen.getByRole("button", { name: "Bad voice" }));
    expect(screen.getByText("popup voice false")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
  });
  it("ignores invalid popup radii and saves a valid change independently", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({
      readerPopupRadius: 0,
      readerPopupTheme: "night",
      readerPopupWidth: 800,
      readerPopupHeight: 600,
    }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("radius 0");
    await user.click(screen.getByRole("button", { name: "Bad radius" }));
    expect(screen.getByText("radius 0")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Roundest popup" }));
    await waitFor(() =>
      expect(fake.store.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readerPopupRadius: 28,
          readerPopupTheme: "night",
          readerPopupWidth: 800,
          readerPopupHeight: 600,
        }),
      ),
    );
  });
  it("ignores an invalid popup theme and saves valid changes independently", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({
      readerPopupTheme: "paper",
      theme: "dark",
      readerTheme: "sepia",
    }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("popup paper");
    await user.click(screen.getByRole("button", { name: "Bad popup" }));
    expect(screen.getByText("popup paper")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
    for (const [button, theme] of [
      ["Night popup", "night"],
      ["Application popup", "application"],
    ]) {
      await user.click(screen.getByRole("button", { name: button }));
      await waitFor(() =>
        expect(fake.store.save).toHaveBeenLastCalledWith(
          expect.objectContaining({ readerPopupTheme: theme, theme: "dark", readerTheme: "sepia" }),
        ),
      );
    }
  });

  it("shows nothing until saved preferences apply, then restores them without saving", async () => {
    let finish!: (value: Partial<AppearancePreferences>) => void;
    const { store } = fakeStore(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AppearanceProvider store={store}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(screen.queryByText(/wheel/)).not.toBeInTheDocument();
    await act(async () =>
      finish({
        theme: "dark",
        accentColor: "#2f8f83",
        readerWheelStep: 250,
        readerFontSize: 28,
        readerLineHeight: 1.85,
        readerFontWeight: 300,
        readerParagraphIndent: 2.5,
        readerParagraphMargin: 24,
        readerMaxWidth: 120,
        readerMaxHeight: 900,
        readerWritingMode: "vertical",
        readerTextOrientation: "upright",
        readerHideFurigana: true,
        readerBlurImage: true,
        readerBlurMode: "after-toc",
        readerViewMode: "continuous",
        readerSidebarPinned: true,
        readerTheme: customId,
        readerCustomThemes: [customTheme],
      }),
    );
    expect(
      screen.getByText(`reader theme ${customId}: Dusk #101820 #f0e6d2 #445566 #a09880`),
    ).toBeInTheDocument();
    expect(screen.getByText("dark #2f8f83 wheel 250 font 28")).toBeInTheDocument();
    expect(screen.getByText("line 1.85")).toBeInTheDocument();
    expect(screen.getByText("weight 300")).toBeInTheDocument();
    expect(screen.getByText("indent 2.5")).toBeInTheDocument();
    expect(screen.getByText("spacing 24")).toBeInTheDocument();
    expect(screen.getByText("margin 120")).toBeInTheDocument();
    expect(screen.getByText("height 900")).toBeInTheDocument();
    expect(screen.getByText("mode vertical")).toBeInTheDocument();
    expect(screen.getByText("orientation upright")).toBeInTheDocument();
    expect(screen.getByText("furigana hidden")).toBeInTheDocument();
    expect(screen.getByText("images blurred")).toBeInTheDocument();
    expect(screen.getByText("blur mode after-toc")).toBeInTheDocument();
    expect(screen.getByText("view continuous")).toBeInTheDocument();
    expect(screen.getByText("sidebar pinned")).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    // A preset shows its own accent; the saved one belongs to the custom theme.
    expect(document.documentElement.style.getPropertyValue("--accent-base")).toBe("#7b93f0");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("saves every change, writing only the latest of those made during a write", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({ readerFontSize: 20 }));
    fake.holdWrites();
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("hojicha #b8743c wheel 100 font 20");
    await user.click(screen.getByRole("button", { name: "Larger" }));
    await waitFor(() => expect(fake.saved).toHaveLength(1));
    expect(fake.saved[0]).toEqual({
      ...defaultAppearance,
      readerPopupEnabled: true,
      readerPopupMouseSelection: false,
      readerPopupVoiceAction: true,
      readerPopupShowDictionaryNames: true,
      readerPopupShowPitch: true,
      readerPopupShowFrequency: true,
      readerPopupCustomPalette: defaultPopupPalette,
      readerPopupRadius: 18,
      readerPopupTheme: "application",
      readerPopupWidth: 480,
      readerPopupHeight: 440,
      theme: "hojicha",
      appCustomTheme: defaultAppCustomTheme,
      accentColor: "#b8743c",
      ...defaultLibraryDisplay,
      readerWheelStep: 100,
      readerFontSize: 21,
      readerLineHeight: 1.65,
      readerFontWeight: 400,
      readerParagraphIndent: 1,
      readerParagraphMargin: 0,
      readerMaxWidth: 4000,
      readerMaxHeight: 4000,
      readerWritingMode: "horizontal",
      readerTextOrientation: "mixed",
      readerHideFurigana: false,
      readerBlurImage: false,
      readerViewMode: "paginated",
      readerSidebarPinned: false,
      readerTheme: "hojicha",
      readerCustomThemes: [],
    });
    await user.click(screen.getByRole("button", { name: "Larger" }));
    await user.click(screen.getByRole("button", { name: "Dark" }));
    // Invalid values are refused rather than saved: out-of-range sizes are clamped.
    await user.click(screen.getByRole("button", { name: "Bad accent" }));
    await user.click(screen.getByRole("button", { name: "Huge" }));
    expect(fake.saved).toHaveLength(1);
    await act(async () => fake.releaseWrite());
    await waitFor(() => expect(fake.saved).toHaveLength(2));
    expect(fake.saved[1]).toEqual({
      ...defaultAppearance,
      readerPopupEnabled: true,
      readerPopupMouseSelection: false,
      readerPopupVoiceAction: true,
      readerPopupShowDictionaryNames: true,
      readerPopupShowPitch: true,
      readerPopupShowFrequency: true,
      readerPopupCustomPalette: defaultPopupPalette,
      readerPopupRadius: 18,
      readerPopupTheme: "application",
      readerPopupWidth: 480,
      readerPopupHeight: 440,
      theme: "dark",
      appCustomTheme: defaultAppCustomTheme,
      accentColor: "#b8743c",
      ...defaultLibraryDisplay,
      readerWheelStep: 100,
      readerFontSize: 72,
      readerLineHeight: 1.65,
      readerFontWeight: 400,
      readerParagraphIndent: 1,
      readerParagraphMargin: 0,
      readerMaxWidth: 4000,
      readerMaxHeight: 4000,
      readerWritingMode: "horizontal",
      readerTextOrientation: "mixed",
      readerHideFurigana: false,
      readerBlurImage: false,
      readerViewMode: "paginated",
      readerSidebarPinned: false,
      readerTheme: "hojicha",
      readerCustomThemes: [],
    });
    await act(async () => fake.releaseWrite());
    expect(fake.saved).toHaveLength(2);
  });

  it("saves a chosen wheel step on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("hojicha #b8743c wheel 100 font 16");
    await user.click(screen.getByRole("button", { name: "Farther" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWheelStep).toBe(330));
    await user.click(screen.getByRole("button", { name: "Nearest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWheelStep).toBe(10));
    expect(fake.saved.at(-1)).not.toHaveProperty("readerWheelSpeed");
  });

  it("saves a chosen line height on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("line 1.65");
    await user.click(screen.getByRole("button", { name: "Looser" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerLineHeight).toBe(1.85));
    expect(screen.getByText("line 1.85")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Loosest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerLineHeight).toBe(3));
  });

  it("saves a chosen font weight on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("weight 400");
    await user.click(screen.getByRole("button", { name: "Heavier" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerFontWeight).toBe(600));
    expect(screen.getByText("weight 600")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Heaviest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerFontWeight).toBe(900));
  });

  it("saves a chosen paragraph indentation on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("indent 1");
    await user.click(screen.getByRole("button", { name: "Deeper" }));
    // 1.2 + 0.1 + 0.1 is 1.4000000000000001; the saved value is the nearest step.
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphIndent).toBe(1.5));
    expect(screen.getByText("indent 1.5")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Flush" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphIndent).toBe(0));
    expect(screen.getByText("indent 0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deepest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphIndent).toBe(20));
  });

  it("saves a chosen paragraph margin on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("spacing 0");
    await user.click(screen.getByRole("button", { name: "Spaced" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphMargin).toBe(12));
    expect(screen.getByText("spacing 12")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unspaced" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphMargin).toBe(0));
    expect(screen.getByText("spacing 0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Most spaced" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerParagraphMargin).toBe(200));
  });

  it("saves chosen letter and word spacing in whole pixels and clamps them", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({ readerWordSpacing: 6, readerShowReadingSpeed: true }));
    function Spacing() {
      const appearance = useAppearance();
      return (
        <div>
          <p>
            letters {appearance.readerLetterSpacing} words {appearance.readerWordSpacing} speed{" "}
            {String(appearance.readerShowReadingSpeed)}
          </p>
          <button onClick={() => appearance.setReaderLetterSpacing(2.6)}>Letters</button>
          <button onClick={() => appearance.setReaderLetterSpacing(-80)}>Tightest</button>
          <button onClick={() => appearance.setReaderWordSpacing(500)}>Widest</button>
          <button onClick={() => appearance.setReaderWordSpacing(Number.NaN)}>Bad words</button>
          <button onClick={() => appearance.setReaderFooter({ readerShowReadingSpeed: false })}>
            Hide speed
          </button>
        </div>
      );
    }
    render(
      <AppearanceProvider store={fake.store}>
        <Spacing />
      </AppearanceProvider>,
    );
    await screen.findByText("letters 0 words 6 speed true");
    await user.click(screen.getByRole("button", { name: "Letters" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerLetterSpacing).toBe(3));
    expect(fake.saved.at(-1)?.readerWordSpacing).toBe(6);
    await user.click(screen.getByRole("button", { name: "Tightest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerLetterSpacing).toBe(-10));
    await user.click(screen.getByRole("button", { name: "Widest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWordSpacing).toBe(120));
    await user.click(screen.getByRole("button", { name: "Bad words" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWordSpacing).toBe(0));
    await user.click(screen.getByRole("button", { name: "Hide speed" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerShowReadingSpeed).toBe(false));
    expect(screen.getByText("letters -10 words 0 speed false")).toBeInTheDocument();
  });

  it("saves a chosen text width on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("margin 4000");
    await user.click(screen.getByRole("button", { name: "Wider" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxWidth).toBe(610));
    expect(screen.getByText("margin 610")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No margin" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxWidth).toBe(100));
    expect(screen.getByText("margin 100")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Widest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxWidth).toBe(1_000_000));
  });

  it("saves a chosen max height on its step and clamps it", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("height 4000");
    await user.click(screen.getByRole("button", { name: "Shorter" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxHeight).toBe(720));
    expect(screen.getByText("height 720")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Shortest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxHeight).toBe(100));
    await user.click(screen.getByRole("button", { name: "Tallest" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerMaxHeight).toBe(9000));
  });

  it("saves a chosen writing mode and refuses others", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("mode horizontal");
    await user.click(screen.getByRole("button", { name: "Tate" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWritingMode).toBe("vertical"));
    expect(screen.getByText("mode vertical")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yoko" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWritingMode).toBe("horizontal"));
    // An unknown mode is the default rather than a saved invalid value.
    await user.click(screen.getByRole("button", { name: "Tate" }));
    await user.click(screen.getByRole("button", { name: "Sideways" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerWritingMode).toBe("horizontal"));
  });

  it("saves a chosen text orientation and refuses others", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("orientation mixed");
    await user.click(screen.getByRole("button", { name: "Upright" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTextOrientation).toBe("upright"));
    expect(screen.getByText("orientation upright")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mixed" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTextOrientation).toBe("mixed"));
    // An unknown orientation is the default rather than a saved invalid value.
    await user.click(screen.getByRole("button", { name: "Upright" }));
    await user.click(screen.getByRole("button", { name: "Sideways text" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTextOrientation).toBe("mixed"));
  });

  it("saves hiding and showing furigana", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("furigana shown");
    await user.click(screen.getByRole("button", { name: "Furigana" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerHideFurigana).toBe(true));
    expect(screen.getByText("furigana hidden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Furigana" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerHideFurigana).toBe(false));
  });

  it("saves each furigana style, keeps it while off and rejects invalid choices", async () => {
    const fake = fakeStore(async () => ({ readerHideFurigana: true }));
    const user = userEvent.setup();
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("furigana hidden");
    expect(screen.getByText("furigana style hide")).toBeInTheDocument();
    expect(fake.store.save).not.toHaveBeenCalled();
    for (const style of ["partial", "toggle", "full", "hide"] as const) {
      await user.click(screen.getByRole("button", { name: `Furigana style ${style}` }));
      await waitFor(() => expect(fake.saved.at(-1)?.readerFuriganaStyle).toBe(style));
      expect(fake.saved.at(-1)?.readerHideFurigana).toBe(true);
    }
    await user.click(screen.getByRole("button", { name: "Furigana style toggle" }));
    await user.click(screen.getByRole("button", { name: "Furigana" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerHideFurigana).toBe(false));
    expect(fake.saved.at(-1)?.readerFuriganaStyle).toBe("toggle");
    const writes = fake.saved.length;
    await user.click(screen.getByRole("button", { name: "Furigana style invalid" }));
    expect(fake.saved).toHaveLength(writes);
    expect(screen.getByText("furigana style toggle")).toBeInTheDocument();
  });

  it("normalizes furigana styles independently of the legacy hide switch", () => {
    for (const readerFuriganaStyle of ["hide", "partial", "toggle", "full"])
      expect(
        normalizeAppearancePreferences({ readerFuriganaStyle, readerHideFurigana: true }),
      ).toEqual({ readerFuriganaStyle, readerHideFurigana: true });
    for (const readerFuriganaStyle of [null, false, 1, {}, "Full", "shown", ""])
      expect(
        normalizeAppearancePreferences({ readerFuriganaStyle, readerHideFurigana: true }),
      ).toEqual({ readerHideFurigana: true });
    expect(defaultAppearance.readerFuriganaStyle).toBe("hide");
  });

  it("saves blurring and unblurring images", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("images clear");
    await user.click(screen.getByRole("button", { name: "Blur" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerBlurImage).toBe(true));
    expect(screen.getByText("images blurred")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Blur" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerBlurImage).toBe(false));
  });

  it("defaults to All, saves both blur modes and ignores invalid setters and stored fields independently", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () =>
      normalizeAppearancePreferences({ readerBlurImage: true, readerBlurMode: "invalid" }),
    );
    const view = render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("blur mode all");
    expect(screen.getByText("images blurred")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "After ToC" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerBlurMode).toBe("after-toc"));
    const writes = fake.saved.length;
    await user.click(screen.getByRole("button", { name: "Bad blur mode" }));
    expect(fake.saved).toHaveLength(writes);
    view.unmount();
    render(
      <AppearanceProvider store={fakeStore(async () => fake.saved.at(-1)!).store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("blur mode after-toc");
    await user.click(screen.getByRole("button", { name: "All images" }));
    expect(screen.getByText("blur mode all")).toBeInTheDocument();
    for (const readerBlurMode of [null, true, 1, "ALL", "after", {}, []])
      expect(normalizeAppearancePreferences({ readerBlurMode, readerBlurImage: true })).toEqual({
        readerBlurImage: true,
      });
  });

  it("saves continuous and semi-continuous view, refuses an unknown view, and restores paginated view", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(await screen.findByText("view paginated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuous" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerViewMode).toBe("continuous"));
    await user.click(screen.getByRole("button", { name: "Invalid view" }));
    expect(screen.getByText("view paginated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Semi-continuous" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerViewMode).toBe("semi-continuous"));
    expect(screen.getByText("view semi-continuous")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Paginated" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerViewMode).toBe("paginated"));
  });

  it("saves pinning and unpinning the Reader sidebar", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("sidebar floating");
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerSidebarPinned).toBe(true));
    expect(screen.getByText("sidebar pinned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerSidebarPinned).toBe(false));
  });

  it("saves a chosen theme and creates, edits, renames, and deletes custom themes", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({}));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("reader theme hojicha:");
    await user.click(screen.getByRole("button", { name: "Sepia" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTheme).toBe("sepia"));
    // A theme that is neither a preset nor kept is refused, and a preset is not deleted.
    for (const name of ["Unknown theme", "Invalid theme", "Delete theme"])
      await user.click(screen.getByRole("button", { name }));
    expect(screen.getByText("reader theme sepia:")).toBeInTheDocument();

    // A new theme starts from the shown theme's colors and is chosen.
    await user.click(screen.getByRole("button", { name: "New theme" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerCustomThemes).toHaveLength(1));
    const [created] = fake.saved.at(-1)!.readerCustomThemes;
    expect(created).toEqual({
      id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
      name: "Custom 1",
      background: "#f4ecd8",
      text: "#5b4636",
      selection: "#e2c99a",
      highlight: "#e7d1a8",
      footerText: "#958574",
    });
    expect(fake.saved.at(-1)?.readerTheme).toBe(created.id);

    // Valid fields apply, colors in lowercase; invalid ones are ignored.
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Bad edit" }));
    const renamed = { ...created, name: "Evening", background: "#abcdef" };
    await waitFor(() => expect(fake.saved.at(-1)?.readerCustomThemes).toEqual([renamed]));

    // A second theme starts from the first's colors and takes the first free name.
    await user.click(screen.getByRole("button", { name: "New theme" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerCustomThemes).toHaveLength(2));
    const second = fake.saved.at(-1)!.readerCustomThemes[1];
    expect(second).toMatchObject({ name: "Custom 1", background: "#abcdef", text: "#5b4636" });
    expect(second.id).not.toBe(created.id);

    // Deleting the chosen theme returns to Hojicha and keeps the other.
    await user.click(screen.getByRole("button", { name: "Delete theme" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTheme).toBe("hojicha"));
    expect(fake.saved.at(-1)?.readerCustomThemes).toEqual([renamed]);
    await user.click(screen.getByRole("button", { name: "First custom" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTheme).toBe(created.id));
  });

  it("keeps no more than the limit of custom themes", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => ({
      readerCustomThemes: Array.from({ length: 32 }, (_, index) => ({
        ...customTheme,
        id: customId.slice(0, -2) + index.toString(16).padStart(2, "0"),
      })),
    }));
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText(/reader theme hojicha/);
    await user.click(screen.getByRole("button", { name: "New theme" }));
    await user.click(screen.getByRole("button", { name: "Sepia" }));
    await waitFor(() => expect(fake.saved.at(-1)?.readerTheme).toBe("sepia"));
    expect(fake.saved.at(-1)?.readerCustomThemes).toHaveLength(32);
  });

  it("keeps defaults when loading fails and saves a change only over the saved record", async () => {
    const user = userEvent.setup();
    const fake = fakeStore(async () => {
      throw Error("C:/private/library.sqlite3");
    });
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await screen.findByText("hojicha #b8743c wheel 100 font 16");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(fake.store.load).toHaveBeenCalledTimes(2));
    expect(screen.getByText("dark #b8743c wheel 100 font 16")).toBeInTheDocument();
    expect(fake.saved).toEqual([]);

    fake.store.load.mockResolvedValue({ readerFontSize: 20, interfaceLanguage: "ja" });
    await user.click(screen.getByRole("button", { name: "Farther" }));
    await waitFor(() => expect(fake.saved).toHaveLength(1));
    expect(fake.saved[0]).toMatchObject({
      theme: "dark",
      readerWheelStep: 330,
      readerFontSize: 20,
      interfaceLanguage: "ja",
    });
  });

  it("shows the defaults when loading stalls and applies a late result when nothing changed", async () => {
    vi.useFakeTimers();
    let finish!: (value: Partial<AppearancePreferences>) => void;
    const fake = fakeStore(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(screen.queryByText(/wheel/)).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(screen.getByText("hojicha #b8743c wheel 100 font 16")).toBeInTheDocument();
    await act(async () => finish({ theme: "dark" }));
    expect(screen.getByText("dark #b8743c wheel 100 font 16")).toBeInTheDocument();
    expect(fake.saved).toEqual([]);
  });

  it("keeps a change made before a late load and saves it over the saved record", async () => {
    vi.useFakeTimers();
    let finish!: (value: Partial<AppearancePreferences>) => void;
    const fake = fakeStore(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AppearanceProvider store={fake.store}>
        <Probe />
      </AppearanceProvider>,
    );
    await act(async () => vi.advanceTimersByTime(2000));
    await act(async () => screen.getByRole("button", { name: "Dark" }).click());
    await act(async () => screen.getByRole("button", { name: "Larger" }).click());
    expect(screen.getByText("dark #b8743c wheel 100 font 17")).toBeInTheDocument();
    // Nothing is written while the saved record is unknown.
    expect(fake.saved).toEqual([]);

    await act(async () =>
      finish({
        theme: "matcha",
        readerFontSize: 20,
        readerWheelStep: 222,
        interfaceLanguage: "ja",
        readerCustomThemes: [customTheme],
      }),
    );
    // The newer edits win over the saved values they touched.
    expect(screen.getByText("dark #b8743c wheel 222 font 17")).toBeInTheDocument();
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]).toMatchObject({
      theme: "dark",
      readerFontSize: 17,
      readerWheelStep: 222,
      interfaceLanguage: "ja",
      readerCustomThemes: [customTheme],
    });
  });

  it("renders at once with defaults outside the desktop application", () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    expect(screen.getByText("hojicha #b8743c wheel 100 font 16")).toBeInTheDocument();
  });

  it("keeps each valid saved preference and drops the rest", () => {
    expect(
      normalizeAppearancePreferences({
        theme: "sepia",
        accentColor: "#7A68D8",
        readerWheelStep: 105,
        readerFontSize: 72,
        readerLineHeight: 3,
        future: true,
      }),
    ).toEqual({ accentColor: "#7A68D8", readerFontSize: 72, readerLineHeight: 3 });
    expect(
      normalizeAppearancePreferences({
        theme: "dark",
        readerWheelStep: 10,
        readerWheelSpeed: 3,
        readerFontSize: 7,
      }),
    ).toEqual({ theme: "dark", readerWheelStep: 10 });
    for (const readerLineHeight of [0.95, 3.05, 1.62, "1.5", null]) {
      expect(normalizeAppearancePreferences({ readerLineHeight })).toEqual({});
    }
    expect(normalizeAppearancePreferences({ readerLineHeight: 1 })).toEqual({
      readerLineHeight: 1,
    });
    for (const readerFontWeight of [0, 1000, 450, 700.5, "700", null]) {
      expect(normalizeAppearancePreferences({ readerFontWeight })).toEqual({});
    }
    expect(normalizeAppearancePreferences({ readerFontWeight: 100 })).toEqual({
      readerFontWeight: 100,
      readerWesternFontWeight: 100,
      readerAsianFontWeight: 100,
    });
    expect(normalizeAppearancePreferences({ readerFontWeight: 900 })).toEqual({
      readerFontWeight: 900,
      readerWesternFontWeight: 900,
      readerAsianFontWeight: 900,
    });
    for (const readerParagraphIndent of [-0.5, 20.5, 1.25, "1", null]) {
      expect(normalizeAppearancePreferences({ readerParagraphIndent })).toEqual({});
    }
    for (const readerParagraphIndent of [0, 1.5, 20]) {
      expect(normalizeAppearancePreferences({ readerParagraphIndent })).toEqual({
        readerParagraphIndent,
      });
    }
    for (const readerParagraphMargin of [-2, 202, 15, 12.5, "12", null]) {
      expect(normalizeAppearancePreferences({ readerParagraphMargin })).toEqual({});
    }
    for (const readerLetterSpacing of [-11, 61, 1.5, "2", null]) {
      expect(normalizeAppearancePreferences({ readerLetterSpacing })).toEqual({});
    }
    for (const readerWordSpacing of [-21, 121, 0.5, "4", null]) {
      expect(normalizeAppearancePreferences({ readerWordSpacing })).toEqual({});
    }
    expect(
      normalizeAppearancePreferences({ readerLetterSpacing: -10, readerWordSpacing: 120 }),
    ).toEqual({ readerLetterSpacing: -10, readerWordSpacing: 120 });
    expect(normalizeAppearancePreferences({ readerShowReadingSpeed: "yes" })).toEqual({});
    expect(normalizeAppearancePreferences({ readerShowReadingSpeed: true })).toEqual({
      readerShowReadingSpeed: true,
    });
    for (const readerParagraphMargin of [0, 24, 200]) {
      expect(normalizeAppearancePreferences({ readerParagraphMargin })).toEqual({
        readerParagraphMargin,
      });
    }
    for (const readerMaxWidth of [-4, 404, 42, 40.5, "40", null]) {
      expect(normalizeAppearancePreferences({ readerMaxWidth })).toEqual({});
    }
    for (const readerMaxWidth of [100, 440, 7680, 1_000_000]) {
      expect(normalizeAppearancePreferences({ readerMaxWidth })).toEqual({ readerMaxWidth });
    }
    for (const readerMaxHeight of [0, 90, 1_000_010, 725, 720.5, "720", null]) {
      expect(normalizeAppearancePreferences({ readerMaxHeight })).toEqual({});
    }
    for (const readerMaxHeight of [100, 720, 4000]) {
      expect(normalizeAppearancePreferences({ readerMaxHeight })).toEqual({ readerMaxHeight });
    }
    for (const readerWritingMode of ["vertical-rl", "Vertical", "", 1, null]) {
      expect(normalizeAppearancePreferences({ readerWritingMode })).toEqual({});
    }
    for (const readerWritingMode of ["horizontal", "vertical"]) {
      expect(normalizeAppearancePreferences({ readerWritingMode })).toEqual({ readerWritingMode });
    }
    for (const readerTextOrientation of ["sideways", "Upright", "", 1, null]) {
      expect(normalizeAppearancePreferences({ readerTextOrientation })).toEqual({});
    }
    for (const readerTextOrientation of ["mixed", "upright"]) {
      expect(normalizeAppearancePreferences({ readerTextOrientation })).toEqual({
        readerTextOrientation,
      });
    }
    for (const readerViewMode of ["scroll", "Continuous", "semiContinuous", "", 1, null]) {
      expect(normalizeAppearancePreferences({ readerViewMode })).toEqual({});
    }
    for (const readerViewMode of ["continuous", "semi-continuous", "paginated"]) {
      expect(normalizeAppearancePreferences({ readerViewMode })).toEqual({ readerViewMode });
    }
    for (const readerHideFurigana of ["true", 1, null]) {
      expect(normalizeAppearancePreferences({ readerHideFurigana })).toEqual({});
    }
    for (const readerHideFurigana of [true, false]) {
      expect(normalizeAppearancePreferences({ readerHideFurigana })).toEqual({
        readerHideFurigana,
      });
    }
    for (const readerBlurImage of ["true", 1, null]) {
      expect(normalizeAppearancePreferences({ readerBlurImage })).toEqual({});
    }
    for (const readerBlurImage of [true, false]) {
      expect(normalizeAppearancePreferences({ readerBlurImage })).toEqual({ readerBlurImage });
    }
    for (const readerSidebarPinned of ["true", 1, null]) {
      expect(normalizeAppearancePreferences({ readerSidebarPinned })).toEqual({});
    }
    expect(normalizeAppearancePreferences({ readerSidebarPinned: false })).toEqual({
      readerSidebarPinned: false,
    });
    // Presets and kept custom themes are chosen; custom themes are kept one by one.
    for (const readerTheme of ["paper", "sepia", "night", "latte", "frappe", "macchiato", "mocha"])
      expect(normalizeAppearancePreferences({ readerTheme })).toEqual({ readerTheme });
    for (const readerTheme of ["Paper", "custom", "", 3, customId, customId.toUpperCase()])
      expect(normalizeAppearancePreferences({ readerTheme })).toEqual({});
    expect(
      normalizeAppearancePreferences({ readerTheme: customId, readerCustomThemes: [customTheme] }),
    ).toEqual({ readerTheme: customId, readerCustomThemes: [customTheme] });
    const other = { ...customTheme, id: customId.replace("0b8a", "1c9b"), name: "名前".repeat(20) };
    expect(
      normalizeAppearancePreferences({
        readerTheme: customId,
        readerCustomThemes: [
          { ...customTheme, id: "paper" },
          { ...customTheme, name: "" },
          { ...customTheme, name: " Dusk" },
          { ...customTheme, name: "x".repeat(41) },
          { ...customTheme, name: "Tab\there" },
          { ...customTheme, background: "#10182" },
          { ...customTheme, text: "white" },
          { ...customTheme, selection: "rgb(0, 0, 0)" },
          { ...customTheme, footerText: undefined },
          "Dusk",
          null,
          other,
          { ...customTheme, id: other.id, name: "Duplicate" },
        ],
      }),
    ).toEqual({ readerCustomThemes: [other] });
    for (const readerCustomThemes of [{}, "[]", null])
      expect(normalizeAppearancePreferences({ readerCustomThemes })).toEqual({});
    // Only a theme's own fields are kept, never anything else such as CSS.
    expect(
      normalizeAppearancePreferences({
        readerCustomThemes: [{ ...customTheme, css: "body { color: red }" }],
      }),
    ).toEqual({ readerCustomThemes: [customTheme] });
    expect(normalizeAppearancePreferences(null)).toEqual({});
    expect(normalizeAppearancePreferences("dark")).toEqual({});
  });
});
