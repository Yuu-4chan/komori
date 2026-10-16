import { describe, expect, it } from "vitest";
import { applyBookImageLayout, fitBookImagePage } from "./bookImageLayout";

function page(html: string) {
  const document = window.document.implementation.createHTMLDocument();
  document.body.innerHTML = html;
  return document;
}

describe("publisher book images", () => {
  it("sizes explicit characters in em without guessing from illustration dimensions", () => {
    // Sanitized shape of the real gaiji regression: an unstyled 128px image in prose.
    const doc = page(
      '<p>字<img id="gaiji" class="gaiji" src="glyph.png" width="128" height="128">文' +
        '<span class="gaiji-line"><img id="wrapped" style="width: 128px !important; height: 128px !important"></span>' +
        '<ruby><img id="ruby"><rt>よみ</rt></ruby><img id="art" width="128" height="128"></p>' +
        '<p><img id="alone" class="glyph"></p><p><img id="plate" width="800"></p>',
    );
    const text = doc.body.textContent;
    const source = doc.querySelector("#gaiji")!.getAttribute("src");
    applyBookImageLayout(doc);
    expect([...doc.querySelectorAll("[data-komori-text-image]")].map((e) => e.id)).toEqual([
      "gaiji",
      "wrapped",
      "ruby",
      "alone",
    ]);
    for (const image of doc.querySelectorAll<HTMLElement>("[data-komori-text-image]")) {
      expect(image.style.width).toBe("1em");
      expect(image.style.height).toBe("1em");
      expect(image.style.getPropertyPriority("width")).toBe("important");
      expect(image.style.margin).toBe("0px");
    }
    expect(doc.querySelector("#art")!.hasAttribute("style")).toBe(false);
    expect(doc.querySelector("#plate")!.getAttribute("width")).toBe("800");
    expect(doc.querySelector("#alone")!.closest("[data-komori-image-spacing]")).toBeNull();
    expect(doc.body.textContent).toBe(text);
    expect(doc.querySelector("#gaiji")!.getAttribute("src")).toBe(source);
    applyBookImageLayout(doc);
    const serialized = new XMLSerializer().serializeToString(doc);
    expect(doc.querySelectorAll("style[data-komori-book-images]")).toHaveLength(1);
    expect(serialized).toContain("data-komori-text-image");
  });

  it.each(["horizontal-tb", "vertical-rl"])(
    "uses one logical gap between image lines and following text in %s",
    (mode) => {
      const doc = page(
        '<div id="wrap"><p><span><img id="a"></span></p></div><p id="b"><img></p>' +
          '<p id="pair"><img id="first"><img id="last"></p><p id="text">Body</p>',
      );
      doc.documentElement.style.writingMode = mode;
      applyBookImageLayout(doc);
      expect([...doc.querySelectorAll("[data-komori-image-spacing]")].map((e) => e.id)).toEqual([
        "wrap",
        "b",
        "pair",
      ]);
      expect([...doc.querySelectorAll("[data-komori-image-gap]")].map((e) => e.id)).toEqual([
        "first",
      ]);
      const css = doc.querySelector("style[data-komori-book-images]")!.textContent!;
      expect(css).toContain("padding-block: 0 1.5em !important");
      expect(css).toContain("margin-block-end: 1.5em !important");
      expect(css).toContain("line-height: 0 !important");
      expect(doc.querySelector("#text")!.hasAttribute("data-komori-image-spacing")).toBe(false);
    },
  );

  it("fits portrait and landscape SVG boxes to the area with their actual proportions", () => {
    for (const [box, expectedWidth, expectedHeight] of [
      ["0 0 600 900", 400, 600],
      ["0 0 900 600", 800, (800 * 2) / 3],
    ] as const) {
      const doc = page(
        `<div><svg width="100%" height="100%" viewBox="${box}"><image href="cover.png"/></svg></div>`,
      );
      doc.documentElement.style.fontSize = "20px";
      applyBookImageLayout(doc);
      fitBookImagePage(doc, 800, 630);
      const css = doc.querySelector("style[data-komori-page-image-fit]")!.textContent!;
      expect(css).toContain(
        `width: ${expectedWidth}px !important; height: ${expectedHeight}px !important`,
      );
      expect(doc.querySelector("svg")!.getAttribute("viewBox")).toBe(box);
      fitBookImagePage(doc, 600, 430);
      expect(doc.querySelectorAll("style[data-komori-page-image-fit]")).toHaveLength(1);
      fitBookImagePage(doc);
      expect(doc.querySelector("style[data-komori-page-image-fit]")).toBeNull();
    }
  });

  it("keeps raster proportions, refuses invalid SVG ratios and leaves mixed pages alone", () => {
    for (const html of [
      '<p><img width="900" height="600"></p>',
      '<svg viewBox="0 0 0 1"></svg>',
      '<svg viewBox="0 0 NaN 1"></svg>',
    ]) {
      const doc = page(html);
      applyBookImageLayout(doc);
      fitBookImagePage(doc, 700, 600);
      expect(doc.querySelector("style[data-komori-page-image-fit]")!.textContent).toContain(
        "width: auto !important; height: auto !important",
      );
      expect(doc.querySelector("style[data-komori-page-image-fit]")!.textContent).not.toContain(
        "NaNpx",
      );
    }
    const mixed = page("<p>Caption</p><img>");
    applyBookImageLayout(mixed);
    fitBookImagePage(mixed, 700, 600);
    expect(mixed.querySelector("style[data-komori-page-image-fit]")).toBeNull();
  });

  it.each(["horizontal-tb", "vertical-rl"])(
    "centers an image-only paginated section within its page in %s",
    (writingMode) => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const doc = frame.contentDocument!;
      doc.body.innerHTML = '<div><p><svg viewBox="0 0 600 900"></svg></p></div>';
      doc.body.style.padding = "60px 40px";
      doc.documentElement.style.writingMode = writingMode;
      applyBookImageLayout(doc);
      const markup = doc.body.innerHTML;
      fitBookImagePage(doc, 1440, 788, true);
      const css = doc.querySelector("style[data-komori-page-image-fit]")!.textContent!;
      expect(css).toContain("align-items: center !important; justify-content: center !important");
      expect(css).toContain(
        `width: ${writingMode === "vertical-rl" ? 1440 : 1520}px !important; height: 788px !important`,
      );
      expect(css).toContain("max-height: 668px !important");
      expect(css).toContain("padding: 0 !important; line-height: 0 !important");
      expect(css).toContain("[data-komori-image-spacing] { padding-block: 0 !important; }");
      expect(css).toContain("[data-komori-page-image] { margin: 0 !important; }");
      expect(doc.body.innerHTML).toBe(markup);
      fitBookImagePage(doc, 700, 600);
      expect(doc.querySelector("style[data-komori-page-image-fit]")!.textContent).not.toContain(
        "display: flex",
      );
      frame.remove();
    },
  );

  it("separates an unwrapped image from its caption while keeping running illustrations inline", () => {
    const doc = page('<div><img id="lone"><p>Caption</p></div><p>Text <img id="inline"> text</p>');
    applyBookImageLayout(doc);
    expect(doc.querySelector("#lone")!.hasAttribute("data-komori-image-line")).toBe(true);
    expect(doc.querySelector("#lone")!.hasAttribute("data-komori-image-gap")).toBe(true);
    expect(doc.querySelector("#inline")!.hasAttribute("data-komori-image-line")).toBe(false);
  });
});
