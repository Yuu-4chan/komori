import { describe, expect, it } from "vitest";

import type { LibraryBook } from "./libraryApi";
import {
  type LibrarySort,
  groupBooks,
  languageName,
  lastReadLabel,
  leadAuthor,
  matchesQuery,
  progressLabel,
  progressPercent,
  readingStatus,
  readTotalLabel,
  sectionGroup,
  seriesFromTitles,
  shownLanguage,
  sortBooks,
  groupAmounts,
  libraryRead,
} from "./libraryView";

function book(id: string, fields: Partial<LibraryBook> = {}): LibraryBook {
  return {
    id,
    title: `Book ${id}`,
    author: "Author",
    fileName: `${id}.epub`,
    importedAt: "2026-09-01T00:00:00Z",
    availability: "available",
    hasCover: false,
    progress: null,
    lastReadAt: null,
    ...fields,
  };
}

const characters = (current: number, total: number) =>
  ({ unit: "characters", current, total }) as const;

describe("Library view", () => {
  it("derives reading status and progress labels from the Reader's counts", () => {
    const unread = book("a");
    const opened = book("b", { lastReadAt: "2026-09-20T00:00:00Z" });
    const reading = book("c", { progress: characters(2_500, 10_000) });
    const almost = book("d", { progress: characters(9_999, 10_000) });
    const done = book("e", { progress: { unit: "words", current: 12, total: 12 } });
    expect([unread, opened, reading, almost, done].map(readingStatus)).toEqual([
      "not-started",
      "reading",
      "reading",
      "reading",
      "completed",
    ]);
    // Only a finished book reads 100%.
    expect(progressPercent(almost)).toBe(99);
    expect(progressLabel(reading)).toBe("25%");
    expect(progressLabel(done)).toBe("Completed");
    expect(readTotalLabel(reading)).toBe(
      `${(2500).toLocaleString()} / ${(10000).toLocaleString()} characters`,
    );
    // Western books count words, and show their percentage like any other.
    expect(readTotalLabel(done)).toBe("12 / 12 words");
    expect(progressLabel(book("f", { progress: { unit: "words", current: 50, total: 200 } }))).toBe(
      "25%",
    );
    expect(readTotalLabel(unread)).toBeNull();
  });

  it("matches every word of a query against title, author, and file name", () => {
    const target = book("x", {
      title: "ふつつかな悪女",
      author: "中村颯希",
      fileName: "akujo09.epub",
    });
    expect(matchesQuery(target, "")).toBe(true);
    expect(matchesQuery(target, "悪女 中村")).toBe(true);
    expect(matchesQuery(target, "AKUJO")).toBe(true);
    expect(matchesQuery(target, "悪女 missing")).toBe(false);
  });

  it("sorts recently opened first, then never-opened books by import", () => {
    const books = [
      book("old-import", { importedAt: "2026-01-01T00:00:00Z" }),
      book("read-early", { lastReadAt: "2026-09-01T00:00:00Z" }),
      book("new-import", { importedAt: "2026-09-10T00:00:00Z" }),
      book("read-late", { lastReadAt: "2026-09-20T00:00:00Z" }),
    ];
    expect(sortBooks(books, "recent", false).map((item) => item.id)).toEqual([
      "read-late",
      "read-early",
      "new-import",
      "old-import",
    ]);
    // Reversing keeps never-opened books after the opened ones.
    expect(sortBooks(books, "recent", true).map((item) => item.id)).toEqual([
      "read-early",
      "read-late",
      "old-import",
      "new-import",
    ]);
  });

  it("sorts by title naturally, progress, and counted characters with uncounted books last", () => {
    const books = [
      book("10", { title: "Volume 10", progress: characters(10, 100), characters: 100 }),
      book("2", {
        title: "Volume 2",
        progress: { unit: "words", current: 1, total: 40 },
      }),
      // Counted at import, never opened.
      book("1", { title: "Volume 1", characters: 300 }),
      book("none", { title: "Another" }),
    ];
    const ids = (sort: Parameters<typeof sortBooks>[1], reversed = false) =>
      sortBooks(books, sort, reversed).map((item) => item.id);
    expect(ids("title")).toEqual(["none", "1", "2", "10"]);
    expect(ids("progress")).toEqual(["10", "2", "none", "1"]);
    expect(ids("characters")).toEqual(["1", "10", "none", "2"]);
    expect(ids("characters", true)).toEqual(["10", "1", "none", "2"]);
  });

  it("sorts by counted words with books counted in characters or not at all last", () => {
    const books = [
      book("short", { title: "Short", words: 20_000 }),
      book("long", { title: "Long", words: 180_000 }),
      book("ja", { title: "Japanese", characters: 300_000 }),
    ];
    const ids = (reversed = false) => sortBooks(books, "words", reversed).map((item) => item.id);
    expect(ids()).toEqual(["long", "short", "ja"]);
    expect(ids(true)).toEqual(["short", "long", "ja"]);
  });

  it("describes the last read time relative to now", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(lastReadLabel(book("a", { lastReadAt: "2026-09-27T12:00:00Z" }), now)).toBe(
      new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-2, "day"),
    );
    expect(lastReadLabel(book("b"), now)).toBeNull();
    // The phone's narrow cards: "44m ago", "2h ago".
    const narrow = (at: string) => lastReadLabel(book("c", { lastReadAt: at }), now, "narrow");
    expect(narrow("2026-09-29T11:16:00Z")).toBe("44m ago");
    expect(narrow("2026-09-29T10:00:00Z")).toBe("2h ago");
  });
});

