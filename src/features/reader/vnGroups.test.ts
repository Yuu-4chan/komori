import { describe, expect, it } from "vitest";
import { vnBlocks, vnGroupStarts, VN_BLOCK_LIMIT } from "./vnGroups";

function groups(html: string, count = 1, ids: string[] = []) {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = html;
  const blocks = vnBlocks(doc);
  return {
    doc,
    blocks,
    starts: vnGroupStarts(
      blocks,
      count,
      ids.map((id) => doc.getElementById(id)!),
    ),
  };
}

describe("VN paragraph grouping", () => {
  it("keeps headings, ruby and inline glyphs with their text and shows every image alone", () => {
    const html =
      '<h2>章</h2><p><ruby>本<rt>ほん</rt></ruby><img class="gaiji"/>。</p><p>Second</p><figure><img/></figure><p>Third</p><p><img/></p>';
    const { doc, blocks, starts } = groups(html, 2);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "media",
      "paragraph",
      "media",
    ]);
    expect(starts).toEqual([0, 3, 4, 5]);
    expect(doc.body.innerHTML).toBe(html.replaceAll("/>", ">"));
  });

  it("restarts at headings and authored anchors without splitting lists or tables", () => {
    const { blocks, starts } = groups(
      '<p>One</p><h2>Title</h2><p>Two</p><div><p id="chapter">Three</p><p>Four</p></div><ul><li>Five</li><li>Six</li></ul><table><tr><td>Seven</td></tr></table>',
      20,
      ["chapter"],
    );
    expect(starts).toEqual([0, 1, 3]);
    expect(blocks.map((block) => block.element.localName)).toEqual([
      "p",
      "h2",
      "p",
      "p",
      "p",
      "li",
      "li",
      "table",
    ]);
  });

  it("keeps a captioned figure whole and apart from the text around it", () => {
    const { blocks, starts } = groups(
      "<p>One</p><figure><img/><figcaption><p>Caption</p></figcaption></figure><p>Two</p>",
      20,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "media", "paragraph"]);
    expect(starts).toEqual([0, 1, 2]);
  });

  it("keeps image-only sections and unstructured text whole and bounds derived blocks", () => {
    expect(groups("<div><img/></div>").starts).toEqual([0]);
    expect(groups("Bare text<p>More</p>").blocks).toEqual([]);
    expect(groups("<p>text</p>".repeat(VN_BLOCK_LIMIT + 1)).blocks).toEqual([]);
  });
});
