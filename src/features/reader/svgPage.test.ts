import { describe, expect, it } from "vitest";
import { readableText } from "./readingMeasure";
import { fillFixedSvgPage, isSvgPage, svgPageDocument } from "./svgPage";

const svg = (markup: string) => new DOMParser().parseFromString(markup, "image/svg+xml");

const drawn =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<?xml-stylesheet href="../Style/page.css" type="text/css"?>\n' +
  '<?xml-stylesheet href="alternate.css" type="text/css" alternate="yes" title="Other"?>\n' +
  '<?xml-stylesheet href="page.xsl" type="text/xsl"?>\n' +
  '<?xml-stylesheet href="print.css?a=1&amp;b=2" media="print"?>\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="736px" height="1162px" viewBox="0 0 368 581">' +
  "<title> Page one </title><desc>The book's title page.</desc><metadata>Made by hand</metadata>" +
  "<style>.ink { fill: #221f1f; }</style>" +
  '<g><text class="ink" x="10" y="20">Under the wind</text><title>A tooltip</title></g>' +
  '<image width="368" height="581" xlink:href="../Image/art.jpg"/>' +
  '<style type="text/x-other">ignored</style><script>alert(1)</script></svg>';

describe("SVG spine pages", () => {
  it("holds the drawing alone in an XHTML body and its title, size and styles in the head", () => {
    const page = svgPageDocument(svg(drawn));
    expect(isSvgPage(page)).toBe(true);
    expect(page.documentElement.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect([...page.body!.children].map((child) => child.localName)).toEqual(["svg"]);
    const head = page.head!;
    expect(head.querySelector("title")?.textContent).toBe("Page one");
    expect(head.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=368, height=581",
    );
    // Stylesheets apply in document order: the instructions' before the drawing's own.
    expect(
      [...head.querySelectorAll("link, style")].map((element) =>
        element.localName === "link"
          ? `${element.getAttribute("href")} ${element.getAttribute("media") ?? ""}`.trim()
          : element.textContent,
      ),
    ).toEqual(["../Style/page.css", "print.css?a=1&b=2 print", ".ink { fill: #221f1f; }"]);
    for (const link of head.querySelectorAll("link")) {
      expect(link.getAttribute("rel")).toBe("stylesheet");
      expect(link.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    }
    // Only drawn text is page text.
    expect(readableText(page)).toBe("Under the wind");
    expect(page.body!.querySelectorAll("title, desc, metadata, style, script")).toHaveLength(0);
    expect(
      page.querySelector("image")?.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    ).toBe("../Image/art.jpg");
  });

  it("serializes to an XHTML page whose drawing stays SVG, as EPUB.js shows it", () => {
    const output = new XMLSerializer().serializeToString(
      svgPageDocument(svg(drawn)).documentElement,
    );
    expect(output).toContain('xlink:href="../Image/art.jpg"');
    const shown = new DOMParser().parseFromString(output, "application/xhtml+xml");
    expect(shown.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(shown.body?.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(shown.querySelector("text")?.textContent).toBe("Under the wind");
  });

  it("takes the viewport from the viewBox, else a pixel size, else none", () => {
    const viewport = (attributes: string) =>
      svgPageDocument(svg(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}/>`))
        .querySelector('meta[name="viewport"]')
        ?.getAttribute("content");
    expect(viewport('width="100%" height="100%" viewBox="0,0,1100,1700"')).toBe(
      "width=1100, height=1700",
    );
    expect(viewport('width="600" height="900px"')).toBe("width=600, height=900");
    expect(viewport('width="100%" height="100%"')).toBeUndefined();
    expect(viewport('viewBox="0 0 0 10" width="5em" height="9"')).toBeUndefined();
  });

  it("fills a fixed-layout page once, beneath the book's own styles, and leaves other pages", () => {
    const page = svgPageDocument(svg(drawn));
    fillFixedSvgPage(page);
    fillFixedSvgPage(page);
    const fills = page.querySelectorAll("style[data-komori-svg-page-fill]");
    expect(fills).toHaveLength(1);
    expect(page.head!.firstElementChild).toBe(fills[0]);
    expect(fills[0].textContent).toContain("@layer komori-svg-page");
    expect(fills[0].textContent).toContain(":root body > svg { display: block; width: 100%;");
    const chapter = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>',
      "application/xhtml+xml",
    );
    fillFixedSvgPage(chapter);
    expect(isSvgPage(chapter)).toBe(false);
    expect(chapter.querySelector("style")).toBeNull();
  });
});