describe("authors", () => {
  it("sorts by author, then title, with books without one last either way", () => {
    const books = [
      book("b2", { author: "Bee", title: "Saga 10" }),
      book("none", { author: null }),
      book("b1", { author: "Bee", title: "Saga 2" }),
      book("a", { author: "Ant" }),
    ];
    expect(sortBooks(books, "author", false).map((entry) => entry.id)).toEqual([
      "a",
      "b1",
      "b2",
      "none",
    ]);
    expect(sortBooks(books, "author", true).map((entry) => entry.id)).toEqual([
      "b1",
      "b2",
      "a",
      "none",
    ]);
  });

  it("groups each book under its first author, by name, with unknown authors last", () => {
    expect(leadAuthor(book("x", { author: "猫又ぬこ & あろあ" }))).toBe("猫又ぬこ");
    expect(leadAuthor(book("x", { author: "鏡 遊／ひげ猫" }))).toBe("鏡 遊");
    expect(leadAuthor(book("x", { author: "A, B" }))).toBe("A");
    expect(leadAuthor(book("x", { author: "  " }))).toBeNull();
    const sections = groupBooks(
      [
        book("1", { author: "Zed & Ann" }),
        book("2", { author: null }),
        book("3", { author: "Ann" }),
        book("4", { author: "Zed" }),
      ],
      "author",
      "added",
    );
    expect(sections.map((section) => [section.key, section.title])).toEqual([
      ["author:Ann", "Ann"],
      ["author:Zed", "Zed"],
      ["author:", "Unknown author"],
    ]);
    expect(sections[1]?.books.map((entry) => entry.id)).toEqual(["1", "4"]);
  });
});

