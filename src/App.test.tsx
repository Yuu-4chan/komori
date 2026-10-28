import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { AppearanceProvider } from "./features/appearance/AppearanceProvider";
import { appPresetThemes } from "./features/appearance/appThemes";
import {
  defaultPopupPalette,
  popupThemeStyle,
  popupPaletteFields,
} from "./features/reader/popupThemes";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
} from "./features/appearance/appearancePreferences";

// The Reader route is code-split. Loading its chunk (EPUB.js and the Reader modules) takes
// well under a second normally but can take several seconds on a slow, loaded test run.
const readerChunkTimeout = 10_000;

function renderApp(route = "/library") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppearanceProvider>
        <App />
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

describe("Komori foundation", () => {
  it.each(
    ["/library", "/dictionary", "/settings", "/statistics"].flatMap((route) =>
      [
        ["d", "Dictionary"],
        ["s", "Statistics"],
        ["g", "Settings"],
      ].map(([key, title]) => ({ route, key, title })),
    ),
  )(
    "navigates by exact Ctrl+$key from $route, with Ctrl+B returning to Library",
    async ({ route, key, title }) => {
      renderApp(route);
      fireEvent.keyDown(document.body, { key, ctrlKey: true });
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
      expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    },
  );
  it("keeps page navigation out of edits, dialogs, menus, composition and modified/repeated keys", () => {
    renderApp("/settings");
    const input = document.createElement("textarea");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "d", ctrlKey: true });
    input.remove();
    for (const exclusion of [
      { altKey: true },
      { shiftKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
    ]) {
      fireEvent.keyDown(document.body, { key: "d", ctrlKey: true, ...exclusion });
    }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    dialog.remove();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    fireEvent.keyDown(menu, { key: "s", ctrlKey: true });
    menu.remove();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Dictionary" })).not.toBeInTheDocument();
  });
  it("keeps the current Dictionary query when its navigation shortcut is pressed", () => {
    renderApp("/dictionary?q=original");
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    fireEvent.change(input, { target: { value: "unsent query" } });
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Dictionary search" })).toBe(input);
    expect(input).toHaveValue("unsent query");
  });
  it("ignores the retired pitch-placement field and omits placement controls", async () => {
    expect(
      normalizeAppearancePreferences({
        readerPopupPitchBeforeDefinitions: false,
        readerPopupShowFrequency: false,
      }),
    ).toEqual({ readerPopupShowFrequency: false });
    renderApp("/settings");
    await userEvent.setup().click(screen.getByRole("button", { name: "Reader popup" }));
    expect(
      screen.queryByRole("button", { name: "Pitch before definitions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Frequency under headword" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show pitch" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Show frequency" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("defaults pitch visibility on and saves keyboard off/on through Settings and reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Show pitch" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(saved).toEqual({ ...defaultAppearance, readerPopupShowPitch: false }),
    );
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Show pitch" });
    expect(restored).toHaveAttribute("aria-pressed", "false");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupShowPitch).toBe(true));
  });

  it("drops missing and invalid pitch-visibility values independently", () => {
    expect(defaultAppearance.readerPopupShowPitch).toBe(true);
    for (const readerPopupShowPitch of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({
          readerPopupShowPitch,
          readerPopupTheme: "night",
        }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupShowPitch of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupShowPitch })).toEqual({
        readerPopupShowPitch,
      });
    }
  });
  it("defaults frequency visibility on and saves keyboard off/on through Settings and reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Show frequency" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(saved).toEqual({ ...defaultAppearance, readerPopupShowFrequency: false }),
    );
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Show frequency" });
    expect(restored).toHaveAttribute("aria-pressed", "false");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupShowFrequency).toBe(true));
  });

  it("drops missing and invalid frequency-visibility values independently", () => {
    expect(defaultAppearance.readerPopupShowFrequency).toBe(true);
    for (const readerPopupShowFrequency of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({
          readerPopupShowFrequency,
          readerPopupTheme: "night",
        }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupShowFrequency of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupShowFrequency })).toEqual({
        readerPopupShowFrequency,
      });
    }
  });
  it("defaults dictionary names on and saves keyboard off/on through Settings and reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Show dictionary names" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(saved).toEqual({ ...defaultAppearance, readerPopupShowDictionaryNames: false }),
    );
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Show dictionary names" });
    expect(restored).toHaveAttribute("aria-pressed", "false");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupShowDictionaryNames).toBe(true));
  });

  it("drops missing and invalid dictionary-name values independently", () => {
    expect(defaultAppearance.readerPopupShowDictionaryNames).toBe(true);
    for (const readerPopupShowDictionaryNames of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({
          readerPopupShowDictionaryNames,
          readerPopupTheme: "night",
        }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupShowDictionaryNames of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupShowDictionaryNames })).toEqual({
        readerPopupShowDictionaryNames,
      });
    }
  });
  it("defaults popup lookup on and saves off/on through Settings, including reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Enable reader popup" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    await waitFor(() => expect(saved.readerPopupEnabled).toBe(false));
    expect(saved).toEqual({ ...defaultAppearance, readerPopupEnabled: false });
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Enable reader popup" });
    expect(restored).toHaveAttribute("aria-pressed", "false");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupEnabled).toBe(true));
    expect(restored).toHaveAttribute("aria-pressed", "true");
  });

  it("drops missing and invalid popup enabled values independently", () => {
    expect(defaultAppearance.readerPopupEnabled).toBe(true);
    for (const readerPopupEnabled of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({ readerPopupEnabled, readerPopupTheme: "night" }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupEnabled of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupEnabled })).toEqual({
        readerPopupEnabled,
      });
    }
  });
  it("defaults mouse-selection lookup off and saves keyboard on/off through Settings and reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Mouse selection" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupMouseSelection).toBe(true));
    expect(saved).toEqual({ ...defaultAppearance, readerPopupMouseSelection: true });
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Mouse selection" });
    expect(restored).toHaveAttribute("aria-pressed", "true");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupMouseSelection).toBe(false));
    expect(restored).toHaveAttribute("aria-pressed", "false");
  });

  it("drops missing and invalid popup mouse-selection values independently", () => {
    expect(defaultAppearance.readerPopupMouseSelection).toBe(false);
    for (const readerPopupMouseSelection of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({ readerPopupMouseSelection, readerPopupTheme: "night" }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupMouseSelection of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupMouseSelection })).toEqual({
        readerPopupMouseSelection,
      });
    }
  });
  it("defaults popup voice actions on and saves off/on through Settings, including reload", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings?section=popup"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const user = userEvent.setup();
    const view = mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const toggle = screen.getByRole("button", { name: "Voice action" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    await waitFor(() => expect(saved.readerPopupVoiceAction).toBe(false));
    expect(saved).toEqual({ ...defaultAppearance, readerPopupVoiceAction: false });
    view.unmount();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reader popup" }));
    const restored = screen.getByRole("button", { name: "Voice action" });
    expect(restored).toHaveAttribute("aria-pressed", "false");
    restored.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(saved.readerPopupVoiceAction).toBe(true));
    expect(restored).toHaveAttribute("aria-pressed", "true");
  });

  it("drops missing and invalid popup voice action values independently", () => {
    expect(defaultAppearance.readerPopupVoiceAction).toBe(true);
    for (const readerPopupVoiceAction of [undefined, null, "false", 0, 1, {}, []]) {
      expect(
        normalizeAppearancePreferences({ readerPopupVoiceAction, readerPopupTheme: "night" }),
      ).toEqual({ readerPopupTheme: "night" });
    }
    for (const readerPopupVoiceAction of [true, false]) {
      expect(normalizeAppearancePreferences({ readerPopupVoiceAction })).toEqual({
        readerPopupVoiceAction,
      });
    }
  });
  it("edits every custom popup color, rejects incomplete input, and retains colors across presets and reload", async () => {
    const user = userEvent.setup();
    const saved = {
      ...defaultAppearance,
      theme: "dark" as const,
      readerTheme: "sepia",
      readerPopupRadius: 7,
      readerPopupWidth: 800,
      readerPopupHeight: 600,
    };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter initialEntries={["/settings?section=popup"]}>
          <AppearanceProvider store={store}>
            <App />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const view = mount();
    // Popup design lives in Settings > Reader popup.
    await screen.findByRole("group", { name: "Popup theme" });
    const rootStyle = document.documentElement.style.cssText;
    await user.click(screen.getByRole("button", { name: "Custom" }));
    const palette = {
      background: "#121826",
      text: "#EAF0FF",
      accent: "#80A0FF",
      border: "#405070",
      tag: "#253040",
    };
    for (const field of popupPaletteFields) {
      const input = screen.getByRole("textbox", { name: `Popup ${field} HEX` });
      await user.clear(input);
      await user.type(input, palette[field]);
      palette[field] = palette[field].toLowerCase();
      await waitFor(() => expect(saved.readerPopupCustomPalette[field]).toBe(palette[field]));
    }
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    const tokens = popupThemeStyle("custom", palette) as Record<string, string>;
    for (const key of [
      "--surface-card",
      "--text-primary",
      "--accent-base",
      "--border-soft",
      "--popup-tag",
    ])
      expect(preview.style.getPropertyValue(key)).toBe(tokens[key]);
    expect(preview.style.borderRadius).toBe("7px");
    expect(saved).toMatchObject({
      theme: "dark",
      readerTheme: "sepia",
      readerPopupWidth: 800,
      readerPopupHeight: 600,
    });
    const input = screen.getByRole("textbox", { name: "Popup text HEX" });
    const count = store.save.mock.calls.length;
    await user.clear(input);
    await user.type(input, "#bad");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(store.save).toHaveBeenCalledTimes(count);
    await user.tab();
    expect(input).toHaveValue(palette.text);
    for (const label of ["Night", "Application", "Paper", "Classic", "Custom"])
      await user.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("textbox", { name: "Popup background HEX" })).toHaveValue(
      palette.background,
    );
    expect(document.documentElement.style.cssText).toBe(rootStyle);
    await waitFor(() => expect(saved.readerPopupTheme).toBe("custom"));
    view.unmount();
    mount();
    // Popup design lives in Settings > Reader popup.
    await screen.findByRole("group", { name: "Popup theme" });
    expect(screen.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Popup accent HEX" })).toHaveValue(palette.accent);
  });

  it("defaults legacy custom palettes and drops malformed palettes independently", () => {
    expect(defaultAppearance.readerPopupCustomPalette).toEqual(defaultPopupPalette);
    expect(normalizeAppearancePreferences({ readerPopupTheme: "custom" })).toEqual({
      readerPopupTheme: "custom",
    });
    for (const field of popupPaletteFields) {
      for (const value of [undefined, null, 123, "red", "#abc", "#1234567", "url(x)"]) {
        expect(
          normalizeAppearancePreferences({
            readerPopupCustomPalette: { ...defaultPopupPalette, [field]: value },
            readerPopupTheme: "custom",
            readerPopupRadius: 7,
          }),
        ).toEqual({ readerPopupTheme: "custom", readerPopupRadius: 7 });
      }
    }
    expect(
      normalizeAppearancePreferences({
        readerPopupCustomPalette: { ...defaultPopupPalette, accent: "#ABCDEF", css: "ignored" },
      }),
    ).toEqual({ readerPopupCustomPalette: { ...defaultPopupPalette, accent: "#abcdef" } });
  });
  it("loads, edits, and previews popup corners independently of palette and size", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {});
    render(
      <MemoryRouter initialEntries={["/settings?section=popup"]}>
        <AppearanceProvider
          store={{
            load: async () => ({
              readerPopupRadius: 7,
              readerPopupTheme: "night",
              readerPopupWidth: 800,
              readerPopupHeight: 600,
            }),
            save,
          }}
        >
          <App />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    // Popup design lives in Settings > Reader popup.
    await screen.findByRole("group", { name: "Popup theme" });
    const input = screen.getByRole("textbox", { name: "Rounded corners" });
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    expect(input).toHaveValue("7");
    expect(preview).toHaveStyle({ borderRadius: "7px" });
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Increase Rounded corners" }));
    expect(input).toHaveValue("8");
    await user.click(screen.getByRole("button", { name: "Decrease Rounded corners" }));
    expect(input).toHaveValue("7");
    for (const [typed, radius] of [
      ["0", 0],
      ["18.4", 18],
      ["99", 28],
      ["-1", 0],
    ] as const) {
      await user.click(input);
      await user.clear(input);
      await user.type(input, `${typed}{Enter}`);
      expect(input).toHaveValue(String(radius));
      expect(preview).toHaveStyle({ borderRadius: `${radius}px` });
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            readerPopupRadius: radius,
            readerPopupTheme: "night",
            readerPopupWidth: 800,
            readerPopupHeight: 600,
          }),
        ),
      );
    }
    await user.click(screen.getByRole("button", { name: "Decrease Rounded corners" }));
    expect(input).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Decrease Rounded corners" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Paper" }));
    expect(preview).toHaveStyle({ borderRadius: "0px" });
    await user.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "General",
      }),
    );
    await user.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "Reader popup",
      }),
    );
    expect(screen.getByRole("textbox", { name: "Rounded corners" })).toHaveValue("0");
  });

  it("loads, edits, saves and previews the popup's text size and line height", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {});
    render(
      <MemoryRouter initialEntries={["/settings?section=popup"]}>
        <AppearanceProvider
          store={{
            load: async () => ({ readerPopupFontSize: 18, readerPopupRadius: 7 }),
            save,
          }}
        >
          <App />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("group", { name: "Popup theme" });
    const size = screen.getByRole("textbox", { name: "Font size" });
    const lineHeight = screen.getByRole("textbox", { name: "Line height" });
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    expect(size).toHaveValue("18");
    expect(lineHeight).toHaveValue("1.60");
    // The content zooms by the size over the default 15 px definitions.
    expect(preview.style.getPropertyValue("--popup-zoom")).toBe("1.2");
    expect(preview.style.getPropertyValue("--popup-line-height")).toBe("1.6");
    await user.click(screen.getByRole("button", { name: "Increase Font size" }));
    expect(size).toHaveValue("19");
    await user.click(screen.getByRole("button", { name: "Increase Line height" }));
    expect(lineHeight).toHaveValue("1.65");
    expect(preview.style.getPropertyValue("--popup-line-height")).toBe("1.65");
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readerPopupFontSize: 19,
          readerPopupLineHeight: 1.65,
          readerPopupRadius: 7,
        }),
      ),
    );
    for (const [typed, shown] of [
      ["99", "48"],
      ["3", "8"],
    ] as const) {
      await user.click(size);
      await user.clear(size);
      await user.type(size, `${typed}{Enter}`);
      expect(size).toHaveValue(shown);
    }
    expect(
      normalizeAppearancePreferences({
        readerPopupFontSize: 15.5,
        readerPopupLineHeight: 3.05,
        readerPopupRadius: 7,
      }),
    ).toEqual({ readerPopupRadius: 7 });
    expect(defaultAppearance).toMatchObject({
      readerPopupFontSize: 15,
      readerPopupLineHeight: 1.6,
    });
  });

  it("defaults legacy popup corners and filters invalid values independently", () => {
    expect(defaultAppearance.readerPopupRadius).toBe(18);
    expect(normalizeAppearancePreferences({})).toEqual({});
    for (const radius of [null, true, "18", -1, 29, 18.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        normalizeAppearancePreferences({
          readerPopupRadius: radius,
          readerPopupTheme: "paper",
          readerPopupWidth: 800,
          readerPopupHeight: 600,
        }),
      ).toEqual({ readerPopupTheme: "paper", readerPopupWidth: 800, readerPopupHeight: 600 });
    }
    for (let radius = 0; radius <= 28; radius++) {
      expect(normalizeAppearancePreferences({ readerPopupRadius: radius })).toEqual({
        readerPopupRadius: radius,
      });
    }
  });
  it("loads and saves popup presets with a live preview while keeping app and book colors", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {});
    render(
      <MemoryRouter initialEntries={["/settings?section=popup"]}>
        <AppearanceProvider
          store={{
            load: async () => ({
              readerPopupTheme: "paper",
              theme: "dark",
              readerTheme: "sepia",
              accentColor: "#123456",
            }),
            save,
          }}
        >
          <App />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    // Popup design lives in Settings > Reader popup.
    await screen.findByRole("group", { name: "Popup theme" });
    const choices = within(screen.getByRole("group", { name: "Popup theme" }));
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    expect(choices.getByRole("button", { name: /^Paper/ })).toHaveAttribute("aria-pressed", "true");
    expect(preview.style.getPropertyValue("--surface-card")).toBe("#fffdf8");
    expect(save).not.toHaveBeenCalled();
    for (const [label, id, background] of [
      ["Classic", "classic", "#fff7f1"],
      ["Night", "night", "#15192a"],
      ["Paper", "paper", "#fffdf8"],
      ["Application", "application", ""],
    ]) {
      const choice = choices.getByRole("button", { name: new RegExp(`^${label}`) });
      choice.focus();
      await user.keyboard("{Enter}");
      expect(choice).toHaveAttribute("aria-pressed", "true");
      expect(preview.style.getPropertyValue("--surface-card")).toBe(background);
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            readerPopupTheme: id,
            theme: "dark",
            readerTheme: "sepia",
            accentColor: "#123456",
          }),
        ),
      );
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--text-primary")).toBe("#e6e8f2");
    }
    await user.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "General",
      }),
    );
    await user.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "Reader popup",
      }),
    );
    expect(screen.getByRole("button", { name: "Application" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("defaults legacy popup themes and filters invalid choices independently", () => {
    expect(defaultAppearance.readerPopupTheme).toBe("reader");
    for (const theme of [null, 1, true, "", "Night", "Custom", "unknown", { background: "red" }]) {
      expect(
        normalizeAppearancePreferences({ readerPopupTheme: theme, readerPopupWidth: 640 }),
      ).toEqual({ readerPopupWidth: 640 });
    }
    for (const theme of ["reader", "application", "classic", "paper", "night", "custom"]) {
      expect(normalizeAppearancePreferences({ readerPopupTheme: theme })).toEqual({
        readerPopupTheme: theme,
      });
    }
  });

  it("keeps Reader out of the dock, marks the current destination, and reaches Settings", async () => {
    const user = userEvent.setup();
    renderApp();
    const dock = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(dock).queryByRole("link", { name: "Reader" })).not.toBeInTheDocument();
    expect(
      within(dock)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Dictionary", "Library", "Statistics"]);
    expect(within(dock).getByRole("link", { name: "Library" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Komori library" })).toHaveAttribute(
      "href",
      "/library",
    );
    // The theme lives in Settings; the top bar adds books instead.
    expect(screen.queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add books" })).toBeEnabled();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Storage" }));
    expect(screen.getByRole("heading", { name: "Disk space" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Backup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reclaim space" })).not.toBeInTheDocument();
    expect(within(dock).getByRole("link", { name: "Library" })).not.toHaveAttribute("aria-current");
    // Settings stays on every page's top bar, marked while open; Add books is the Library's.
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Add books" })).not.toBeInTheDocument();
    await user.click(within(dock).getByRole("link", { name: "Dictionary" }));
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
    await user.click(within(dock).getByRole("link", { name: "Statistics" }));
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    await user.click(within(dock).getByRole("link", { name: "Library" }));
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add books" })).toBeEnabled();
  });

  it("edits and persists popup dimensions through Settings categories", async () => {
    const save = vi.fn(async () => {});
    render(
      <MemoryRouter initialEntries={["/settings?section=popup"]}>
        <AppearanceProvider
          store={{ load: async () => ({ readerPopupWidth: 640, readerPopupHeight: 600 }), save }}
        >
          <App />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("group", { name: "Popup theme" });
    const width = screen.getByRole("textbox", { name: "Popup width" });
    expect(width).toHaveValue("640");
    expect(screen.getByRole("textbox", { name: "Popup height" })).toHaveValue("600");
    fireEvent.change(width, { target: { value: "800" } });
    fireEvent.keyDown(width, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Increase Popup height" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ readerPopupWidth: 800, readerPopupHeight: 620 }),
      ),
    );
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "Dictionary",
      }),
    );
    expect(screen.getByRole("heading", { name: "Dictionary sources" })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings categories" })).getByRole("button", {
        name: "Reader popup",
      }),
    );
    expect(screen.getByRole("textbox", { name: "Popup width" })).toHaveValue("800");
  });

  it("saves the Library card size and series from titles in Settings and sizes the grid", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {});
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppearanceProvider store={{ load: async () => ({ libraryCardSize: 200 }), save }}>
          <App />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    // The card size is in General, the first section, with the book folders.
    const size = await screen.findByRole("textbox", { name: "Card size" });
    expect(size).toHaveValue("200");
    await user.click(screen.getByRole("button", { name: "Increase Card size" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ libraryCardSize: 210 })),
    );
    await user.click(size);
    await user.clear(size);
    await user.type(size, "999{Enter}");
    expect(size).toHaveValue("480");
    // Series from titles stays off until chosen.
    const titles = screen.getByRole("button", { name: "Series from titles" });
    expect(titles).toHaveAttribute("aria-pressed", "false");
    await user.click(titles);
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ libraryCardSize: 480, librarySeriesFromTitles: true }),
      ),
    );
    expect(titles).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("link", { name: "Library" }));
    expect(
      (document.querySelector(".page--library") as HTMLElement).style.getPropertyValue(
        "--library-card-min",
      ),
    ).toBe("480px");
    expect(normalizeAppearancePreferences({ libraryCardSize: 245 })).toEqual({});
    expect(normalizeAppearancePreferences({ libraryCardSize: 90 })).toEqual({});
    expect(normalizeAppearancePreferences({ librarySort: "pages" })).toEqual({});
    expect(defaultAppearance.libraryCardSize).toBe(180);
    expect(normalizeAppearancePreferences({ librarySeriesFromTitles: "on" })).toEqual({});
    expect(defaultAppearance.librarySeriesFromTitles).toBe(false);
  });

  it("defaults missing popup sizes and drops invalid saved dimensions independently", () => {
    expect(defaultAppearance).toMatchObject({ readerPopupWidth: 480, readerPopupHeight: 440 });
    for (const size of [null, "480", 0, 319, 481, 1220, Number.NaN]) {
      expect(
        normalizeAppearancePreferences({ readerPopupWidth: size, readerPopupHeight: size }),
      ).toEqual({});
    }
    expect(
      normalizeAppearancePreferences({ readerPopupWidth: 320, readerPopupHeight: 1200 }),
    ).toEqual({ readerPopupWidth: 320, readerPopupHeight: 1200 });
    expect(
      normalizeAppearancePreferences({ readerPopupWidth: 1200, readerPopupHeight: 200 }),
    ).toEqual({ readerPopupWidth: 1200, readerPopupHeight: 200 });
    expect(
      normalizeAppearancePreferences({ readerPopupWidth: 200, readerPopupHeight: 600 }),
    ).toEqual({ readerPopupHeight: 600 });
  });
  it.each([
    ["Library", "/library"],
    ["Dictionary", "/dictionary"],
    ["Statistics", "/statistics"],
    ["Settings", "/settings"],
  ])("renders the %s route as a distinct view", async (heading, route) => {
    renderApp(route);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it(
    "renders the Komori Reader route as a distinct view",
    async () => {
      renderApp("/reader");
      expect(
        await screen.findByRole(
          "heading",
          { level: 1, name: "Komori Reader" },
          { timeout: readerChunkTimeout },
        ),
      ).toBeInTheDocument();
    },
    readerChunkTimeout + 5_000,
  );

  it(
    "keeps the current page while the Reader chunk loads, never revealing its placeholder",
    async () => {
      // A fresh module graph, so the Reader chunk is not loaded yet.
      vi.resetModules();
      const [{ App: FreshApp }, { AppearanceProvider: FreshAppearance }, router] =
        await Promise.all([
          import("./App"),
          import("./features/appearance/AppearanceProvider"),
          import("react-router-dom"),
        ]);
      let navigate: ((to: string) => void) | undefined;
      function Navigator() {
        navigate = router.useNavigate();
        return null;
      }
      render(
        <router.MemoryRouter initialEntries={["/library"]}>
          <FreshAppearance>
            <FreshApp />
            <Navigator />
          </FreshAppearance>
        </router.MemoryRouter>,
      );
      expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
      let placeholders = 0;
      const observer = new MutationObserver(() => {
        if (document.querySelector('.reader-shell[aria-busy="true"]')) placeholders++;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      act(() => navigate!("/reader"));
      // The Library stays until the Reader can show itself.
      expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
      expect(
        await screen.findByRole(
          "heading",
          { level: 1, name: "Komori Reader" },
          { timeout: readerChunkTimeout },
        ),
      ).toBeInTheDocument();
      observer.disconnect();
      expect(placeholders).toBe(0);
    },
    readerChunkTimeout + 5_000,
  );

  it("opens the Dictionary route searching its query", async () => {
    renderApp(`/dictionary?q=${encodeURIComponent("読む")}`);
    expect(screen.getByRole("textbox", { name: "Dictionary search" })).toHaveValue("読む");
    // Outside the desktop app the search itself fails, path-safely.
    expect(await screen.findByText("Search could not be completed. Try again.")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("navigates through real links", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("link", { name: /dictionary/i }));

    expect(screen.getByRole("heading", { level: 1, name: "Dictionary" })).toBeInTheDocument();
  });

  it("switches themes, each with its own accent, through shared appearance state", async () => {
    const user = userEvent.setup();
    renderApp("/settings");

    await user.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // No separate accent picker: a preset supplies its accent.
    expect(screen.queryByRole("group", { name: "Accent color" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Accent color" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Forest theme" }));
    expect(document.documentElement.style.getPropertyValue("--accent-base")).toBe(
      appPresetThemes.find((preset) => preset.id === "forest")!.accent,
    );
  });

  it("applies a preset's colors and accent, and edits the custom theme", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    const root = document.documentElement;

    await user.click(screen.getByRole("radio", { name: "Sakura theme" }));
    expect(root).toHaveAttribute("data-theme", "light");
    expect(root).toHaveAttribute("data-app-theme", "sakura");
    expect(root.style.getPropertyValue("--surface-main")).toBe("#fdf9f7");
    expect(root.style.getPropertyValue("--accent-base")).toBe("#e0606b");

    expect(screen.queryByRole("group", { name: "Custom theme colors" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Custom theme" }));
    const editor = screen.getByRole("group", { name: "Custom theme colors" });
    expect(root).toHaveAttribute("data-theme", "light");
    await user.click(within(editor).getByRole("button", { name: "Midnight" }));
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(root.style.getPropertyValue("--surface-app")).toBe("#111219");
    const surface = within(editor).getByRole("textbox", { name: "Surface HEX" });
    await user.clear(surface);
    await user.type(surface, "#203040");
    expect(root.style.getPropertyValue("--surface-main")).toBe("#203040");
    const base = within(editor).getByRole("group", { name: "Custom theme base" });
    await user.click(within(base).getByRole("button", { name: "Light" }));
    expect(root).toHaveAttribute("data-theme", "light");
    expect(root).toHaveAttribute("data-app-theme", "custom");
  });
});
