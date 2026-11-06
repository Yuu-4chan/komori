import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";

const back = vi.hoisted(() => ({ press: () => {} }));
vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: vi.fn(async (handler: () => void) => {
    back.press = handler;
    return { unregister: async () => {} };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

const { MobileLookupSheet, sheetPlace } = await import("./MobileLookupSheet");
const { useBackButton } = await import("./system");

function BackButton() {
  useBackButton();
  return null;
}

function sheet(rect?: { left: number; top: number; right: number; bottom: number }) {
  const onBack = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <AppearanceProvider store={null}>
        <BackButton />
        <MobileLookupSheet label="Lookup: 見当" onBack={onBack} onClose={onClose} rect={rect}>
          <p>けんとう</p>
        </MobileLookupSheet>
      </AppearanceProvider>
    </MemoryRouter>,
  );
  const section = screen.getByRole("dialog", { name: "Lookup: 見当" });
  const handle = section.querySelector<HTMLElement>(".mobile-lookup__handle")!;
  const drag = (from: number, to: number) => {
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: from });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: to });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: to });
  };
  return { section, onBack, onClose, drag };
}

afterEach(() => {
  cleanup();
});

describe("the phone's lookup sheet", () => {
  it("rises from the bottom, or comes from the top for a word under that place", () => {
    expect(sheetPlace(undefined, 800)).toEqual({ edge: "bottom", height: 432 });
    expect(sheetPlace({ left: 0, top: 100, right: 20, bottom: 120 }, 800)).toEqual({
      edge: "bottom",
      height: 432,
    });
    expect(sheetPlace({ left: 0, top: 700, right: 20, bottom: 720 }, 800)).toEqual({
      edge: "top",
      height: 432,
    });
    // Neither side has its share: the roomier one, kept clear of the word.
    expect(sheetPlace({ left: 0, top: 380, right: 20, bottom: 400 }, 800)).toEqual({
      edge: "bottom",
      height: 388,
    });
    expect(sheetPlace({ left: 0, top: 420, right: 20, bottom: 440 }, 800)).toEqual({
      edge: "top",
      height: 408,
    });
  });

  it("shows its lookup, and closes from the book beside it", () => {
    const { section, onClose } = sheet({ left: 0, top: 700, right: 20, bottom: 720 });
    expect(section.textContent).toContain("けんとう");
    expect(section.closest(".mobile-lookup--top")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("passes a tap beside it on, to look up another word", () => {
    const onTapBeside = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={["/reader"]}>
        <AppearanceProvider store={null}>
          <MobileLookupSheet
            label="Lookup: 見当"
            onBack={() => {}}
            onClose={onClose}
            onTapBeside={onTapBeside}
          >
            <p>けんとう</p>
          </MobileLookupSheet>
        </AppearanceProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }), { clientX: 40, clientY: 120 });
    expect(onTapBeside).toHaveBeenCalledWith(40, 120);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes the whole screen when its handle is dragged up, and closes when dragged down", () => {
    const { section, onClose, drag } = sheet();
    const height = section.style.height;
    drag(400, 300);
    expect(section.hasAttribute("data-full")).toBe(true);
    expect(section.style.height).toBe(`${window.innerHeight}px`);
    drag(100, 200);
    expect(section.hasAttribute("data-full")).toBe(false);
    expect(section.style.height).toBe(height);
    expect(onClose).not.toHaveBeenCalled();
    // A short drag leaves it as it is.
    drag(400, 430);
    expect(onClose).not.toHaveBeenCalled();
    drag(400, 500);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back with Android's Back", () => {
    const { onBack, onClose } = sheet();
    act(() => back.press());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