describe("counted characters and group keys", () => {
  it("shows a CJK book's counted characters before it is opened", () => {
    expect(readTotalLabel(book("a", { characters: 253_732 }))).toBe(
      `0 / ${(253_732).toLocaleString()} characters`,
    );
    expect(readTotalLabel(book("b"))).toBeNull();
    // A western book shows the words Komori counted.
    expect(readTotalLabel(book("w", { words: 92_418 }))).toBe(
      `0 / ${(92_418).toLocaleString()} words`,
    );
    // Opened before progress was counted: the Reader counts it on next open.
    expect(
      readTotalLabel(book("c", { characters: 10, lastReadAt: "2026-09-01T00:00:00Z" })),
    ).toBeNull();
  });

  it("adds up what has been read of a group's counted characters or words", () => {
    const books = [
      book("a", { characters: 1_000, progress: characters(400, 1_000) }),
      // Never more than the book holds, and nothing for a book not opened.
      book("b", { characters: 500, progress: characters(900, 900) }),
      book("c", { characters: 2_000 }),
      book("d", { words: 300, progress: { unit: "words", current: 120, total: 300 } }),
    ];
    expect(libraryRead(books, "characters")).toBe(900);
    expect(libraryRead(books, "words")).toBe(120);
    expect(libraryRead([book("e", { characters: 10 })], "characters")).toBe(0);
    // A heading gives what was read with the total, and the total alone before anything is read.
    expect(groupAmounts(books, false)).toEqual(["900 / 3,500 characters", "120 / 300 words"]);
    expect(groupAmounts([book("e", { characters: 1_600_000 })], true)).toEqual(["1.6M characters"]);
    expect(groupAmounts(books, true, true)).toEqual(["900 / 3.5K Ch.", "120 / 300 Wo."]);
    expect(groupAmounts([book("f")], true)).toEqual([]);
  });

  it("reads the grouping from a section key", () => {
    expect(sectionGroup("series:Accel World")).toBe("series");
    expect(sectionGroup("language:")).toBe("language");
    expect(sectionGroup("author:鏡 遊")).toBe("author");
    expect(sectionGroup("all")).toBeNull();
    expect(sectionGroup("other:x")).toBeNull();
  });
});

describe("language names", () => {
  it("names the language alone, and Chinese by its script when the tag says it", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("ja-JP")).toBe("Japanese");
    expect(languageName("pt-BR")).toBe("Portuguese");
    expect(languageName("zh")).toBe("Chinese");
    expect(languageName("zh-CN")).toBe("Chinese Simplified");
    expect(languageName("zh-Hans")).toBe("Chinese Simplified");
    expect(languageName("zh_sg")).toBe("Chinese Simplified");
    expect(languageName("zh-TW")).toBe("Chinese Traditional");
    expect(languageName("zh-Hant-CN")).toBe("Chinese Traditional");
    expect(languageName("zh-HK")).toBe("Chinese Traditional");
    expect(shownLanguage("zh-yue")).toBe("zh");
  });

  it("groups regional tags of one language together", () => {
    const sections = groupBooks(
      [
        book("a", { language: "ja" }),
        book("b", { language: "ja-JP" }),
        book("c", { language: "zh-CN" }),
        book("d", { language: "zh-Hans" }),
        book("e", { language: "zh-TW" }),
      ],
      "language",
    );
    expect(sections.map((section) => [section.title, section.books.length])).toEqual([
      ["Chinese Simplified", 2],
      ["Chinese Traditional", 1],
      ["Japanese", 2],
    ]);
  });

  it("orders groups as the sort orders books, books without a group last", () => {
    const books = [
      book("a1", {
        series: "Alpha",
        importedAt: "2026-09-01T00:00:00Z",
        lastReadAt: "2026-10-01T00:00:00Z",
        progress: characters(40, 100),
        characters: 100,
      }),
      book("b1", { series: "Beta", importedAt: "2026-09-05T00:00:00Z", characters: 500 }),
      book("g1", {
        series: "Gamma",
        seriesIndex: 1,
        importedAt: "2026-09-03T00:00:00Z",
        lastReadAt: "2026-10-05T00:00:00Z",
        progress: characters(100, 100),
      }),
      book("g2", { series: "Gamma", seriesIndex: 2, characters: 50 }),
      book("n1", { lastReadAt: "2026-10-10T00:00:00Z", progress: characters(90, 100) }),
    ];
    const order = (sort: LibrarySort, reversed = false) =>
      groupBooks(books, "series", sort, reversed).map((section) => section.key);
    expect(order("title")).toEqual(["series:Alpha", "series:Beta", "series:Gamma", "series:"]);
    expect(order("title", true)).toEqual([
      "series:Gamma",
      "series:Beta",
      "series:Alpha",
      "series:",
    ]);
    expect(order("recent")).toEqual(["series:Gamma", "series:Alpha", "series:Beta", "series:"]);
    expect(order("recent", true)).toEqual([
      "series:Alpha",
      "series:Gamma",
      "series:Beta",
      "series:",
    ]);
    expect(order("added")).toEqual(["series:Beta", "series:Gamma", "series:Alpha", "series:"]);
    expect(order("progress")).toEqual(["series:Gamma", "series:Alpha", "series:Beta", "series:"]);
    expect(order("characters")).toEqual(["series:Beta", "series:Alpha", "series:Gamma", "series:"]);
    expect(order("words")).toEqual(["series:Alpha", "series:Beta", "series:Gamma", "series:"]);
    // A group's books keep the chosen order, whatever their series numbers.
    expect(
      groupBooks([books[3], books[2]], "series", "title")[0]?.books.map((item) => item.id),
    ).toEqual(["g2", "g1"]);
  });
});

