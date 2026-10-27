import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TermGroup, TermMatch } from "./dictionaryApi";
import { LookupEntry } from "./LookupEntry";

function group(expression: string, terms: TermMatch[]): TermGroup {
  return {
    expression,
    reading: expression,
    text: expression,
    deinflection: null,
    terms,
    frequencies: [],
    pitches: [],
  };
}

const good = group("本", [
  {
    dictionaryId: 1,
    dictionaryTitle: "Test dictionary",
    definitionTags: "n",
    rules: "",
    score: 0,
    sequence: 1,
    termTags: "",
    tags: [],
    glossary: ["book"],
  },
]);
// Imported data the entry cannot render: rendering it throws.
const bad = group("壊", null as unknown as TermMatch[]);

describe("LookupEntry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds card sources again only when the entry or its reading context changes", () => {
    let reads = 0;
    const counted = group("本", [
      {
        ...good.terms[0],
        glossary: new Proxy(["book"], {
          get(target, property, receiver) {
            if (property === "flatMap") reads += 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      },
    ]);
    const entry = (sentence: string) => (
      <LookupEntry
        canPlayAudio={false}
        group={counted}
        onSearchTerm={() => {}}
        readerContext={{ sentence, bookTitle: "Book" }}
        showDictionaryNames
        showFrequency
        showPitch
        showVoiceAction={false}
        start={null}
      />
    );
    const { rerender } = render(entry("本を読む。"));
    const first = reads;
    rerender(entry("本を読む。"));
    expect(reads).toBe(first);
    rerender(entry("本を買う。"));
    expect(reads).toBe(first + 1);
  });

  it("shows a one-line failure in place of an entry that cannot render, keeping the others", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const entries of [
      [bad, good],
      [good, bad],
    ]) {
      const { unmount } = render(
        <>
          {entries.map((entry) => (
            <LookupEntry
              canPlayAudio={false}
              group={entry}
              key={entry.expression}
              onSearchTerm={() => {}}
              showDictionaryNames
              showFrequency
              showPitch
              showVoiceAction={false}
              start={null}
            />
          ))}
        </>,
      );
      expect(screen.getByRole("article", { name: "本" })).toHaveTextContent("book");
      expect(screen.getByText("壊 could not be shown.")).toBeInTheDocument();
      unmount();
    }
  });

  it("shows four headword tags before +N more, so the definitions stay in view", () => {
    const names = ["n", "vs", "uk", "P", "news", "ichi", "spec"];
    const tagged = group("本", [{ ...good.terms[0], tags: names.map((name) => ({ name })) }]);
    render(
      <LookupEntry
        canPlayAudio={false}
        group={tagged}
        onSearchTerm={() => {}}
        showDictionaryNames
        showFrequency
        showPitch
        showVoiceAction={false}
        start={null}
      />,
    );
    const shown = () => names.filter((name) => screen.queryByText(name, { exact: true }));
    expect(shown()).toEqual(["n", "vs", "uk", "P"]);
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }));
    expect(shown()).toEqual(names);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(shown()).toEqual(["n", "vs", "uk", "P"]);
  });
});

describe("headword furigana", () => {
  it("spreads each kanji run's reading kana by kana over that run", () => {
    const entry = (expression: string, reading: string) =>
      render(
        <LookupEntry
          canPlayAudio={false}
          group={{ ...good, expression, reading, text: expression }}
          onSearchTerm={() => {}}
          readingPosition="above"
          showDictionaryNames
          showFrequency
          showPitch
          showVoiceAction={false}
          start={null}
        />,
      );
    const whole = entry("有象無象", "うぞうむぞう");
    const [rt] = whole.container.querySelectorAll("rt");
    expect(rt.textContent).toBe("うぞうむぞう");
    expect(rt.querySelectorAll("span")).toHaveLength(6);
    whole.unmount();
    const split = entry("読み込む", "よみこむ");
    expect([...split.container.querySelectorAll("rt")].map((node) => node.textContent)).toEqual([
      "よ",
      "こ",
    ]);
  });
});
