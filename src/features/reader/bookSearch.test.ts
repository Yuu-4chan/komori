import { describe, expect, it } from "vitest";
import { literalMatches, matchExcerpt, searchText } from "./bookSearch";

describe("readable book search", () => {
  it("joins inline and ruby base text, separates blocks/breaks, and excludes annotations and internals", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<style>fake styling</style><script>fake script</script><p id="a">𠮷<ruby>読<rt>よ</rt><rp>(</rp></ruby><b>む</b><br>次</p><p id="b">Latin [a.b]</p><div hidden>hidden text</div>';
    const map = searchText(doc);
    expect(map.text).toBe("𠮷読む\n次\nLatin [a.b]");
    const offset = [...literalMatches(map.text, "読む")][0].index;
    const point = map.point(offset)!;
    expect(point.startContainer.textContent).toBe("読");
    expect(point.startOffset).toBe(0);
    expect(map.anchorOffset("b")).toBe(map.text.indexOf("Latin"));
    expect([...literalMatches(map.text, "む次")]).toHaveLength(0);
    expect([...literalMatches(map.text, "LATIN")]).toHaveLength(1);
    expect([...literalMatches(map.text, "[a.b]")]).toHaveLength(1);
  });

  it("bounds excerpts without splitting supplementary characters or interpreting markup", () => {
    const text = "𠮷".repeat(100) + "<literal>" + "𠮷".repeat(100);
    const excerpt = matchExcerpt(text, 200, 9);
    expect(excerpt.match).toBe("<literal>");
    expect([...excerpt.before]).toHaveLength(41);
    expect([...excerpt.after]).toHaveLength(41);
    expect(excerpt.before).not.toContain("�");
    const long = matchExcerpt("a".repeat(256), 0, 256);
    expect([...long.match]).toHaveLength(77);
  });
});
