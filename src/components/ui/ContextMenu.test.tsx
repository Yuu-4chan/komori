import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
  it("takes Escape and the arrows before any other key handler", async () => {
    const user = userEvent.setup();
    // Registered first, as the Reader's own keys are.
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    const onClose = vi.fn();
    render(
      <ContextMenu
        label="Text"
        items={[
          { label: "Copy", onSelect: vi.fn() },
          { label: "Look up", onSelect: vi.fn() },
        ]}
        onClose={onClose}
        position={{ x: 10, y: 10 }}
      />,
    );
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Look up" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener("keydown", behind);
  });
});
