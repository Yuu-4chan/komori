import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { googleFontUrl } from "./fontChoices";
import { ReaderShell } from "./ReaderShell";
import type { ReaderPresentation, ReaderRendererFactory } from "./renderer";

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
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));

const font = (id: string, bundled = false) => ({
  id,
  family: "Zen Old Mincho",
  source: "google",
  available: true,
  bundled,
  url: googleFontUrl(id),
});
const georgiaBold = { family: "Georgia", name: "Georgia Bold", weight: 700, style: "normal" };

/** Native answers the test gives when it chooses. */
function answers() {
  const pending = new Map<string, (value: unknown) => void>();
  vi.mocked(invoke).mockImplementation(
    (command) => new Promise((resolve) => pending.set(command, resolve)),
  );
  return async (command: string, value: unknown) => {
    await vi.waitFor(() => expect(pending.has(command)).toBe(true));
    await act(async () => pending.get(command)!(value));
  };
}

function openBook() {
  const mount = vi.fn(async (..._args: unknown[]) => "ready" as const);
  const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => {});
  const dispose = vi.fn();
  const factory: ReaderRendererFactory = () => ({
    mount,
    setPresentation,
    advancePage: async () => {},
    retreatPage: async () => {},
    dispose,
  });
  render(
    <MemoryRouter>
      <AppearanceProvider
        store={{
          load: async () => ({
            readerAsianFont: { source: "google", id: "zen-old-mincho" },
            readerAsianFontWeight: 600,
          }),
          save: async () => {},
        }}
      >
        <ReaderShell rendererFactory={factory} />
      </AppearanceProvider>
    </MemoryRouter>,
  );
  const opened = () => mount.mock.calls[0]?.[7] as ReaderPresentation | undefined;
  return { mount, setPresentation, dispose, opened };
}

describe("Reader fonts as a book opens", () => {
  it("lays a book out once its fonts are known, so it opens in them", async () => {
    const answer = answers();
    const book = openBook();
    await answer("check_system_font", { family: "Georgia", available: true, faces: [georgiaBold] });
    await act(async () => {});
    // The installed weight is not known before the font list answers.
    expect(book.mount).not.toHaveBeenCalled();
    await answer("list_reader_fonts", [font("zen-old-mincho", true), font("zen-old-mincho-600")]);
    await screen.findByText("Reader ready");
    expect(book.mount).toHaveBeenCalledOnce();
    expect(book.opened()?.fontPair).toMatchObject({
      weights: { asian: 600 },
      downloaded: ["zen-old-mincho", "zen-old-mincho-600"],
      systemFaces: [georgiaBold],
    });
    expect(book.setPresentation).not.toHaveBeenCalled();
  });

  it("opens a book whose fonts take long without them, then lays it out in them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const answer = answers();
      const book = openBook();
      await act(async () => vi.advanceTimersByTime(900));
      expect(book.mount).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(100));
      await screen.findByText("Reader ready");
      expect(book.opened()?.fontPair?.systemFaces).toBeUndefined();
      await answer("check_system_font", {
        family: "Georgia",
        available: true,
        faces: [georgiaBold],
      });
      await vi.waitFor(() => expect(book.setPresentation).toHaveBeenCalledOnce());
      expect(book.setPresentation.mock.calls[0][0].fontPair?.systemFaces).toEqual([georgiaBold]);
      // The open book takes the late fonts; it is not opened again.
      expect(book.mount).toHaveBeenCalledOnce();
      expect(book.dispose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