describe("series from titles", () => {
  it("names the series titles begin with, without volume numbers and words", () => {
    expect(seriesFromTitles(["Cat Tales 1", "Cat Tales 2"])).toBe("Cat Tales");
    expect(seriesFromTitles(["８６ Tales 1", "86 Tales ２"])).toBe("８６ Tales");
    expect(seriesFromTitles(["Title v01", "Title v02"])).toBe("Title");
    expect(seriesFromTitles(["『八男って！ 26』BOOK", "『八男って！ 27』BOOK"])).toBe("八男って！");
    expect(seriesFromTitles(["「ロウきゅーぶ！」1", "「ロウきゅーぶ！」2"])).toBe(
      "「ロウきゅーぶ！」",
    );
    expect(seriesFromTitles(["Bing - An - Volume 03", "Bing - An - Volume 04"])).toBe("Bing - An");
    expect(seriesFromTitles(["幼女戦記07", "幼女戦記08"])).toBe("幼女戦記");
    expect(seriesFromTitles(["Foo Vol. 1", "Foo Vol. 2", "Foo Vol. 3"])).toBe("Foo");
    expect(seriesFromTitles(["作品 第1巻", "作品 第2巻"])).toBe("作品");
    expect(seriesFromTitles(["Re:Zero - 01", "Re:Zero - 02"])).toBe("Re:Zero");
    expect(seriesFromTitles(["Saga (Light Novel) 1", "Saga (Light Novel) 2"])).toBe(
      "Saga (Light Novel)",
    );
    // A dash closing one earlier in the name stays.
    expect(
      seriesFromTitles([
        "86─エイティシックス─Ep.06─明けねばこそ夜は永く─",
        "86─エイティシックス─Alter.01─死神ときどき青春─",
        "86─エイティシックス─Ep.05─死よ、驕るなかれ─",
      ]),
    ).toBe("86─エイティシックス─");
    expect(
      seriesFromTitles(["86─エイティシックス─Ep.06─明けねば─", "86─エイティシックス─Ep.05─死よ─"]),
    ).toBe("86─エイティシックス─");
    // Angle brackets keep their closing mark, a title keeps its own ！ or ？, and parts go.
    expect(
      seriesFromTitles([
        "IS＜インフィニット・ストラトス＞01",
        "IS＜インフィニット・ストラトス＞02",
      ]),
    ).toBe("IS＜インフィニット・ストラトス＞");
    expect(
      seriesFromTitles([
        "運命に愛されて。<運命に愛されて。>01",
        "運命に愛されて。<運命に愛されて。>02",
      ]),
    ).toBe("運命に愛されて。<運命に愛されて。>");
    expect(seriesFromTitles(["ギブあっぷ！01", "ギブあっぷ！02"])).toBe("ギブあっぷ！");
    expect(seriesFromTitles(["にしない？01", "にしない？02"])).toBe("にしない？");
    expect(seriesFromTitles(["魔女と傭兵06（上）", "魔女と傭兵06（下）"])).toBe("魔女と傭兵");
    expect(
      seriesFromTitles([
        "地味なおじさん、実は英雄でした（上）。05",
        "地味なおじさん、実は英雄でした（下）。06",
      ]),
    ).toBe("地味なおじさん、実は英雄でした");
  });

  it("names nothing for one title, titles sharing no name, or within a word", () => {
    expect(seriesFromTitles(["Cat Tales 1"])).toBe("");
    expect(seriesFromTitles(["Plain Book", "English Book"])).toBe("");
    expect(seriesFromTitles(["1", "2"])).toBe("");
    expect(seriesFromTitles(["Cat Tales", "Cat Tails"])).toBe("Cat");
  });
});
