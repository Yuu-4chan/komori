import { describe, expect, it } from "vitest";
import {
  dataAttributeName,
  externalUrl,
  glossaryData,
  glossaryStyle,
  internalQuery,
} from "./glossaryStyle";
import { furiganaSegments } from "./furigana";

describe("imported glossary styles", () => {
  it.each(["__proto__", "hasOwnProperty", "constructor", "toString"])(
    "ignores the JSON-owned inherited allowlist key %s while keeping supported styles",
    (property) => {
      const imported = JSON.parse(`{"${property}":"x","color":"red","marginRight":0.25}`);
      expect(glossaryStyle(imported)).toEqual({ color: "red", marginRight: "0.25em" });
    },
  );

  it("keeps the layout and text styles dictionaries use and drops everything else", () => {
    expect(
      glossaryStyle({
        fontWeight: "bold",
        fontSize: "0.85em",
        verticalAlign: "text-bottom",
        marginBottom: "-0.4em",
        marginRight: 0.25,
        marginLeft: "0.5",
        padding: "0.1em 0.25em 0em 0.2em",
        borderStyle: "none none none solid",
        borderWidth: "0.03em",
        borderRadius: "0.18em",
        listStyleType: "'◆'",
        color: "red",
        backgroundColor: "color-mix(in srgb, lime, var(--text-color, var(--fg, #333)))",
        textAlign: "center",
        whiteSpace: "nowrap",
        cursor: "pointer",
        position: "fixed",
        display: "none",
      }),
    ).toEqual({
      fontWeight: "bold",
      fontSize: "0.85em",
      verticalAlign: "text-bottom",
      marginBottom: "-0.4em",
      marginRight: "0.25em",
      marginLeft: "0.5em",
      padding: "0.1em 0.25em 0em 0.2em",
      borderStyle: "none none none solid",
      borderWidth: "0.03em",
      borderRadius: "0.18em",
      listStyleType: "'◆'",
      color: "red",
      backgroundColor: "color-mix(in srgb, lime, var(--text-color, var(--fg, #333)))",
      textAlign: "center",
      whiteSpace: "nowrap",
    });
    for (const [property, value] of [
      ["backgroundColor", "url(https://example.com/x.png)"],
      ["color", "red; display: none"],
      ["color", "attr(title)"],
      ["fontSize", "40em"],
      ["padding", "-1em"],
      ["margin", "9999px"],
      ["listStyleType", "'a';x"],
    ])
      expect(glossaryStyle({ [property]: value })).toBeUndefined();
  });

  it("keeps short data values under attribute names that browsers and Lapis use", () => {
    expect(dataAttributeName("content")).toBe("data-sc-content");
    expect(dataAttributeName("senseNumber")).toBe("data-sc-sense-number");
    expect(dataAttributeName("用例囲み-g")).toBe("data-sc用例囲み-g");
    expect(dataAttributeName('x"y')).toBeNull();
    expect(glossaryData({ content: "glossary", count: 2, nested: { a: 1 }, "a b": "x" })).toEqual({
      content: "glossary",
      count: "2",
    });
  });

  it("separates dictionary searches from web links", () => {
    expect(internalQuery("?query=%E8%A8%98%E5%8F%B7&wildcards=off")).toBe("記号");
    expect(internalQuery("?query=記号")).toBe("記号");
    expect(internalQuery("https://example.com/?query=x")).toBeNull();
    expect(externalUrl("https://dic.pixiv.net/a/ ルキア(QMA)")).toBe(
      "https://dic.pixiv.net/a/%20%E3%83%AB%E3%82%AD%E3%82%A2(QMA)",
    );
    expect(externalUrl("https://www.google.com/search?q=誰が")).toMatch(
      /^https:\/\/www\.google\.com\/search\?q=/,
    );
    for (const href of [
      "javascript:alert(1)",
      "file:///C:/private",
      "https://user:pass@example.com",
      'https://example.com/"x',
      "?query=x",
    ])
      expect(externalUrl(href)).toBeNull();
  });
});

describe("headword furigana", () => {
  it("aligns each kanji run with its part of the reading", () => {
    expect(furiganaSegments("読み込む", "よみこむ")).toEqual([
      { text: "読", reading: "よ" },
      { text: "み" },
      { text: "込", reading: "こ" },
      { text: "む" },
    ]);
    expect(furiganaSegments("誰が", "だれが")).toEqual([
      { text: "誰", reading: "だれ" },
      { text: "が" },
    ]);
    expect(furiganaSegments("大人しい", "おとなしい")).toEqual([
      { text: "大人", reading: "おとな" },
      { text: "しい" },
    ]);
    expect(furiganaSegments("お茶", "おちゃ")).toEqual([
      { text: "お" },
      { text: "茶", reading: "ちゃ" },
    ]);
    expect(furiganaSegments("コーヒー", "こーひー")).toEqual([{ text: "コーヒー" }]);
    // A reading that cannot be aligned stays over the whole headword.
    expect(furiganaSegments("可笑しい", "おかしかった")).toEqual([
      { text: "可笑しい", reading: "おかしかった" },
    ]);
  });
});
