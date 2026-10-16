import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isTauri } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

const appWindow = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  minimize: vi.fn(async () => undefined),
  onResized: vi.fn(async () => () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

function renderDialog(onCancel = vi.fn()) {
  render(
    <>
      <button type="button">Opener</button>
      <ConfirmDialog
        confirmLabel="Remove"
        description="Remove this book?"
        onCancel={onCancel}
        onConfirm={vi.fn()}
        open
        title="Remove"
      />
    </>,
  );
  return screen.getByRole("alertdialog");
}

it("keeps the window's title bar usable above an open dialog without changing its focus trap", async () => {
  const onCancel = vi.fn();
  const dialog = renderDialog(onCancel);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel).toHaveFocus();

  // The title bar is inside the dialog's top layer, where the page's own is inert.
  const caption = dialog.querySelector(".dialog-caption")!;
  expect(caption).toHaveAttribute("data-tauri-drag-region");
  const close = screen.getByRole("button", { name: "Close" });
  const minimize = screen.getByRole("button", { name: "Minimize" });
  expect(caption).toContainElement(close);
  expect(caption).toContainElement(minimize);
  expect(caption).toContainElement(screen.getByRole("button", { name: "Maximize" }));

  // Pressing a window control never takes focus from the dialog, and Tab skips them.
  expect(fireEvent.mouseDown(minimize)).toBe(false);
  await userEvent.click(minimize);
  expect(appWindow.minimize).toHaveBeenCalledOnce();
  await userEvent.click(close);
  expect(appWindow.close).toHaveBeenCalledOnce();
  expect(cancel).toHaveFocus();
  for (const control of caption.querySelectorAll("button")) expect(control.tabIndex).toBe(-1);

  // The strip is not the backdrop: pressing it does not cancel the dialog.
  await userEvent.click(caption);
  expect(onCancel).not.toHaveBeenCalled();
});

it("draws no title bar outside the desktop application", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const dialog = renderDialog();
  expect(dialog.querySelector(".dialog-caption")).toBeNull();
});
