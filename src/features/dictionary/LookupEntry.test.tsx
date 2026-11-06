import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TermGroup, TermMatch } from "./dictionaryApi";
import { DictionaryLookupEntry, LookupEntry } from "./LookupEntry";

function group(expression: string, terms: TermMatch[]): TermGroup {
  return {
    expression,
    reading: expression,
    text: expression,
    deinflection: null,
    terms,
    frequencies: [],
    transcriptions: [],
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

  it("shows four of a dictionary's tags before +N more, so the definitions stay in view", () => {
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

describe("dictionary parts", () => {
  const term = (
    dictionaryId: number,
    dictionaryTitle: string,
    gloss: string,
    sequence: number,
  ) => ({
    ...good.terms[0],
    dictionaryId,
    dictionaryTitle,
    glossary: [gloss],
    sequence,
  });
  const entry = (terms: TermMatch[]) =>
    render(
      <LookupEntry
        canPlayAudio={false}
        group={group("本", terms)}
        onSearchTerm={() => {}}
        showDictionaryNames
        showFrequency
        showPitch
        showVoiceAction={false}
        start={null}
      />,
    );

  it("groups definitions under their dictionary's name, numbered when there are several", () => {
    entry([
      term(1, "Jitendex", "book", 1),
      term(2, "国語", "書物", 2),
      term(1, "Jitendex", "main", 3),
    ]);
    const jitendex = screen.getByRole("region", { name: "Jitendex" });
    const list = jitendex.querySelector("ol")!;
    expect([...list.children].map((item) => item.textContent)).toEqual(["book", "main"]);
    expect(list).not.toHaveClass("lookup-source__senses--single");
    expect(screen.getByRole("region", { name: "国語" }).querySelector("ol")).toHaveClass(
      "lookup-source__senses--single",
    );
    expect(
      [...document.querySelectorAll(".lookup-source__name")].map((name) => name.textContent),
    ).toEqual(["Jitendex", "国語"]);
  });

  it("folds one dictionary's definitions from its name and keeps the others open", () => {
    entry([term(1, "Jitendex", "book", 1), term(2, "国語", "書物", 2)]);
    const name = screen.getByRole("button", { name: "Collapse Jitendex definitions" });
    expect(name).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(name);
    expect(name).toHaveAttribute("aria-expanded", "false");
    expect(name).toHaveAccessibleName("Expand Jitendex definitions");
    expect(screen.getByText("book")).not.toBeVisible();
    expect(screen.getByText("書物")).toBeVisible();
    fireEvent.click(name);
    expect(screen.getByText("book")).toBeVisible();
  });

  it("leads the frequencies with a common word's star, out of the dictionary's tags", () => {
    entry([
      {
        ...term(1, "Jitendex", "book", 1),
        tags: [
          { name: "⭐", category: "popular", order: 0, notes: "common", score: 0 },
          { name: "n", category: "partOfSpeech", order: 0, notes: "noun", score: 0 },
        ],
      },
    ]);
    const frequencies = screen.getByRole("list", { name: "Frequency" });
    expect(frequencies.firstElementChild).toHaveTextContent("⭐");
    expect(frequencies.firstElementChild).toHaveClass("lookup-entry__popular");
    const tags = screen
      .getByRole("region", { name: "Jitendex" })
      .querySelector(".lookup-source__tags")!;
    expect(tags).toHaveTextContent(/^n$/);
  });
});

describe("Dictionary page readings", () => {
  it("show pinyin and Hangul beside the headword, and no reading in English", () => {
    const entry = (expression: string, reading: string, language: "zh" | "ko" | "en") =>
      render(
        <DictionaryLookupEntry
          group={{ ...good, expression, reading }}
          language={language}
          onSearchTerm={() => {}}
          showDictionaryNames={false}
        />,
      );
    entry("学习", "xué xí", "zh");
    expect(screen.getByRole("article", { name: "学习 (xué xí)" })).toHaveTextContent("xué xí");
    entry("學校", "학교", "ko");
    expect(screen.getByRole("article", { name: "學校 (학교)" })).toHaveTextContent("학교");
    entry("walk", "wɔːk", "en");
    expect(screen.getByRole("article", { name: "walk" })).not.toHaveTextContent("wɔːk");
  });

  it("show pronunciations between slashes, and pinyin as it is", () => {
    const entry = (expression: string, language: "de" | "zh", transcriptions: string[]) =>
      render(
        <DictionaryLookupEntry
          group={{ ...good, expression, reading: expression, transcriptions }}
          language={language}
          onSearchTerm={() => {}}
          showDictionaryNames={false}
        />,
      );
    entry("Kind", "de", ["kɪnt", "[kɪnd]"]);
    expect(screen.getByRole("article", { name: "Kind" })).toHaveTextContent("/kɪnt/, [kɪnd]");
    entry("好", "zh", ["hǎo"]);
    expect(screen.getByRole("article", { name: "好" })).toHaveTextContent("hǎo");
    expect(screen.getByRole("article", { name: "好" })).not.toHaveTextContent("/hǎo/");
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

describe("headword pitch", () => {
  const pitched = (expression: string, reading: string, position: number) => ({
    ...good,
    expression,
    reading,
    text: expression,
    pitches: [
      {
        dictionaryId: 9,
        dictionaryTitle: "Pitch",
        data: { reading, pitches: [{ position }] },
      },
    ],
  });
  const marks = (root: Element) =>
    [...root.children].map((span) => [span.textContent, span.className]);

  it("draws the pitch on the reading beside the headword", () => {
    const { container } = render(
      <LookupEntry
        canPlayAudio={false}
        group={pitched("圧力", "あつりょく", 2)}
        onSearchTerm={() => {}}
        showDictionaryNames
        showFrequency
        showPitch
        showVoiceAction={false}
        start={null}
      />,
    );
    expect(marks(container.querySelector(".lookup-entry__reading")!)).toEqual([
      ["あ", ""],
      ["つ", "pitch-kana--high pitch-kana--drop"],
      ["り", ""],
      ["ょ", ""],
      ["く", ""],
    ]);
    expect(container.querySelector(".lookup-entry__pitch")).toHaveAttribute("title", "[2] Pitch");
  });

  it("draws the pitch over the furigana and on the kana between its kanji", () => {
    const { container } = render(
      <LookupEntry
        canPlayAudio={false}
        group={pitched("読み込む", "よみこむ", 3)}
        onSearchTerm={() => {}}
        readingPosition="above"
        showDictionaryNames
        showFrequency
        showPitch
        showVoiceAction={false}
        start={null}
      />,
    );
    const expression = container.querySelector(".lookup-entry__expression")!;
    expect(
      [...expression.querySelectorAll("rt span, .lookup-entry__expression > span")].map((span) => [
        span.textContent,
        span.className,
      ]),
    ).toEqual([
      ["よ", ""],
      ["み", "pitch-kana--high"],
      ["こ", "pitch-kana--high pitch-kana--drop"],
    ]);
    // Kana with no mark of their own stay plain text.
    expect(expression).toHaveTextContent(/^読よみ込こむ$/);
    expect(container.querySelector(".lookup-entry__reading")).toBeNull();
  });

  it("draws nothing when pitch is off", () => {
    const { container } = render(
      <LookupEntry
        canPlayAudio={false}
        group={pitched("圧力", "あつりょく", 2)}
        onSearchTerm={() => {}}
        showDictionaryNames
        showFrequency
        showPitch={false}
        showVoiceAction={false}
        start={null}
      />,
    );
    expect(container.querySelector("[class^='pitch-kana'], .lookup-entry__pitch")).toBeNull();
    expect(container.querySelector(".lookup-entry__reading")).toHaveTextContent(/^あつりょく$/);
  });
});
