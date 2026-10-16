import { afterEach, describe, expect, it, vi } from "vitest";
import { applyParagraphLayout } from "./paragraphLayout";

describe("paragraph composition", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves XHTML text/ruby, excludes headings/image lines and restores independent inline choices", () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>@layer publisher { #prose { text-align: right !important; } }</style></head><body>' +
        '<p id="prose" style="text-align: right !important; text-align-last: center; text-wrap: nowrap !important">本文<ruby>漢<rt>かん</rt></ruby> Latin prose.</p>' +
        '<p data-komori-heading="" style="text-align: center !important">Chapter</p>' +
        '<div data-komori-heading=""><p>Nested title</p></div>' +
        '<p data-komori-image-block="" style="text-align: center"><img src="art.png"/></p>' +
        "</body></html>",
      "application/xhtml+xml",
    );
    const prose = doc.getElementById("prose")!;
    const original = prose.getAttribute("style");
    const alignPriority = prose.style.getPropertyPriority("text-align");
    const wrapPriority = prose.style.getPropertyPriority("text-wrap");
    const setProperty = vi.spyOn(prose.style, "setProperty");
    const text = doc.querySelector("body")!.textContent;
    applyParagraphLayout(doc, false, false);
    expect(prose.getAttribute("style")).toBe(original);
    expect(doc.querySelector("style[data-komori-paragraph-layout]")).toBeNull();
    for (let repeat = 0; repeat < 2; repeat++) applyParagraphLayout(doc, true, true);
    const styles = doc.querySelectorAll("style[data-komori-paragraph-layout]");
    expect(styles).toHaveLength(1);
    expect(styles[0].namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(doc.querySelector("head")!.firstElementChild).toBe(styles[0]);
    expect(styles[0].textContent).toContain("@layer komori-paragraphs");
    expect(styles[0].textContent).toContain(":not([data-komori-heading] *)");
    expect(styles[0].textContent).toContain(":not([data-komori-image-block] *)");
    expect(prose.style.getPropertyValue("text-align")).toBe("justify");
    expect(setProperty).toHaveBeenCalledWith("text-align", "justify", "important");
    expect(prose.style.getPropertyValue("text-align-last")).toBe("auto");
    expect(prose.style.getPropertyValue("text-wrap")).toBe("pretty");
    expect(doc.querySelector("[data-komori-heading]")!.getAttribute("style")).toBe(
      "text-align: center !important",
    );
    expect(doc.querySelector("[data-komori-image-block]")!.getAttribute("style")).toBe(
      "text-align: center",
    );
    expect(doc.querySelector("body")!.textContent).toBe(text);
    expect(doc.querySelector("rt")!.textContent).toBe("かん");
    const serialized = new XMLSerializer().serializeToString(doc);
    const displayed = new DOMParser().parseFromString(serialized, "application/xhtml+xml");
    applyParagraphLayout(displayed, false, true);
    const restored = displayed.getElementById("prose")!;
    expect(restored.style.getPropertyValue("text-align")).toBe("right");
    expect(restored.style.getPropertyPriority("text-align")).toBe(alignPriority);
    expect(restored.style.getPropertyValue("text-align-last")).toBe("center");
    expect(restored.style.getPropertyValue("text-wrap")).toBe("pretty");
    applyParagraphLayout(displayed, true, false);
    expect(restored.style.getPropertyValue("text-align")).toBe("justify");
    expect(restored.style.getPropertyValue("text-wrap")).toBe("nowrap");
    expect(restored.style.getPropertyPriority("text-wrap")).toBe(wrapPriority);
    applyParagraphLayout(displayed, false, false);
    expect(displayed.querySelector("style[data-komori-paragraph-layout]")).toBeNull();
    expect(restored.hasAttribute("data-komori-own-paragraph-align")).toBe(false);
    expect(restored.hasAttribute("data-komori-own-paragraph-wrap")).toBe(false);
  });

  it("retains publisher wrapping when pretty is unsupported, independently of justification", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<p style="text-wrap: nowrap !important">Text</p>';
    applyParagraphLayout(doc, true, true);
    expect(doc.querySelector("p")!.style.getPropertyValue("text-wrap")).toBe("nowrap");
    expect(doc.querySelector("style[data-komori-paragraph-layout]")!.textContent).not.toContain(
      "text-wrap:",
    );
    expect(doc.querySelector("style[data-komori-paragraph-layout]")!.textContent).toContain(
      "text-align: justify",
    );
  });
});
