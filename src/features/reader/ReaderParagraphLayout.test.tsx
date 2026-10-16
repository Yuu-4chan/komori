import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { ReaderShell } from "./ReaderShell";
import type { ReaderPresentation, ReaderRendererFactory } from "./renderer";

describe("Reader paragraph choices", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("defaults off and validates each loaded value and setter independently", async () => {
    expect(defaultAppearance.readerTextJustification).toBe(false);
    expect(defaultAppearance.readerPrettyTextWrap).toBe(false);
    for (const field of ["readerTextJustification", "readerPrettyTextWrap"] as const) {
      const other =
        field === "readerTextJustification" ? "readerPrettyTextWrap" : "readerTextJustification";
      for (const value of [null, 1, "true", [], {}])
        expect(normalizeAppearancePreferences({ [field]: value, [other]: true })).toEqual({
          [other]: true,
        });
      for (const value of [true, false])
        expect(normalizeAppearancePreferences({ [field]: value })).toEqual({ [field]: value });
    }
    function InvalidProbe() {
      const prefs = useAppearance();
      return (
        <button
          onClick={() => {
            prefs.setReaderTextJustification("true" as never);
            prefs.setReaderPrettyTextWrap(1 as never);
          }}
        >
          Invalid choices
        </button>
      );
    }
    const save = vi.fn(async () => {});
    render(
      <AppearanceProvider store={{ load: async () => ({}), save }}>
        <InvalidProbe />
      </AppearanceProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Invalid choices" }));
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["paginated", "continuous", "semi-continuous"] as const)(
    "saves pointer/keyboard choices, reloads and forwards them to new books in %s and both writing modes",
    async (viewMode) => {
      const user = userEvent.setup();
      let saved: Partial<AppearancePreferences> = { readerViewMode: viewMode };
      const save = vi.fn(async (value: AppearancePreferences) => {
        saved = value;
      });
      const mount = vi.fn(async (..._args: unknown[]) => "ready" as const);
      const setPresentation = vi.fn(async (_value: ReaderPresentation) => {});
      const factory: ReaderRendererFactory = () => ({
        mount,
        setPresentation,
        advancePage: vi.fn(async () => {}),
        retreatPage: vi.fn(async () => {}),
        dispose: vi.fn(),
      });
      const tree = (book = factory) => (
        <MemoryRouter>
          <AppearanceProvider store={{ load: async () => saved, save }}>
            <ReaderShell rendererFactory={book} />
          </AppearanceProvider>
        </MemoryRouter>
      );
      const result = render(tree());
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const justify = screen.getByRole("button", { name: "Text justification" });
      const pretty = screen.getByRole("button", { name: "Pretty text wrap" });
      expect(justify).toHaveAttribute("aria-pressed", "false");
      expect(pretty).toHaveAttribute("aria-pressed", "false");
      await user.click(justify);
      pretty.focus();
      await user.keyboard(" ");
      await waitFor(() =>
        expect(saved).toMatchObject({ readerTextJustification: true, readerPrettyTextWrap: true }),
      );
      expect(pretty).toHaveFocus();
      for (const writingMode of ["vertical", "horizontal"] as const) {
        await user.click(
          screen.getByRole("button", {
            name: writingMode === "vertical" ? "Vertical" : "Horizontal",
          }),
        );
        await waitFor(() =>
          expect(setPresentation).toHaveBeenLastCalledWith(
            expect.objectContaining({
              textJustification: true,
              prettyTextWrap: true,
              writingMode,
            }),
          ),
        );
      }
      expect(mount).toHaveBeenCalledOnce();
      result.rerender(tree(() => factory()));
      await screen.findByText("Reader ready");
      expect(mount.mock.calls.at(-1)![7]).toMatchObject({
        textJustification: true,
        prettyTextWrap: true,
      });
      result.unmount();
      const reopened = render(tree());
      await screen.findByText("Reader ready");
      expect(mount.mock.calls.at(-1)![7]).toMatchObject({
        textJustification: true,
        prettyTextWrap: true,
      });
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      await user.click(screen.getByRole("button", { name: "Pretty text wrap" }));
      await waitFor(() =>
        expect(saved).toMatchObject({ readerTextJustification: true, readerPrettyTextWrap: false }),
      );
      const toggle = screen.getByRole("button", { name: "Text justification" });
      toggle.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(saved).toMatchObject({
          readerTextJustification: false,
          readerPrettyTextWrap: false,
        }),
      );
      reopened.unmount();
    },
  );

  it("explains unsupported pretty wrapping while retaining the saved choice", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    render(
      <MemoryRouter>
        <AppearanceProvider
          store={{ load: async () => ({ readerPrettyTextWrap: true }), save: async () => {} }}
        >
          <ReaderShell />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reader appearance" }));
    expect(screen.getByText(/Pretty text wrap is unsupported/)).toHaveTextContent(
      "Your choice is saved",
    );
    expect(screen.getByRole("button", { name: "Pretty text wrap" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
