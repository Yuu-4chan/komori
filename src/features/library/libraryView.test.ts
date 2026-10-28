import { describe, expect, it } from "vitest";

import type { LibraryBook } from "./libraryApi";
import {
  type LibrarySort,
  groupBooks,
  languageName,
  lastReadLabel,
  matchesQuery,
  progressLabel,
  progressPercent,
  readingStatus,
  readTotalLabel,
  sectionGroup,
  seriesFromTitles,
  shownLanguage,
  sortBooks,
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

  it("reads the grouping from a section key", () => {
    expect(sectionGroup("series:Accel World")).toBe("series");
    expect(sectionGroup("language:")).toBe("language");
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
    // A series keeps its volumes in order whatever the sort.
    expect(groupBooks(books, "series", "recent", true)[1]?.books.map((item) => item.id)).toEqual([
      "g1",
      "g2",
    ]);
  });
});

describe("series from titles", () => {
  it("names the series titles begin with, without volume numbers and words", () => {
    expect(seriesFromTitles(["Cat Tales 1", "Cat Tales 2"])).toBe("Cat Tales");
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
  });

  it("names nothing for one title, titles sharing no name, or within a word", () => {
    expect(seriesFromTitles(["Cat Tales 1"])).toBe("");
    expect(seriesFromTitles(["Plain Book", "English Book"])).toBe("");
    expect(seriesFromTitles(["1", "2"])).toBe("");
    expect(seriesFromTitles(["Cat Tales", "Cat Tails"])).toBe("Cat");
  });
});
