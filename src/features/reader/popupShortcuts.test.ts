import { afterEach, describe, expect, it, vi } from "vitest";
import { popupShortcut } from "./popupShortcuts";

afterEach(() => {
  document.body.innerHTML = "";
});
function popup() {
  const root = document.createElement("section");
  root.className = "reader-lookup";
  root.innerHTML =
    '<div class="reader-lookup__body" style="padding-top:4px"><div data-popup-expression data-active="true"><button data-anki-action="add">Add first</button></div><div data-popup-expression><button data-anki-action="add">Add second</button><button data-anki-action="browse">Browse second</button></div></div>';
  const body = root.firstElementChild as HTMLElement;
  body.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  root.querySelectorAll<HTMLElement>("[data-popup-expression]").forEach((entry, index) => {
    entry.getBoundingClientRect = () =>
      ({ top: 24 + index * 2500 - body.scrollTop, height: 2500 }) as DOMRect;
  });
  document.body.append(root);
  return root;
}
describe("topmost popup commands", () => {
  it("navigates without scrolling the book and sends both actions to the active child expression", () => {
    const parent = popup();
    const child = popup();
    const parentAdd = vi.fn();
    parent.querySelector("button")!.onclick = parentAdd;
    const add = vi.fn();
    const browse = vi.fn();
    const second = child.querySelectorAll<HTMLElement>("[data-popup-expression]")[1];
    second.querySelectorAll("button")[0].onclick = add;
    second.querySelectorAll("button")[1].onclick = browse;
    const wheel = new WheelEvent("wheel", { altKey: true, deltaY: 100, cancelable: true });
    expect(popupShortcut(wheel)).toBe(true);
    expect(wheel.defaultPrevented).toBe(true);
    expect(second.dataset.active).toBe("true");
    expect(child.querySelector(".reader-lookup__body")!.scrollTop).toBe(2500);
    popupShortcut(new KeyboardEvent("keydown", { altKey: true, key: "e", cancelable: true }));
    popupShortcut(new KeyboardEvent("keydown", { altKey: true, key: "b", cancelable: true }));
    expect(add).toHaveBeenCalledOnce();
    expect(browse).toHaveBeenCalledOnce();
    expect(parentAdd).not.toHaveBeenCalled();
    const up = new WheelEvent("wheel", { altKey: true, deltaY: -100, cancelable: true });
    expect(popupShortcut(up)).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(child.querySelector(".reader-lookup__body")!.scrollTop).toBe(0);
    expect(second.dataset.active).toBe("false");
    expect(parent.querySelector(".reader-lookup__body")!.scrollTop).toBe(0);
    popupShortcut(new WheelEvent("wheel", { altKey: true, deltaY: -100, cancelable: true }));
    expect(child.querySelector(".reader-lookup__body")!.scrollTop).toBe(0);
    child.remove();
    popupShortcut(new KeyboardEvent("keydown", { altKey: true, key: "b", cancelable: true }));
    expect(parentAdd).not.toHaveBeenCalled(); // Browser never falls back to creation.
  });
  it("keeps disabled, modified, composing, repeated and editable input safe", () => {
    const root = popup();
    const button = root.querySelector("button")!;
    button.disabled = true;
    button.onclick = vi.fn();
    expect(
      popupShortcut(new KeyboardEvent("keydown", { altKey: true, key: "e", cancelable: true })),
    ).toBe(true);
    expect(button.onclick).not.toHaveBeenCalled();
    for (const exclusion of [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
    ])
      expect(
        popupShortcut(new KeyboardEvent("keydown", { altKey: true, key: "e", ...exclusion })),
      ).toBe(false);
    expect(
      popupShortcut(new WheelEvent("wheel", { altKey: true, ctrlKey: true, deltaY: 100 })),
    ).toBe(false);
  });
});
