import { afterEach, describe, expect, it, vi } from "vitest";

import { watchKeyboard } from "./system";

/** A visual viewport the test resizes, as Android's keyboard does when it opens and closes. */
function fakeViewport(height: number) {
  const target = new EventTarget();
  const viewport = Object.assign(target, { height, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  return (next: number) => {
    viewport.height = next;
    target.dispatchEvent(new Event("resize"));
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the phone's keyboard", () => {
  it("gives the page the height the keyboard covers while it is open", () => {
    const root = document.documentElement;
    const resize = fakeViewport(window.innerHeight);
    const stop = watchKeyboard();
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    expect(root.hasAttribute("data-keyboard")).toBe(false);

    resize(window.innerHeight - 349);
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("349px");
    expect(root.hasAttribute("data-keyboard")).toBe(true);

    // A few pixels of rounding are not a keyboard.
    resize(window.innerHeight - 3);
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    expect(root.hasAttribute("data-keyboard")).toBe(false);

    resize(window.innerHeight - 300);
    stop();
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("");
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });
});
