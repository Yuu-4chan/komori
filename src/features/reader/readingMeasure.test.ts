import { describe, expect, it } from "vitest";

import {
  countUnits,
  progressUnit,
  readableText,
  readableUnits,
  readableUnitsBefore,
  scriptCounts,
} from "./readingMeasure";

function body(html: string): Document {
  const document = window.document.implementation.createHTMLDocument();
  document.body.innerHTML = html;
  return document;
}

describe("reading measure", () => {
  it("reads section text without ruby annotations", () => {
    const document = body(
      "<p>　<ruby>凄<rp>(</rp><rt>すご</rt><rp>)</rp></ruby>いことに<ruby><rb>ＧＭ</rb><rt>ゲームマスター</rt></ruby>が。</p>",
    );
    expect(readableText(document)).toBe("　凄いことにＧＭが。");
    expect(countUnits(readableText(document), "characters")).toBe(8);
  });

  it("reads only the text before a point, text or element", () => {
    const document = body(
      '<p id="one">一二<ruby>三<rt>さん</rt></ruby>四</p><h2 id="two">五六</h2><p>七</p>',
    );
    const four = document.getElementById("one")!.lastChild!;
    expect(readableText(document, { node: four, offset: 1 })).toBe("一二三四");
    expect(readableText(document, { node: four, offset: 0 })).toBe("一二三");
    expect(readableText(document, { node: document.getElementById("two")!, offset: 0 })).toBe(
      "一二三四",
    );
    expect(readableText(document, { node: document.body, offset: 0 })).toBe("");
    // A point inside furigana counts the base text before it only.
    const reading = document.querySelector("rt")!.firstChild!;
    expect(readableText(document, { node: reading, offset: 1 })).toBe("一二三");
    expect(readableText(document, { node: document.body, offset: 3 })).toBe("一二三四五六七");
  });

  it("counts the units of and before a point as its readable text does, again once the text changes", async () => {
    const document = body(
      '<p id="one">一二<ruby>三<rt>さん</rt></ruby>四</p><h2 id="two">five six-seven</h2><p>八</p>',
    );
    const four = document.getElementById("one")!.lastChild!;
    const two = document.getElementById("two")!;
    const points = [
      { node: four, offset: 1 },
      { node: four, offset: 0 },
      { node: two, offset: 0 },
      { node: two.firstChild!, offset: 7 },
      { node: document.body, offset: 0 },
      { node: document.body, offset: 2 },
      { node: document.body, offset: 3 },
      { node: document.querySelector("rt")!.firstChild!, offset: 1 },
    ];
    const agrees = () => {
      for (const unit of ["characters", "words"] as const) {
        expect(readableUnits(document, unit)).toBe(countUnits(readableText(document), unit));
        for (const point of points)
          expect(readableUnitsBefore(document, point, unit)).toBe(
            countUnits(readableText(document, point), unit),
          );
      }
    };
    agrees();
    // Asked again, the same points count the same.
    agrees();
    expect(readableUnitsBefore(document, { node: two.firstChild!, offset: 7 }, "characters")).toBe(
      10,
    );
    // Text added before a point, at once or after the change is observed, counts.
    document.getElementById("one")!.prepend("零");
    agrees();
    (four as Text).data = "四四";
    await Promise.resolve();
    agrees();
    expect(readableUnitsBefore(document, { node: four, offset: 2 }, "characters")).toBe(6);
    // A point outside the body has nothing before it.
    expect(readableUnitsBefore(document, { node: document.head, offset: 0 }, "characters")).toBe(0);
  });

  it("counts letters and numbers as characters, never whitespace, punctuation, or symbols", () => {
    expect(countUnits("「本当に……？」　彼は 3 回、頷いた。", "characters")).toBe(10);
    expect(countUnits("ヘンダーソンスケール0.1", "characters")).toBe(12);
    // A supplementary-plane character counts once; Hangul syllables count.
    expect(countUnits("𠮷野家", "characters")).toBe(3);
    expect(countUnits("안녕하세요!", "characters")).toBe(5);
  });

  it("counts words with internal apostrophes and hyphens", () => {
    expect(countUnits("“Don’t,” said the well-known pharaoh — twice… 24 times!", "words")).toBe(8);
    expect(countUnits("naïve café, résumé", "words")).toBe(3);
    expect(countUnits(" — … ", "words")).toBe(0);
  });

  it("chooses characters for mostly Chinese, Japanese, or Korean books, otherwise words", () => {
    expect(progressUnit(scriptCounts("彼はＧＭとＰＬのサイコロを振った。"))).toBe("characters");
    expect(progressUnit(scriptCounts("그는 주사위를 굴렸다."))).toBe("characters");
    expect(progressUnit(scriptCounts("他掷了骰子。"))).toBe("characters");
    expect(progressUnit(scriptCounts("He rolled the dice. 骰子"))).toBe("words");
    expect(progressUnit(scriptCounts("Он бросил кости."))).toBe("words");
    expect(progressUnit(scriptCounts("1 2 3"))).toBe("words");
  });
});
