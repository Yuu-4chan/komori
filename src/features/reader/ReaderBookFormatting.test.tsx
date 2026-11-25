import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { ReaderShell } from "./ReaderShell";
import type { ReaderPresentation, ReaderRendererFactory } from "./renderer";

// What the book decides with its own formatting on; the chosen values stay saved.
const bookOwned = {
  lineHeight: undefined,
  fontWeight: undefined,
  paragraphIndent: undefined,
  paragraphMargin: undefined,
  letterSpacing: undefined,
  wordSpacing: undefined,
  fontFamilyGroup1: undefined,
  fontFamilyGroup2: undefined,
  fontPair: undefined,
  textJustification: false,
};

// The rows the book's own formatting takes over.
const rows = [
  "Line height",
  "Paragraph indentation",
  "Letter spacing",
  "Word spacing",
  "Paragraph margin",
];

describe("Reader book formatting", () => {
  it("defaults off and keeps only a saved true or false", () => {
    expect(defaultAppearance.readerBookFormatting).toBe(false);
    for (const value of [null, 1, "true", [], {}])
      expect(normalizeAppearancePreferences({ readerBookFormatting: value })).toEqual({});
    for (const value of [true, false])
      expect(normalizeAppearancePreferences({ readerBookFormatting: value })).toEqual({
        readerBookFormatting: value,
      });
  });

  it("leaves the book's own typography to it, keeping size, margins and choices for later", async () => {
    const user = userEvent.setup();
    let saved: Partial<AppearancePreferences> = {
      readerLineHeight: 2,
      readerParagraphIndent: 3,
      readerParagraphMargin: 10,
      readerLetterSpacing: 2,
      readerWordSpacing: 4,
      readerTextJustification: true,
      readerFontSize: 22,
      readerPageMargin: 60,
    };
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
    const tree = () => (
      <MemoryRouter>
        <AppearanceProvider store={{ load: async () => saved, save }}>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const first = render(tree());
    await screen.findByText("Reader ready");
    expect(mount.mock.calls.at(-1)![7]).toMatchObject({
      lineHeight: 2,
      paragraphIndent: 3,
      textJustification: true,
    });
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    const toggle = screen.getByRole("button", { name: "Book's formatting" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    for (const row of rows) expect(screen.getByText(row)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Text justification" })).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(saved).toMatchObject({ readerBookFormatting: true }));
    await waitFor(() =>
      expect(setPresentation).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...bookOwned, fontSize: 22, sideMargin: 60 }),
      ),
    );
    // Only the size stays among the typography rows; the chosen values stay saved.
    expect(screen.getByText("Font size")).toBeInTheDocument();
    for (const row of rows) expect(screen.queryByText(row)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Text justification" })).not.toBeInTheDocument();
    expect(saved).toMatchObject({ readerLineHeight: 2, readerTextJustification: true });
    first.unmount();

    // A book opened later keeps its own formatting from the start.
    const second = render(tree());
    await screen.findByText("Reader ready");
    expect(mount.mock.calls.at(-1)![7]).toMatchObject({ ...bookOwned, fontSize: 22 });
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    await user.click(screen.getByRole("button", { name: "Book's formatting" }));
    await waitFor(() =>
      expect(setPresentation).toHaveBeenLastCalledWith(
        expect.objectContaining({ lineHeight: 2, paragraphIndent: 3, textJustification: true }),
      ),
    );
    expect(screen.getByText("Line height")).toBeInTheDocument();
    second.unmount();
  });
});
