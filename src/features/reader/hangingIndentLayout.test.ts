import { describe, expect, it } from "vitest";
import { applyHangingIndentLayout } from "./hangingIndentLayout";

describe("authored hanging-indent direction", () => {
  it.each([
    ["vrtl", "horizontal", "top"],
    ["hltr", "vertical", "left"],
  ] as const)(
    "moves %s indentation onto the %s inline axis and restores it",
    (authored, mode, side) => {
      const doc = new DOMParser().parseFromString(
        `<html xmlns="http://www.w3.org/1999/xhtml" class="${authored}"><head/><body>` +
          '<p id="chapter">Chapter</p><p><br/></p><p><br/></p><p><br/></p>' +
          '<div class="h-indent-5em">\n<p>　　　　　１</p>\n</div><p><br/></p><p>Prose.</p>' +
          '<div class="h-indent-2"><p>Another hanging block.</p></div>' +
          '<div class="h-indent-5em"><p>　　　　　Prose, not a number.</p></div>' +
          '<div class="h-indent-999em">Out of bounds</div></body></html>',
        "application/xhtml+xml",
      );
      const body = new XMLSerializer().serializeToString(doc.body);
      for (let count = 0; count < 2; count++) applyHangingIndentLayout(doc, mode);
      const styles = doc.querySelectorAll("style[data-komori-hanging-indent-layout]");
      expect(styles).toHaveLength(1);
      expect(styles[0].textContent).toContain(
        `padding-${side}: 0 !important; padding-inline-start: 5em !important`,
      );
      expect(styles[0].textContent).toContain("padding-inline-start: 2em");
      expect(styles[0].textContent).toContain(
        ":root body [data-komori-numbered-subchapter] { padding-inline-start: 0 !important; }",
      );
      expect(doc.querySelectorAll("[data-komori-numbered-subchapter]")).toHaveLength(1);
      expect(doc.querySelector("[data-komori-numbered-subchapter] p")?.textContent).toBe(
        "　　　　　１",
      );
      expect(styles[0].textContent).not.toContain("h-indent-999em");
      expect(styles[0].textContent).not.toContain("margin");
      const restoredBody = doc.body.cloneNode(true) as HTMLElement;
      restoredBody
        .querySelector("[data-komori-numbered-subchapter]")
        ?.removeAttribute("data-komori-numbered-subchapter");
      expect(new XMLSerializer().serializeToString(restoredBody)).toBe(body);
      const serialized = new XMLSerializer().serializeToString(doc);
      expect(serialized).not.toContain("&gt;");
      const cached = new DOMParser().parseFromString(
        new XMLSerializer().serializeToString(doc),
        "application/xhtml+xml",
      );
      applyHangingIndentLayout(cached, authored === "vrtl" ? "vertical" : "horizontal");
      expect(cached.querySelector("style[data-komori-hanging-indent-layout]")).toBeNull();
      expect(cached.querySelector("[data-komori-numbered-subchapter]")).toBeNull();
      applyHangingIndentLayout(doc);
      expect(doc.querySelector("style[data-komori-hanging-indent-layout]")).toBeNull();
    },
  );

  it("does not alter an unrelated class convention", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<div class="h-indent-5em">Text</div>';
    applyHangingIndentLayout(doc, "horizontal");
    expect(doc.querySelector("style[data-komori-hanging-indent-layout]")).toBeNull();
  });
});
