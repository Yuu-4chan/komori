import { describe, expect, it, vi } from "vitest";
import { ImageBlurSession } from "./imageBlur";

function page(html: string) {
  const document = window.document.implementation.createHTMLDocument();
  document.body.innerHTML = html;
  return document;
}
const blurred = (doc: Document) =>
  [...doc.querySelectorAll("[data-komori-image-blurred]")].map((e) => e.id);

describe("image blur session", () => {
  it("leaves pointer reveals borderless while keeping an inset keyboard focus indicator", () => {
    const doc = page('<img width="300" height="500">');
    const session = new ImageBlurSession(
      () => session.apply(doc, 0, true, "all"),
      () => true,
    );
    session.apply(doc, 0, true, "all");
    session.watchDocuments([doc]);
    const image = doc.querySelector("img")!;
    image.click();
    expect(image.hasAttribute("data-komori-image-blurred")).toBe(false);
    const style = doc.querySelector("style[data-komori-blur-image]")!.textContent!;
    expect(style).toContain("outline: none !important");
    expect(style).toContain(
      ":focus-visible { outline: 2px solid Highlight !important; outline-offset: -2px",
    );
    expect(style).not.toContain("border:");
    expect(image.getAttribute("width")).toBe("300");
    session.dispose();
  });
  it("overrides and restores an inline important publisher filter without changing image size", () => {
    const doc = page('<img style="filter: grayscale(1) !important; width: 80px" alt="Art">');
    const image = doc.querySelector("img")!;
    // JSDOM drops the priority of filter; Chromium keeps this authored !important.
    vi.spyOn(image.style, "getPropertyPriority").mockReturnValue("important");
    const session = new ImageBlurSession(
      () => session.apply(doc, 0, true, "all"),
      () => true,
    );
    session.apply(doc, 0, true, "all");
    session.watchDocuments([doc]);
    expect(image.style.filter).toBe("blur(20px)");
    image.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(image.style.filter).toBe("grayscale(1)");
    session.apply(doc, 0, false, "all");
    expect(image.style.filter).toBe("grayscale(1)");
    expect(image.style.getPropertyPriority("filter")).toBe("important");
    expect(image.style.width).toBe("80px");
    expect(image.hasAttribute("data-komori-image-filter")).toBe(false);
    session.dispose();
  });

  it("keeps the entire contents container clear, including same-section and nested SVG boundaries", () => {
    const doc = page(
      '<img id="before"><nav id="toc"><img id="inside"><svg id="toc-svg"><svg/></svg></nav><img id="after"><svg id="art"><svg/></svg><video id="video"/>',
    );
    const session = new ImageBlurSession(vi.fn(), () => true);
    session.apply(doc, 1, true, "after-toc", { spineIndex: 1, fragment: "toc" });
    expect(blurred(doc)).toEqual(["after", "art", "video"]);
    expect(doc.querySelector("#art svg")?.hasAttribute("role")).toBe(false);
    session.apply(doc, 0, true, "after-toc", { spineIndex: 1 });
    expect(blurred(doc)).toEqual([]);
    session.apply(doc, 2, true, "after-toc", { spineIndex: 1 });
    expect(blurred(doc)).toHaveLength(6);
  });

  it("falls back to all without a contents page; missing fragments keep the entire contents section clear", () => {
    const doc = page('<img id="art">');
    const session = new ImageBlurSession(vi.fn(), () => true);
    session.apply(doc, 1, true, "after-toc");
    expect(blurred(doc)).toEqual(["art"]);
    session.apply(doc, 1, true, "after-toc", { spineIndex: 1, fragment: "missing" });
    expect(blurred(doc)).toEqual([]);
  });

  it("reveals one occurrence by pointer and keyboard, preserving focus, text and attributes through serialization", () => {
    const doc = page(
      '<p>Text</p><a href="#chapter"><img id="one" src="same.png" alt="Drawing" title="Original" tabindex="-1"></a><img id="two" src="same.png">',
    );
    let displayed = doc;
    let enabled = true;
    let mode: "all" | "after-toc" = "all";
    const apply = () => session.apply(displayed, 2, enabled, mode, { spineIndex: 1 });
    const refresh = vi.fn(apply);
    const session = new ImageBlurSession(refresh, () => true);
    apply();
    session.watchDocuments([doc]);
    const one = doc.querySelector("#one")!;
    const lookup = vi.fn();
    doc.addEventListener("click", lookup);
    one.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(blurred(doc)).toEqual(["two"]);
    expect(one?.getAttribute("aria-pressed")).toBe("true");
    expect(lookup).not.toHaveBeenCalled();
    one.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    one.dispatchEvent(new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true }));
    one.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    expect(blurred(doc)).toEqual(["one", "two"]);
    expect(refresh).toHaveBeenCalledTimes(2);
    one.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // A fresh iframe, as after navigation or a writing/view change, carries the same occurrence.
    displayed = page(doc.body.innerHTML);
    apply();
    session.watchDocuments([displayed]);
    expect(blurred(displayed)).toEqual(["two"]);
    expect(displayed.body.textContent).toBe("Text");
    enabled = false;
    apply();
    expect(displayed.querySelector("#one")?.getAttribute("title")).toBe("Original");
    expect(displayed.querySelector("#one")?.getAttribute("tabindex")).toBe("-1");
    expect(displayed.querySelector("#one")?.hasAttribute("role")).toBe(false);
    enabled = true;
    mode = "after-toc";
    apply();
    expect(blurred(displayed)).toEqual(["two"]);
    // The discarded document and disposed session no longer accept activation.
    one.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(refresh).toHaveBeenCalledTimes(3);
    session.dispose();
    displayed.querySelector("#two")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(refresh).toHaveBeenCalledTimes(3);
    const next = new ImageBlurSession(vi.fn(), () => true);
    next.apply(displayed, 2, true, "all");
    expect(blurred(displayed)).toEqual(["one", "two"]);
  });

  it("ignores secondary/modified input, repeat and composition, and waits during navigation", () => {
    const doc = page('<img id="one">');
    let ready = false;
    const refresh = vi.fn();
    const session = new ImageBlurSession(refresh, () => ready);
    session.apply(doc, 0, true, "all");
    session.watchDocuments([doc]);
    const image = doc.querySelector("img")!;
    image.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ready = true;
    image.dispatchEvent(new MouseEvent("click", { button: 2, bubbles: true }));
    image.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    image.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    image.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(refresh).not.toHaveBeenCalled();
    image.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
