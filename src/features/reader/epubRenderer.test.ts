import ePub from "epubjs";
// @ts-expect-error EPUB.js declares no modules for its utility sources.
import Queue from "epubjs/src/utils/queue";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareReaderContent } from "./contentApi";
import { epubRendererFactory } from "./epubRenderer";
import { EpubResourceLimit, InvalidEpubDocument } from "./epubTolerance";
import { imageInkShift } from "./imageInk";
import { renderBookImage } from "./bookImages";
import type { ReaderPresentation } from "./renderer";
import { defaultLookupTriggers } from "./lookupTriggers";

vi.mock("epubjs", () => ({ default: vi.fn() }));
vi.mock("./contentApi", () => ({ prepareReaderContent: vi.fn() }));
vi.mock("./imageInk", () => ({ imageInkShift: vi.fn(async () => undefined) }));
vi.mock("./bookImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bookImages")>()),
  renderBookImage: vi.fn(async () => ({
    blob: new Blob(["bounded PNG"], { type: "image/png" }),
    width: 320,
    height: 240,
  })),
}));

const id = "11111111-1111-4111-8111-111111111111";
const url = `http://komori-book.localhost/${id}`;
const prepare = vi.mocked(prepareReaderContent);
const epub = vi.mocked(ePub);

function section(href: string, text: string, linear = true, html?: string) {
  const document = window.document.implementation.createHTMLDocument();
  if (html === undefined) document.body.textContent = text;
  else document.body.innerHTML = html;
  return {
    href,
    url: `/${href}`,
    linear,
    document,
    load: vi.fn(async () => document.documentElement),
    unload: vi.fn(),
  };
}

function mockBook(
  sections = [section("Text/one.xhtml", "First readable paragraph ".repeat(8))],
  toc: unknown[] = [],
) {
  const display = vi.fn(async () => undefined);
  const listeners = new Map<string, Set<(location: unknown) => void>>();
  // EPUB.js's view manager pages a vertical section by its layout height, lays out
  // two-page spreads from 800px wide, and keeps the axis the last section reported.
  const manager = {
    layout: {
      height: 780,
      delta: 1066,
      _spread: true,
      _minSpreadWidth: 800,
      settings: { direction: "ltr" },
    },
    _stageSize: { width: 1066, height: 780 },
    viewSettings: { width: 1066, height: 780 },
    settings: { axis: "horizontal", direction: "ltr" },
    scrollBy: vi.fn((_x: number, _y: number, _silent?: boolean) => undefined),
    direction: vi.fn((direction: string) => {
      manager.settings.direction = direction;
    }),
    clear: vi.fn(),
    updateLayout: vi.fn(() => {
      manager.layout.delta = manager._stageSize.width;
    }),
    updateAxis: vi.fn((axis: string, _forceUpdate?: boolean) => {
      manager.settings.axis = axis;
    }),
  };
  const rendition = {
    display,
    // EPUB.js starts with the package's page progression.
    settings: { direction: "ltr" },
    next: vi.fn(async () => undefined),
    prev: vi.fn(async () => undefined),
    manager,
    reportLocation: vi.fn(async () => undefined),
    currentLocation: vi.fn(() => ({
      atStart: true,
      atEnd: false,
      start: { displayed: { page: 1 } },
      end: { displayed: { page: 1, total: 2 } },
    })),
    getContents: vi.fn(() => []),
    on: vi.fn((name: string, listener: (location: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(listener);
    }),
    off: vi.fn((name: string, listener: (location: unknown) => void) => {
      listeners.get(name)?.delete(listener);
    }),
    emit: (name: string) => {
      for (const listener of listeners.get(name) ?? []) listener(rendition.currentLocation());
    },
  };
  const destroy = vi.fn();
  const book = {
    unarchive: vi.fn(async () => undefined),
    loadNavigation: vi.fn(async () => ({ toc })),
    open: vi.fn(async () => undefined),
    opened: Promise.resolve(),
    loaded: { navigation: Promise.resolve({ toc }) },
    // The book-wide character count parses each section from the archive by URL.
    load: vi.fn(async (target: string) => sections.find((item) => item.url === target)?.document),
    archive: {
      request: vi.fn(
        async (url?: string): Promise<Document | null> =>
          sections.find((item) => item.url === url)?.document ?? null,
      ),
      zip: { file: vi.fn(() => ({ _data: { uncompressedSize: 1024 } })) },
    },
    container: { packagePath: "Nested/book.opf" },
    package: { navPath: "toc.xhtml" },
    spine: {
      get: vi.fn((target: string | number) =>
        typeof target === "number"
          ? (sections[target] ?? null)
          : (sections.find((item) => item.href === target.split("#")[0]) ?? null),
      ),
      each: (callback: (item: (typeof sections)[number]) => void) => sections.forEach(callback),
      hooks: { content: { register: vi.fn() } },
    },
    renderTo: vi.fn(() => rendition),
    resources: { replacementUrls: [] },
    destroy,
  };
  epub.mockReturnValue(book as never);
  return { book, rendition, display, destroy };
}

function mockAnchor(rendition: ReturnType<typeof mockBook>["rendition"], id: string, cfi: string) {
  const contentDocument = document.implementation.createHTMLDocument();
  const heading = contentDocument.createElement("h3");
  heading.id = id;
  heading.textContent = "Authored heading";
  contentDocument.body.append(heading);
  rendition.getContents.mockReturnValue([
    { document: contentDocument, cfiFromRange: vi.fn(() => cfi) },
  ] as never);
}

/** A displayed section whose EPUB.js page-start CFI resolves to a text offset. */
function mockSectionText(
  rendition: ReturnType<typeof mockBook>["rendition"],
  sectionIndex: number,
  text: string,
  pageStartOffset: number,
  pageEndOffset?: number,
) {
  const contentDocument = document.implementation.createHTMLDocument();
  const paragraph = contentDocument.createElement("p");
  paragraph.textContent = text;
  contentDocument.body.append(paragraph);
  const contents = {
    document: contentDocument,
    sectionIndex,
    cfiFromRange: vi.fn((range: Range) => `epubcfi(offset-${range.startOffset})`),
    range: vi.fn((cfi: string) => {
      const range = contentDocument.createRange();
      // The page-end CFI is the range of the last displayed character.
      if (cfi === "epubcfi(page-end)" && pageEndOffset !== undefined) {
        range.setStart(paragraph.firstChild!, Math.max(0, pageEndOffset - 1));
        range.setEnd(paragraph.firstChild!, pageEndOffset);
      } else range.setStart(paragraph.firstChild!, pageStartOffset);
      return range;
    }),
  };
  rendition.getContents.mockReturnValue([contents] as never);
  return contents;
}

function positionBinding(initial: Promise<unknown> = Promise.resolve(null)) {
  return { initial: initial as Promise<null>, onLocationChanged: vi.fn() };
}

describe("EPUB.js renderer adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("Blob", NativeBlob);
    prepare.mockResolvedValue({ status: "ready", url });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })),
    );
  });

  it("retains fixed-layout pages with honest VN feedback and never reveals their text", async () => {
    const { book, rendition } = mockBook();
    Object.assign(book.package, { metadata: { layout: "pre-paginated" } });
    const turns = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      turns,
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, viewMode: "vn", vnParagraphs: 3, vnTextSpeed: 20 },
    );
    expect(book.renderTo).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.not.objectContaining({ manager: "continuous" }),
    );
    expect(turns).toHaveBeenLastCalledWith(expect.objectContaining({ vnNotice: "fixed-layout" }));
    await renderer.advancePage();
    expect(rendition.next).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("publishes measured contents starts, aliases and honest unresolved fragments without navigating", async () => {
    const sections = [
      section(
        "Text/one.xhtml",
        "",
        true,
        '<p>猫<ruby>本<rt>ほん</rt></ruby>。</p><h2 id="second">次</h2><p>章</p>',
      ),
    ];
    const { display } = mockBook(sections, [
      { label: "First", href: "Text/one.xhtml" },
      { label: "Second", href: "Text/one.xhtml#second" },
      { label: "Alias", href: "Text/one.xhtml#second" },
      { label: "Missing", href: "Text/one.xhtml#missing" },
    ]);
    const contents = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
    );
    await vi.waitFor(() =>
      expect(contents.mock.lastCall?.[0]?.[1].location).toEqual({
        current: 2,
        total: 4,
        unit: "characters",
      }),
    );
    expect(
      contents.mock.lastCall?.[0].map((entry: { location: unknown }) => entry.location),
    ).toEqual([
      { current: 0, total: 4, unit: "characters" },
      { current: 2, total: 4, unit: "characters" },
      { current: 2, total: 4, unit: "characters" },
      null,
    ]);
    expect(display).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("reports counted chapter edges within one spine section without confusing them with page edges", async () => {
    const item = section("Text/one.xhtml", "", true, '<p>猫犬</p><h2 id="second">次</h2><p>章</p>');
    const { rendition } = mockBook(
      [item],
      [
        { label: "First", href: "Text/one.xhtml" },
        { label: "Second", href: "Text/one.xhtml#second" },
      ],
    );
    let second = false;
    const doc = item.document;
    rendition.getContents.mockReturnValue([
      {
        document: doc,
        sectionIndex: 0,
        cfiFromRange: () => "epubcfi(place)",
        range: (cfi: string) => {
          const range = doc.createRange();
          const node = doc.querySelector(second ? "h2" : "p")!.firstChild!;
          range.setStart(node, cfi === "start" ? 0 : node.textContent!.length);
          range.collapse(true);
          return range;
        },
      },
    ] as never);
    rendition.currentLocation.mockImplementation(
      () =>
        ({
          atStart: false,
          atEnd: false,
          start: { index: 0, cfi: "start", displayed: { page: 2, total: 5 } },
          end: { index: 0, cfi: "end", displayed: { page: 2, total: 5 } },
        }) as never,
    );
    rendition.next.mockImplementation(async () => {
      second = true;
      rendition.emit("relocated");
    });
    const changed = vi.fn();
    const progress = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      changed,
      undefined,
      vi.fn(),
      undefined,
      progress,
    );
    await vi.waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ advanceChapter: true })),
    );
    await renderer.advancePage();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ retreatChapter: true }));
    expect(changed.mock.lastCall?.[0].advanceChapter).toBeUndefined();
    renderer.dispose();
  });

  it("uses the same word measure for English contents, and makes text-free locations unavailable", async () => {
    mockBook(
      [
        section(
          "one.xhtml",
          "",
          true,
          '<p>One well-read reader.</p> <h2 id="next">Next</h2> <p>chapter</p>',
        ),
      ],
      [{ label: "Next", href: "one.xhtml#next" }],
    );
    const contents = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
    );
    await vi.waitFor(() =>
      expect(contents.mock.lastCall?.[0]?.[0].location).toEqual({
        current: 3,
        total: 5,
        unit: "words",
      }),
    );
    renderer.dispose();
    mockBook(
      [section("one.xhtml", "", true, '<img src="cover.png">')],
      [{ label: "Cover", href: "one.xhtml" }],
    );
    const empty = epubRendererFactory(id)();
    await empty.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
    );
    await vi.waitFor(() => expect(contents.mock.lastCall?.[0]?.[0].location).toBeNull());
    empty.dispose();
  });

  it.each([undefined, "auto", "paginated", "scrolled-doc", "scrolled-continuous"])(
    "pages a reflowable book with %s authored flow under Paginated and scrolls it under Continuous",
    async (authored) => {
      // EPUB.js takes the rendition's flow before the book's own (rendition.js
      // determineLayoutProperties).
      const selected = (options: { flow?: string }) => options.flow ?? authored ?? "auto";
      for (const viewMode of ["paginated", "continuous"] as const) {
        const { book } = mockBook();
        Object.assign(book.package, { metadata: authored ? { flow: authored } : {} });
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, viewMode },
        );
        const options = (book.renderTo.mock.calls as unknown[][])[0][1] as { flow?: string };
        expect(selected(options)).toBe(viewMode === "paginated" ? "paginated" : "scrolled");
        renderer.dispose();
      }
    },
  );

  it("leaves a fixed-layout book's authored flow and spreads to EPUB.js", async () => {
    const { book } = mockBook();
    Object.assign(book.package, { metadata: { layout: "pre-paginated", flow: "scrolled-doc" } });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, pageLayout: "single" },
    );
    const options = (book.renderTo.mock.calls as unknown[][])[0][1] as object;
    expect(options).not.toHaveProperty("flow");
    expect(options).not.toHaveProperty("spread");
    renderer.dispose();
  });

  it("switches spread choice and width without replacing the book, with one vertical column a turn", async () => {
    const { book, rendition } = mockBook();
    const layout = { format: vi.fn() };
    Object.assign(rendition, { _layout: layout });
    const host = document.createElement("div");
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      host,
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, maxWidth: 500, pageLayout: "single" },
    );
    expect((book.renderTo.mock.calls as unknown[][])[0][1]).toMatchObject({ spread: "none" });
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("540px");
    await renderer.setPresentation!({ fontSize: 16, maxWidth: 600, pageLayout: "double" });
    expect(rendition.manager.layout._spread).toBe(true);
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("1280px");
    await renderer.setPresentation!({ fontSize: 16, maxWidth: 300, pageLayout: "double" });
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("340px");
    const container = document.createElement("div");
    let availableWidth = 700;
    Object.defineProperty(container, "clientWidth", { get: () => availableWidth });
    container.append(host);
    await renderer.setPresentation!({ fontSize: 16, maxWidth: 600, pageLayout: "double" });
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("640px");
    availableWidth = 1066;
    await renderer.setPresentation!({ fontSize: 17, maxWidth: 600, pageLayout: "double" });
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("1280px");
    const columns = vi.fn();
    layout.format(
      { document, writingMode: () => "vertical-rl", columns } as never,
      undefined,
      "vertical",
    );
    // Vertical text has no double pages.
    expect(columns).toHaveBeenCalledWith(1066, 780, 740, 40, "ltr");
    expect(book.renderTo).toHaveBeenCalledOnce();
    renderer.dispose();
    expect(host.style.getPropertyValue("--reader-max-width")).toBe("");
  });

  it("shows a run of image pages two to a spread, one image a page, leaving the cover alone", async () => {
    const image = (href: string) =>
      section(href, "", true, '<p><img src="../Images/a.png" alt="Art"></p>');
    const { rendition, display } = mockBook(
      [
        image("Text/cover.xhtml"),
        image("Text/one.xhtml"),
        image("Text/two.xhtml"),
        image("Text/three.xhtml"),
        section("Text/story.xhtml", "Readable story text ".repeat(20)),
        image("Text/four.xhtml"),
        image("Text/five.xhtml"),
        // A new chapter starts with the story; the odd image page before it still shares
        // its spread with the story's first page rather than a blank one.
      ],
      [{ label: "Story", href: "Text/story.xhtml" }],
    );
    const { manager } = rendition;
    // EPUB.js's view manager: each view rounds its section up to whole spreads, and a
    // fixed-layout spread shows its second page through handleNextPrePaginated.
    type View = { section: { index: number }; settings: { forceEvenPages: boolean } };
    const views: View[] = [];
    const createView = vi.fn((shown: { index: number }) => ({
      section: shown,
      settings: { forceEvenPages: true },
    }));
    const handleNextPrePaginated = vi.fn();
    const prepend = vi.fn(async (shown: { index: number }) => {
      views.unshift(createView(shown));
    });
    const spine = (index: number) => ({ index });
    Object.assign(manager.layout, { divisor: 2 });
    Object.assign(manager, {
      views: { all: () => views, displayed: () => views, remove: vi.fn() },
      createView,
      handleNextPrePaginated,
      prepend,
    });
    const hooked = manager as unknown as {
      createView(section: { index: number }): View;
      handleNextPrePaginated(forceRight: boolean, section: unknown, action: unknown): unknown;
      prepend(section: { index: number }): Promise<unknown>;
    };
    const renderer = epubRendererFactory(id)();
    const contents = vi.fn();
    // The book opens on its first image page, before the pages are counted.
    views.push(createView(spine(1)));
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
      undefined,
      undefined,
      { fontSize: 16, pageLayout: "double" },
    );
    try {
      // Once counted, the page shown alone is shown again beside its partner.
      await vi.waitFor(() => expect(display).toHaveBeenLastCalledWith("Text/one.xhtml"));
      expect(display).toHaveBeenCalledTimes(2);
      expect(
        [0, 1, 2, 3, 4, 5, 6].map((index) => hooked.createView(spine(index)).settings),
      ).toEqual(
        [true, false, false, false, false, false, false].map((forceEvenPages) => ({
          forceEvenPages,
        })),
      );
      const action = vi.fn(async () => undefined);
      views.splice(0, views.length, createView(spine(1)));
      await hooked.handleNextPrePaginated(false, spine(1), action);
      expect(action).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ href: "Text/two.xhtml" }),
      );
      expect(handleNextPrePaginated).not.toHaveBeenCalled();
      // Opening the second page brings the first before it.
      views.splice(0, views.length, createView(spine(2)));
      await hooked.handleNextPrePaginated(false, spine(2), action);
      expect(prepend).toHaveBeenLastCalledWith(expect.objectContaining({ href: "Text/one.xhtml" }));
      // The cover keeps EPUB.js's own page handling; the odd page of a run brings the
      // chapter after it.
      await hooked.handleNextPrePaginated(false, spine(0), action);
      expect(handleNextPrePaginated).toHaveBeenCalledOnce();
      await hooked.handleNextPrePaginated(false, spine(3), action);
      expect(action).toHaveBeenLastCalledWith(
        expect.objectContaining({ href: "Text/story.xhtml" }),
      );
      action.mockClear();
      // Going back to a spread's second page shows its first one before it.
      views.splice(0, views.length);
      prepend.mockClear();
      await hooked.prepend(spine(6));
      expect(prepend.mock.calls.map(([shown]) => shown)).toEqual([
        spine(6),
        expect.objectContaining({ href: "Text/four.xhtml" }),
      ]);
      // The text after an odd image page brings that page before it as well.
      prepend.mockClear();
      await hooked.prepend(spine(4));
      expect(prepend.mock.calls.map(([shown]) => shown)).toEqual([
        spine(4),
        expect.objectContaining({ href: "Text/three.xhtml" }),
      ]);
      // A pair's first page has nothing before it.
      prepend.mockClear();
      await hooked.prepend(spine(5));
      expect(prepend).toHaveBeenCalledOnce();
      // In single pages, or in a window too narrow for a spread, every image page is alone.
      Object.assign(manager.layout, { divisor: 1 });
      expect(hooked.createView(spine(1)).settings.forceEvenPages).toBe(true);
      Object.assign(manager.layout, { divisor: 2 });
      views.splice(0, views.length, createView(spine(1)), createView(spine(2)));
      const shownBefore = display.mock.calls.length;
      // A change made while the paired page is still being shown applies when it ends.
      await renderer.setPresentation!({ fontSize: 16, pageLayout: "single" });
      await vi.waitFor(() =>
        expect(hooked.createView(spine(1)).settings.forceEvenPages).toBe(true),
      );
      await vi.waitFor(() => expect(display.mock.calls.length).toBeGreaterThan(shownBefore));
      expect(display).toHaveBeenLastCalledWith("Text/one.xhtml");
      await hooked.handleNextPrePaginated(false, spine(1), action);
      expect(action).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
    }
  });

  it("shows an image page left alone beside the first page of the text that follows it", async () => {
    const image = (href: string) =>
      section(href, "", true, '<p><img src="../Images/a.png" alt="Art"></p>');
    const { rendition } = mockBook([
      image("Text/cover.xhtml"),
      image("Text/art.xhtml"),
      section("Text/story.xhtml", "Readable story text ".repeat(20)),
    ]);
    const { manager } = rendition;
    const reframe = vi.fn();
    const createView = vi.fn((shown: { index: number }) => ({
      reframe,
      section: shown,
      settings: { forceEvenPages: true },
    }));
    // The image page fills the spread's first page and the text starts on its second.
    const views = [
      { section: { index: 1 }, offset: () => ({ left: 0, top: 0 }) },
      {
        section: { index: 2 },
        offset: () => ({ left: 720, top: 0 }),
        locationOf: () => ({ left: 1500, top: 0 }),
      },
    ];
    const scrollTo = vi.fn();
    const display = vi.fn(async () => undefined);
    const handleNextPrePaginated = vi.fn();
    Object.assign(manager.layout, { divisor: 2, pageWidth: 720, delta: 1440 });
    Object.assign(manager, {
      views: { all: () => views, displayed: () => views, remove: vi.fn() },
      createView,
      handleNextPrePaginated,
      prepend: vi.fn(async () => undefined),
      display,
      scrollTo,
    });
    const hooked = manager as unknown as {
      createView(section: { index: number }): {
        settings: { forceEvenPages: boolean };
        reframe(width: number, height: number): void;
      };
      handleNextPrePaginated(forceRight: boolean, section: unknown, action: unknown): unknown;
      display(section: { index: number }, target?: string): Promise<unknown>;
    };
    const contents = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
      undefined,
      undefined,
      { fontSize: 16, pageLayout: "double" },
    );
    try {
      await vi.waitFor(() =>
        expect(hooked.createView({ index: 2 }).settings.forceEvenPages).toBe(false),
      );
      expect(hooked.createView({ index: 1 }).settings.forceEvenPages).toBe(false);
      // The text takes an odd number of pages, so the two sections end on a whole spread.
      hooked.createView({ index: 2 }).reframe(1440, 780);
      expect(reframe).toHaveBeenLastCalledWith(2160, 780);
      hooked.createView({ index: 2 }).reframe(2160, 780);
      expect(reframe).toHaveBeenLastCalledWith(2160, 780);
      hooked.createView({ index: 1 }).reframe(1441, 780);
      expect(reframe).toHaveBeenLastCalledWith(720, 780);
      const action = vi.fn(async () => undefined);
      const [imageView, textView] = views;
      views.splice(0, views.length, imageView);
      await hooked.handleNextPrePaginated(false, { index: 1 }, action);
      expect(action).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ href: "Text/story.xhtml" }),
      );
      expect(handleNextPrePaginated).not.toHaveBeenCalled();
      views.push(textView);
      // A point in the text shows the spread holding it, a page after the text's own.
      await hooked.display({ index: 2 }, "epubcfi(/6/6!/4/2/1:0)");
      expect(display).toHaveBeenCalledWith({ index: 2 }, "epubcfi(/6/6!/4/2/1:0)");
      expect(scrollTo).toHaveBeenLastCalledWith(1440, 0, true);
      await hooked.display({ index: 2 });
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0, true);
    } finally {
      renderer.dispose();
    }
  });

  it("keeps the first page alone when the declared cover lies outside the reading order", async () => {
    const image = (href: string, linear = true) =>
      section(href, "", linear, '<p><img src="../Images/a.png" alt=""></p>');
    const { book, rendition } = mockBook([
      image("Text/cover.xhtml", false),
      image("Text/one.xhtml"),
      image("Text/two.xhtml"),
      image("Text/three.xhtml"),
      section("Text/story.xhtml", "Readable story text ".repeat(20)),
    ]);
    const { manager } = rendition;
    const styleSection = vi.mocked(book.spine.hooks.content.register);
    // EPUB.js measures a fitted page a rounded pixel wider than a fractional page width.
    const reframe = vi.fn();
    const createView = vi.fn((shown: { index: number }) => ({
      reframe,
      section: shown,
      settings: { forceEvenPages: true },
    }));
    Object.assign(manager.layout, { divisor: 2 });
    Object.assign(manager, {
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
      createView,
      handleNextPrePaginated: vi.fn(),
      prepend: vi.fn(async () => undefined),
    });
    const contents = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      contents,
      undefined,
      undefined,
      { fontSize: 16, pageLayout: "double" },
    );
    const hooked = manager as unknown as {
      createView(section: { index: number }): { settings: { forceEvenPages: boolean } };
    };
    try {
      await vi.waitFor(() => expect(contents).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(hooked.createView({ index: 2 }).settings.forceEvenPages).toBe(false),
      );
      expect(
        [1, 2, 3].map((index) => hooked.createView({ index }).settings.forceEvenPages),
      ).toEqual([true, false, false]);
      Object.assign(manager.layout, { pageWidth: 720.5 });
      (
        hooked.createView({ index: 3 }) as unknown as { reframe(w: number, h: number): void }
      ).reframe(721, 780);
      (
        hooked.createView({ index: 1 }) as unknown as { reframe(w: number, h: number): void }
      ).reframe(1441, 780);
      expect(reframe.mock.calls).toEqual([
        [720.5, 780],
        [1441, 780],
      ]);
      // An image page alone fills one spread, never a rounded pixel more.
      const cover = hooked.createView({ index: 1 }) as unknown as {
        contents: { document: Document };
        reframe(w: number, h: number): void;
      };
      cover.contents = { document: document.implementation.createHTMLDocument() };
      cover.contents.document.body.innerHTML = '<img data-komori-page-image="">';
      cover.reframe(2162, 780);
      expect(reframe).toHaveBeenLastCalledWith(1441, 780);
      // The page alone centers its image on the whole spread; a paired one on its page.
      const fitted = (index: number) => {
        const page = document.implementation.createHTMLDocument();
        page.body.innerHTML = '<div><img src="a.png"></div>';
        styleSection.mock.calls[0][0](page, { index });
        return page.querySelector("style[data-komori-page-image-fit]")?.textContent;
      };
      Object.assign(manager.layout, { delta: 1441 });
      expect(fitted(1)).toContain("width: 1441px !important; height: 780px !important");
      expect(fitted(2)).toContain("width: 720.5px !important; height: 780px !important");
    } finally {
      renderer.dispose();
    }
  });

  it("restores double-page width when a fitted single-page container grows", async () => {
    let resize!: () => void;
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect() {}
      },
    );
    const { rendition } = mockBook();
    const container = document.createElement("div");
    const host = document.createElement("div");
    container.append(host);
    let availableWidth = 700;
    Object.defineProperty(container, "clientWidth", { get: () => availableWidth });
    Object.defineProperty(host, "clientWidth", {
      get: () =>
        Math.min(availableWidth, parseFloat(host.style.getPropertyValue("--reader-max-width"))),
    });
    Object.defineProperty(host, "clientHeight", { get: () => 780 });
    const renderer = epubRendererFactory(id)();
    try {
      await renderer.mount(
        host,
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          maxWidth: 600,
          pageLayout: "double",
        },
      );
      expect(host.style.getPropertyValue("--reader-max-width")).toBe("640px");
      expect(observe).toHaveBeenCalledWith(container);
      rendition.manager.updateLayout.mockClear();
      availableWidth = 1066;
      resize();
      await vi.waitFor(() => expect(rendition.manager.updateLayout).toHaveBeenCalled());
      expect(host.style.getPropertyValue("--reader-max-width")).toBe("1280px");
    } finally {
      renderer.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("discovers real illustrated occurrences in reading order with path-safe labels and a bound", async () => {
    const sections = [
      section(
        "Text/one.xhtml",
        "",
        true,
        '<img src="../Images/private.png" alt="Cover"><svg><image href="../Images/private.png"/></svg>',
      ),
      section("Text/nonlinear.xhtml", "", false, '<img src="private.png">'),
      section("Text/many.xhtml", "", true, '<img src="image.png">'.repeat(501)),
    ];
    const { book, display } = mockBook(sections, [{ label: "Opening", href: "Text/one.xhtml" }]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const calls = display.mock.calls.length;
    const images = await renderer.listImages!(new AbortController().signal);
    expect(images.items).toHaveLength(500);
    expect(images.truncated).toBe(true);
    expect(images.items[0]).toEqual({
      id: expect.any(String),
      alt: "Cover",
      label: "Opening",
      section: 1,
    });
    expect(images.items[1].section).toBe(1);
    expect(images.items[2].section).toBe(3);
    expect(JSON.stringify(images)).not.toMatch(/private|xhtml|\.png|epubcfi/);
    expect(display).toHaveBeenCalledTimes(calls);
    expect(book.archive.request).not.toHaveBeenCalledWith(
      expect.stringContaining("Images"),
      "blob",
    );
    renderer.dispose();
  });

  it("resolves clicked displayed occurrences by section and ordinal without following rendered URLs", async () => {
    const first = section("first.xhtml", "", true, '<img src="repeat.png"><img src="repeat.png">');
    const second = section("second.xhtml", "", true, '<svg><image href="art.png"/></svg>');
    const { book, rendition, display } = mockBook([first, second]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const shown = document.implementation.createHTMLDocument();
    shown.body.innerHTML = '<img src="blob:derived"><img src="blob:derived">';
    rendition.getContents.mockReturnValue([{ document: shown, sectionIndex: 0 }] as never);
    const controller = new AbortController();
    const gallery = await renderer.listImages!(controller.signal);
    const reads = book.load.mock.calls.length;
    const selection = await renderer.imageAt!(shown.querySelectorAll("img")[1], controller.signal);
    expect(selection?.index).toBe(1);
    expect(selection?.items).toHaveLength(3);
    expect(selection?.items).toBe(gallery.items);
    expect(book.load).toHaveBeenCalledTimes(reads);
    expect(JSON.stringify(selection)).not.toMatch(/blob|xhtml|png/);
    expect(display).toHaveBeenCalledOnce();
    expect(await renderer.imageAt!(document.createElement("img"), controller.signal)).toBeNull();
    controller.abort();
    await expect(
      renderer.imageAt!(shown.querySelector("img")!, controller.signal),
    ).rejects.toThrow();
    renderer.dispose();
  });

  it("loads bounded adapter-owned raster URLs, refuses external/oversized resources and revokes on dispose", async () => {
    const first = section(
      "Text/one.xhtml",
      "",
      true,
      '<img src="../Images/private.png"><svg xmlns="http://www.w3.org/2000/svg"><image href="../Images/private.png"/></svg><img src="https://evil/private.png">',
    );
    const { book } = mockBook([first]);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:generated");
        static revokeObjectURL = vi.fn();
      },
    );
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    book.archive.request.mockResolvedValue(
      new Blob([new Uint8Array([137, 80, 78, 71, 0])]) as never,
    );
    const controller = new AbortController();
    const images = await renderer.listImages!(controller.signal);
    const resource = await renderer.loadImage!(images.items[0].id, "thumbnail", controller.signal);
    expect(resource).toEqual({
      url: "blob:generated",
      width: 320,
      height: 240,
      blob: expect.any(Blob),
    });
    expect(book.archive.request).toHaveBeenCalledWith("/Images/private.png", "blob");
    expect(renderBookImage).toHaveBeenCalledWith(
      expect.any(Blob),
      "thumbnail",
      expect.any(AbortSignal),
    );
    const framed = await renderer.loadImage!(images.items[1].id, "viewer", controller.signal);
    const drawing = vi.mocked(renderBookImage).mock.calls.at(-1)![0];
    expect(drawing.type).toBe("image/svg+xml");
    expect(await drawing.text()).toContain("data:image/png;base64,");
    // A drawing that only frames a picture copies and saves as that picture's own bytes.
    expect(framed.blob?.type).toBe("image/png");
    expect([...new Uint8Array(await framed.blob!.arrayBuffer())]).toEqual([137, 80, 78, 71, 0]);
    expect(vi.mocked(renderBookImage).mock.calls.at(-2)![0].type).toBe("image/png");
    // Reject an oversized/undecodable embedded raster before publishing its SVG.
    vi.mocked(renderBookImage).mockRejectedValueOnce(Error("Image dimensions unavailable"));
    await expect(
      renderer.loadImage!(images.items[1].id, "viewer", controller.signal),
    ).rejects.toThrow();
    const calls = book.archive.request.mock.calls.length;
    await expect(
      renderer.loadImage!(images.items[2].id, "viewer", controller.signal),
    ).rejects.toThrow();
    expect(book.archive.request).toHaveBeenCalledTimes(calls);
    Object.assign(book.archive, {
      zip: { file: vi.fn(() => ({ _data: { uncompressedSize: 17 * 1024 * 1024 } })) },
    });
    await expect(
      renderer.loadImage!(images.items[0].id, "viewer", controller.signal),
    ).rejects.toThrow();
    expect(book.archive.request).toHaveBeenCalledTimes(calls);
    renderer.releaseImage!("blob:foreign");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:foreign");
    renderer.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated");
    vi.unstubAllGlobals();
  });

  it("reports unreadable sections and rejects obsolete discovery, loads and destinations", async () => {
    const first = section("one.xhtml", "", true, '<img src="one.png">');
    const second = section("two.xhtml", "second");
    const { book, display } = mockBook([first, second]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    book.load.mockImplementation(async (url) => {
      if (url === "/two.xhtml") throw Error("private");
      return first.document;
    });
    const controller = new AbortController();
    const images = await renderer.listImages!(controller.signal);
    expect(images.failedSections).toBe(1);
    expect(images.items).toHaveLength(1);
    let finish!: (blob: Blob) => void;
    book.archive.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const pending = renderer.loadImage!(images.items[0].id, "viewer", controller.signal);
    controller.abort();
    finish(new Blob([new Uint8Array([137, 80, 78, 71])]));
    await expect(pending).rejects.toThrow();
    const calls = display.mock.calls.length;
    expect(await renderer.goToImage!(images.items[0].id, new AbortController().signal)).toBe(false);
    expect(display).toHaveBeenCalledTimes(calls);
    let resolve!: (document: Document) => void;
    book.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const listing = renderer.listImages!(new AbortController().signal);
    renderer.dispose();
    resolve(first.document);
    await expect(listing).rejects.toThrow();
  });

  it("jumps to an actual image element and publishes its location only on explicit navigation", async () => {
    const first = section("one.xhtml", "", true, '<p>before</p><img src="one.png"><p>after</p>');
    const { rendition, display } = mockBook([first]);
    const contents = {
      document: first.document,
      sectionIndex: 0,
      cfiFromRange: vi.fn(() => "epubcfi(image)"),
    };
    rendition.getContents.mockReturnValue([contents] as never);
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      binding,
    );
    const images = await renderer.listImages!(new AbortController().signal);
    const calls = display.mock.calls.length;
    expect(binding.onLocationChanged).not.toHaveBeenCalled();
    expect(await renderer.goToImage!(images.items[0].id, new AbortController().signal)).toBe(true);
    expect(display.mock.calls.length).toBeGreaterThan(calls);
    expect(display).toHaveBeenLastCalledWith(expect.stringMatching(/^one\.xhtml#komori/));
    renderer.dispose();
  });

  it("searches real linear text with bounded results and no paths, annotations or styling", async () => {
    const sections = [
      section(
        "private/one.xhtml",
        "",
        true,
        "<h1>Real chapter</h1><p>𠮷<ruby>読<rt>よ</rt></ruby><b>む</b> Latin</p><style>styling</style>",
      ),
      section("private/two.xhtml", "読む ".repeat(110)),
      section("private/nonlinear.xhtml", "excluded", false),
    ];
    const { book } = mockBook(sections, [{ label: "Real chapter", href: "private/one.xhtml" }]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const search = new AbortController();
    const result = await renderer.searchBook!("読む", "book", search.signal);
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.matches[0]).toEqual(
      expect.objectContaining({ label: "Real chapter", match: "読む", section: 1 }),
    );
    expect(JSON.stringify(result)).not.toMatch(/private|epubcfi|xhtml/);
    for (const query of ["よ", "styling", "excluded", "no matches"])
      expect((await renderer.searchBook!(query, "book", search.signal)).matches).toHaveLength(0);
    expect((await renderer.searchBook!("LATIN", "book", search.signal)).matches).toHaveLength(1);
    expect(book.load).toHaveBeenCalledWith("/private/one.xhtml");
    await expect(renderer.searchBook!("a".repeat(257), "book", search.signal)).rejects.toThrow();
    renderer.dispose();
  });

  it("rejects cancelled, replaced and disposed searches and jumps before display", async () => {
    const first = section("one.xhtml", "before match after");
    const { book, display } = mockBook([first]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const controller = new AbortController();
    const result = await renderer.searchBook!("match", "book", controller.signal);
    let resolve!: (value: Document) => void;
    book.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    display.mockClear();
    const jumping = renderer.goToSearchResult!(result.matches[0].id, controller.signal);
    controller.abort();
    resolve(first.document);
    expect(await jumping).toBe(false);
    expect(display).not.toHaveBeenCalled();
    const next = new AbortController();
    const fresh = await renderer.searchBook!("match", "book", next.signal);
    await renderer.searchBook!("after", "book", next.signal);
    expect(await renderer.goToSearchResult!(fresh.matches[0].id, next.signal)).toBe(false);
    book.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = renderer.searchBook!("match", "book", next.signal);
    renderer.dispose();
    resolve(first.document);
    await expect(pending).rejects.toThrow();
  });

  it("jumps to a match's actual text offset and publishes resume without including ruby", async () => {
    const original = section(
      "one.xhtml",
      "",
      true,
      "<p>before <ruby>読<rt>よ</rt></ruby>む after</p>",
    );
    const { rendition, display } = mockBook([original]);
    const binding = positionBinding();
    const contents = {
      document: original.document,
      sectionIndex: 0,
      cfiFromRange: vi.fn(
        (range: Range) => `epubcfi(${range.startContainer.textContent}:${range.startOffset})`,
      ),
    };
    rendition.getContents.mockReturnValue([contents] as never);
    rendition.currentLocation.mockReturnValue({
      start: { index: 0, href: "one.xhtml", displayed: { page: 1 } },
      end: { displayed: { page: 1, total: 1 } },
    } as never);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      binding,
    );
    const controller = new AbortController();
    const result = await renderer.searchBook!("読む", "book", controller.signal);
    display.mockClear();
    expect(await renderer.goToSearchResult!(result.matches[0].id, controller.signal)).toBe(true);
    expect(display).toHaveBeenCalledWith("epubcfi(読:0)");
    expect(binding.onLocationChanged).toHaveBeenCalled();
    expect(original.document.querySelector("rt")?.textContent).toBe("よ");
    renderer.dispose();
  });

  it("searches only the current authored chapter between anchors within one section", async () => {
    const original = section(
      "one.xhtml",
      "",
      true,
      '<h1 id="a">First</h1><p>match first</p><h1 id="b">Second</h1><p>match second</p>',
    );
    const { rendition } = mockBook(
      [original],
      [
        { label: "First", href: "one.xhtml#a" },
        { label: "Second", href: "one.xhtml#b" },
      ],
    );
    const range = original.document.createRange();
    range.setStart(original.document.querySelector("p")!.firstChild!, 0);
    rendition.getContents.mockReturnValue([
      { document: original.document, sectionIndex: 0, range: () => range, cfiFromRange: vi.fn() },
    ] as never);
    rendition.currentLocation.mockReturnValue({
      start: { index: 0, href: "one.xhtml", cfi: "epubcfi(current)", displayed: { page: 1 } },
      end: { displayed: { page: 1, total: 2 } },
    } as never);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const result = await renderer.searchBook!("match", "chapter", new AbortController().signal);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].label).toBe("First");
    expect(result.matches[0].after).toContain("first");
    renderer.dispose();
  });

  it("stops a cancelled jump after an in-flight display without publishing a late resume", async () => {
    const original = section("one.xhtml", "before match after");
    const { display } = mockBook([original]);
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      binding,
    );
    const controller = new AbortController();
    const result = await renderer.searchBook!("match", "book", controller.signal);
    let displayed!: () => void;
    let started!: () => void;
    const displaying = new Promise<void>((resolve) => {
      started = resolve;
    });
    display.mockClear();
    display.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          displayed = () => resolve(undefined);
          started();
        }),
    );
    const jumping = renderer.goToSearchResult!(result.matches[0].id, controller.signal);
    await displaying;
    controller.abort();
    displayed();
    expect(await jumping).toBe(false);
    expect(display).toHaveBeenCalledTimes(1);
    expect(binding.onLocationChanged).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("reports unreadable and oversized search text rather than a partial success", async () => {
    const original = section("one.xhtml", "match");
    const { book } = mockBook([original]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    book.load.mockRejectedValueOnce(Error("private/archive-entry"));
    await expect(
      renderer.searchBook!("match", "book", new AbortController().signal),
    ).rejects.toThrow();
    original.document.body.textContent = "x".repeat(4_000_001);
    await expect(
      renderer.searchBook!("missing", "book", new AbortController().signal),
    ).rejects.toThrow("Search text limit");
    renderer.dispose();
  });

  it("uses continuous scrolling and keeps EPUB.js cleanup from removing absent views", async () => {
    const { book, rendition } = mockBook();
    const container = document.createElement("div");
    const trim = vi.fn(async () => undefined);
    const erase = vi.fn();
    const shown: Array<{
      element: HTMLElement;
      section: { index: number; prev(): null; next(): null };
    }> = [];
    Object.assign(rendition.manager, {
      container,
      views: { all: () => shown, displayed: () => shown, remove: vi.fn() },
      trim,
      erase,
    });
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(book.renderTo).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      // An unbounded offset has EPUB.js lay out and keep every linear section.
      expect.objectContaining({
        manager: "continuous",
        flow: "scrolled",
        offset: Number.POSITIVE_INFINITY,
      }),
    );
    const guarded = rendition.manager as typeof rendition.manager & {
      trim(): Promise<unknown>;
      erase(view: (typeof shown)[number]): void;
    };
    await guarded.trim();
    expect(trim).not.toHaveBeenCalled();
    const view = {
      element: document.createElement("div"),
      section: { index: 0, prev: () => null, next: () => null },
    };
    container.append(view.element);
    shown.push(view);
    await guarded.trim();
    expect(trim).toHaveBeenCalledOnce();
    shown.pop();
    guarded.erase(view);
    expect(erase).not.toHaveBeenCalled();
    shown.push(view);
    guarded.erase(view);
    expect(erase).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("shows a continuous section only when it is not already shown", async () => {
    const { rendition } = mockBook();
    const element = document.createElement("div");
    const iframe = document.createElement("iframe");
    element.append(iframe);
    const show = vi.fn(() => {
      element.style.visibility = "visible";
      iframe.style.visibility = "visible";
    });
    const view = {
      element,
      iframe,
      section: { index: 0, prev: () => null, next: () => null },
      display: vi.fn(async () => undefined),
      show,
    };
    Object.assign(rendition.manager, {
      container: document.createElement("div"),
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
      createView: () => view,
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, viewMode: "continuous" },
    );
    const created = (rendition.manager as unknown as { createView(): typeof view }).createView();
    // EPUB.js shows every view again after each section it adds, forcing a layout each time.
    created.show();
    created.show();
    created.show();
    expect(show).toHaveBeenCalledOnce();
    element.style.visibility = "hidden";
    created.show();
    expect(show).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it("waits for a continuous section's display under way instead of rendering it again", async () => {
    const { rendition } = mockBook();
    // EPUB.js loads the section again on each request, and its frame's load event ends
    // only the latest one.
    let load = () => {};
    const display = vi.fn(
      () =>
        new Promise((resolve) => {
          load = () => resolve(view);
        }),
    );
    const view = {
      element: document.createElement("div"),
      section: { index: 0, prev: () => null, next: () => null },
      display,
    };
    const destroy = vi.fn();
    Object.assign(rendition.manager, {
      container: document.createElement("div"),
      views: { all: () => [], displayed: () => [], remove: vi.fn(), destroy },
      createView: () => view,
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, viewMode: "continuous" },
    );
    const manager = rendition.manager as unknown as {
      createView(): typeof view;
      views: { destroy(view: unknown): void };
    };
    const created = manager.createView();
    const settled = (promise: Promise<unknown>) => {
      const outcome = { value: undefined as unknown, error: undefined as unknown };
      promise.then(
        (value) => (outcome.value = value),
        (error: unknown) => (outcome.error = error),
      );
      return outcome;
    };
    // EPUB.js's display adds the section, and an update asks for it while it renders.
    const added = settled(created.display());
    const updated = settled(created.display());
    load();
    await vi.waitFor(() => expect(added.value).toBe(view));
    expect(updated.value).toBe(view);
    expect(display).toHaveBeenCalledOnce();
    // Removing the view ends every display waiting for it.
    const scrolled = settled(created.display());
    const again = settled(created.display());
    manager.views.destroy(created);
    await vi.waitFor(() => expect(scrolled.error).toEqual(new Error("Section removed")));
    expect(again.error).toEqual(new Error("Section removed"));
    expect(destroy).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("lets EPUB.js's queue go on after a section removed while it renders", async () => {
    const { rendition } = mockBook();
    // The section's frame never loads: it was removed before EPUB.js finished rendering it.
    const view = {
      element: document.createElement("div"),
      section: { index: 0, prev: () => null, next: () => null },
      display: vi.fn(() => new Promise(() => {})),
    };
    const queue = new Queue(rendition.manager);
    Object.assign(rendition.manager, {
      container: document.createElement("div"),
      views: { all: () => [], displayed: () => [], remove: vi.fn(), destroy: vi.fn() },
      createView: () => view,
      q: queue,
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, viewMode: "continuous" },
    );
    const manager = rendition.manager as unknown as {
      createView(): typeof view;
      views: { destroy(view: unknown): void };
    };
    const created = manager.createView();
    // EPUB.js renders a section it adds as a task of its queue, and a jump waits behind it.
    const rendering = queue.enqueue(() => created.display()) as Promise<unknown>;
    rendering.catch(() => undefined);
    const navigation = vi.fn();
    void queue.enqueue(navigation);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigation).not.toHaveBeenCalled();
    manager.views.destroy(created);
    await vi.waitFor(() => expect(navigation).toHaveBeenCalledOnce());
    await expect(rendering).rejects.toThrow("Section removed");
    renderer.dispose();
  });

  it("keeps the text in view in place when a continuous section before it changes size or is removed", async () => {
    const observers: Array<{
      callback: (entries: Array<{ target: Element }>) => void;
      targets: Set<unknown>;
    }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly entry: (typeof observers)[number];
        constructor(callback: (entries: Array<{ target: Element }>) => void) {
          this.entry = { callback, targets: new Set() };
          observers.push(this.entry);
        }
        observe(target: unknown) {
          this.entry.targets.add(target);
        }
        unobserve(target: unknown) {
          this.entry.targets.delete(target);
        }
        disconnect() {
          this.entry.targets.clear();
        }
      },
    );
    const { rendition } = mockBook([
      section("Text/one.xhtml", "一"),
      section("Text/two.xhtml", "二"),
      section("Text/three.xhtml", "三"),
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 500, left: 0, right: 100, width: 100, height: 500 }) as DOMRect,
    );
    // jsdom has no layout: the sections stack from the top of the scrolled container.
    const heights = [300, 400, 300];
    const shown: Array<{
      element: HTMLElement;
      section: { index: number; prev(): null; next(): null };
      display: () => Promise<undefined>;
    }> = [];
    const views = heights.map((_, index) => {
      const element = document.createElement("div");
      const view = {
        element,
        section: { index, prev: () => null, next: () => null },
        display: async () => undefined,
      };
      vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
        const before = shown.slice(0, shown.indexOf(view));
        const top =
          before.reduce((sum, other) => sum + heights[other.section.index], 0) -
          container.scrollTop;
        const height = heights[index];
        return { top, bottom: top + height, left: 0, right: 100, width: 100, height } as DOMRect;
      });
      return view;
    });
    let created = 0;
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: {
        all: () => shown,
        displayed: () => shown,
        remove: (view: (typeof shown)[number]) => {
          shown.splice(shown.indexOf(view), 1);
          view.element.remove();
        },
      },
      createView: () => views[created++],
      erase: vi.fn(),
    });
    const renderer = epubRendererFactory(id)();
    try {
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      );
      // The browser's own scroll anchoring would add to the Reader's compensation.
      expect(container.style.overflowAnchor).toBe("none");
      const manager = rendition.manager as unknown as {
        createView(): (typeof shown)[number];
        erase(view: (typeof shown)[number], above: boolean): void;
      };
      for (let i = 0; i < 3; i++) {
        const view = manager.createView();
        shown.push(view);
        container.append(view.element);
      }
      const resized = (...changed: number[]) => {
        const entries = changed.map((index) => ({ target: views[index].element }));
        for (const { callback, targets } of observers)
          if (entries.some(({ target }) => targets.has(target))) callback(entries);
      };
      // The reading point is 50px into the second section.
      container.scrollTop = 350;
      resized(0, 1, 2);
      expect(container.scrollTop).toBe(350);
      const secondTop = () => views[1].element.getBoundingClientRect().top;

      // The first section grows once it is laid out, and shrinks again.
      heights[0] = 450;
      resized(0);
      expect(secondTop()).toBe(-50);
      heights[0] = 250;
      resized(0);
      expect(secondTop()).toBe(-50);
      // The section holding the reading point, and those after it, change nothing.
      heights[1] = 500;
      heights[2] = 600;
      resized(1, 2);
      expect(secondTop()).toBe(-50);

      // Removing the first section keeps the second where it is.
      manager.erase(views[0], true);
      expect(shown).toEqual([views[1], views[2]]);
      expect(secondTop()).toBe(-50);
      expect(container.scrollTop).toBe(50);
    } finally {
      renderer.dispose();
      container.remove();
    }
  });

  it.each(["continuous", "semi-continuous"] as const)(
    "sizes vertical %s sections to their content instead of rounding to page widths",
    async (viewMode) => {
      const { rendition } = mockBook();
      const iframe = document.createElement("iframe");
      const textWidth = vi.fn(() => 580);
      const reframe = vi.fn((width: number, height: number) => {
        iframe.style.width = `${width}px`;
        iframe.style.height = `${height}px`;
      });
      const expand = vi.fn(() => reframe(Math.ceil(textWidth() / 680) * 680, 773));
      const view = {
        element: document.createElement("div"),
        iframe,
        lockedHeight: 773,
        contents: { document, textWidth },
        settings: { axis: "horizontal" },
        section: { index: 0, prev: () => null, next: () => null },
        display: vi.fn(async () => undefined),
        expand,
        reframe,
      };
      Object.assign(rendition.manager, {
        container: document.createElement("div"),
        views: { all: () => [], displayed: () => [], remove: vi.fn() },
        createView: () => view,
      });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 26, viewMode, writingMode: "vertical" },
      );
      const created = (rendition.manager as unknown as { createView(): typeof view }).createView();
      created.expand();
      expect(reframe).toHaveBeenLastCalledWith(581, 773);
      expect(expand).not.toHaveBeenCalled();
      created.expand();
      expect(reframe).toHaveBeenCalledOnce();
      // A long text section followed by an illustration formerly left 464px blank.
      textWidth.mockReturnValue(6335);
      created.expand();
      expect(reframe).toHaveBeenLastCalledWith(6336, 773);
      view.lockedHeight = 600;
      created.expand();
      expect(reframe).toHaveBeenLastCalledWith(6336, 600);
      textWidth.mockReturnValue(Number.NaN);
      created.expand();
      expect(expand).toHaveBeenCalledOnce();
      // Horizontal scrolling documents and their existing height sizing stay owned
      // by EPUB.js.
      view.settings.axis = "vertical";
      textWidth.mockReturnValue(580);
      created.expand();
      expect(expand).toHaveBeenCalledTimes(2);
      renderer.dispose();
    },
  );

  it("counts a page's side padding once when a paginated section's text starts at its edge", async () => {
    const { rendition } = mockBook();
    const register = vi.fn();
    Object.assign(rendition, { hooks: { content: { register } } });
    // EPUB.js: the text's width plus the body's side padding, then whole pages.
    const range = { left: 0, right: 57580 };
    const contents = {
      document,
      textWidth: () => Math.round(range.right - range.left) + 40,
      resizeCheck: vi.fn(),
    };
    document.body.style.paddingLeft = "20px";
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: () => ({ left: range.left, right: range.right }) as DOMRect,
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 20, viewMode: "paginated" },
    );
    for (const [hook] of register.mock.calls) await hook(contents);
    // Forty full columns end at the fortieth page, not before an empty one.
    expect(contents.textWidth()).toBe(57600);
    expect(contents.resizeCheck).toHaveBeenCalled();
    // Text that starts after the padding keeps EPUB.js's measure.
    range.left = 20;
    expect(contents.textWidth()).toBe(57600);
    range.right = 57700;
    expect(contents.textWidth()).toBe(57720);
    // A glyph overhanging the body's left edge adds nothing to the pages after the text.
    range.left = -2;
    range.right = 57580;
    expect(contents.textWidth()).toBe(57600);
    // Right-to-left columns run from the body's right edge: every page after the first
    // lies to the left of the body, and the padding is measured on the right.
    document.body.style.direction = "rtl";
    document.body.style.paddingRight = "20px";
    vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1440,
    } as DOMRect);
    range.left = 1440 - 57580;
    range.right = 1440;
    expect(contents.textWidth()).toBe(57600);
    range.right = 1420;
    expect(contents.textWidth()).toBe(57600);
    range.right = 1442;
    expect(contents.textWidth()).toBe(57600);
    vi.mocked(document.body.getBoundingClientRect).mockRestore();
    document.body.style.direction = "";
    document.body.style.paddingRight = "";
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    document.body.style.paddingLeft = "";
    renderer.dispose();
  });

  it.each([
    { fixed: false, writingMode: "horizontal" as const },
    { fixed: true, writingMode: "vertical" as const },
  ])("retains EPUB.js section sizing for $writingMode text (fixed: $fixed)", async (options) => {
    const { book, rendition } = mockBook();
    if (options.fixed)
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
    const expand = vi.fn();
    const view = {
      element: document.createElement("div"),
      iframe: document.createElement("iframe"),
      lockedHeight: 773,
      contents: { document, textWidth: () => 580 },
      settings: { axis: "horizontal" },
      section: { index: 0, prev: () => null, next: () => null },
      display: vi.fn(async () => undefined),
      expand,
      reframe: vi.fn(),
    };
    Object.assign(rendition.manager, {
      container: document.createElement("div"),
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
      createView: () => view,
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 26, viewMode: "continuous", writingMode: options.writingMode },
    );
    const created = (rendition.manager as unknown as { createView(): typeof view }).createView();
    created.expand();
    expect(expand).toHaveBeenCalledOnce();
    expect(view.reframe).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("jumps within a continuous book laid out whole without clearing its sections", async () => {
    const old = Object.assign(section("Text/old.xhtml", "Old text"), { index: 0 });
    const target = Object.assign(section("Text/new.xhtml", "Target text"), { index: 1 });
    const { rendition } = mockBook([old, target], [{ label: "Target", href: "Text/new.xhtml" }]);
    const container = document.createElement("div");
    const targetElement = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    vi.spyOn(targetElement, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 200 - container.scrollTop,
          bottom: 300 - container.scrollTop,
          left: 0,
          right: 100,
          width: 100,
          height: 100,
        }) as DOMRect,
    );
    const shown = { document: target.document, sectionIndex: 1, cfiFromRange: vi.fn() };
    const update = vi.fn(() => {
      if (container.scrollTop >= 200) rendition.getContents.mockReturnValue([shown] as never);
    });
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: {
        all: () => [{ element: targetElement, section: { index: 1 } }],
        displayed: () => [],
        remove: vi.fn(),
      },
      update,
    });
    const renderer = epubRendererFactory(id)();
    const saved = positionBinding(Promise.resolve({ spineIndex: 1, progress: 0.3 }));
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        saved,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(container.scrollTop).toBe(200);
    container.scrollTop = 500;
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    // Every section stays laid out, so the jump only scrolls to its target.
    expect(rendition.manager.clear).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(200);
    expect(update).toHaveBeenCalled();
    renderer.dispose();
  });

  it("aligns an image-only continuous contents target by its box", async () => {
    const target = Object.assign(section("Text/one.xhtml", ""), { index: 0 });
    const { rendition } = mockBook(
      [target],
      [{ label: "Illustrated heading", href: "Text/one.xhtml#heading" }],
    );
    const container = document.createElement("div");
    const iframe = document.createElement("iframe");
    container.append(iframe);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    contentDocument.body.innerHTML = '<section id="heading"><img alt="Chapter heading"></section>';
    const anchor = contentDocument.getElementById("heading")!;
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 50 - container.scrollTop,
          bottom: 100 - container.scrollTop,
          left: 0,
          right: 50,
          width: 50,
          height: 50,
        }) as DOMRect,
    );
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([
      { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
    ] as never);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    expect(container.scrollTop).toBe(50);
    renderer.dispose();
    container.remove();
  });

  it("restores a continuous point before a heading holding only an image to that heading", async () => {
    const target = Object.assign(section("Text/one.xhtml", ""), { index: 0 });
    const { rendition } = mockBook([target]);
    const container = document.createElement("div");
    const iframe = document.createElement("iframe");
    container.append(iframe);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    // The saved point, half of the text, falls in the whitespace before the heading, and
    // is found again at the heading's image.
    contentDocument.body.innerHTML = '<p>abcdef</p>\n\n<h1><img alt=""></h1><p>ghij</p>';
    const image = contentDocument.querySelector("h1 > img")!;
    vi.spyOn(image, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 80 - container.scrollTop,
          bottom: 120 - container.scrollTop,
          left: 0,
          right: 50,
          width: 50,
          height: 40,
        }) as DOMRect,
    );
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([
      { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
    ] as never);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(Promise.resolve({ spineIndex: 0, progress: 0.5 })),
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(container.scrollTop).toBe(80);
    renderer.dispose();
    container.remove();
  });

  it.each([
    { before: "", after: "efgh" },
    { before: '<p id="before">abcd</p>', after: "efgh" },
    { before: '<p id="before">abcd</p>', after: "　efgh" },
  ])(
    "reopens continuous text after a partly visible heading image while keeping an image position ($before, $after)",
    async ({ before, after }) => {
      const target = Object.assign(section("Text/one.xhtml", ""), { index: 0 });
      const { rendition } = mockBook([target]);
      const container = document.createElement("div");
      const viewElement = document.createElement("div");
      const iframe = document.createElement("iframe");
      viewElement.append(iframe);
      container.append(viewElement);
      document.body.append(container);
      const contentDocument = iframe.contentDocument!;
      contentDocument.body.innerHTML = `${before}<h1><img alt="Chapter name"></h1><p id="after">${after}</p>`;
      const image = contentDocument.querySelector("img")!;
      vi.spyOn(image, "getBoundingClientRect").mockImplementation(
        () => ({ top: 20, bottom: 182, left: 0, right: 50, width: 50, height: 162 }) as DOMRect,
      );
      vi.spyOn(container, "getBoundingClientRect").mockImplementation(
        () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
      );
      const sectionRect = () =>
        ({
          top: -container.scrollTop,
          bottom: 250 - container.scrollTop,
          left: 0,
          right: 100,
          width: 100,
          height: 250,
        }) as DOMRect;
      vi.spyOn(viewElement, "getBoundingClientRect").mockImplementation(sectionRect);
      vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(sectionRect);
      const createRange = contentDocument.createRange.bind(contentDocument);
      const decorate = (range: Range): Range => {
        const clone = range.cloneRange.bind(range);
        range.cloneRange = () => decorate(clone());
        range.getClientRects = () => {
          const top =
            range.startContainer.nodeType === Node.ELEMENT_NODE
              ? range.startContainer.nodeName === "H1" || range.startContainer.nodeName === "IMG"
                ? 20
                : range.startContainer.nodeName === "BODY" && !before
                  ? 20
                  : 0
              : range.startContainer.parentElement?.id === "before"
                ? 0
                : 188;
          const height = range.startContainer.nodeType === Node.ELEMENT_NODE ? 162 : 20;
          return [
            {
              top,
              bottom: top + height,
              left: 0,
              right: 10,
              width: 10,
              height,
            },
          ] as unknown as DOMRectList;
        };
        return range;
      };
      vi.spyOn(contentDocument, "createRange").mockImplementation(() => decorate(createRange()));
      const view = {
        element: viewElement,
        section: { index: 0, prev: () => null, next: () => null },
        contents: { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
      };
      Object.assign(rendition.manager, {
        container,
        settings: { axis: "vertical", direction: "ltr" },
        views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
      });
      rendition.getContents.mockReturnValue([view.contents] as never);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
          undefined,
          { fontSize: 16, viewMode: "continuous" },
        ),
      ).toBe("ready");
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() =>
        expect(binding.onLocationChanged).toHaveBeenCalledWith(
          expect.objectContaining({ spineIndex: 0, progress: before ? 4 / (4 + after.length) : 0 }),
        ),
      );
      const imageLocator = binding.onLocationChanged.mock.lastCall![0];
      // The image is still 77px inside a 100px reading area, but its midpoint is
      // behind the area and the first text line is visible near the far edge.
      container.scrollTop = 105;
      container.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() =>
        expect(binding.onLocationChanged.mock.lastCall?.[0].progress).toBeGreaterThan(
          imageLocator.progress,
        ),
      );
      const textLocator = binding.onLocationChanged.mock.lastCall![0];
      renderer.dispose();

      for (const [locator, expected] of [
        [imageLocator, 20],
        [textLocator, 188],
      ] as const) {
        container.scrollTop = 0;
        const reopened = epubRendererFactory(id)();
        expect(
          await reopened.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            positionBinding(Promise.resolve(locator)),
            undefined,
            { fontSize: 16, viewMode: "continuous" },
          ),
        ).toBe("ready");
        expect(container.scrollTop).toBe(expected);
        reopened.dispose();
      }
      container.remove();
    },
  );

  it("publishes the first visible character after continuous scrolling settles", async () => {
    const { rendition } = mockBook([
      Object.assign(section("Text/one.xhtml", "abcdefghij"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    const viewElement = document.createElement("div");
    const iframe = document.createElement("iframe");
    viewElement.append(iframe);
    container.append(viewElement);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    contentDocument.body.textContent = "abcdefghij";
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    const sectionRect = () =>
      ({
        top: -container.scrollTop,
        bottom: 200 - container.scrollTop,
        left: 0,
        right: 100,
        width: 100,
        height: 200,
      }) as DOMRect;
    vi.spyOn(viewElement, "getBoundingClientRect").mockImplementation(sectionRect);
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(sectionRect);
    const createRange = contentDocument.createRange.bind(contentDocument);
    const decorate = (range: Range): Range => {
      const clone = range.cloneRange.bind(range);
      range.cloneRange = () => decorate(clone());
      range.getClientRects = () =>
        [
          {
            top: range.startOffset * 20,
            bottom: range.endOffset * 20,
            left: 0,
            right: 10,
            width: 10,
            height: (range.endOffset - range.startOffset) * 20,
          },
        ] as unknown as DOMRectList;
      return range;
    };
    vi.spyOn(contentDocument, "createRange").mockImplementation(() => {
      return decorate(createRange());
    });
    const view = {
      element: viewElement,
      section: { index: 0, prev: () => null, next: () => null },
      contents: { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
    };
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([view.contents] as never);
    const position = positionBinding();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        position,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    renderer.scrollBy?.(60);
    container.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(position.onLocationChanged).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(position.onLocationChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
    );
    await renderer.setPresentation?.({ fontSize: 17, viewMode: "continuous" });
    expect(container.scrollTop).toBe(60);
    expect(position.onLocationChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
    );
    renderer.dispose();
    container.remove();
  });

  it("publishes where a continuous scroll stopped when asked before it settles", async () => {
    const { rendition } = mockBook([
      Object.assign(section("Text/one.xhtml", "abcdefghij"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    const viewElement = document.createElement("div");
    const iframe = document.createElement("iframe");
    viewElement.append(iframe);
    container.append(viewElement);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    contentDocument.body.textContent = "abcdefghij";
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    const sectionRect = () =>
      ({
        top: -container.scrollTop,
        bottom: 200 - container.scrollTop,
        left: 0,
        right: 100,
        width: 100,
        height: 200,
      }) as DOMRect;
    vi.spyOn(viewElement, "getBoundingClientRect").mockImplementation(sectionRect);
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(sectionRect);
    const createRange = contentDocument.createRange.bind(contentDocument);
    const decorate = (range: Range): Range => {
      const clone = range.cloneRange.bind(range);
      range.cloneRange = () => decorate(clone());
      range.getClientRects = () =>
        [
          {
            top: range.startOffset * 20,
            bottom: range.endOffset * 20,
            left: 0,
            right: 10,
            width: 10,
            height: (range.endOffset - range.startOffset) * 20,
          },
        ] as unknown as DOMRectList;
      return range;
    };
    vi.spyOn(contentDocument, "createRange").mockImplementation(() => decorate(createRange()));
    const view = {
      element: viewElement,
      section: { index: 0, prev: () => null, next: () => null },
      contents: { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
    };
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([view.contents] as never);
    const position = positionBinding();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        position,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    // Nothing has scrolled since the book was shown.
    renderer.settlePosition?.();
    expect(position.onLocationChanged).not.toHaveBeenCalled();

    renderer.scrollBy?.(60);
    container.dispatchEvent(new Event("scroll"));
    renderer.settlePosition?.();
    expect(position.onLocationChanged).toHaveBeenCalledOnce();
    expect(position.onLocationChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
    );
    // The settle that follows finds that point published already.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(position.onLocationChanged).toHaveBeenCalledOnce();
    renderer.dispose();
    container.remove();
  });

  it("keeps a continuous reading point that EPUB.js's own resize display scrolls away from", async () => {
    const observers: Array<{ callback: () => void; targets: unknown[] }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly entry: { callback: () => void; targets: unknown[] };
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(target: unknown) {
          this.entry.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const { rendition } = mockBook([
      Object.assign(section("Text/one.xhtml", "abcdefghij"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    const viewElement = document.createElement("div");
    const iframe = document.createElement("iframe");
    viewElement.append(iframe);
    container.append(viewElement);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    contentDocument.body.textContent = "abcdefghij";
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    const sectionRect = () =>
      ({
        top: -container.scrollTop,
        bottom: 200 - container.scrollTop,
        left: 0,
        right: 100,
        width: 100,
        height: 200,
      }) as DOMRect;
    vi.spyOn(viewElement, "getBoundingClientRect").mockImplementation(sectionRect);
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(sectionRect);
    const createRange = contentDocument.createRange.bind(contentDocument);
    const decorate = (range: Range): Range => {
      const clone = range.cloneRange.bind(range);
      range.cloneRange = () => decorate(clone());
      range.getClientRects = () =>
        [
          {
            top: range.startOffset * 20,
            bottom: range.endOffset * 20,
            left: 0,
            right: 10,
            width: 10,
            height: (range.endOffset - range.startOffset) * 20,
          },
        ] as unknown as DOMRectList;
      return range;
    };
    vi.spyOn(contentDocument, "createRange").mockImplementation(() => decorate(createRange()));
    const view = {
      element: viewElement,
      section: { index: 0, prev: () => null, next: () => null },
      contents: { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
    };
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([view.contents] as never);
    const host = document.createElement("div");
    const size = { width: 1066, height: 780 };
    Object.defineProperty(host, "clientWidth", { get: () => size.width });
    Object.defineProperty(host, "clientHeight", { get: () => size.height });
    const followHost = () => observers.find(({ targets }) => targets.includes(host))!.callback();
    // EPUB.js answers a window resize with its own display, which scrolls to the start of
    // the paragraph it last reported (here a later one), then relocates.
    const resize = (width: number, scrollTop: number) => {
      size.width = width;
      rendition.emit("resized");
      container.scrollTop = scrollTop;
      container.dispatchEvent(new Event("scroll"));
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const position = positionBinding();
    const renderer = epubRendererFactory(id)();
    try {
      expect(
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          position,
          undefined,
          { fontSize: 16, viewMode: "continuous" },
        ),
      ).toBe("ready");
      renderer.scrollBy?.(60);
      container.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() =>
        expect(position.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
        ),
      );

      // The scroll settles after EPUB.js relocates but before the host's size is followed.
      resize(900, 160);
      await wait(150);
      rendition.emit("relocated");
      followHost();
      await wait(400);
      expect(container.scrollTop).toBe(60);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
      );

      // Resizing there and back leaves the host at its size, but not the reading point.
      resize(1066, 120);
      resize(900, 180);
      await wait(150);
      rendition.emit("relocated");
      followHost();
      await wait(400);
      expect(container.scrollTop).toBe(60);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 0.3 }),
      );
      for (const progress of [0.6, 0.8, 0.9])
        expect(position.onLocationChanged).not.toHaveBeenCalledWith(
          expect.objectContaining({ progress }),
        );
    } finally {
      renderer.dispose();
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the reading point when switching between continuous and paginated view", async () => {
    const { book, rendition, display } = mockBook([
      Object.assign(section("Text/one.xhtml", "abcdefghij"), { index: 0 }),
    ]);
    const destroyRendition = vi.fn();
    Object.assign(rendition, { destroy: destroyRendition });
    const container = document.createElement("div");
    const viewElement = document.createElement("div");
    const iframe = document.createElement("iframe");
    viewElement.append(iframe);
    container.append(viewElement);
    document.body.append(container);
    const contentDocument = iframe.contentDocument!;
    contentDocument.body.textContent = "abcdefghij";
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect,
    );
    const sectionRect = () =>
      ({
        top: -container.scrollTop,
        bottom: 200 - container.scrollTop,
        left: 0,
        right: 100,
        width: 100,
        height: 200,
      }) as DOMRect;
    vi.spyOn(viewElement, "getBoundingClientRect").mockImplementation(sectionRect);
    vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(sectionRect);
    // Each character is one 20px line.
    const createRange = contentDocument.createRange.bind(contentDocument);
    const decorate = (range: Range): Range => {
      const clone = range.cloneRange.bind(range);
      range.cloneRange = () => decorate(clone());
      range.getClientRects = () =>
        [
          {
            top: range.startOffset * 20,
            bottom: range.endOffset * 20,
            left: 0,
            right: 10,
            width: 10,
            height: (range.endOffset - range.startOffset) * 20,
          },
        ] as unknown as DOMRectList;
      return range;
    };
    vi.spyOn(contentDocument, "createRange").mockImplementation(() => decorate(createRange()));
    const contents = {
      document: contentDocument,
      sectionIndex: 0,
      cfiFromRange: vi.fn((range: Range) => `epubcfi(offset-${range.startOffset})`),
    };
    const view = {
      element: viewElement,
      section: { index: 0, prev: () => null, next: () => null },
      contents,
    };
    Object.assign(rendition.manager, {
      container,
      settings: { axis: "vertical", direction: "ltr" },
      views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
    });
    rendition.getContents.mockReturnValue([contents] as never);
    const position = positionBinding();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        position,
        undefined,
        { fontSize: 16, viewMode: "continuous" },
      ),
    ).toBe("ready");
    renderer.scrollBy?.(60);
    container.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(position.onLocationChanged).toHaveBeenCalled(), {
      timeout: 1000,
    });

    // Paginated view renders the book again and shows the page of the fourth character.
    display.mockClear();
    await renderer.setPresentation?.({ fontSize: 16 });
    expect(destroyRendition).toHaveBeenCalledOnce();
    expect(book.renderTo).toHaveBeenCalledTimes(2);
    expect(book.renderTo).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.not.objectContaining({ manager: "continuous" }),
    );
    expect(display).toHaveBeenCalledWith("Text/one.xhtml");
    expect(display).toHaveBeenLastCalledWith("epubcfi(offset-3)");

    // Continuous view again scrolls that character to the top of the reading area.
    container.scrollTop = 0;
    await renderer.setPresentation?.({ fontSize: 16, viewMode: "continuous" });
    expect(book.renderTo).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      // An unbounded offset has EPUB.js lay out and keep every linear section.
      expect.objectContaining({
        manager: "continuous",
        flow: "scrolled",
        offset: Number.POSITIVE_INFINITY,
      }),
    );
    expect(container.scrollTop).toBe(60);
    renderer.dispose();
    container.remove();
  });

  it("scrolls continuous vertical text right to left with its margin at the reading area's sides", async () => {
    const { book, rendition } = mockBook([
      Object.assign(section("Text/one.xhtml", "本文です。"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    Object.assign(rendition.manager, {
      container,
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    const host = document.createElement("div");
    const turns = vi.fn();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        host,
        new AbortController().signal,
        turns,
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, writingMode: "vertical", viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(rendition.settings.direction).toBe("rtl");
    expect(host.style.getPropertyValue("--reader-side-inset")).toBe("20px");
    // Reading on moves left; reading back moves right.
    container.scrollLeft = 0;
    renderer.scrollBy?.(-100);
    expect(container.scrollLeft).toBe(100);
    // The Reader's own scrollbar reads and moves it from the right end.
    Object.defineProperty(container, "scrollWidth", { configurable: true, value: 3000 });
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    const scrolled = vi.fn();
    const unwatch = renderer.watchScroll!(scrolled);
    container.scrollLeft = -500;
    container.dispatchEvent(new Event("scroll"));
    expect(scrolled).toHaveBeenCalledOnce();
    expect(renderer.scrollMetrics?.()).toEqual({
      axis: "horizontal",
      reversed: true,
      position: 500,
      length: 2000,
      visible: 1000,
    });
    renderer.scrollToPosition?.(2500);
    expect(container.scrollLeft).toBe(-2000);
    unwatch();
    container.dispatchEvent(new Event("scroll"));
    expect(scrolled).toHaveBeenCalledOnce();
    container.scrollLeft = 0;

    await renderer.setPresentation?.({
      fontSize: 16,
      writingMode: "vertical",
      viewMode: "continuous",
      sideMargin: 48,
    });
    expect(host.style.getPropertyValue("--reader-side-inset")).toBe("48px");
    expect(turns).toHaveBeenLastCalledWith(
      expect.objectContaining({ forwardArrow: "ArrowLeft", scrollAxis: "horizontal" }),
    );
    // Paginated vertical pages take the margin inside each page instead. EPUB.js sizes
    // its pages to the host as it attaches, so the inset is gone by then; otherwise the
    // pages' last lines would lie outside views as narrow as the inset host.
    Object.assign(rendition, { destroy: vi.fn() });
    const insets: string[] = [];
    book.renderTo.mockImplementation(((target: HTMLElement) => {
      insets.push(target.style.getPropertyValue("--reader-side-inset"));
      return rendition;
    }) as never);
    await renderer.setPresentation?.({ fontSize: 16, writingMode: "vertical", sideMargin: 48 });
    expect(insets).toEqual([""]);
    expect(host.style.getPropertyValue("--reader-side-inset")).toBe("");
    renderer.dispose();
  });

  it("sizes a fresh vertical continuous section to the scrollable height before formatting", async () => {
    const { rendition, display } = mockBook([
      Object.assign(section("Text/one.xhtml", "本文です。"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    const manager = rendition.manager;
    manager.settings.axis = "vertical";
    Object.defineProperty(container, "clientHeight", {
      get: () => (manager.settings.axis === "horizontal" ? 1174 : 1186),
    });
    const size = vi.fn();
    const element = document.createElement("div");
    container.append(element);
    const view = { element, size, section: { index: 0, prev: () => null, next: () => null } };
    Object.assign(manager, {
      container,
      viewSettings: { width: 1538, height: 1186 },
      stage: { overflow: vi.fn() },
      views: { all: () => [view], displayed: () => [], remove: vi.fn() },
    });
    manager.updateLayout.mockImplementation(() => {
      manager.viewSettings.height = container.clientHeight;
    });
    const displayedHeights: number[] = [];
    display.mockImplementation(async () => {
      manager.updateAxis("horizontal");
      displayedHeights.push(manager.viewSettings.height);
    });
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, writingMode: "vertical", viewMode: "continuous" },
      ),
    ).toBe("ready");
    expect(displayedHeights).toEqual([1174]);
    expect(size).toHaveBeenCalledWith(1538, 1174);
    renderer.dispose();
  });

  it("measures the host at its new side inset before showing a continuous book in another writing mode", async () => {
    const { rendition, display } = mockBook([
      Object.assign(section("Text/one.xhtml", "本文です。"), { index: 0 }),
    ]);
    const container = document.createElement("div");
    Object.assign(rendition.manager, {
      container,
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    const host = document.createElement("div");
    const inset = () => host.style.getPropertyValue("--reader-side-inset");
    // EPUB.js measures the host as it lays out, less the scrollbar along its axis, and
    // sizes each new view, and the images in it, to that layout. It drops its two-page
    // spread on changing to the vertical axis.
    const { layout, settings } = rendition.manager;
    let measured: string | undefined;
    rendition.manager.updateLayout.mockImplementation(() => {
      const height = settings.axis === "horizontal" ? 1174 : 1186;
      Object.assign(rendition.manager, { viewSettings: { width: 1538, height } });
      measured = `${inset() || "no inset"}, ${settings.axis} scroll, spread ${layout._spread}, height ${height}`;
    });
    rendition.manager.updateAxis.mockImplementation((axis: string) => {
      settings.axis = axis;
      layout._spread = axis === "horizontal";
    });
    rendition.manager.direction.mockImplementation((direction: string) => {
      rendition.manager.settings.direction = direction;
      rendition.manager.updateLayout();
    });
    rendition.currentLocation.mockReturnValue({
      atStart: true,
      atEnd: false,
      start: { index: 0, displayed: { page: 1 } },
      end: { displayed: { page: 1, total: 1 } },
    } as never);
    const shown: (string | undefined)[] = [];
    display.mockImplementation(async () => {
      shown.push(measured);
    });
    const renderer = epubRendererFactory(id)();
    const presentation = {
      fontSize: 16,
      sideMargin: 400,
      viewMode: "continuous" as const,
    };
    expect(
      await renderer.mount(
        host,
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { ...presentation, writingMode: "vertical" },
      ),
    ).toBe("ready");
    expect(inset()).toBe("400px");

    shown.length = 0;
    await renderer.setPresentation?.({ ...presentation, writingMode: "horizontal" });
    expect(inset()).toBe("");
    expect(shown).toEqual(["no inset, vertical scroll, spread true, height 1186"]);

    shown.length = 0;
    await renderer.setPresentation?.({ ...presentation, writingMode: "vertical" });
    expect(inset()).toBe("400px");
    expect(shown).toEqual(["400px, horizontal scroll, spread true, height 1174"]);
    renderer.dispose();
  });

  it("fits continuous images and image pages inside the body's side padding", async () => {
    // A spread page shaped like a light novel's: blank paragraphs, then a wide image.
    const frames = ["one", "two"].map(() => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      return frame.contentDocument!;
    });
    frames[0].body.innerHTML = '<p><img src="plate.png" width="2048" height="1453"></p><p>Text</p>';
    frames[1].body.innerHTML =
      '<p> </p><p> </p><p> <img src="spread.png" width="2048" height="1453"></p>';
    for (const frame of frames) frame.body.style.padding = "0 70px";
    const items = frames.map((frame, index) =>
      Object.assign(section(`Text/${index}.xhtml`, ""), { index, document: frame }),
    );
    const { book, rendition } = mockBook(items);
    const container = document.createElement("div");
    const manager = rendition.manager;
    manager.settings.axis = "vertical";
    Object.defineProperties(container, {
      clientWidth: { get: () => 840 },
      clientHeight: { get: () => 788 },
    });
    Object.assign(manager, {
      container,
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    Object.assign(rendition, { destroy: vi.fn() });
    rendition.display.mockImplementation(async () => {
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        for (const item of items)
          await (hook as (document: Document, section: unknown) => unknown)(item.document, item);
    });
    try {
      for (const [viewMode, lead] of [
        ["continuous", 1.5 * 25],
        ["semi-continuous", 2 * 25],
      ] as const) {
        const renderer = epubRendererFactory(id)();
        expect(
          await renderer.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            undefined,
            undefined,
            { fontSize: 25, viewMode, writingMode: "horizontal" },
          ),
        ).toBe("ready");
        // Never wider than the text between the margins, the side padding.
        expect(
          frames[0].querySelector("style[data-komori-continuous-images]")?.textContent,
        ).toContain("max-width: 700px !important; max-height: 788px !important");
        // An image page leaves room for its gap, or for a chapter's lead in semi-continuous view.
        expect(frames[1].querySelector("style[data-komori-page-image-fit]")?.textContent).toContain(
          `max-width: 700px !important; max-height: ${788 - lead}px !important`,
        );
        renderer.dispose();
      }
    } finally {
      for (const frame of frames) frame.defaultView?.frameElement?.remove();
    }
  });

  it("fits continuous images to the scrollable area on open and after writing-mode switches", async () => {
    const item = Object.assign(
      section("Text/one.xhtml", "", true, '<p><img src="plate.png" width="146" height="1920"></p>'),
      { index: 0 },
    );
    const { book, rendition } = mockBook([item]);
    const container = document.createElement("div");
    const manager = rendition.manager;
    manager.settings.axis = "vertical";
    Object.defineProperties(container, {
      clientWidth: { get: () => (manager.settings.axis === "horizontal" ? 1538 : 1526) },
      clientHeight: { get: () => (manager.settings.axis === "horizontal" ? 1174 : 1186) },
    });
    Object.assign(manager, {
      container,
      views: { all: () => [], displayed: () => [], remove: vi.fn() },
    });
    Object.assign(rendition, { destroy: vi.fn() });
    rendition.display.mockImplementation(async () => {
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(item.document);
    });
    const renderer = epubRendererFactory(id)();
    const imageStyle = () =>
      item.document.querySelector("style[data-komori-continuous-images]")?.textContent;
    const horizontal =
      ":root body img, :root body svg { max-width: 1526px !important; max-height: 1186px !important; object-fit: contain !important; }";
    const vertical =
      ":root body img, :root body svg { max-width: 1538px !important; max-height: 1174px !important; object-fit: contain !important; }";
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, viewMode: "continuous", writingMode: "horizontal" },
      ),
    ).toBe("ready");
    expect(imageStyle()).toBe(horizontal);
    expect(new XMLSerializer().serializeToString(item.document)).toContain(
      "data-komori-continuous-images",
    );
    await renderer.setPresentation?.({
      fontSize: 16,
      viewMode: "continuous",
      writingMode: "vertical",
    });
    expect(imageStyle()).toBe(vertical);
    await renderer.setPresentation?.({
      fontSize: 16,
      viewMode: "continuous",
      writingMode: "horizontal",
    });
    expect(imageStyle()).toBe(horizontal);
    expect(item.document.querySelectorAll("style[data-komori-continuous-images]")).toHaveLength(1);
    expect(item.document.querySelector("img")?.getAttribute("height")).toBe("1920");
    await renderer.setPresentation?.({
      fontSize: 16,
      viewMode: "paginated",
      writingMode: "horizontal",
    });
    expect(imageStyle()).toBeUndefined();
    renderer.dispose();
  });

  it("uses the actual horizontal column width for images without subtracting the margin twice", async () => {
    const item = section("one.xhtml", "", true, '<svg><image href="plate.png"/></svg>');
    const { book, rendition } = mockBook([item]);
    Object.assign(rendition.manager.layout, { columnWidth: 584 });
    rendition.display.mockImplementation(async () => {
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(item.document);
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, writingMode: "horizontal", sideMargin: 400 },
    );
    expect(
      item.document.querySelector("style[data-komori-page-image-width]")?.textContent,
    ).toContain("max-width: 584px !important");
    rendition.manager.settings.axis = "vertical";
    await renderer.setPresentation!({ fontSize: 16, writingMode: "vertical", sideMargin: 400 });
    expect(item.document.querySelector("style[data-komori-page-image-width]")).toBeNull();
    renderer.dispose();
  });

  describe("semi-continuous view", () => {
    /**
     * A continuous book laid out whole in a 100px reading area, where each character of a
     * section is one 20px line (or column) along the reading order. Sections take the
     * chapter view's collapse and clip styles as a browser would lay them out.
     */
    function chapterBook(
      toc: unknown[] = [
        { label: "Prologue", href: "Text/s0.xhtml" },
        { label: "One", href: "Text/s1.xhtml" },
        { label: "Two", href: "Text/s1.xhtml#two" },
        { label: "Three", href: "Text/s2.xhtml" },
      ],
      axis: "vertical" | "horizontal" = "vertical",
      bodies = ["<p>abcdefgh</p>", '<p>ijklmnop</p><h2 id="two">qrstuvwx</h2>', "<p>yzABCDEF</p>"],
    ) {
      const sections = bodies.map((html, index) =>
        Object.assign(section(`Text/s${index}.xhtml`, "", true, html), { index }),
      );
      const mocked = mockBook(sections, toc);
      const horizontal = axis === "horizontal";
      const container = document.createElement("div");
      document.body.append(container);
      const views = bodies.map((html, index) => {
        const element = document.createElement("div");
        const iframe = document.createElement("iframe");
        element.append(iframe);
        container.append(element);
        const contentDocument = iframe.contentDocument!;
        contentDocument.body.innerHTML = html;
        const texts = Array.from(contentDocument.querySelectorAll("p, h2"))
          .map((block) => block.firstChild)
          .filter((node): node is Text => node?.nodeType === Node.TEXT_NODE);
        // A section holding only an image is one 100px image.
        const image = contentDocument.querySelector("img");
        if (image && !texts.length)
          vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
            top: 0,
            bottom: 100,
            left: 0,
            right: 100,
            width: 100,
            height: 100,
          } as DOMRect);
        const size =
          texts.reduce((sum, text) => sum + text.data.length, 0) * 20 || (image ? 100 : 0);
        // A point's distance along the reading order from its section's start.
        const along = (node: Node, offset: number) => {
          const text = node.nodeType === Node.TEXT_NODE ? node : node.firstChild;
          let before = 0;
          for (const item of texts) {
            if (item === text) return (before + (node === text ? offset : 0)) * 20;
            before += item.data.length;
          }
          return 0;
        };
        const createRange = contentDocument.createRange.bind(contentDocument);
        const decorate = (range: Range): Range => {
          const clone = range.cloneRange.bind(range);
          range.cloneRange = () => decorate(clone());
          range.getClientRects = () => {
            const from = along(range.startContainer, range.startOffset);
            const to = Math.max(from + 20, along(range.endContainer, range.endOffset));
            return [
              horizontal
                ? { top: 0, bottom: 10, left: size - to, right: size - from, width: to - from }
                : { top: from, bottom: to, left: 0, right: 10, width: 10, height: to - from },
            ] as unknown as DOMRectList;
          };
          return range;
        };
        vi.spyOn(contentDocument, "createRange").mockImplementation(() => decorate(createRange()));
        const view = {
          element,
          size,
          section: {
            index,
            prev: () => (index > 0 ? sections[index - 1] : null),
            next: () => (index < bodies.length - 1 ? sections[index + 1] : null),
          },
          contents: { document: contentDocument, sectionIndex: index, cfiFromRange: vi.fn() },
        };
        return { view, iframe };
      });
      const style = (element: HTMLElement, property: string) =>
        parseFloat(element.style.getPropertyValue(property)) || 0;
      const clipped = (element: HTMLElement, size: number) => {
        const max = element.style.getPropertyValue(horizontal ? "max-width" : "max-height");
        return max ? Math.min(size, parseFloat(max)) : size;
      };
      // The laid-out start and shown extent of each section along the reading order.
      const layout = (offset: number) => {
        let at = -offset;
        return views.map(({ view }) => {
          const start = at + style(view.element, horizontal ? "margin-right" : "margin-top");
          const shown = clipped(view.element, view.size);
          at = start + shown;
          return { start, shown };
        });
      };
      const length = () => Math.max(100, layout(0).at(-1)!.start + layout(0).at(-1)!.shown);
      let offset = 0;
      const place = (value: number) => {
        offset = Math.max(0, Math.min(value, length() - 100));
      };
      // Reading on scrolls down, or leftwards from 0 to negative offsets for vertical text.
      Object.defineProperties(container, {
        clientHeight: { value: 100 },
        clientWidth: { value: 100 },
        scrollHeight: { get: () => (horizontal ? 100 : length()) },
        scrollWidth: { get: () => (horizontal ? length() : 100) },
        scrollTop: {
          get: () => (horizontal ? 0 : offset),
          set: (value: number) => !horizontal && place(value),
        },
        scrollLeft: {
          get: () => (horizontal && offset ? -offset : 0),
          set: (value: number) => horizontal && place(-value),
        },
      });
      const box = (start: number, extent: number) =>
        (horizontal
          ? { top: 0, bottom: 100, left: 100 - start - extent, right: 100 - start }
          : { top: start, bottom: start + extent, left: 0, right: 100 }) as DOMRect;
      vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => box(0, 100));
      views.forEach(({ view, iframe }, index) => {
        vi.spyOn(view.element, "getBoundingClientRect").mockImplementation(() => {
          const { start, shown } = layout(offset)[index];
          return box(start, shown);
        });
        vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(() =>
          box(layout(offset)[index].start, view.size),
        );
      });
      const shown = views.map(({ view }) => view);
      Object.assign(mocked.rendition.manager, {
        container,
        settings: { axis, direction: horizontal ? "rtl" : "ltr" },
        views: { all: () => shown, displayed: () => shown, remove: vi.fn() },
      });
      mocked.rendition.getContents.mockReturnValue(shown.map((view) => view.contents) as never);
      return { ...mocked, container, views: shown, layout: () => layout(offset) };
    }

    async function mountChapters(
      book: ReturnType<typeof chapterBook>,
      presentation: ReaderPresentation = { fontSize: 16, viewMode: "semi-continuous" },
      saved: unknown = null,
    ) {
      const position = positionBinding(Promise.resolve(saved));
      const turns = vi.fn();
      const progress = vi.fn();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          turns,
          undefined,
          undefined,
          position,
          progress,
          presentation,
        ),
      ).toBe("ready");
      return { renderer, position, turns, progress };
    }

    const extents = (book: ReturnType<typeof chapterBook>) =>
      book.layout().map(({ shown }) => shown);

    it.each(["vertical", "horizontal"] as const)(
      "reads VN groups, changes count and resumes in the %s reading axis",
      async (axis) => {
        // The next section begins after 20px of blank space, which never shows with a group.
        const book = chapterBook([], axis, [
          "<p>ab</p><p>cd</p><p>ef</p>",
          "<p> </p><p>gh</p><p>ij</p>",
        ]);
        const presentation: ReaderPresentation = {
          fontSize: 16,
          viewMode: "vn",
          vnParagraphs: 1,
          vnTextSpeed: 0,
          ...(axis === "horizontal" && { writingMode: "vertical" }),
        };
        const { renderer, position, turns } = await mountChapters(book, presentation);
        const lead = (index = 0) =>
          book.views[index].element.style.getPropertyValue(
            axis === "horizontal" ? "margin-right" : "margin-top",
          );
        // Each group shows centered along the reading order: 40px of a 100px area.
        expect(extents(book)).toEqual([40, 0]);
        expect(lead()).toBe("30px");
        await renderer.advancePage();
        // The 40px before it are clipped, and 30px lead it to the middle.
        expect(lead()).toBe("-10px");
        expect(book.views[0].element.style.getPropertyValue("clip-path")).toBe(
          axis === "horizontal" ? "inset(0px 40px 0px 0px)" : "inset(40px 0px 0px 0px)",
        );
        await renderer.setPresentation?.({ ...presentation, vnParagraphs: 2 });
        expect(extents(book)).toEqual([80, 0]);
        await renderer.advancePage();
        expect(extents(book)).toEqual([120, 0]);
        await renderer.advancePage();
        // Its 80px after the 20px blank start, clipped and led to the middle.
        expect(extents(book)).toEqual([0, 100]);
        expect(lead(1)).toBe("-10px");
        expect(position.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 1 }),
        );
        await renderer.retreatPage();
        expect(extents(book)).toEqual([120, 0]);
        expect(turns).toHaveBeenLastCalledWith(
          expect.objectContaining({ canAdvance: true, canRetreat: true }),
        );
        const saved = position.onLocationChanged.mock.calls.at(-1)![0];
        renderer.dispose();
        const reopened = chapterBook([], axis, [
          "<p>ab</p><p>cd</p><p>ef</p>",
          "<p> </p><p>gh</p><p>ij</p>",
        ]);
        const resumed = await mountChapters(reopened, { ...presentation, vnParagraphs: 2 }, saved);
        expect(extents(reopened)).toEqual([120, 0]);
        resumed.renderer.dispose();
      },
    );

    it("VN destinations and view changes retain their point and text-speed changes publish no position", async () => {
      const book = chapterBook([{ label: "Two", href: "Text/s0.xhtml#two" }], "vertical", [
        '<p>ab</p><h2 id="two">cd</h2><p>ef</p><p>gh</p>',
      ]);
      const presentation: ReaderPresentation = {
        fontSize: 16,
        viewMode: "vn",
        vnParagraphs: 1,
        vnTextSpeed: 0,
      };
      const { renderer, position } = await mountChapters(book, presentation);
      expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
      expect(extents(book)).toEqual([120]);
      const saves = position.onLocationChanged.mock.calls.length;
      await renderer.setPresentation?.({ ...presentation, vnTextSpeed: 80 });
      expect(position.onLocationChanged).toHaveBeenCalledTimes(saves);
      await renderer.setPresentation?.({ ...presentation, viewMode: "continuous" });
      expect(extents(book)).toEqual([160]);
      expect(book.views[0].element.style.getPropertyValue("margin-top")).toBe("");
      await renderer.setPresentation?.(presentation);
      expect(extents(book)).toEqual([120]);
      expect(book.views[0].element.style.getPropertyValue("margin-top")).toBe("-30px");
      // A group longer than the reading area starts at its start and scrolls instead.
      await renderer.setPresentation?.({ ...presentation, vnParagraphs: 3 });
      expect(book.views[0].element.style.getPropertyValue("margin-top")).toBe("-40px");
      // A taller reading area, as a max height reflows to, centers the same group again.
      vi.spyOn(book.container, "getBoundingClientRect").mockImplementation(
        () => ({ top: 0, bottom: 200, left: 0, right: 100 }) as DOMRect,
      );
      await renderer.setPresentation?.({ ...presentation, vnParagraphs: 3, maxHeight: 200 });
      expect(book.views[0].element.style.getPropertyValue("margin-top")).toBe("");
      expect(book.views[0].element.style.getPropertyValue("clip-path")).toBe(
        "inset(40px 0px 0px 0px)",
      );
      expect(book.book.renderTo).toHaveBeenCalledTimes(1);
      renderer.dispose();
    });

    it("scrolls one chapter at a time and crosses chapter boundaries both ways", async () => {
      const book = chapterBook();
      const { renderer, position, turns } = await mountChapters(book);
      // The prologue alone is laid out for scrolling: 8 lines of 20px.
      expect(book.book.renderTo).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ manager: "continuous", offset: Number.POSITIVE_INFINITY }),
      );
      expect(extents(book)).toEqual([160, 0, 0]);
      expect(book.container.scrollHeight).toBe(192);
      expect(turns).toHaveBeenLastCalledWith(
        expect.objectContaining({ canAdvance: true, canRetreat: false, scrollAxis: "vertical" }),
      );
      expect(renderer.scrollBy?.(40)).toBe(true);
      expect(renderer.scrollBy?.(100)).toBe(true);
      expect(book.container.scrollTop).toBe(92);
      // At the chapter's end, reading on turns instead of scrolling.
      expect(renderer.scrollBy?.(20)).toBe(false);
      expect(book.container.scrollTop).toBe(92);
      expect(renderer.scrollBy?.(-20)).toBe(true);
      expect(book.container.scrollTop).toBe(72);
      book.container.scrollTop = 92;

      // The next chapter starts at section one and ends at its "two" heading.
      await renderer.advancePage();
      expect(extents(book)).toEqual([0, 160, 0]);
      expect(book.container.scrollTop).toBe(0);
      expect(book.container.scrollHeight).toBe(192);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 1, progress: 0 }),
      );
      expect(turns).toHaveBeenLastCalledWith(
        expect.objectContaining({ canAdvance: true, canRetreat: true }),
      );
      // Within a chapter, a turn scrolls by most of the reading area.
      await renderer.advancePage();
      expect(book.container.scrollTop).toBe(90);
      renderer.scrollBy?.(20);
      expect(book.container.scrollTop).toBe(92);
      expect(renderer.scrollBy?.(20)).toBe(false);

      // The heading's chapter begins at the heading, part way into the same section.
      await renderer.advancePage();
      expect(book.views[1].element.style.getPropertyValue("margin-top")).toBe("-128px");
      expect(book.layout()[1].start).toBe(-128);
      expect(book.container.scrollTop).toBe(0);
      expect(book.container.scrollHeight).toBe(192);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 1, progress: 0.5 }),
      );
      expect(renderer.scrollBy?.(-10)).toBe(false);

      // Reading back shows the previous chapter from its end.
      await renderer.retreatPage();
      expect(book.views[1].element.style.getPropertyValue("margin-top")).toBe("32px");
      expect(extents(book)).toEqual([0, 160, 0]);
      expect(book.container.scrollTop).toBe(92);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 1, progress: 3 / 16 }),
      );
      await renderer.retreatPage();
      await renderer.retreatPage();
      await renderer.retreatPage();
      expect(extents(book)).toEqual([160, 0, 0]);
      expect(book.container.scrollTop).toBe(92);
      // The book's start and end stay where scrolling stops.
      book.container.scrollTop = 0;
      expect(renderer.scrollBy?.(-20)).toBe(true);
      renderer.dispose();
      book.container.remove();
    });

    it("jumps, restores, and reflows to the chapter holding the reading point", async () => {
      const book = chapterBook();
      const { renderer, position } = await mountChapters(book, undefined, {
        spineIndex: 1,
        progress: 10 / 16,
      });
      // The saved character lies in the heading's chapter.
      expect(book.views[1].element.style.getPropertyValue("margin-top")).toBe("-128px");
      expect(book.container.scrollTop).toBe(72);

      expect(await renderer.goToContentsEntry?.("toc.3")).toBe(true);
      expect(extents(book)).toEqual([0, 0, 160]);
      expect(book.container.scrollTop).toBe(0);
      expect(await renderer.goToContentsEntry?.("toc.2")).toBe(true);
      expect(book.layout()[1].start).toBe(-128);
      expect(book.container.scrollTop).toBe(0);
      book.container.scrollTop = 72;
      book.container.dispatchEvent(new Event("scroll"));
      await vi.waitFor(
        () =>
          expect(position.onLocationChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ spineIndex: 1, progress: 10 / 16 }),
          ),
        { timeout: 1000 },
      );

      // A new size keeps the point, and continuous view shows the whole book around it.
      await renderer.setPresentation?.({ fontSize: 17, viewMode: "semi-continuous" });
      expect(book.container.scrollTop).toBe(74);
      await renderer.setPresentation?.({ fontSize: 17, viewMode: "continuous" });
      expect(extents(book)).toEqual([160, 320, 160]);
      expect(book.views[1].element.style.getPropertyValue("margin-top")).toBe("");
      expect(book.container.scrollTop).toBe(360);
      await renderer.setPresentation?.({ fontSize: 17, viewMode: "semi-continuous" });
      expect(extents(book)).toEqual([0, 320, 0]);
      expect(book.container.scrollTop).toBe(74);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 1, progress: 10 / 16 }),
      );
      // Both share EPUB.js's continuous view manager, so the book is not rendered again.
      expect(book.book.renderTo).toHaveBeenCalledOnce();
      renderer.dispose();
      book.container.remove();
    });

    it("clips right-to-left vertical text at its chapter's start on the right", async () => {
      const book = chapterBook(undefined, "horizontal");
      const { renderer } = await mountChapters(
        book,
        { fontSize: 16, writingMode: "vertical", viewMode: "semi-continuous" },
        { spineIndex: 1, progress: 0.5 },
      );
      expect(book.views[1].element.style.getPropertyValue("margin-right")).toBe("-128px");
      expect(extents(book)).toEqual([0, 320, 0]);
      expect(book.container.scrollWidth).toBe(192);
      expect(book.container.scrollLeft).toBe(0);
      renderer.scrollBy?.(100);
      expect(book.container.scrollLeft).toBe(-92);
      await renderer.retreatPage();
      await renderer.retreatPage();
      await renderer.retreatPage();
      // The previous chapter ends at the heading, and shows from its end.
      expect(book.views[1].element.style.getPropertyValue("margin-right")).toBe("32px");
      expect(book.views[1].element.style.getPropertyValue("max-width")).toBe("160px");
      expect(book.container.scrollLeft).toBe(-92);
      renderer.dispose();
      book.container.remove();
    });

    it("clips a chapter at its heading's box and shows a jumped chapter from its start", async () => {
      const book = chapterBook();
      // The heading's line begins 8px before its first, smaller, character.
      const heading = book.views[1].contents.document.getElementById("two")!;
      vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
        top: 152,
        bottom: 320,
        left: 0,
        right: 100,
        width: 100,
        height: 168,
      } as DOMRect);
      const { renderer, position } = await mountChapters(book);
      expect(await renderer.goToContentsEntry?.("toc.2")).toBe(true);
      expect(book.views[1].element.style.getPropertyValue("margin-top")).toBe("-120px");
      expect(book.container.scrollTop).toBe(0);
      expect(position.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 1, progress: 0.5 }),
      );
      expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
      expect(book.views[1].element.style.getPropertyValue("max-height")).toBe("152px");
      renderer.dispose();
      book.container.remove();
    });

    it.each(["vertical", "horizontal"] as const)(
      "keeps heading ruby outside its box and clear of the chapter edge in the %s axis",
      async (axis) => {
        const book = chapterBook(undefined, axis);
        const doc = book.views[1].contents.document;
        const heading = doc.getElementById("two")!;
        const ruby = doc.createElement("ruby");
        const rt = doc.createElement("rt");
        rt.textContent = "reading";
        ruby.append(rt);
        heading.append(ruby);
        vi.spyOn(rt, "getBoundingClientRect").mockReturnValue(
          (axis === "horizontal"
            ? { top: 0, left: 160, width: 7, height: 20 }
            : { top: 153, left: 0, width: 20, height: 7 }) as DOMRect,
        );
        const { renderer, position } = await mountChapters(book, {
          fontSize: 16,
          viewMode: "semi-continuous",
          writingMode: axis === "horizontal" ? "vertical" : "horizontal",
        });
        expect(await renderer.goToContentsEntry?.("toc.2")).toBe(true);
        const view = book.views[1].element;
        expect(
          view.style.getPropertyValue(axis === "horizontal" ? "margin-right" : "margin-top"),
        ).toBe("-121px");
        expect(view.style.getPropertyValue("clip-path")).toBe(
          axis === "horizontal" ? "inset(0px 153px 0px 0px)" : "inset(153px 0px 0px 0px)",
        );
        expect(book.container.scrollTop).toBe(0);
        expect(book.container.scrollLeft).toBe(0);
        expect(position.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 1, progress: 8 / 23 }),
        );
        expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
        expect(
          view.style.getPropertyValue(axis === "horizontal" ? "max-width" : "max-height"),
        ).toBe("153px");
        await renderer.setPresentation?.({ fontSize: 16, viewMode: "continuous" });
        expect(view.style.getPropertyValue("clip-path")).toBe("");
        renderer.dispose();
        book.container.remove();
      },
    );

    it("reports the shown chapter while the illustrations at its end show", async () => {
      const book = chapterBook(
        [
          { label: "Prologue", href: "Text/s0.xhtml" },
          { label: "Three", href: "Text/s2.xhtml" },
        ],
        "vertical",
        ["<p>abcdefgh</p>", '<p><img alt=""></p>', "<p>yzABCDEF</p>"],
      );
      const { renderer, progress } = await mountChapters(book);
      await vi.waitFor(() => expect(progress).toHaveBeenCalled());
      expect(extents(book)).toEqual([160, 100, 0]);
      book.container.scrollTop = 160;
      book.container.dispatchEvent(new Event("scroll"));
      // Book progress alone would place a text-less page at a section end in the next
      // chapter, which a chapter view does not show.
      await vi.waitFor(
        () =>
          expect(progress).toHaveBeenLastCalledWith({
            unit: "words",
            current: 1,
            total: 2,
            chapter: { current: 1, total: 1, entryId: "toc.0" },
          }),
        { timeout: 1000 },
      );
      renderer.dispose();
      book.container.remove();
    });

    it("uses each linear section with text as a chapter without contents", async () => {
      const book = chapterBook([]);
      const { renderer } = await mountChapters(book);
      expect(extents(book)).toEqual([160, 0, 0]);
      book.container.scrollTop = 92;
      await renderer.advancePage();
      expect(extents(book)).toEqual([0, 320, 0]);
      renderer.dispose();
      book.container.remove();
    });

    it("ends a chapter only at the next contents destination", async () => {
      const book = chapterBook([
        { label: "Frontispiece", href: "Text/s0.xhtml" },
        { label: "Two", href: "Text/s1.xhtml#two" },
      ]);
      const { renderer } = await mountChapters(book);
      // The prologue and section one's text before the heading form the first chapter.
      expect(extents(book)).toEqual([160, 160, 0]);
      renderer.dispose();
      book.container.remove();
    });
  });

  it("opens only the catalog URL and mounts the authored spine cover first", async () => {
    const cover = section("Images/cover.xhtml", "", true);
    cover.document.body.append(document.createElement("img"));
    const title = section("Text/title.xhtml", "Title page", true);
    const notice = section(
      "xhtml/book_0002.xhtml",
      "Vertical display recommended. ".repeat(9),
      true,
    );
    const contents = section("OEBPS/c16.xhtml", "Chapter 1 Chapter 2 ".repeat(20), true);
    for (let index = 0; index < 20; index++) {
      const link = contents.document.createElement("a");
      link.href = `chapter-${index}.xhtml`;
      link.textContent = "Chapter 1 Chapter 2 ";
      contents.document.body.append(link);
    }
    const chapter = section("Nested/Text/chapter.xhtml", "本文です。".repeat(120), true);
    const { book, display } = mockBook([cover, title, notice, contents, chapter]);
    const host = document.createElement("div");
    const renderer = epubRendererFactory(id)();

    expect(await renderer.mount(host, new AbortController().signal, vi.fn())).toBe("ready");
    expect(prepare).toHaveBeenCalledWith(id);
    expect(book.open).toHaveBeenCalledWith(url, "epub");
    expect(book.renderTo).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ width: "100%", height: "100%" }),
    );
    expect(display).toHaveBeenCalledWith("Images/cover.xhtml");
    const request = epub.mock.calls[0]?.[0] as {
      requestMethod: (input: string) => Promise<ArrayBuffer>;
    };
    await expect(request.requestMethod(url)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(request.requestMethod("file:///private/book.epub")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ cache: "no-store" }));
    renderer.dispose();
  });

  it.each([
    [
      "title",
      [
        section("Text/title.xhtml", "Title page"),
        section("Text/chapter.xhtml", "Prose ".repeat(100)),
      ],
    ],
    [
      "notice",
      [
        section("Text/notice.xhtml", "Copyright 2026"),
        section("Text/chapter.xhtml", "Prose ".repeat(100)),
      ],
    ],
    [
      "contents",
      [
        section("Text/contents.xhtml", "Contents"),
        section("Text/chapter.xhtml", "Prose ".repeat(100)),
      ],
    ],
    [
      "coverless",
      [
        section("Text/opening.xhtml", "First page"),
        section("Text/chapter.xhtml", "Prose ".repeat(100)),
      ],
    ],
  ])("does not skip authored %s opening material", async (_name, sections) => {
    const { display } = mockBook(sections);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("ready");
    expect(display).toHaveBeenCalledWith(sections[0].href);
    renderer.dispose();
  });

  it("does not synthesize a non-linear package cover into the reading flow", async () => {
    const { display } = mockBook([
      section("Images/package-cover.xhtml", "", false),
      section("Text/first.xhtml", "The authored first page"),
    ]);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("ready");
    expect(display).toHaveBeenCalledWith("Text/first.xhtml");
    renderer.dispose();
  });

  it.each([
    ["vertical-rl", "ArrowLeft"],
    ["vertical-lr", "ArrowRight"],
  ] as const)(
    "promotes a declared %s mode for initial and TOC destination sections",
    async (declared, forwardArrow) => {
      const packageDocument = new DOMParser().parseFromString(
        `<package><metadata><meta name="primary-writing-mode" content="${declared}"/></metadata></package>`,
        "application/xml",
      );
      const { book } = mockBook();
      book.archive.request.mockResolvedValue(packageDocument);
      const renderer = epubRendererFactory(id)();
      const changed = vi.fn();
      expect(
        await renderer.mount(document.createElement("div"), new AbortController().signal, changed),
      ).toBe("ready");
      expect(book.archive.request).toHaveBeenCalledWith("/Nested/book.opf", "xml");

      const hook = book.spine.hooks.content.register.mock.calls[0]?.[0] as (
        content: Document,
        section: { href: string },
      ) => void;
      const chapter = document.implementation.createHTMLDocument();
      hook(chapter, { href: "Text/one.xhtml" });
      expect(chapter.documentElement.style.writingMode).toBe(declared);
      const other = document.implementation.createHTMLDocument();
      hook(other, { href: "Text/other.xhtml" });
      expect(other.documentElement.style.writingMode).toBe(declared);
      // Without a chosen mode, the Reader's own styling keeps the declared one.
      for (const [later] of book.spine.hooks.content.register.mock.calls.slice(1))
        await (later as (document: Document) => unknown)(chapter);
      expect(chapter.documentElement.style.writingMode).toBe(declared);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ forwardArrow }));
      renderer.dispose();
    },
  );

  it.each([
    ["unknown", "missing"],
    ["missing", "missing"],
    ["unreadable", "unreadable"],
    ["invalid", "invalid"],
    ["tooLarge", "tooLarge"],
    ["failed", "error"],
  ] as const)("maps native %s to safe %s without opening an archive", async (native, expected) => {
    prepare.mockResolvedValue({ status: native, url: null });
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe(expected);
    expect(epub).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("disposes a book after rendering fails and never exposes the failure detail", async () => {
    const { display, destroy } = mockBook();
    display.mockRejectedValueOnce(new Error("C:\\private\\book.epub"));
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("error");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    [new InvalidEpubDocument(), "invalid"],
    [new EpubResourceLimit(), "tooLarge"],
  ] as const)(
    "refuses a bad spine before rendering or publishing saved state",
    async (error, status) => {
      const { book, destroy } = mockBook();
      book.archive.request.mockRejectedValueOnce(error);
      const onLocationChanged = vi.fn();
      const onProgress = vi.fn();
      const host = document.createElement("div");
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          {
            initial: Promise.resolve({ spineIndex: 0, sectionKey: "deadbeef", progress: 0.6 }),
            onLocationChanged,
          },
          onProgress,
        ),
      ).toBe(status);
      expect(book.renderTo).not.toHaveBeenCalled();
      expect(onLocationChanged).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
      expect(host.childElementCount).toBe(0);
    },
  );

  it("ignores spine validation completing after a book switch", async () => {
    const { book, destroy } = mockBook();
    let finish!: (document: Document) => void;
    book.archive.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const onLocationChanged = vi.fn();
    const host = document.createElement("div");
    const renderer = epubRendererFactory(id)();
    const pending = renderer.mount(host, controller.signal, vi.fn(), undefined, undefined, {
      initial: Promise.resolve(null),
      onLocationChanged,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    renderer.dispose();
    finish(document.implementation.createHTMLDocument());
    expect(await pending).toBe("error");
    expect(book.renderTo).not.toHaveBeenCalled();
    expect(onLocationChanged).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(2); // Immediate disposal and late-completion cleanup.
  });

  it("cleans up after unmount or book switch and ignores late preparation", async () => {
    let finish!: (value: { status: "ready"; url: string }) => void;
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = epubRendererFactory(id)();
    const oldHost = document.createElement("div");
    const controller = new AbortController();
    const pending = old.mount(oldHost, controller.signal, vi.fn());
    controller.abort();
    old.dispose();
    finish({ status: "ready", url });
    expect(await pending).toBe("error");
    expect(epub).not.toHaveBeenCalled();

    // Every window listener added while a book is open goes with it, and the view manager
    // EPUB.js destroys no longer refers to the renderer.
    const listening = new Map<string, Set<unknown>>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const adding = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        listening.set(type, (listening.get(type) ?? new Set()).add(listener));
        add(type, listener, options);
      });
    const removing = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((type, listener, options) => {
        listening.get(type)?.delete(listener);
        remove(type, listener, options);
      });
    const open = () => [...listening.values()].reduce((count, set) => count + set.size, 0);
    const { rendition, destroy } = mockBook();
    const manager = (rendition as unknown as { manager: { updateAxis: unknown } }).manager;
    const updateAxis = manager.updateAxis;
    const next = epubRendererFactory(id)();
    expect(
      await next.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("ready");
    expect(manager.updateAxis).not.toBe(updateAxis);
    next.dispose();
    next.dispose();
    expect(destroy).toHaveBeenCalledOnce();
    expect(manager.updateAxis).toBe(updateAxis);
    expect(open()).toBe(0);

    const switched = mockBook();
    const third = epubRendererFactory(id)();
    expect(
      await third.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("ready");
    third.dispose();
    expect(switched.destroy).toHaveBeenCalledOnce();
    expect(open()).toBe(0);
    adding.mockRestore();
    removing.mockRestore();
  });

  it("removes a late iframe mount after disposal during display", async () => {
    const { display, destroy } = mockBook();
    const host = document.createElement("div");
    let complete!: () => void;
    display.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          complete = () => {
            host.append(document.createElement("iframe"));
            resolve(undefined);
          };
        }),
    );
    const controller = new AbortController();
    const renderer = epubRendererFactory(id)();
    const pending = renderer.mount(host, controller.signal, vi.fn());
    await vi.waitFor(() => expect(display).toHaveBeenCalledOnce());

    controller.abort();
    renderer.dispose();
    complete();

    expect(await pending).toBe("error");
    expect(host.childElementCount).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it.each(["ltr", "rtl", "vertical-rl"])(
    "advances and retreats exactly one displayed page with %s book metadata",
    async (direction) => {
      const { book, rendition } = mockBook([
        section("Text/one.xhtml", "First chapter ".repeat(70)),
        section("Text/two.xhtml", "Second chapter ".repeat(70)),
      ]);
      Object.assign(book, { package: { metadata: { direction } } });
      const positions = [
        {
          atStart: true,
          atEnd: false,
          start: { index: 0, displayed: { page: 1 } },
          end: { index: 0, displayed: { page: 1, total: 2 } },
        },
        {
          atStart: false,
          atEnd: false,
          start: { index: 0, displayed: { page: 2 } },
          end: { index: 0, displayed: { page: 2, total: 2 } },
        },
        {
          atStart: false,
          atEnd: true,
          start: { index: 1, displayed: { page: 1 } },
          end: { index: 1, displayed: { page: 1, total: 1 } },
        },
      ];
      let position = 0;
      rendition.currentLocation.mockImplementation(() => positions[position]);
      rendition.next.mockImplementation(async () => {
        position = Math.min(position + 1, 2);
        rendition.emit("relocated");
      });
      rendition.prev.mockImplementation(async () => {
        position = Math.max(position - 1, 0);
        rendition.emit("relocated");
      });
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(document.createElement("div"), new AbortController().signal, changed),
      ).toBe("ready");
      expect(changed).toHaveBeenLastCalledWith({
        canAdvance: true,
        canRetreat: false,
        forwardArrow: direction === "rtl" ? "ArrowLeft" : "ArrowRight",
      });
      await renderer.advancePage();
      expect(position).toBe(1);
      expect(changed).toHaveBeenLastCalledWith({
        canAdvance: true,
        canRetreat: true,
        forwardArrow: direction === "rtl" ? "ArrowLeft" : "ArrowRight",
        advanceChapter: true,
      });
      await renderer.advancePage(); // EPUB.js crosses to the next readable spine section.
      expect(position).toBe(2);
      expect(changed).toHaveBeenLastCalledWith({
        canAdvance: false,
        canRetreat: true,
        forwardArrow: direction === "rtl" ? "ArrowLeft" : "ArrowRight",
        retreatChapter: true,
      });
      await renderer.retreatPage();
      expect(position).toBe(1);
      expect(rendition.next).toHaveBeenCalledTimes(2);
      expect(rendition.prev).toHaveBeenCalledOnce();
      renderer.dispose();
    },
  );

  it.each([
    ["a chosen horizontal", "horizontal"],
    ["the book's own", undefined],
  ] as const)(
    "pages a section set right to left by its own direction in its page order, in %s mode",
    async (_mode, writingMode) => {
      const { rendition, display } = mockBook([
        section("Text/one.xhtml", "First chapter ".repeat(70)),
        section("Text/two.xhtml", "Second chapter ".repeat(70)),
      ]);
      const { manager } = rendition;
      // EPUB.js formats each section's columns in its layout's progression as the section
      // renders, then pages, maps and scrolls it in its view manager's.
      const formatted: string[] = [];
      const stage = { direction: vi.fn() };
      const mapping = { direction: "ltr" };
      const layout = Object.assign(manager.layout, {
        format: vi.fn((_contents: unknown, _section?: unknown, _axis?: string): unknown => {
          formatted.push(manager.layout.settings.direction);
          return undefined;
        }),
      });
      Object.assign(manager, { stage, mapping });
      // A section document whose root sets its direction (jsdom has no layout).
      const sectionContents = (direction: "ltr" | "rtl") => {
        const contentDocument = document.implementation.createHTMLDocument();
        contentDocument.documentElement.dir = direction;
        contentDocument.body.textContent = "Chapter text ".repeat(70);
        Object.defineProperty(contentDocument, "defaultView", {
          value: { getComputedStyle: () => ({ writingMode: "horizontal-tb", direction }) },
        });
        return { document: contentDocument, cfiFromRange: vi.fn(() => "epubcfi(text)") };
      };
      display.mockImplementation(async () => {
        layout.format(sectionContents("rtl"), undefined, "horizontal");
      });
      rendition.next.mockImplementation(async () => {
        // EPUB.js renders the next section as it crosses into it.
        layout.format(sectionContents("ltr"), undefined, "horizontal");
        rendition.emit("relocated");
      });
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          changed,
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, writingMode },
        ),
      ).toBe("ready");

      // Its columns run right to left, so it is read right to left from its first page.
      expect(formatted).toEqual(["rtl"]);
      expect(rendition.settings.direction).toBe("rtl");
      expect(manager.settings.direction).toBe("rtl");
      expect(mapping).toEqual({ direction: "rtl" });
      expect(stage.direction).toHaveBeenLastCalledWith("rtl");
      // EPUB.js positions the section next; its pages are not laid out again first.
      expect(manager.direction).not.toHaveBeenCalled();
      expect(manager.updateLayout).not.toHaveBeenCalled();
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ forwardArrow: "ArrowLeft" }),
      );

      // A following section without its own direction reads in the mode's progression.
      await renderer.advancePage();
      expect(formatted).toEqual(["rtl", "ltr"]);
      expect(rendition.settings.direction).toBe("ltr");
      expect(manager.settings.direction).toBe("ltr");
      expect(mapping).toEqual({ direction: "ltr" });
      expect(stage.direction).toHaveBeenLastCalledWith("ltr");
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ forwardArrow: "ArrowRight" }),
      );
      renderer.dispose();
    },
  );

  it("pages a section in its body's direction and turns its root to match", async () => {
    const { rendition, display } = mockBook([
      section("Text/one.xhtml", "First chapter ".repeat(70)),
      section("Text/two.xhtml", "Second chapter ".repeat(70)),
    ]);
    const { manager } = rendition;
    const formatted: string[] = [];
    const layout = Object.assign(manager.layout, {
      format: vi.fn((_contents: unknown, _section?: unknown, _axis?: string): unknown => {
        formatted.push(manager.layout.settings.direction);
        return undefined;
      }),
    });
    Object.assign(manager, { stage: { direction: vi.fn() }, mapping: { direction: "ltr" } });
    // A section whose body runs one way inside a root that runs the other (jsdom has no
    // layout, so each element's own direction is its computed one).
    const sectionContents = (root: "ltr" | "rtl", body: "ltr" | "rtl") => {
      const contentDocument = document.implementation.createHTMLDocument();
      contentDocument.documentElement.dir = root;
      contentDocument.body.dir = body;
      contentDocument.body.textContent = "Chapter text ".repeat(70);
      Object.defineProperty(contentDocument, "defaultView", {
        value: {
          getComputedStyle: (element: HTMLElement) => ({
            writingMode: "horizontal-tb",
            direction: element.style.direction || element.dir,
          }),
        },
      });
      return { document: contentDocument, cfiFromRange: vi.fn(() => "epubcfi(text)") };
    };
    // Some books set `dir="rtl"` on the body alone.
    const bodyRtl = sectionContents("ltr", "rtl");
    const bodyLtr = sectionContents("rtl", "ltr");
    display.mockImplementation(async () => {
      layout.format(bodyRtl, undefined, "horizontal");
    });
    rendition.next.mockImplementation(async () => {
      layout.format(bodyLtr, undefined, "horizontal");
      rendition.emit("relocated");
    });
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      changed,
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, writingMode: "horizontal" },
    );

    // EPUB.js lays the columns out on the body, so they run right to left, and the root
    // that scrolls them runs so too: its later pages lie to the left of its first.
    expect(formatted).toEqual(["rtl"]);
    expect(bodyRtl.document.documentElement.style.direction).toBe("rtl");
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ forwardArrow: "ArrowLeft" }),
    );

    // A body that runs left to right inside a right-to-left root pages left to right.
    await renderer.advancePage();
    expect(formatted).toEqual(["rtl", "ltr"]);
    expect(bodyLtr.document.documentElement.style.direction).toBe("ltr");
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ forwardArrow: "ArrowRight" }),
    );
    renderer.dispose();
  });

  it("keeps the page in sight until the next section's page shows when a turn crosses sections", async () => {
    const { rendition } = mockBook([
      section("Text/one.xhtml", "First chapter ".repeat(70)),
      section("Text/two.xhtml", "Second chapter ".repeat(70)),
    ]);
    const { manager } = rendition;
    // jsdom has no layout: the reading area, and a section scrolled to its second page.
    const container = document.createElement("div");
    document.body.append(container);
    container.getBoundingClientRect = () => new DOMRect(100, 50, 1066, 780);
    // EPUB.js's views: hidden as they render, shown once a navigation has laid them out,
    // and removed from the page as it is cleared.
    const sectionView = (index: number, box: DOMRect) => {
      const element = document.createElement("div");
      const iframe = document.createElement("iframe");
      element.append(iframe);
      element.getBoundingClientRect = () => box;
      const setVisibility = (visibility: string) => {
        element.style.visibility = visibility;
        iframe.style.visibility = visibility;
      };
      const view = {
        section: { index, prev: () => undefined, next: () => undefined },
        element,
        iframe,
        displayed: true,
        display: vi.fn(async () => undefined),
        show: () => setVisibility("visible"),
        hide: () => setVisibility("hidden"),
        destroy: vi.fn(() => {
          view.displayed = false;
          iframe.remove();
        }),
      };
      return view;
    };
    type SectionView = ReturnType<typeof sectionView>;
    const views = {
      list: [] as SectionView[],
      all: () => views.list,
      displayed: () => views.list.filter((view) => view.displayed),
      append(view: SectionView) {
        views.list.push(view);
        container.append(view.element);
      },
      remove(view: SectionView) {
        views.list.splice(views.list.indexOf(view), 1);
        views.destroy(view);
      },
      destroy(view: SectionView) {
        if (view.displayed) view.destroy();
        container.removeChild(view.element);
      },
      clear() {
        for (const view of views.list) views.destroy(view);
        views.list = [];
      },
      show: () => views.displayed().forEach((view) => view.show()),
      hide: () => views.displayed().forEach((view) => view.hide()),
    };
    const first = sectionView(0, new DOMRect(-966, 50, 3198, 780));
    views.append(first);
    Object.assign(manager, {
      container,
      views,
      clear: vi.fn(() => {
        views.hide();
        views.clear();
      }),
    });
    let loading: Record<string, unknown> = {};
    let shown: Record<string, unknown> = {};
    rendition.next.mockImplementation(async () => {
      // EPUB.js clears the page, then renders the next section hidden and shows it.
      manager.clear();
      const second = sectionView(1, new DOMRect(100, 50, 1066, 780));
      second.hide();
      views.append(second);
      loading = {
        held: first.element.isConnected,
        visibility: [first.element.style.visibility, first.iframe.style.visibility],
        position: first.element.style.position,
        place: [first.element.style.left, first.element.style.top],
        clip: first.element.style.clipPath,
        pointer: first.element.style.pointerEvents,
        destroyed: first.destroy.mock.calls.length,
        contents: views.all(),
      };
      await Promise.resolve();
      views.show();
      shown = {
        visibility: [first.element.style.visibility, first.iframe.style.visibility],
        destroyed: first.destroy.mock.calls.length,
        next: second.element.style.visibility,
      };
      rendition.emit("relocated");
    });
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn()),
    ).toBe("ready");
    try {
      await renderer.advancePage();
      expect(rendition.next).toHaveBeenCalledOnce();
      // The page in sight stays where it is, within the reading area, while the next
      // section loads, and leaves as the new page shows; its section is torn down once
      // that frame is drawn.
      expect(loading).toEqual({
        held: true,
        visibility: ["visible", "visible"],
        position: "fixed",
        place: ["-966px", "50px"],
        clip: "inset(0px 1066px 0px 1066px)",
        pointer: "none",
        destroyed: 0,
        contents: [expect.objectContaining({ section: expect.objectContaining({ index: 1 }) })],
      });
      expect(shown).toEqual({ visibility: ["hidden", "hidden"], destroyed: 0, next: "visible" });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      expect(first.element.isConnected).toBe(false);
      expect(first.destroy).toHaveBeenCalledOnce();
      // Clearing the page outside a turn, as a jump does, removes it at once.
      const second = views.list[0];
      manager.clear();
      expect(second.element.isConnected).toBe(false);
      expect(second.destroy).toHaveBeenCalledOnce();
    } finally {
      renderer.dispose();
      container.remove();
    }
  });

  it("keeps both pages of a two-section spread where they were while a turn loads the next", async () => {
    const { rendition } = mockBook([
      section("Text/art.xhtml", "", true, '<p><img src="a.png" alt=""></p>'),
      section("Text/story.xhtml", "Story text ".repeat(70)),
      section("Text/next.xhtml", "Next chapter ".repeat(70)),
    ]);
    const { manager } = rendition;
    const container = document.createElement("div");
    document.body.append(container);
    container.getBoundingClientRect = () => new DOMRect(0, 0, 1440, 780);
    // A row of views: the second sits beside the first until the first leaves the flow,
    // and a fixed one sits where its style places it.
    const element = (inFlow: () => number) => {
      const view = document.createElement("div");
      view.getBoundingClientRect = () =>
        new DOMRect(
          view.style.position === "fixed" ? parseFloat(view.style.left) : inFlow(),
          0,
          720,
          780,
        );
      container.append(view);
      return view;
    };
    const left = element(() => 0);
    const right = element(() => (left.style.position === "fixed" ? 0 : 720));
    const views = [left, right].map((view, index) => ({
      section: { index },
      element: view,
      displayed: true,
      destroy: vi.fn(),
    }));
    Object.assign(manager, {
      container,
      views: {
        all: () => views,
        displayed: () => views,
        destroy: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
      },
      clear: vi.fn(),
    });
    let held: string[] = [];
    rendition.next.mockImplementation(async () => {
      manager.clear();
      held = [left.style.left, right.style.left];
      rendition.emit("relocated");
    });
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    try {
      await renderer.advancePage();
      // The text page stays on the right rather than over the image on the left.
      expect(held).toEqual(["0px", "720px"]);
    } finally {
      renderer.dispose();
      container.remove();
    }
  });

  it("reads a section set right to left from the top in a chosen vertical mode", async () => {
    const { book } = mockBook();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { fontSize: 16, writingMode: "vertical" },
    );
    const styled = document.implementation.createHTMLDocument();
    styled.documentElement.dir = "rtl";
    styled.body.dir = "rtl";
    const quote = styled.createElement("p");
    quote.dir = "rtl";
    styled.body.append(quote);
    for (const [hook] of book.spine.hooks.content.register.mock.calls)
      await (hook as (document: Document) => unknown)(styled);
    // Its root and body would run its lines and pages upwards, where EPUB.js cannot page
    // them; the elements inside keep their own direction.
    const style = styled.querySelector("style[data-komori-writing-mode]")?.textContent ?? "";
    expect(style).toContain(":root, :root body { direction: ltr !important; }");
    expect(style.match(/direction/g)).toHaveLength(1);
    expect(quote.dir).toBe("rtl");

    // A chosen horizontal mode keeps the section's own direction.
    await renderer.setPresentation?.({ fontSize: 16, writingMode: "horizontal" });
    for (const [hook] of book.spine.hooks.content.register.mock.calls)
      await (hook as (document: Document) => unknown)(styled);
    expect(styled.querySelector("style[data-komori-writing-mode]")?.textContent).not.toContain(
      "direction",
    );
    renderer.dispose();
  });

  it("makes turns unavailable during reflow and ignores late location after disposal", async () => {
    const { rendition } = mockBook();
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, changed);
    const resized = rendition.on.mock.calls.find(([name]) => name === "resized")?.[1] as () => void;
    const relocated = rendition.on.mock.calls.find(
      ([name]) => name === "relocated",
    )?.[1] as () => void;
    resized();
    expect(changed).toHaveBeenLastCalledWith({ canAdvance: false, canRetreat: false });
    await renderer.advancePage();
    expect(rendition.next).not.toHaveBeenCalled();
    relocated();
    await vi.waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({
        canAdvance: true,
        canRetreat: false,
        forwardArrow: "ArrowRight",
      }),
    );
    renderer.dispose();
    relocated();
    expect(rendition.off).toHaveBeenCalledWith("relocated", relocated);
  });

  it.each(["horizontal-tb", undefined])(
    "retreats to the last displayed page of the preceding %s section by its content CFI",
    async (writingMode) => {
      const { rendition } = mockBook();
      const previousDocument = document.implementation.createHTMLDocument();
      previousDocument.body.textContent = "Last words of the previous story.";
      if (writingMode) {
        Object.defineProperty(previousDocument, "defaultView", {
          value: { getComputedStyle: () => ({ writingMode }) },
        });
      }
      const cfiFromRange = vi.fn((_range: Range) => "epubcfi(previous-last-word)");
      rendition.getContents.mockReturnValue([
        { document: previousDocument, cfiFromRange },
      ] as never);
      let position = 1;
      rendition.currentLocation.mockImplementation(() =>
        position === 1
          ? {
              atStart: false,
              atEnd: false,
              start: { index: 1, displayed: { page: 1 } },
              end: { index: 1, displayed: { page: 1, total: 3 } },
            }
          : {
              atStart: false,
              atEnd: false,
              start: { index: 0, displayed: { page: position === 2 ? 4 : 1 } },
              end: { index: 0, displayed: { page: position === 2 ? 4 : 1, total: 4 } },
            },
      );
      rendition.prev.mockImplementation(async () => {
        position = 0;
        rendition.emit("relocated");
      });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      rendition.display.mockImplementation(async () => {
        position = 2;
        rendition.emit("relocated");
      });
      await renderer.retreatPage();
      expect(rendition.prev).toHaveBeenCalledOnce();
      expect(rendition.display).toHaveBeenLastCalledWith("epubcfi(previous-last-word)");
      expect(rendition.next).not.toHaveBeenCalled();
      expect(cfiFromRange.mock.calls[0]?.[0].toString()).toBe(".");
      expect(position).toBe(2);
      renderer.dispose();
    },
  );

  it.each(["vertical-rl", "vertical-lr"])(
    "retreats into a long %s section's final page in one page-height-aligned move",
    async (writingMode) => {
      const { rendition, display } = mockBook([
        section("Text/one.xhtml", "一".repeat(50)),
        section("Text/two.xhtml", "二".repeat(50)),
      ]);
      const next = mockSectionText(rendition, 1, "次の章".repeat(50), 0);
      const previous = mockSectionText(rendition, 0, "前の章の最後。".repeat(2000), 0);
      // EPUB.js keeps only the previous section after crossing the boundary.
      rendition.getContents.mockReturnValue([next] as never);
      // jsdom has no layout: model a vertical section whose last character is on page 55 of 55.
      Object.defineProperty(previous.document, "defaultView", {
        value: { getComputedStyle: () => ({ writingMode }) },
      });
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      rangePrototype.getBoundingClientRect = () => ({ top: 54 * 780 + 120, height: 20 }) as DOMRect;
      let location = { index: 1, page: 1, total: 3 };
      let scrollTop = 0;
      rendition.currentLocation.mockImplementation(
        () =>
          ({
            atStart: false,
            atEnd: false,
            start: {
              index: location.index,
              displayed: { page: location.page, total: location.total },
            },
            end: {
              index: location.index,
              displayed: { page: location.page, total: location.total },
            },
          }) as never,
      );
      rendition.prev.mockImplementation(async () => {
        // EPUB.js lands at an arbitrary page of the previous vertical section.
        location = { index: 0, page: 1, total: 55 };
        rendition.getContents.mockReturnValue([previous] as never);
        rendition.emit("relocated");
      });
      rendition.next.mockImplementation(async () => {
        location = { ...location, page: location.page + 1 };
        rendition.emit("relocated");
      });
      rendition.manager.scrollBy.mockImplementation((_x, y) => {
        scrollTop += y;
        location = { ...location, page: Math.floor(scrollTop / 780) + 1 };
      });
      rendition.reportLocation.mockImplementation(async () => {
        rendition.emit("relocated");
      });
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
        );
        display.mockImplementation(async () => {
          scrollTop = 0;
          location = { ...location, page: 1 };
          rendition.emit("relocated");
        });
        display.mockClear();
        await renderer.retreatPage();
        expect(rendition.prev).toHaveBeenCalledOnce();
        expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
        expect(previous.cfiFromRange).not.toHaveBeenCalled();
        // No per-page next() steps: one scroll by whole page heights.
        expect(rendition.next).not.toHaveBeenCalled();
        expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 54 * 780, true]]);
        expect(scrollTop % 780).toBe(0);
        expect(location).toEqual({ index: 0, page: 55, total: 55 });
        expect(binding.onLocationChanged).toHaveBeenCalledOnce();
        expect(binding.onLocationChanged).toHaveBeenCalledWith(
          expect.objectContaining({ spineIndex: 0 }),
        );
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
      }
    },
  );

  it("stays on a short vertical section's single page without scrolling", async () => {
    const { rendition, display } = mockBook([
      section("Text/one.xhtml", "一".repeat(50)),
      section("Text/two.xhtml", "二".repeat(50)),
    ]);
    const next = mockSectionText(rendition, 1, "次の章".repeat(50), 0);
    const previous = mockSectionText(rendition, 0, "短い。", 0);
    rendition.getContents.mockReturnValue([next] as never);
    Object.defineProperty(previous.document, "defaultView", {
      value: { getComputedStyle: () => ({ writingMode: "vertical-rl" }) },
    });
    const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
    rangePrototype.getBoundingClientRect = () => ({ top: 300, height: 20 }) as DOMRect;
    let location = { index: 1, page: 1, total: 3 };
    rendition.currentLocation.mockImplementation(
      () =>
        ({
          atStart: false,
          atEnd: false,
          start: { index: location.index, displayed: { page: location.page, total: 1 } },
          end: { index: location.index, displayed: { page: location.page, total: 1 } },
        }) as never,
    );
    rendition.prev.mockImplementation(async () => {
      location = { index: 0, page: 1, total: 1 };
      rendition.getContents.mockReturnValue([previous] as never);
      rendition.emit("relocated");
    });
    const host = document.createElement("div");
    Object.defineProperty(host, "clientHeight", { value: 780 });
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    try {
      await renderer.mount(
        host,
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
      );
      display.mockImplementation(async () => {
        rendition.emit("relocated");
      });
      display.mockClear();
      await renderer.retreatPage();
      expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
      expect(rendition.next).not.toHaveBeenCalled();
      expect(rendition.manager.scrollBy).not.toHaveBeenCalled();
      expect(location).toEqual({ index: 0, page: 1, total: 1 });
      expect(binding.onLocationChanged).toHaveBeenCalledOnce();
      expect(binding.onLocationChanged).toHaveBeenCalledWith(
        expect.objectContaining({ spineIndex: 0 }),
      );
    } finally {
      delete rangePrototype.getBoundingClientRect;
      renderer.dispose();
    }
  });

  describe.each(["vertical-rl", "horizontal-tb"])("retreating into a %s section", (writingMode) => {
    const vertical = writingMode === "vertical-rl";
    it.each([
      ["an illustration after its last paragraph", "image"],
      ["text after an illustration", "text"],
    ])("lands on the final page when the section ends with %s", async (_ending, last) => {
      const { rendition, display } = mockBook([
        section("Text/one.xhtml", "一".repeat(50)),
        section("Text/two.xhtml", "二".repeat(50)),
      ]);
      const next = mockSectionText(rendition, 1, "次の章".repeat(50), 0);
      const paragraph = `<p>${"あ".repeat(99)}終</p>`;
      const previous = mockSectionText(rendition, 0, "", 0);
      previous.document.body.innerHTML =
        last === "image" ? `${paragraph}\n<p><img></p>\n` : `<p><img></p>\n${paragraph}\n`;
      previous.cfiFromRange.mockImplementation((range: Range) => `epubcfi(${range.toString()})`);
      rendition.getContents.mockReturnValue([next] as never);
      Object.defineProperty(previous.document, "defaultView", {
        value: { getComputedStyle: () => ({ writingMode }) },
      });
      // jsdom has no layout: the section has three pages, and its last content, the
      // illustration or the final character, is on page 3; the other is on page 1 or 2.
      const image = previous.document.querySelector("img")!;
      image.getBoundingClientRect = () =>
        ({
          top: last === "image" ? 2 * 780 + 50 : 50,
          left: 0,
          width: 400,
          height: 600,
        }) as DOMRect;
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      rangePrototype.getBoundingClientRect = function (this: Range) {
        if (this.startContainer.nodeType !== Node.TEXT_NODE)
          return { top: 0, left: 0, width: 0, height: 0 } as DOMRect;
        return { top: (last === "image" ? 780 : 2 * 780) + 120, width: 16, height: 20 } as DOMRect;
      };
      let location = { index: 1, page: 1, total: 3 };
      let scrollTop = 0;
      rendition.currentLocation.mockImplementation(
        () =>
          ({
            atStart: false,
            atEnd: false,
            start: {
              index: location.index,
              displayed: { page: location.page, total: location.total },
            },
            end: {
              index: location.index,
              displayed: { page: location.page, total: location.total },
            },
          }) as never,
      );
      rendition.prev.mockImplementation(async () => {
        // EPUB.js lands at an arbitrary page of the previous section.
        location = { index: 0, page: 1, total: 3 };
        rendition.getContents.mockReturnValue([previous] as never);
        rendition.emit("relocated");
      });
      rendition.manager.scrollBy.mockImplementation((_x, y) => {
        scrollTop += y;
        location = { ...location, page: Math.floor(scrollTop / 780) + 1 };
      });
      rendition.reportLocation.mockImplementation(async () => {
        rendition.emit("relocated");
      });
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(host, new AbortController().signal, vi.fn());
        display.mockImplementation(async () => {
          scrollTop = 0;
          location = { ...location, page: 1 };
          rendition.emit("relocated");
        });
        display.mockClear();
        await renderer.retreatPage();
        expect(rendition.prev).toHaveBeenCalledOnce();
        expect(rendition.next).not.toHaveBeenCalled();
        if (vertical) {
          expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
          expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 2 * 780, true]]);
          expect(location).toEqual({ index: 0, page: 3, total: 3 });
        } else if (last === "image") {
          // EPUB.js pages to the illustration by a temporary ID, released afterwards.
          expect(display.mock.calls).toEqual([
            [expect.stringMatching(/^Text\/one\.xhtml#komori-point-\d+$/)],
          ]);
          expect(image.hasAttribute("id")).toBe(false);
        } else {
          expect(display.mock.calls).toEqual([["epubcfi(終)"]]);
        }
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
      }
    });
  });

  describe.each(["horizontal-tb", "vertical-rl"])("from a text-less %s section", (writingMode) => {
    const vertical = writingMode === "vertical-rl";

    /**
     * Section 1 shows only an image. EPUB.js reports no relocation after leaving it,
     * and its new view has no location on the first read, as when that view is not
     * sized yet in the frame EPUB.js reports from.
     */
    function textlessBook() {
      const sections = [
        section("Text/one.xhtml", "", true, "<p>前の章の最後まで読む。</p>".repeat(40)),
        section("Images/plate.xhtml", "", true, '<img src="plate.jpg" alt="">'),
        section("Text/two.xhtml", "", true, "<p>次の章を読み始める。</p>".repeat(40)),
      ];
      const book = mockBook(sections);
      const { rendition } = book;
      Object.assign(book.book, { package: { metadata: { direction: vertical ? "rtl" : "ltr" } } });
      for (const item of sections) {
        Object.defineProperty(item.document, "defaultView", {
          value: { getComputedStyle: () => ({ writingMode }) },
        });
      }
      let location = { index: 1, page: 1, total: 1 };
      let unsizedReads = 0;
      rendition.currentLocation.mockImplementation(() => {
        if (unsizedReads > 0) {
          unsizedReads--;
          return {} as never;
        }
        const displayed = { page: location.page, total: location.total };
        return {
          atStart: false,
          atEnd: false,
          start: { index: location.index, displayed },
          end: { index: location.index, displayed },
        } as never;
      });
      rendition.getContents.mockImplementation(
        () =>
          [
            {
              document: sections[location.index].document,
              sectionIndex: location.index,
              cfiFromRange: vi.fn(() => "epubcfi(previous-last-character)"),
            },
          ] as never,
      );
      // None of these navigations emits "relocated".
      const moveTo = (next: typeof location) => {
        location = next;
        unsizedReads = 1;
      };
      rendition.next.mockImplementation(async () => {
        moveTo(
          location.page < location.total
            ? { ...location, page: location.page + 1 }
            : { index: location.index + 1, page: 1, total: 3 },
        );
      });
      rendition.prev.mockImplementation(async () => {
        moveTo({ index: location.index - 1, page: 1, total: location.index === 2 ? 1 : 4 });
      });
      rendition.manager.scrollBy.mockImplementation((_x, y) => {
        moveTo({ ...location, page: location.page + y / 780 });
      });
      const place = (next: typeof location) => {
        location = next;
      };
      return { ...book, where: () => location, moveTo, place };
    }

    async function mountAtPlate(book: ReturnType<typeof textlessBook>) {
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      const binding = positionBinding();
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        host,
        new AbortController().signal,
        changed,
        undefined,
        undefined,
        binding,
      );
      book.display.mockClear();
      return { renderer, binding, changed };
    }

    /** A turn settles well before the 1.5 s wait for a relocation that never comes. */
    async function promptly(turn: Promise<void>) {
      let late!: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<"late">((resolve) => {
        late = setTimeout(() => resolve("late"), 1000);
      });
      try {
        expect(await Promise.race([turn, timedOut])).toBeUndefined();
      } finally {
        clearTimeout(late);
      }
    }

    it("advances one page into the next section and publishes it", async () => {
      const book = textlessBook();
      const { renderer, binding, changed } = await mountAtPlate(book);
      try {
        await promptly(renderer.advancePage());
        expect(book.rendition.next).toHaveBeenCalledOnce();
        expect(book.where()).toEqual({ index: 2, page: 1, total: 3 });
        expect(binding.onLocationChanged).toHaveBeenCalledOnce();
        expect(binding.onLocationChanged).toHaveBeenCalledWith(
          expect.objectContaining({ spineIndex: 2, progress: 0 }),
        );
        expect(changed).toHaveBeenLastCalledWith(
          expect.objectContaining({ canAdvance: true, canRetreat: true }),
        );
        await promptly(renderer.advancePage());
        expect(book.where()).toEqual({ index: 2, page: 2, total: 3 });
        expect(binding.onLocationChanged).toHaveBeenCalledTimes(2);
      } finally {
        renderer.dispose();
      }
    });

    it("retreats one page to the previous section's final page and publishes it", async () => {
      const book = textlessBook();
      const { renderer, binding } = await mountAtPlate(book);
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      // jsdom has no layout: the previous section's last character is on page 4 of 4.
      rangePrototype.getBoundingClientRect = () => ({ top: 2400, height: 20 }) as DOMRect;
      book.display.mockImplementation(async () => {
        const { index } = book.where();
        book.moveTo(vertical ? { index, page: 1, total: 4 } : { index, page: 4, total: 4 });
      });
      try {
        await promptly(renderer.retreatPage());
        expect(book.rendition.prev).toHaveBeenCalledOnce();
        expect(book.display.mock.calls).toEqual([
          [vertical ? "Text/one.xhtml" : "epubcfi(previous-last-character)"],
        ]);
        expect(book.rendition.next).not.toHaveBeenCalled();
        expect(book.rendition.manager.scrollBy.mock.calls).toEqual(
          vertical ? [[0, 3 * 780, true]] : [],
        );
        expect(book.where()).toEqual({ index: 0, page: 4, total: 4 });
        expect(binding.onLocationChanged).toHaveBeenCalledOnce();
        expect(binding.onLocationChanged).toHaveBeenCalledWith(
          expect.objectContaining({ spineIndex: 0 }),
        );
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
      }
    });

    it("retreats into it from the next section and advances out of it again", async () => {
      const book = textlessBook();
      book.place({ index: 2, page: 1, total: 3 });
      const { renderer, binding } = await mountAtPlate(book);
      book.display.mockImplementation(async () => {
        book.moveTo({ ...book.where() });
      });
      try {
        await promptly(renderer.retreatPage());
        expect(book.where()).toEqual({ index: 1, page: 1, total: 1 });
        expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 1 }),
        );
        await promptly(renderer.advancePage());
        expect(book.where()).toEqual({ index: 2, page: 1, total: 3 });
        expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 2 }),
        );
        expect(binding.onLocationChanged).toHaveBeenCalledTimes(2);
      } finally {
        renderer.dispose();
      }
    });
  });

  it("cancels a pending page relocation when the book is disposed", async () => {
    const { rendition } = mockBook();
    let finish!: () => void;
    rendition.next.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, changed);
    const pending = renderer.advancePage();
    expect(rendition.next).toHaveBeenCalledOnce();
    const calls = changed.mock.calls.length;
    renderer.dispose();
    finish();
    await pending;
    expect(changed).toHaveBeenCalledTimes(calls);
  });

  it("publishes authored nested labels and session IDs without destination paths", async () => {
    const toc = [
      {
        label: "第一章　はじまり",
        href: "Text/one.xhtml#opening",
        subitems: [{ label: "A quiet morning", href: "Text/one.xhtml#morning" }],
      },
      { label: "Part two", subitems: [{ label: "Chapter 2", href: "Text/two.xhtml" }] },
    ];
    const { rendition } = mockBook(
      [section("Text/one.xhtml", "First"), section("Text/two.xhtml", "Second")],
      toc,
    );
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    expect(changed).toHaveBeenCalledWith([
      {
        id: "toc.0",
        label: "第一章　はじまり",
        navigable: true,
        children: [{ id: "toc.0.0", label: "A quiet morning", navigable: true, children: [] }],
      },
      {
        id: "toc.1",
        label: "Part two",
        navigable: false,
        children: [{ id: "toc.1.0", label: "Chapter 2", navigable: true, children: [] }],
      },
    ]);
    expect(JSON.stringify(changed.mock.calls)).not.toContain("Text/");
    mockAnchor(rendition, "morning", "epubcfi(morning)");
    expect(await renderer.goToContentsEntry?.("toc.0.0")).toBe(true);
    expect(rendition.display).toHaveBeenCalledWith("Text/one.xhtml#morning");
    expect(rendition.display).toHaveBeenLastCalledWith("epubcfi(morning)");
    renderer.dispose();
  });

  describe("contents entries outside the spine", () => {
    /**
     * A converter replaced the book's own cover page with titlepage.xhtml at spine 0,
     * leaving the dropped cover page in the manifest and the contents.
     */
    function offSpineBook(pages: Record<string, string>, guide = "") {
      const toc = [
        { label: "表紙", href: "OEBPS/part0000.xhtml" },
        { label: "Notes", href: "OEBPS/notes.xhtml" },
        { label: "第一章", href: "OEBPS/part0001.xhtml" },
      ];
      const mocked = mockBook(
        [
          section("titlepage.xhtml", "", true, '<svg><image href="cover.jpeg"/></svg>'),
          section("OEBPS/part0001.xhtml", "本文が始まる。"),
        ],
        toc,
      );
      const spineLoad = mocked.book.load.getMockImplementation()!;
      mocked.book.load.mockImplementation(async (target: string) => {
        if (!(target in pages)) return spineLoad(target);
        const page = window.document.implementation.createHTMLDocument();
        page.body.innerHTML = pages[target];
        return page;
      });
      mocked.book.archive.request.mockResolvedValue(
        new DOMParser().parseFromString(
          `<package><guide>${guide}</guide></package>`,
          "application/xml",
        ),
      );
      return mocked;
    }

    const pages = {
      "OEBPS/part0000.xhtml": '<div><svg><image href="image_rsrc4SW.jpg"/></svg></div>',
      "OEBPS/notes.xhtml": '<p>注釈</p><img src="figure.jpg">',
    };

    async function mountContents() {
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        changed,
      );
      return { renderer, entries: changed.mock.lastCall![0] as Array<{ navigable: boolean }> };
    }

    it("opens the declared spine cover page for an image-only cover page outside the spine", async () => {
      const { display } = offSpineBook(
        pages,
        '<reference type="cover" href="titlepage.xhtml"/><reference type="text" href="OEBPS/part0000.xhtml"/>',
      );
      const { renderer, entries } = await mountContents();
      try {
        expect(entries.map((entry) => entry.navigable)).toEqual([true, false, true]);
        display.mockClear();
        expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
        expect(display).toHaveBeenCalledWith("titlepage.xhtml");
        expect(await renderer.goToContentsEntry?.("toc.1")).toBe(false);
        expect(display).toHaveBeenCalledOnce();
      } finally {
        renderer.dispose();
      }
    });

    it("uses an EPUB 3 cover landmark relative to the navigation document", async () => {
      const { book, display } = offSpineBook(pages);
      book.loaded.navigation = Promise.resolve({
        toc: [{ label: "表紙", href: "OEBPS/part0000.xhtml" }],
        landmark: (type: string) =>
          type === "cover" ? { href: "titlepage.xhtml#cover", type } : undefined,
      } as never);
      const { renderer, entries } = await mountContents();
      try {
        expect(entries.map((entry) => entry.navigable)).toEqual([true]);
        display.mockClear();
        expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
        expect(display).toHaveBeenCalledWith("titlepage.xhtml");
      } finally {
        renderer.dispose();
      }
    });

    it("shows an entry outside the spine as a label without a declared spine cover", async () => {
      const { display } = offSpineBook(
        pages,
        '<reference type="cover" href="OEBPS/part0000.xhtml"/>',
      );
      const { renderer, entries } = await mountContents();
      try {
        expect(entries.map((entry) => entry.navigable)).toEqual([false, false, true]);
        display.mockClear();
        expect(await renderer.goToContentsEntry?.("toc.0")).toBe(false);
        expect(display).not.toHaveBeenCalled();
      } finally {
        renderer.dispose();
      }
    });
  });

  it("keeps an empty or missing navigation document honest", async () => {
    const { book } = mockBook();
    book.loaded.navigation = Promise.reject(new Error("missing nav"));
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        changed,
      ),
    ).toBe("ready");
    expect(changed).toHaveBeenCalledWith([]);
    renderer.dispose();
  });

  it("shows the entries of an entry without a label in its place", async () => {
    mockBook(
      [section("Text/doc1.xhtml", "Prologue and chapters")],
      [
        {
          label: "　",
          href: "Text/doc1.xhtml#part",
          subitems: [
            { label: "プロローグ", href: "Text/doc1.xhtml#prologue" },
            { label: "第一章", href: "Text/doc1.xhtml#one" },
          ],
        },
      ],
    );
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "toc.0.0", label: "プロローグ", navigable: true }),
      expect.objectContaining({ id: "toc.0.1", label: "第一章", navigable: true }),
    ]);
    renderer.dispose();
  });

  it.each([
    ["leads nowhere in the book", [{ label: "开始", href: "Section0001.xhtml" }]],
    [
      "names a file the book lacks",
      [
        { label: "プロローグ", href: "p-001.xhtml" },
        { label: "天野ハザマ", href: "Section0050.xhtml" },
      ],
    ],
  ])("lists the NCX's contents when the navigation document %s", async (_case, toc) => {
    // An editor's unfinished placeholder.
    const { book, rendition } = mockBook(
      [section("xhtml/p-001.xhtml", "First chapter"), section("xhtml/p-003.xhtml", "Second")],
      toc,
    );
    Object.assign(book.package, { navPath: "xhtml/nav.xhtml", ncxPath: "toc.ncx" });
    // The book's own loader, before the tolerance layer wraps it.
    const { loadNavigation } = book;
    loadNavigation.mockResolvedValue({
      toc: [
        { label: "第一章", href: "xhtml/p-001.xhtml#toc-001" },
        { label: "第二章", href: "xhtml/p-003.xhtml#toc-002" },
      ],
    });
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    // EPUB.js reads the NCX alone, and its links are relative to the NCX.
    expect(loadNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ navPath: "", ncxPath: "toc.ncx" }),
    );
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "toc.0", label: "第一章", navigable: true }),
      expect.objectContaining({ id: "toc.1", label: "第二章", navigable: true }),
    ]);
    mockAnchor(rendition, "toc-002", "epubcfi(toc-002)");
    expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
    expect(rendition.display).toHaveBeenCalledWith("xhtml/p-003.xhtml#toc-002");
    renderer.dispose();
  });

  it("keeps a navigation document over an NCX that leads to no more places", async () => {
    const { book, rendition } = mockBook(
      [section("Text/chapter.xhtml", "Chapter")],
      [
        { label: "Chapter", href: "chapter.xhtml" },
        { label: "Missing", href: "missing.xhtml" },
      ],
    );
    Object.assign(book.package, { navPath: "Text/nav.xhtml", ncxPath: "toc.ncx" });
    book.loadNavigation.mockResolvedValue({
      toc: [{ label: "NCX chapter", href: "Text/chapter.xhtml" }],
    });
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "toc.0", label: "Chapter", navigable: true }),
      expect.objectContaining({ id: "toc.1", label: "Missing", navigable: false }),
    ]);
    // Its own destinations stay.
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    expect(rendition.display).toHaveBeenCalledWith("Text/chapter.xhtml");
    renderer.dispose();
  });

  it("keeps a navigation document that leads into the book over its NCX", async () => {
    const { book } = mockBook(
      [section("Text/chapter.xhtml", "Chapter")],
      [{ label: "Chapter", href: "chapter.xhtml" }],
    );
    Object.assign(book.package, { navPath: "Text/nav.xhtml", ncxPath: "toc.ncx" });
    const { loadNavigation } = book;
    const changed = vi.fn();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    expect(loadNavigation).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ label: "Chapter", navigable: true }),
    ]);
    renderer.dispose();
  });

  it("resolves a navigation-document-relative heading anchor inside the adapter", async () => {
    const { book, rendition } = mockBook(
      [section("Text/chapter.xhtml", "Heading and body")],
      [{ label: "Heading", href: "../Text/chapter.xhtml#part-two" }],
    );
    book.package.navPath = "Navigation/toc.xhtml";
    mockAnchor(rendition, "part-two", "epubcfi(part-two)");
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    expect(rendition.display).toHaveBeenCalledWith("Text/chapter.xhtml#part-two");
    expect(rendition.display).toHaveBeenLastCalledWith("epubcfi(part-two)");
    renderer.dispose();
  });

  it("jumps to a vertical heading holding only an image on its own page", async () => {
    const { rendition, display } = mockBook(
      [section("Text/body.xhtml", "本文。".repeat(100))],
      [
        { label: "第一章", href: "Text/body.xhtml#toc-001" },
        { label: "見出し", href: "Text/body.xhtml#heading" },
      ],
    );
    const contents = mockSectionText(rendition, 0, "本文。".repeat(100), 0);
    const sectionDocument = contents.document;
    Object.defineProperty(sectionDocument, "defaultView", {
      value: { getComputedStyle: () => ({ writingMode: "vertical-rl" }) },
    });
    // An image heading mid-section, as in <h1 id="toc-001"><img/></h1>, then a text heading.
    const imageHeading = sectionDocument.createElement("h1");
    imageHeading.id = "toc-001";
    const image = sectionDocument.createElement("img");
    imageHeading.append(image);
    const textHeading = sectionDocument.createElement("h2");
    textHeading.id = "heading";
    textHeading.textContent = "見出し";
    sectionDocument.body.append(imageHeading, sectionDocument.createElement("p"), textHeading);
    // jsdom has no layout: an empty range has an empty rect, as in a browser; the image
    // is on page 11 of 32 and the text heading on page 21.
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({ top: 10 * 780 + 60, height: 700 }),
    });
    const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
    rangePrototype.getBoundingClientRect = function (this: Range) {
      return (
        this.collapsed ? { top: 0, width: 0, height: 0 } : { top: 20 * 780 + 40, height: 20 }
      ) as DOMRect;
    };
    let page = 1;
    let scrollTop = 0;
    rendition.currentLocation.mockImplementation(
      () =>
        ({
          atStart: false,
          atEnd: false,
          start: { index: 0, displayed: { page, total: 32 } },
          end: { index: 0, displayed: { page, total: 32 } },
        }) as never,
    );
    display.mockImplementation(async () => {
      scrollTop = 0;
      page = 1;
      rendition.emit("relocated");
    });
    rendition.manager.scrollBy.mockImplementation((_x, y) => {
      scrollTop += y;
      page = Math.floor(scrollTop / 780) + 1;
    });
    rendition.reportLocation.mockImplementation(async () => {
      rendition.emit("relocated");
    });
    const host = document.createElement("div");
    Object.defineProperty(host, "clientHeight", { value: 780 });
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    try {
      await renderer.mount(
        host,
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
      );
      display.mockClear();
      expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
      expect(display.mock.calls).toEqual([["Text/body.xhtml#toc-001"], ["Text/body.xhtml"]]);
      expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 10 * 780, true]]);
      expect(rendition.next).not.toHaveBeenCalled();
      expect(page).toBe(11);
      expect(scrollTop % 780).toBe(0);
      expect(binding.onLocationChanged).toHaveBeenCalledOnce();

      // A text heading is still measured from its first character.
      rendition.manager.scrollBy.mockClear();
      expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
      expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 20 * 780, true]]);
      expect(page).toBe(21);
    } finally {
      delete rangePrototype.getBoundingClientRect;
      renderer.dispose();
    }
  });

  it("jumps to a horizontal heading holding only an image by its ID, not a CFI", async () => {
    const { rendition, display } = mockBook(
      [section("Text/body.xhtml", "本文。".repeat(100))],
      [
        { label: "第一章", href: "Text/body.xhtml#toc-001" },
        { label: "見出し", href: "Text/body.xhtml#heading" },
      ],
    );
    const contents = mockSectionText(rendition, 0, "本文。".repeat(100), 0);
    const sectionDocument = contents.document;
    // EPUB.js builds a CFI for the start of <h1><img/></h1> that it cannot resolve itself.
    const imageHeading = sectionDocument.createElement("h1");
    imageHeading.id = "toc-001";
    imageHeading.append(sectionDocument.createElement("img"));
    const textHeading = sectionDocument.createElement("h2");
    textHeading.id = "heading";
    textHeading.textContent = "見出し";
    sectionDocument.body.append(imageHeading, textHeading);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    display.mockClear();
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    expect(display.mock.calls).toEqual([["Text/body.xhtml#toc-001"], ["Text/body.xhtml#toc-001"]]);
    // A text heading is still shown at its first character.
    expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
    expect(display.mock.calls.slice(2)).toEqual([
      ["Text/body.xhtml#heading"],
      ["epubcfi(offset-0)"],
    ]);

    // An element without an ID gets a temporary one while EPUB.js locates it.
    imageHeading.removeAttribute("id");
    const point = sectionDocument.createRange();
    const body = sectionDocument.body;
    point.setStart(body, [...body.childNodes].indexOf(imageHeading));
    let located: string | undefined;
    display.mockImplementationOnce(async (target?: string) => {
      located = target && sectionDocument.getElementById(target.split("#")[1]!)?.tagName;
    });
    rendition.currentLocation.mockReturnValue({
      atStart: false,
      atEnd: false,
      start: { index: 0, cfi: "epubcfi(page-start)", displayed: { page: 2, total: 4 } },
      end: { index: 0, displayed: { page: 2, total: 4 } },
    } as never);
    contents.range.mockImplementation(() => point.cloneRange());
    rendition.getContents.mockReturnValue([{ ...contents, resizeCheck: vi.fn() }] as never);
    display.mockClear();
    await renderer.setPresentation?.({ fontSize: 20 });
    expect((display.mock.calls[0] as unknown as [string])[0]).toMatch(
      /^Text\/body\.xhtml#komori-point-\d+$/,
    );
    expect(located).toBe("H1");
    expect(imageHeading.hasAttribute("id")).toBe(false);
    renderer.dispose();
  });

  it("rejects unresolved destinations safely and serializes a jump against turns", async () => {
    const { book, rendition } = mockBook(undefined, [
      { label: "Broken", href: "Text/missing.xhtml" },
      { label: "Chapter", href: "Text/one.xhtml#heading" },
    ]);
    expect(book.spine.get("Text/one.xhtml#heading")).toBeTruthy();
    const renderer = epubRendererFactory(id)();
    const changed = vi.fn();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      changed,
    );
    expect(changed.mock.calls[0][0]).toHaveLength(2);
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(false);
    mockAnchor(rendition, "heading", "epubcfi(heading)");
    let finish!: () => void;
    rendition.display.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const jumping = renderer.goToContentsEntry?.("toc.1");
    expect(rendition.display).toHaveBeenLastCalledWith("Text/one.xhtml#heading");
    await renderer.advancePage();
    expect(rendition.next).not.toHaveBeenCalled();
    expect(await renderer.goToContentsEntry?.("toc.1")).toBe(false);
    finish();
    expect(await jumping).toBe(true);
    renderer.dispose();
  });

  it("publishes a layout-independent text position after a turn and restores it on reopen", async () => {
    const sections = [
      section("Text/one.xhtml", "One ".repeat(50)),
      section("Text/two.xhtml", "Two ".repeat(50)),
    ];
    const first = mockBook(sections);
    const contents = mockSectionText(first.rendition, 1, "x".repeat(100), 40);
    first.rendition.next.mockImplementation(async () => {
      first.rendition.currentLocation.mockReturnValue({
        atStart: false,
        atEnd: false,
        start: {
          index: 1,
          href: "Text/two.xhtml",
          cfi: "epubcfi(page-start)",
          displayed: { page: 3, total: 5 },
        },
        end: { index: 1, displayed: { page: 3, total: 5 } },
      } as never);
      first.rendition.emit("relocated");
    });
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
      ),
    ).toBe("ready");
    expect(first.display.mock.calls).toEqual([["Text/one.xhtml"]]);
    expect(binding.onLocationChanged).not.toHaveBeenCalled();
    await renderer.advancePage();
    expect(contents.range).toHaveBeenCalledWith("epubcfi(page-start)");
    const saved = binding.onLocationChanged.mock.calls[0][0];
    expect(saved).toEqual({
      spineIndex: 1,
      sectionKey: expect.stringMatching(/^[\da-f]{8}$/),
      progress: 0.4,
    });
    expect(JSON.stringify(saved)).not.toMatch(/xhtml|epubcfi/);
    renderer.dispose();

    const second = mockBook(sections);
    mockSectionText(second.rendition, 1, "x".repeat(100), 0);
    const reopened = epubRendererFactory(id)();
    expect(
      await reopened.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(Promise.resolve(saved)),
      ),
    ).toBe("ready");
    // The saved text offset, not a page number, positions the reopened section.
    expect(second.display.mock.calls).toEqual([["Text/two.xhtml"], ["epubcfi(offset-40)"]]);
    reopened.dispose();
  });

  it("captures and paints a ruby-free saved passage without changing selection, markup or location", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const html = "<p>Before <ruby>本<rt>ほん</rt></ruby><b>文</b> after</p>";
    const source = section("Text/one.xhtml", "", true, html);
    const mocked = mockBook([source]);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const rendered = iframe.contentDocument!;
    rendered.body.innerHTML = html;
    // Each painted range is one 10 × 16 px box, laid out on a line where its text is.
    const painted: string[] = [];
    Object.defineProperty(rendered.defaultView!.Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const text = this.toString();
        if (!painted.includes(text)) painted.push(text);
        return [{ left: 10 * (["本", "文"].indexOf(text) + 1), top: 20, width: 10, height: 16 }];
      },
    });
    const marked = () => rendered.querySelectorAll("[data-komori-note-marks] > span").length > 0;
    mocked.rendition.getContents.mockReturnValue([
      { document: rendered, sectionIndex: 0 },
    ] as never);
    const adapter = epubRendererFactory(id)();
    await adapter.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const range = rendered.createRange();
    range.setStart(rendered.querySelector("ruby")!.firstChild!, 0);
    range.setEnd(rendered.querySelector("b")!.firstChild!, 1);
    const selection = rendered.getSelection()!;
    selection.addRange(range);
    const displays = mocked.display.mock.calls.length;
    const passage = await adapter.captureNote!();
    const note = passage && { ...passage, id: "n1", body: "" };
    expect(note?.passage).toBe("本文");
    expect(note?.locator.progress).toBeCloseTo(7 / rendered.body.textContent!.length);
    expect(note?.locator.contentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(selection.getRangeAt(0).startContainer).toBe(range.startContainer);
    expect(selection.getRangeAt(0).endOffset).toBe(range.endOffset);
    expect(mocked.display.mock.calls).toHaveLength(displays);
    const markup = rendered.body.innerHTML;
    adapter.setNoteHighlights!([note!]);
    await vi.waitFor(() => expect(painted).toEqual(expect.arrayContaining(["本", "文"])));
    // Both pieces of the line join into one rounded mark with room around the letters.
    const marks = rendered.querySelectorAll<HTMLElement>("[data-komori-note-marks] > span");
    expect(marks).toHaveLength(1);
    expect(parseFloat(marks[0].style.left)).toBeLessThan(10);
    expect(parseFloat(marks[0].style.top)).toBeLessThan(20);
    expect(parseFloat(marks[0].style.width)).toBeGreaterThan(20);
    expect(parseFloat(marks[0].style.height)).toBeGreaterThan(16);
    expect(marks[0].closest("body")).toBeNull();
    expect(rendered.body.innerHTML).toBe(markup);
    expect(rendered.querySelector("style[data-komori-note-marks-style]")?.textContent).toContain(
      "background-color: #f0d889",
    );
    expect(selection.getRangeAt(0).startContainer).toBe(range.startContainer);
    expect(mocked.display.mock.calls).toHaveLength(displays);
    adapter.setNoteHighlights!([
      { ...note!, locator: { ...note!.locator, contentKey: "b".repeat(64) } },
    ]);
    await vi.waitFor(() => expect(marked()).toBe(false));
    adapter.setNoteHighlights!([note!]);
    await vi.waitFor(() => expect(marked()).toBe(true));
    adapter.setNoteHighlights!([]);
    expect(marked()).toBe(false);
    expect(rendered.querySelector("style[data-komori-note-marks-style]")).toBeNull();
    adapter.setNoteHighlights!([note!]);
    await vi.waitFor(() => expect(marked()).toBe(true));
    selection.removeAllRanges();
    expect(await adapter.captureNote!()).toBeNull();
    adapter.dispose();
    expect(marked()).toBe(false);
    iframe.remove();
  });

  it("rejects a late note paint after removal or disposal, and repaints newly displayed documents", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const source = section("Text/one.xhtml", "Saved passage");
    const mocked = mockBook([source]);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const rendered = iframe.contentDocument!;
    rendered.body.textContent = "Saved passage";
    // Each painted range is one 10 × 16 px box, laid out after the previous one on a line.
    const painted: string[] = [];
    Object.defineProperty(rendered.defaultView!.Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        painted.push(this.toString());
        return [{ left: 10 * painted.length, top: 20, width: 10, height: 16 }];
      },
    });
    const marked = () => rendered.querySelectorAll("[data-komori-note-marks] > span").length > 0;
    mocked.rendition.getContents.mockReturnValue([
      { document: rendered, sectionIndex: 0 },
    ] as never);
    const adapter = epubRendererFactory(id)();
    await adapter.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const range = rendered.createRange();
    range.selectNodeContents(rendered.body);
    rendered.getSelection()!.addRange(range);
    const captured = await adapter.captureNote!();
    const place = captured && { ...captured, id: "n1", body: "" };
    mocked.rendition.getContents.mockReturnValue([]);
    adapter.setNoteHighlights!([place!]);
    expect(marked()).toBe(false);
    mocked.rendition.getContents.mockReturnValue([
      { document: rendered, sectionIndex: 0 },
    ] as never);
    mocked.rendition.emit("rendered");
    await vi.waitFor(() => expect(marked()).toBe(true));
    // Remove while the cached hash promise is still yielding.
    adapter.setNoteHighlights!([place!]);
    adapter.setNoteHighlights!([]);
    await Promise.resolve();
    expect(marked()).toBe(false);
    adapter.setNoteHighlights!([place!]);
    adapter.dispose();
    await Promise.resolve();
    expect(marked()).toBe(false);
    iframe.remove();
  });

  it("rejects a selected passage changed during an original-section read and after disposal", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const source = section("Text/one.xhtml", "Selected passage");
    const mocked = mockBook([source]);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const rendered = iframe.contentDocument!;
    rendered.body.textContent = "Selected passage";
    mocked.rendition.getContents.mockReturnValue([
      { document: rendered, sectionIndex: 0 },
    ] as never);
    const adapter = epubRendererFactory(id)();
    await adapter.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const range = rendered.createRange();
    range.selectNodeContents(rendered.body);
    rendered.getSelection()!.addRange(range);
    let finish!: (value: Document) => void;
    mocked.book.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = adapter.captureNote!();
    await vi.waitFor(() => expect(finish).toBeDefined());
    rendered.getSelection()!.removeAllRanges();
    finish(source.document);
    expect(await pending).toBeNull();
    adapter.dispose();
    expect(await adapter.captureNote!()).toBeNull();
    iframe.remove();
  });

  it("captures the actual place and resolves bookmarks across reopen, rejecting changed content before display", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const sections = [section("Text/one.xhtml", "x".repeat(100))];
    const first = mockBook(sections);
    mockSectionText(first.rendition, 0, "x".repeat(100), 40);
    first.rendition.currentLocation.mockReturnValue({
      start: {
        index: 0,
        href: "Text/one.xhtml",
        cfi: "epubcfi(page-start)",
        displayed: { page: 3, total: 5 },
      },
      end: { index: 0, displayed: { page: 3, total: 5 } },
    } as never);
    const adapter = epubRendererFactory(id)();
    await adapter.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    const displays = first.display.mock.calls.length;
    const place = await adapter.captureBookmark!();
    expect(place?.locator).toEqual({
      spineIndex: 0,
      sectionKey: expect.stringMatching(/^[\da-f]{8}$/),
      progress: 0.4,
      contentKey: expect.stringMatching(/^[\da-f]{64}$/),
    });
    expect(place?.excerpt).toBe("x".repeat(60));
    expect(first.display.mock.calls).toHaveLength(displays);
    adapter.dispose();
    expect(await adapter.captureBookmark!()).toBeNull();

    const second = mockBook(sections);
    mockSectionText(second.rendition, 0, "x".repeat(100), 0);
    second.rendition.currentLocation.mockReturnValue({
      start: { index: 0, href: "Text/one.xhtml", displayed: { page: 1, total: 5 } },
    } as never);
    const binding = positionBinding();
    const reopened = epubRendererFactory(id)();
    await reopened.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      binding,
    );
    expect(await reopened.goToBookmark!(place!.locator)).toBe(true);
    expect(second.display).toHaveBeenLastCalledWith("epubcfi(offset-40)");
    expect(binding.onLocationChanged).toHaveBeenCalled();
    second.rendition.getContents.mockReturnValue([]);
    expect(await reopened.goToBookmark!(place!.locator)).toBe(false);
    reopened.dispose();

    const replacement = mockBook([
      section("Text/one.xhtml", "Different content under the same href"),
    ]);
    const relinked = epubRendererFactory(id)();
    await relinked.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    replacement.display.mockClear();
    expect(await relinked.goToBookmark!(place!.locator)).toBe(false);
    expect(await relinked.goToBookmark!({ ...place!.locator, spineIndex: 10 })).toBe(false);
    expect(await relinked.goToBookmark!({ ...place!.locator, sectionKey: "00000000" })).toBe(false);
    expect(replacement.display).not.toHaveBeenCalled();
    relinked.dispose();
  });

  it("discards a pending bookmark content read after disposal", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const book = mockBook();
    book.rendition.currentLocation.mockReturnValue({
      start: { index: 0, href: "Text/one.xhtml", displayed: { page: 1, total: 2 } },
    } as never);
    const adapter = epubRendererFactory(id)();
    await adapter.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    let finish!: (value: Document) => void;
    book.book.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = adapter.captureBookmark!();
    await vi.waitFor(() => expect(finish).toBeDefined());
    adapter.dispose();
    finish(document.implementation.createHTMLDocument());
    expect(await pending).toBeNull();
    expect(
      await adapter.goToBookmark!({
        spineIndex: 0,
        progress: 0,
        sectionKey: "1234abcd",
        contentKey: "a".repeat(64),
      }),
    ).toBe(false);
  });

  it.each([
    ["an invalid token", () => Promise.resolve({ spineIndex: "1", cfi: "epubcfi(/6/4!/4)" })],
    [
      "a spine position that no longer exists",
      () => Promise.resolve({ spineIndex: 7, progress: 0.5 }),
    ],
    [
      "a relinked source with a different section",
      () => Promise.resolve({ spineIndex: 1, sectionKey: "00000000", progress: 0.5 }),
    ],
    ["a failed position load", () => Promise.reject(Error("C:/private/book.epub"))],
  ])("opens the authored start quietly for %s", async (_name, initial) => {
    const { display } = mockBook([
      section("Text/one.xhtml", "One ".repeat(50)),
      section("Text/two.xhtml", "Two ".repeat(50)),
    ]);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(initial()),
      ),
    ).toBe("ready");
    expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
    renderer.dispose();
  });

  it.each(["vertical-rl", "vertical-lr"])(
    "pages to a saved %s text point by page height instead of display(cfi)",
    async (writingMode) => {
      const { rendition, display } = mockBook([
        section("Text/one.xhtml", "一".repeat(50)),
        section("Text/two.xhtml", "二".repeat(50)),
      ]);
      const contents = mockSectionText(rendition, 1, "本文".repeat(50), 0);
      // jsdom has no layout: model a vertical section whose saved character is on page 3.
      Object.defineProperty(contents.document, "defaultView", {
        value: { getComputedStyle: () => ({ writingMode }) },
      });
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      rangePrototype.getBoundingClientRect = () => ({ top: 1700, height: 20 }) as DOMRect;
      let page = 1;
      rendition.currentLocation.mockImplementation(
        () =>
          ({
            atStart: false,
            atEnd: false,
            start: { index: 1, displayed: { page, total: 4 } },
            end: { index: 1, displayed: { page, total: 4 } },
          }) as never,
      );
      rendition.manager.scrollBy.mockImplementation((_x, y) => {
        page += y / 780;
      });
      rendition.reportLocation.mockImplementation(async () => {
        rendition.emit("relocated");
      });
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      const renderer = epubRendererFactory(id)();
      try {
        expect(
          await renderer.mount(
            host,
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            positionBinding(Promise.resolve({ spineIndex: 1, progress: 0.5 })),
          ),
        ).toBe("ready");
        expect(display.mock.calls).toEqual([["Text/two.xhtml"], ["Text/two.xhtml"]]);
        expect(contents.cfiFromRange).not.toHaveBeenCalled();
        expect(rendition.next).not.toHaveBeenCalled();
        expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 2 * 780, true]]);
        expect(page).toBe(3);
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
      }
    },
  );

  it.each(["vertical-rl", "horizontal-tb"])(
    "saves and restores an illustration page after a %s section's last paragraph",
    async (writingMode) => {
      const vertical = writingMode === "vertical-rl";
      // The section's text ends on page 2 and its illustration fills page 3.
      const html = `<p id="t1">${"あ".repeat(100)}</p>\n<p><img></p>\n`;
      const open = (initial: Promise<unknown>) => {
        const { rendition, display } = mockBook([section("Text/one.xhtml", "", true, html)]);
        const displayed = document.implementation.createHTMLDocument();
        displayed.body.innerHTML = html;
        const text = displayed.getElementById("t1")!.firstChild as Text;
        const image = displayed.querySelector("img")!;
        // jsdom has no layout: pages follow each other along the paging axis, one reading
        // area apart, and the section's iframe moves back one area per page.
        let page = 1;
        const along = (distance: number, size: number) =>
          ({
            top: vertical ? distance : 40,
            left: vertical ? 500 : distance,
            width: vertical ? 16 : size,
            height: vertical ? size : 16,
          }) as DOMRect;
        const character = (index: number) =>
          along((index < 60 ? 0 : 780) + 40 + (index % 60) * 10, 10);
        image.getBoundingClientRect = () => along(2 * 780 + 50, 600);
        const createRange = displayed.createRange.bind(displayed);
        const decorate = (range: Range): Range => {
          const clone = range.cloneRange.bind(range);
          range.cloneRange = () => decorate(clone());
          range.getClientRects = () => {
            if (range.startContainer !== text || range.endContainer !== text)
              return [] as unknown as DOMRectList;
            const boxes = [];
            for (let index = range.startOffset; index < range.endOffset; index++)
              boxes.push(character(index));
            return boxes as unknown as DOMRectList;
          };
          return range;
        };
        vi.spyOn(displayed, "createRange").mockImplementation(() => decorate(createRange()));
        const frame = document.createElement("iframe");
        frame.getBoundingClientRect = () =>
          (vertical
            ? { top: -(page - 1) * 780, left: 0 }
            : { top: 0, left: -(page - 1) * 780 }) as DOMRect;
        Object.defineProperty(displayed, "defaultView", {
          value: { frameElement: frame, getComputedStyle: () => ({ writingMode }) },
        });
        // EPUB.js starts the illustration page at the paragraph continuing from page 2.
        const pages: Record<number, [number, number]> = { 1: [0, 60], 2: [60, 100], 3: [60, 100] };
        const contents = {
          document: displayed,
          sectionIndex: 0,
          cfiFromRange: vi.fn(() => "epubcfi(point)"),
          range: vi.fn((cfi: string) => {
            const [start, end] = pages[page];
            const range = displayed.createRange();
            if (cfi === "epubcfi(page-end)") {
              range.setStart(text, end - 1);
              range.setEnd(text, end);
            } else range.setStart(text, start);
            return range;
          }),
        };
        rendition.getContents.mockReturnValue([contents] as never);
        rendition.currentLocation.mockImplementation(
          () =>
            ({
              atStart: page === 1,
              atEnd: false,
              start: { index: 0, cfi: "epubcfi(page-start)", displayed: { page, total: 3 } },
              end: { index: 0, cfi: "epubcfi(page-end)", displayed: { page, total: 3 } },
            }) as never,
        );
        display.mockImplementation(async () => {
          page = 1;
          rendition.emit("relocated");
        });
        rendition.next.mockImplementation(async () => {
          page++;
          rendition.emit("relocated");
        });
        rendition.manager.scrollBy.mockImplementation((_x, y) => {
          page += Math.round(y / 780);
        });
        rendition.reportLocation.mockImplementation(async () => {
          rendition.emit("relocated");
        });
        const host = document.createElement("div");
        Object.defineProperty(host, "clientHeight", { value: 780 });
        host.getBoundingClientRect = () =>
          ({ top: 0, bottom: 780, left: 0, right: 780 }) as DOMRect;
        const binding = positionBinding(initial);
        const renderer = epubRendererFactory(id)();
        const mounted = renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
        );
        return { renderer, mounted, binding, display, image, page: () => page };
      };

      const first = open(Promise.resolve(null));
      expect(await first.mounted).toBe("ready");
      await first.renderer.advancePage();
      await first.renderer.advancePage();
      expect(first.page()).toBe(3);
      // The page starts at the illustration: all the text and the line break before it.
      const saved = first.binding.onLocationChanged.mock.lastCall?.[0];
      expect(saved).toMatchObject({ spineIndex: 0, progress: 101 / 102 });
      first.renderer.dispose();

      // Reopening finds the illustration again, not the text page before it or the
      // section's start.
      const second = open(Promise.resolve(saved));
      expect(await second.mounted).toBe("ready");
      if (vertical) {
        expect(second.page()).toBe(3);
      } else {
        expect(second.display).toHaveBeenLastCalledWith(
          expect.stringMatching(/^Text\/one\.xhtml#komori-point-\d+$/),
        );
        expect(second.image.hasAttribute("id")).toBe(false);
      }
      second.renderer.dispose();
    },
  );

  it("restores a point after an image in running text to the text, not the image", async () => {
    const { rendition, display } = mockBook([section("Text/one.xhtml", "あいうえ")]);
    const displayed = document.implementation.createHTMLDocument();
    // A character drawn as an image between two runs of text, with no space around it.
    displayed.body.innerHTML = "<p>あい<img>うえ</p>";
    rendition.getContents.mockReturnValue([
      {
        document: displayed,
        sectionIndex: 0,
        cfiFromRange: vi.fn(
          (range: Range) => `epubcfi(${range.startContainer.textContent}-${range.startOffset})`,
        ),
      },
    ] as never);
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(Promise.resolve({ spineIndex: 0, progress: 0.5 })),
      ),
    ).toBe("ready");
    expect(display).toHaveBeenLastCalledWith("epubcfi(うえ-0)");
    renderer.dispose();
  });

  it("falls back to the authored start when a saved section cannot be displayed", async () => {
    const { display } = mockBook([
      section("Text/one.xhtml", "One ".repeat(50)),
      section("Text/two.xhtml", "Two ".repeat(50)),
    ]);
    display.mockRejectedValueOnce(Error("broken section"));
    const renderer = epubRendererFactory(id)();
    expect(
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(Promise.resolve({ spineIndex: 1, progress: 0.5 })),
      ),
    ).toBe("ready");
    expect(display.mock.calls).toEqual([["Text/two.xhtml"], ["Text/one.xhtml"]]);
    renderer.dispose();
  });

  it("publishes after a contents jump but not after disposal during a pending turn", async () => {
    const { rendition } = mockBook(undefined, [{ label: "Chapter", href: "Text/one.xhtml" }]);
    const binding = positionBinding();
    const renderer = epubRendererFactory(id)();
    await renderer.mount(
      document.createElement("div"),
      new AbortController().signal,
      vi.fn(),
      undefined,
      undefined,
      binding,
    );
    // EPUB.js reports an empty location until the newly displayed section relocates.
    rendition.currentLocation.mockReturnValue({} as never);
    rendition.display.mockImplementationOnce(async () => {
      setTimeout(() => {
        rendition.currentLocation.mockReturnValue({
          atStart: false,
          atEnd: false,
          start: { index: 0, href: "Text/one.xhtml", displayed: { page: 2, total: 4 } },
          end: { index: 0, displayed: { page: 2, total: 4 } },
        } as never);
        rendition.emit("relocated");
      }, 10);
    });
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
    // Without a resolvable text point, the displayed page gives an estimate.
    expect(binding.onLocationChanged).toHaveBeenLastCalledWith({
      spineIndex: 0,
      sectionKey: expect.stringMatching(/^[\da-f]{8}$/),
      progress: 0.25,
    });

    let finish!: () => void;
    rendition.next.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const pending = renderer.advancePage();
    renderer.dispose();
    finish();
    await pending;
    expect(binding.onLocationChanged).toHaveBeenCalledOnce();
  });

  it("reports a missing fragment without leaking the authored path", async () => {
    mockBook(undefined, [{ label: "Missing heading", href: "Text/one.xhtml#not-there" }]);
    const renderer = epubRendererFactory(id)();
    await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
    expect(await renderer.goToContentsEntry?.("toc.0")).toBe(false);
    renderer.dispose();
  });

  describe("book progress", () => {
    function mountWithProgress(renderer: ReturnType<ReturnType<typeof epubRendererFactory>>) {
      const onProgress = vi.fn();
      const binding = positionBinding();
      const mounted = renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        onProgress,
      );
      return { mounted, onProgress, binding };
    }

    function showPage(
      rendition: ReturnType<typeof mockBook>["rendition"],
      index: number,
      text: string,
      offset: number,
      atEnd = false,
      endOffset?: number,
    ) {
      mockSectionText(rendition, index, text, offset, endOffset);
      rendition.currentLocation.mockReturnValue({
        atStart: index === 0 && offset === 0,
        atEnd,
        start: { index, cfi: "epubcfi(page-start)", displayed: { page: 1, total: 2 } },
        end: {
          index,
          cfi: endOffset === undefined ? undefined : "epubcfi(page-end)",
          displayed: { page: atEnd ? 2 : 1, total: 2 },
        },
      } as never);
    }

    it("counts a 100-character body and leaves out a 100-character non-linear appendix", async () => {
      const sections = [
        section("Text/body.xhtml", "あ".repeat(100)),
        section("Text/appendix.xhtml", "ね".repeat(100), false),
      ];
      const { rendition } = mockBook(sections, []);
      showPage(rendition, 0, "あ".repeat(100), 0);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenCalledWith(
          expect.objectContaining({ unit: "characters", total: 100 }),
        ),
      );
      renderer.dispose();
    });

    it("counts linear text after the first display and publishes it with settled positions", async () => {
      const sections = [
        section("Text/one.xhtml", "あ".repeat(100)),
        section("Text/notes.xhtml", "ね".repeat(50), false),
        section("Text/two.xhtml", "い".repeat(200)),
        section("Text/three.xhtml", "う".repeat(100)),
      ];
      const { book, rendition, display } = mockBook(sections, [
        { label: "Three", href: "Text/three.xhtml" },
      ]);
      showPage(rendition, 0, "あ".repeat(100), 0);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress, binding } = mountWithProgress(renderer);

      expect(await mounted).toBe("ready");
      // The first page is displayed before any section is parsed for the count.
      expect(display).toHaveBeenCalledOnce();
      expect(book.load).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenCalledWith({
          unit: "characters",
          current: 0,
          total: 400,
          chapter: { current: 0, total: 300 },
        }),
      );
      // Text before the first destination has no contents entry.
      expect(onProgress.mock.lastCall?.[0].chapter).not.toHaveProperty("entryId");
      // Non-linear sections are neither counted nor loaded; the initial display is not saved.
      expect(book.load).not.toHaveBeenCalledWith("/Text/notes.xhtml");
      expect(binding.onLocationChanged).not.toHaveBeenCalled();

      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 2, "い".repeat(200), 50);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      expect(onProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 150,
        total: 400,
        chapter: { current: 150, total: 300 },
      });

      rendition.display.mockImplementationOnce(async () => {
        showPage(rendition, 3, "う".repeat(100), 0);
        rendition.emit("relocated");
      });
      expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
      expect(onProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 300,
        total: 400,
        chapter: { current: 0, total: 100, entryId: "toc.0" },
      });

      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 3, "う".repeat(100), 60, true);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      // The final page reports the whole book.
      expect(onProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 400,
        total: 400,
        chapter: { current: 100, total: 100, entryId: "toc.0" },
      });
      expect(onProgress.mock.calls.map(([progress]) => progress.current)).toEqual([
        0, 150, 300, 400,
      ]);
      expect(JSON.stringify(onProgress.mock.calls)).not.toMatch(/xhtml|epubcfi/);
      renderer.dispose();
    });

    it("bounds chapters by nested contents destinations and fragments in reading order", async () => {
      // one.xhtml: "一章" + 98 あ + "二節" + 98 い = 200 characters; whitespace counts nothing.
      const one = `\n<h1 id="c1">一章</h1><p>${"あ".repeat(98)}</p>\n<h2 id="c1-2">二節</h2><p>${"い".repeat(98)}</p>`;
      const sections = [
        section("Text/cover.xhtml", ""),
        section("Text/one.xhtml", "", true, one),
        section("Text/notes.xhtml", "ね".repeat(50), false),
        section("Text/three.xhtml", "う".repeat(100)),
      ];
      // Contents order differs from reading order; entries share offsets and nest.
      const { rendition } = mockBook(sections, [
        { label: "Three", href: "Text/three.xhtml" },
        { label: "Cover", href: "Text/cover.xhtml" },
        {
          label: "One",
          href: "Text/one.xhtml#c1",
          subitems: [{ label: "Two", href: "Text/one.xhtml#c1-2" }],
        },
        { label: "Notes", href: "Text/notes.xhtml" },
        { label: "Missing", href: "Text/one.xhtml#not-there" },
      ]);
      const text = "え".repeat(200);
      showPage(rendition, 1, text, 0, false, 60);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      // The cover and "一章" both start at 0, and "二節" at 100. The displayed "一章"
      // follows the cover, and the missing anchor at the section start, in reading order.
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenCalledWith({
          unit: "characters",
          current: 0,
          total: 300,
          chapter: { current: 0, total: 100, entryId: "toc.2" },
        }),
      );

      const turn = async (offset: number, endOffset: number) => {
        rendition.next.mockImplementationOnce(async () => {
          showPage(rendition, 1, text, offset, false, endOffset);
          rendition.emit("relocated");
        });
        await renderer.advancePage();
        return onProgress.mock.lastCall?.[0];
      };
      // The page 40–100 ends on "一章"'s last character, so the chapter is complete.
      expect(await turn(40, 100)).toEqual({
        unit: "characters",
        current: 40,
        total: 300,
        chapter: { current: 100, total: 100, entryId: "toc.2" },
      });
      // The nested fragment at 100 begins on the page 60–120, so its chapter starts there.
      expect(await turn(60, 120)).toEqual({
        unit: "characters",
        current: 60,
        total: 300,
        chapter: { current: 0, total: 100, entryId: "toc.2.0" },
      });
      expect(await turn(120, 180)).toEqual({
        unit: "characters",
        current: 120,
        total: 300,
        chapter: { current: 20, total: 100, entryId: "toc.2.0" },
      });
      // A chapter's last page reports its whole length, like the book's final page.
      expect((await turn(180, 200)).chapter).toEqual({
        current: 100,
        total: 100,
        entryId: "toc.2.0",
      });
      // The displayed document can differ from the counted one; a page showing the
      // section's last counted character still completes the chapter.
      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 1, `${"え".repeat(201)}   `, 190, false, 201);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      expect(onProgress.mock.lastCall?.[0]).toMatchObject({
        current: 189,
        chapter: { current: 100, total: 100 },
      });

      rendition.display.mockImplementationOnce(async () => {
        showPage(rendition, 3, "う".repeat(100), 0, false, 50);
        rendition.emit("relocated");
      });
      expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
      expect(onProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 200,
        total: 300,
        chapter: { current: 0, total: 100, entryId: "toc.0" },
      });
      renderer.dispose();
    });

    it("marks the current contents entry across turns, jumps, and shared positions", async () => {
      // pre.xhtml has 50 characters before any destination. The image-only cover and
      // illustrations, "Part", and its first chapter all begin at 50; "Chapter 2" at 100.
      const one = `<h1 id="c1">一章</h1><p>${"あ".repeat(48)}</p><h2 id="c2">二章</h2><p>${"い".repeat(48)}</p>`;
      const sections = [
        section("Text/pre.xhtml", "ま".repeat(50)),
        section("Text/cover.xhtml", ""),
        section("Text/illustrations.xhtml", ""),
        section("Text/one.xhtml", "", true, one),
      ];
      const { rendition } = mockBook(sections, [
        { label: "Cover", href: "Text/cover.xhtml" },
        { label: "Illustrations", href: "Text/illustrations.xhtml" },
        {
          label: "Part",
          href: "Text/one.xhtml",
          subitems: [
            { label: "Chapter 1", href: "Text/one.xhtml#c1" },
            { label: "Chapter 2", href: "Text/one.xhtml#c2" },
          ],
        },
      ]);
      const pre = "ま".repeat(50);
      const text = "え".repeat(100);
      showPage(rendition, 0, pre, 10);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
      const entry = () => onProgress.mock.lastCall?.[0].chapter.entryId;
      // Text before the first destination has no entry.
      expect(entry()).toBeUndefined();

      const turn = async (
        direction: "advance" | "retreat",
        index: number,
        page: string,
        offset: number,
      ) => {
        rendition[direction === "advance" ? "next" : "prev"].mockImplementationOnce(async () => {
          showPage(rendition, index, page, offset);
          rendition.emit("relocated");
        });
        await renderer[direction === "advance" ? "advancePage" : "retreatPage"]();
        return entry();
      };
      // A page with nothing counted at a section end belongs to the chapter that starts
      // there, and of its shared entries the first in reading order.
      expect(await turn("advance", 0, pre, 50)).toBe("toc.0");
      expect(await turn("advance", 1, "", 0)).toBe("toc.0");
      // Entries sharing a position resolve to the last one at or before the displayed section.
      expect(await turn("advance", 2, "", 0)).toBe("toc.1");
      // A part and its first chapter share the section start; the nested chapter follows it.
      expect(await turn("advance", 3, text, 0)).toBe("toc.2.0");
      expect(await turn("advance", 3, text, 60)).toBe("toc.2.1");

      // A jump keeps its chosen entry until the next settled position.
      rendition.display.mockImplementationOnce(async () => {
        showPage(rendition, 3, text, 0);
        rendition.emit("relocated");
      });
      expect(await renderer.goToContentsEntry?.("toc.2")).toBe(true);
      expect(onProgress.mock.lastCall?.[0]).toMatchObject({
        current: 50,
        chapter: { current: 0, entryId: "toc.2" },
      });
      expect(await turn("advance", 3, text, 60)).toBe("toc.2.1");
      expect(await turn("retreat", 3, text, 0)).toBe("toc.2.0");
      expect(JSON.stringify(onProgress.mock.calls)).not.toMatch(/xhtml|c1|c2/);
      renderer.dispose();
    });

    it("keeps a jump's entry when the book count completes after the jump", async () => {
      const one = `<h1 id="c1">一章</h1><p>${"あ".repeat(98)}</p>`;
      const { rendition } = mockBook(
        [section("Text/one.xhtml", "", true, one)],
        [
          {
            label: "Part",
            href: "Text/one.xhtml",
            subitems: [{ label: "Chapter 1", href: "Text/one.xhtml#c1" }],
          },
        ],
      );
      showPage(rendition, 0, "え".repeat(100), 0);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      rendition.display.mockImplementationOnce(async () => {
        rendition.emit("relocated");
      });
      expect(await renderer.goToContentsEntry?.("toc.0")).toBe(true);
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
      expect(onProgress.mock.lastCall?.[0].chapter.entryId).toBe("toc.0");

      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 0, "え".repeat(100), 40);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      expect(onProgress.mock.lastCall?.[0].chapter.entryId).toBe("toc.0.0");
      renderer.dispose();
    });

    it("starts a chapter on a page that ends with its image heading", async () => {
      // "二章" is an image-only heading after 100 counted characters, as in
      // <p id="c2"><img/></p>, and its text follows on the next page.
      const html = `<p id="t1">${"あ".repeat(100)}</p><p id="c2"><img></p><p id="t2">${"い".repeat(100)}</p>`;
      const { rendition, display } = mockBook(
        [section("Text/one.xhtml", "", true, html)],
        [
          { label: "一章", href: "Text/one.xhtml" },
          { label: "二章", href: "Text/one.xhtml#c2" },
        ],
      );
      const sectionDocument = document.implementation.createHTMLDocument();
      sectionDocument.body.innerHTML = html;
      // jsdom has no layout: the reading area is 780 px high, the section's iframe moves
      // up one area per page, and the heading image is at the end of page 2 unless moved.
      let page = 1;
      let headingTop = 780 + 600;
      const frame = document.createElement("iframe");
      frame.getBoundingClientRect = () => ({ top: -(page - 1) * 780, left: 0 }) as DOMRect;
      Object.defineProperty(sectionDocument, "defaultView", {
        value: { frameElement: frame, getComputedStyle: () => ({ writingMode: "vertical-rl" }) },
      });
      sectionDocument.querySelector("img")!.getBoundingClientRect = () =>
        ({ top: headingTop, left: 100, width: 50, height: 150 }) as DOMRect;
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      host.getBoundingClientRect = () => ({ top: 0, bottom: 780, left: 0, right: 1000 }) as DOMRect;
      // Each page's first displayed character and the point after its last one.
      const pages: Record<number, [string, number, string, number]> = {
        1: ["t1", 0, "t1", 60],
        2: ["t1", 60, "t1", 100],
        3: ["t2", 0, "t2", 60],
        4: ["t2", 60, "t2", 100],
      };
      const text = (id: string) => sectionDocument.getElementById(id)!.firstChild!;
      rendition.getContents.mockReturnValue([
        {
          document: sectionDocument,
          sectionIndex: 0,
          cfiFromRange: vi.fn(() => "epubcfi(point)"),
          range: vi.fn((cfi: string) => {
            const [startId, startOffset, endId, endOffset] = pages[page];
            const range = sectionDocument.createRange();
            if (cfi === "epubcfi(page-end)") {
              range.setStart(text(endId), endOffset - 1);
              range.setEnd(text(endId), endOffset);
            } else range.setStart(text(startId), startOffset);
            return range;
          }),
        },
      ] as never);
      rendition.currentLocation.mockImplementation(
        () =>
          ({
            atStart: page === 1,
            atEnd: page === 4,
            start: { index: 0, cfi: "epubcfi(page-start)", displayed: { page, total: 4 } },
            end: { index: 0, cfi: "epubcfi(page-end)", displayed: { page, total: 4 } },
          }) as never,
      );
      display.mockImplementation(async () => {
        page = 1;
        rendition.emit("relocated");
      });
      rendition.manager.scrollBy.mockImplementation((_x, y) => {
        page += Math.round(y / 780);
      });
      rendition.reportLocation.mockImplementation(async () => {
        rendition.emit("relocated");
      });
      rendition.next.mockImplementation(async () => {
        page++;
        rendition.emit("relocated");
      });
      rendition.prev.mockImplementation(async () => {
        page--;
        rendition.emit("relocated");
      });
      const onProgress = vi.fn();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          positionBinding(),
          onProgress,
        ),
      ).toBe("ready");
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
      const shown = () => onProgress.mock.lastCall?.[0];
      expect(shown()).toEqual({
        unit: "characters",
        current: 0,
        total: 200,
        chapter: { current: 0, total: 100, entryId: "toc.0" },
      });

      // The page ending with the heading begins its chapter, turning in either direction.
      await renderer.advancePage();
      expect(shown()).toEqual({
        unit: "characters",
        current: 60,
        total: 200,
        chapter: { current: 0, total: 100, entryId: "toc.1" },
      });
      await renderer.advancePage();
      expect(shown()).toMatchObject({ current: 100, chapter: { current: 0, entryId: "toc.1" } });
      await renderer.retreatPage();
      expect(shown()).toMatchObject({ current: 60, chapter: { current: 0, entryId: "toc.1" } });
      await renderer.retreatPage();
      expect(shown()).toMatchObject({ current: 0, chapter: { current: 0, entryId: "toc.0" } });

      // A jump to the heading lands on that page and shows its chapter at 0 too.
      expect(await renderer.goToContentsEntry?.("toc.1")).toBe(true);
      expect(page).toBe(2);
      expect(shown()).toEqual({
        unit: "characters",
        current: 60,
        total: 200,
        chapter: { current: 0, total: 100, entryId: "toc.1" },
      });

      // A page that ends where the next chapter starts without showing its heading
      // still completes the previous chapter.
      headingTop = 2 * 780 + 20;
      await renderer.retreatPage();
      await renderer.advancePage();
      expect(page).toBe(2);
      expect(shown()).toEqual({
        unit: "characters",
        current: 60,
        total: 200,
        chapter: { current: 100, total: 100, entryId: "toc.0" },
      });
      renderer.dispose();
    });

    it("falls back to linear sections with text when the contents are not usable", async () => {
      const sections = [
        section("Text/one.xhtml", "あ".repeat(100)),
        section("Text/image.xhtml", ""),
        section("Text/notes.xhtml", "ね".repeat(50), false),
        section("Text/two.xhtml", "い".repeat(50)),
      ];
      const { rendition } = mockBook(sections, [
        { label: "Broken", href: "Text/missing.xhtml" },
        { label: "Notes", href: "Text/notes.xhtml" },
      ]);
      showPage(rendition, 0, "あ".repeat(100), 90);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenCalledWith({
          unit: "characters",
          current: 90,
          total: 150,
          chapter: { current: 90, total: 100 },
        }),
      );

      // The empty image section and the non-linear notes are not chapters.
      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 3, "い".repeat(50), 20);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      expect(onProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 120,
        total: 150,
        chapter: { current: 20, total: 50 },
      });
      // Section chapters have no contents entry to mark.
      expect(onProgress.mock.lastCall?.[0].chapter).not.toHaveProperty("entryId");
      renderer.dispose();
    });

    it.each([
      [
        "characters without furigana, whitespace, or punctuation",
        "<p>「<ruby>凄<rp>(</rp><rt>すご</rt><rp>)</rp></ruby>い」、\n　と。</p>",
        `<p>${"本".repeat(97)}。</p>`,
        `${"本".repeat(97)}。`,
        { unit: "characters", current: 53, total: 100, chapter: { current: 50, total: 97 } },
      ],
      [
        "words for other books",
        "<p>“Don’t,” said the well-known pharaoh.</p>",
        `<p>${"word ".repeat(95)}</p>`,
        "word ".repeat(95),
        { unit: "words", current: 15, total: 100, chapter: { current: 10, total: 95 } },
      ],
    ])("counts %s", async (_name, first, second, displayed, expected) => {
      const { rendition } = mockBook([
        section("Text/one.xhtml", "", true, first),
        section("Text/two.xhtml", "", true, second),
      ]);
      // The page starts 50 code units into the second section's displayed text.
      showPage(rendition, 1, displayed, 50);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expected));
      renderer.dispose();
    });

    it.each([
      [
        "empty",
        (book: ReturnType<typeof mockBook>["book"]) =>
          book.load.mockResolvedValue(document.implementation.createHTMLDocument()),
      ],
      [
        "unreadable",
        (book: ReturnType<typeof mockBook>["book"]) =>
          book.load.mockRejectedValue(Error("C:/private/book.epub")),
      ],
    ])("keeps reading without numbers when the count is %s", async (_name, arrange) => {
      const sections = [
        section("Text/one.xhtml", "あ".repeat(100)),
        section("Text/two.xhtml", "い"),
      ];
      const { book, rendition } = mockBook(sections);
      arrange(book);
      showPage(rendition, 0, "あ".repeat(100), 0);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress, binding } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      await vi.waitFor(() => expect(book.load).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 10));

      rendition.next.mockImplementationOnce(async () => {
        showPage(rendition, 1, "い", 0);
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      expect(binding.onLocationChanged).toHaveBeenCalledOnce();
      expect(onProgress).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("stops counting when the book is disposed", async () => {
      const { book, rendition } = mockBook([
        section("Text/one.xhtml", "あ".repeat(100)),
        section("Text/two.xhtml", "い".repeat(100)),
      ]);
      showPage(rendition, 0, "あ".repeat(100), 0);
      const renderer = epubRendererFactory(id)();
      const { mounted, onProgress } = mountWithProgress(renderer);
      expect(await mounted).toBe("ready");
      renderer.dispose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(book.load).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    });
  });

  describe("font size, line height, font weight, paragraph indentation, and side margin", () => {
    it.each(["continuous", "semi-continuous", "paginated", "vn"] as const)(
      "adapts Re:Zero-style subchapter padding to horizontal text in %s without deleting breaks",
      async (viewMode) => {
        const markup =
          '<p id="chapter">Chapter</p><p><br/></p><p><br/></p><p><br/></p>' +
          '<div class="h-indent-5em"><p>　　　　　１</p></div><p><br/></p><p>Body text.</p>';
        const one = section("Text/one.xhtml", "", true, markup);
        one.document.documentElement.classList.add("vrtl");
        const { book } = mockBook([one], [{ label: "Chapter", href: "Text/one.xhtml#chapter" }]);
        const renderer = epubRendererFactory(id)();
        const host = document.createElement("div");
        Object.defineProperties(host, {
          clientWidth: { value: 1000 },
          clientHeight: { value: 700 },
        });
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 24, writingMode: "horizontal", viewMode },
        );
        await runHooks(book, one.document, one);
        expect(
          one.document.querySelector("style[data-komori-hanging-indent-layout]")?.textContent,
        ).toContain("padding-top: 0 !important; padding-inline-start: 5em !important");
        expect(one.document.querySelectorAll("p > br")).toHaveLength(4);
        expect(one.document.querySelector(".h-indent-5em")?.textContent).toBe("　　　　　１");
        const displayed = document.implementation.createHTMLDocument();
        displayed.documentElement.classList.add("vrtl");
        displayed.body.innerHTML = markup;
        await runHooks(book, displayed, one);
        expect(displayed.querySelector("style[data-komori-hanging-indent-layout]")).not.toBeNull();
        await renderer.setPresentation!({ fontSize: 24, writingMode: "vertical", viewMode });
        expect(one.document.querySelector("style[data-komori-hanging-indent-layout]")).toBeNull();
        renderer.dispose();
      },
    );

    it("keeps one text anchor through repeated page and width reflows", async () => {
      const text = "Japanese Latin ".repeat(30);
      const { book, rendition, display } = mockBook([section("one.xhtml", text)]);
      const pageStart = { offset: 30 };
      reflowingSection(rendition, 0, text, pageStart);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(),
        undefined,
        { fontSize: 16, maxWidth: 600, pageLayout: "single" },
      );
      for (const [maxWidth, pageLayout] of [
        [800, "double"],
        [300, "single"],
        [600, "single"],
      ] as const) {
        await renderer.setPresentation!({ fontSize: 16, maxWidth, pageLayout });
        expect(display).toHaveBeenLastCalledWith("epubcfi(offset-30)");
        pageStart.offset = 5;
      }
      expect(book.renderTo).toHaveBeenCalledOnce();
      renderer.dispose();
    });

    /** A displayed section whose page-start character can move as the text reflows. */
    function reflowingSection(
      rendition: ReturnType<typeof mockBook>["rendition"],
      index: number,
      text: string,
      pageStart: { offset: number },
    ) {
      const contentDocument = document.implementation.createHTMLDocument();
      const paragraph = contentDocument.createElement("p");
      paragraph.textContent = text;
      contentDocument.body.append(paragraph);
      const contents = {
        document: contentDocument,
        sectionIndex: index,
        cfiFromRange: vi.fn((range: Range) => `epubcfi(offset-${range.startOffset})`),
        range: vi.fn(() => {
          const range = contentDocument.createRange();
          range.setStart(paragraph.firstChild!, pageStart.offset);
          return range;
        }),
        resizeCheck: vi.fn(),
      };
      rendition.getContents.mockReturnValue([contents] as never);
      rendition.currentLocation.mockReturnValue({
        atStart: false,
        atEnd: false,
        start: { index, cfi: "epubcfi(page-start)", displayed: { page: 2, total: 4 } },
        end: { index, displayed: { page: 2, total: 4 } },
      } as never);
      return contents;
    }

    function fontSizeHook(book: ReturnType<typeof mockBook>["book"]) {
      const hooks = book.spine.hooks.content.register.mock.calls.map(
        ([hook]) =>
          hook as (document: Document, section?: { url?: string }) => Promise<void> | void,
      );
      return hooks.at(-1)!;
    }

    const familyStyle = (doc: Document) =>
      doc.querySelector("style[data-komori-font-family]")?.textContent;

    it("styles fonts before XHTML serialization and restores important inline families", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, fontFamilyGroup1: "georgia", fontFamilyGroup2: "inter" },
      );
      const styled = new DOMParser().parseFromString(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>@layer publisher { #book p {font-family: Publisher !important} }</style></head>' +
          '<body><p style="font-family: Publisher !important; font-style: italic; font-weight: bold; font-size: 18px">本文<ruby>漢<rt>かん</rt></ruby> Latin</p></body></html>',
        "application/xhtml+xml",
      );
      const before = styled.body.textContent;
      const paragraph = styled.querySelector("p")!;
      const properties = ["font-family", "font-style", "font-weight", "font-size"];
      const snapshot = () =>
        properties.map((property) => [
          paragraph.style.getPropertyValue(property),
          paragraph.style.getPropertyPriority(property),
        ]);
      const original = snapshot();
      await fontSizeHook(book)(styled);
      await fontSizeHook(book)(styled);
      expect(familyStyle(styled)).toContain(
        'font-family: "Georgia", "Komori Reader Inter", serif !important',
      );
      expect(familyStyle(styled)).toContain("@font-face");
      expect(familyStyle(styled)).toContain("@layer komori-fonts");
      expect(styled.head.firstElementChild).toBe(
        styled.querySelector("style[data-komori-font-family]"),
      );
      expect(styled.querySelectorAll("style[data-komori-font-family]")).toHaveLength(1);
      expect(paragraph.style.getPropertyPriority("font-family")).toBe("important");
      expect(paragraph.style.fontFamily).toContain("Georgia");
      expect(paragraph.style.fontSize).toBe("18px");
      expect(styled.body.textContent).toBe(before);
      expect(new XMLSerializer().serializeToString(styled)).toContain('data-komori-font-family=""');
      renderer.dispose();
      const restored = mockBook();
      const plain = epubRendererFactory(id)();
      await plain.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      await fontSizeHook(restored.book)(styled);
      expect(familyStyle(styled)).toBeUndefined();
      expect(snapshot()).toEqual(original);
      expect(styled.body.textContent).toBe(before);
      plain.dispose();
    });

    for (const viewMode of ["paginated", "continuous", "semi-continuous"] as const) {
      for (const writingMode of ["horizontal", "vertical"] as const) {
        it(`reflows font choices in ${viewMode}/${writingMode} without remounting`, async () => {
          const text = "日本語 Latin ".repeat(30);
          const sections = [section("one.xhtml", text)];
          const { book, rendition, display } = mockBook(sections);
          const contents = reflowingSection(rendition, 0, text, { offset: 30 });
          const binding = positionBinding();
          const renderer = epubRendererFactory(id)();
          const shown: ReaderPresentation = {
            fontSize: 16,
            viewMode,
            writingMode,
            fontPair: {
              asian: { source: "preset", id: "yu-mincho" },
              western: { source: "preset", id: "segoe-ui" },
              downloaded: [],
            },
          };
          await renderer.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            binding,
            undefined,
            shown,
          );
          display.mockClear();
          await renderer.setPresentation?.({
            ...shown,
            fontPair: {
              asian: { source: "google", id: "zen-old-mincho" },
              western: { source: "system", family: "Georgia" },
              downloaded: ["zen-old-mincho"],
            },
          });
          for (const doc of [sections[0].document, contents.document])
            expect(familyStyle(doc)).toContain(
              '"Komori Asian", "Georgia", "Komori Google zen-old-mincho", serif',
            );
          expect(book.renderTo).toHaveBeenCalledOnce();
          expect(rendition.manager.clear).not.toHaveBeenCalled();
          if (viewMode === "paginated")
            expect(display).toHaveBeenLastCalledWith("epubcfi(offset-30)");
          const calls = display.mock.calls.length;
          await renderer.setPresentation?.({
            ...shown,
            fontPair: {
              asian: { source: "google", id: "zen-old-mincho" },
              western: { source: "system", family: "Georgia" },
              downloaded: ["zen-old-mincho"],
            },
          });
          expect(display).toHaveBeenCalledTimes(calls);
          await renderer.setPresentation?.({
            ...shown,
            fontPair: {
              asian: { source: "google", id: "zen-old-mincho" },
              western: { source: "system", family: "Georgia" },
              downloaded: [],
            },
          });
          expect(familyStyle(contents.document)).not.toContain("komori-font.localhost");
          expect(book.renderTo).toHaveBeenCalledOnce();
          const uploadedId = "a".repeat(64);
          await renderer.setPresentation?.({
            ...shown,
            fontWeight: 600,
            fontPair: {
              asian: { source: "google", id: "klee-one" },
              western: { source: "uploaded", id: uploadedId },
              downloaded: ["klee-one", "klee-one-600"],
              weights: { western: 600, asian: 400 },
              uploaded: [
                { id: uploadedId, family: "Imported", weight: "400 700", style: "normal" },
              ],
            },
          });
          for (const doc of [sections[0].document, contents.document]) {
            expect(familyStyle(doc)).toContain("Komori Uploaded");
            expect(familyStyle(doc)).toContain("font-weight: 600;");
            expect(familyStyle(doc)).toContain(`/uploaded/${uploadedId}.ttf`);
            expect(familyStyle(doc)).toContain('font-family: "Komori Western"');
            expect(familyStyle(doc)).toContain('font-variation-settings: "wght" 600;');
            const asianBody = familyStyle(doc)!
              .split("\n")
              .find(
                (f) => f.includes('font-family: "Komori Asian"') && f.includes("font-weight: 400;"),
              );
            expect(asianBody).toContain("/klee-one/");
          }
          expect(book.renderTo).toHaveBeenCalledOnce();
          expect(rendition.manager.clear).not.toHaveBeenCalled();
          await renderer.setPresentation?.({ fontSize: 16, viewMode, writingMode });
          expect(familyStyle(contents.document)).toBeUndefined();
          if (viewMode === "paginated")
            expect(display).toHaveBeenLastCalledWith("epubcfi(offset-30)");
          renderer.dispose();
        });
      }
    }

    it("keeps independent emphasis at weight extremes and inline weights before serialization", async () => {
      const { book } = mockBook([section("one.xhtml", "日本語 Latin")]);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          fontPair: {
            western: { source: "preset", id: "inter" },
            asian: { source: "preset", id: "inter" },
            downloaded: [],
            weights: { western: 900, asian: 400 },
          },
        },
      );
      const styled = document.implementation.createHTMLDocument();
      styled.body.innerHTML =
        '<p style="font-weight:575">日本語 Latin <ruby>漢<rt>かん</rt></ruby><b>Bold</b></p>';
      const before = styled.body.innerHTML;
      await fontSizeHook(book)(styled);
      const faces = familyStyle(styled)!.split("\n");
      expect(
        faces.find(
          (f) => f.includes('font-family: "Komori Asian"') && f.includes("font-weight: 575;"),
        ),
      ).toContain('font-variation-settings: "wght" 575;');
      expect(
        faces.find(
          (f) => f.includes('font-family: "Komori Asian"') && f.includes("font-weight: 700;"),
        ),
      ).toContain('font-variation-settings: "wght" 700;');
      expect(styled.querySelector("p")!.style.fontWeight).toBe("575");
      expect(styled.body.innerHTML.replace(/ data-komori-own-font-weight="575"/, "")).toBe(before);
      renderer.dispose();
    });

    it("restyles a late view serialized with the previous font choice", async () => {
      const sections = [section("one.xhtml", "本文 Latin")];
      const { book, rendition } = mockBook(sections);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          fontPair: {
            asian: { source: "preset", id: "yu-mincho" },
            western: { source: "preset", id: "segoe-ui" },
            downloaded: [],
          },
        },
      );
      const stale = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(stale);
      await renderer.setPresentation?.({
        fontSize: 16,
        fontPair: {
          asian: { source: "google", id: "zen-old-mincho" },
          western: { source: "system", family: "Georgia" },
          downloaded: ["zen-old-mincho"],
        },
      });
      const view = { contents: { document: stale, sectionIndex: 0, resizeCheck: vi.fn() } };
      for (const [name, listener] of rendition.on.mock.calls)
        if (name === "rendered")
          (listener as (section: unknown, view: unknown) => void)(sections[0], view);
      expect(familyStyle(stale)).toContain(
        '"Komori Asian", "Georgia", "Komori Google zen-old-mincho"',
      );
      expect(familyStyle(stale)).toContain("komori-font.localhost/zen-old-mincho");
      expect(view.contents.resizeCheck).toHaveBeenCalledOnce();
      const serializedBeforeRemoval = stale.cloneNode(true) as Document;
      await renderer.setPresentation?.({
        fontSize: 16,
        fontPair: {
          asian: { source: "google", id: "zen-old-mincho" },
          western: { source: "system", family: "Georgia" },
          downloaded: [],
        },
      });
      for (const [name, listener] of rendition.on.mock.calls)
        if (name === "rendered")
          (listener as (section: unknown, view: unknown) => void)(sections[0], {
            contents: { document: serializedBeforeRemoval, sectionIndex: 0, resizeCheck: vi.fn() },
          });
      expect(familyStyle(serializedBeforeRemoval)).not.toContain("komori-font.localhost");

      renderer.dispose();
    });

    it("ignores font choices and font-only updates in fixed-layout books", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          fontPair: {
            asian: { source: "google", id: "zen-old-mincho" },
            western: { source: "system", family: "Arial" },
            downloaded: ["zen-old-mincho"],
          },
        },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(familyStyle(styled)).toBeUndefined();
      display.mockClear();
      await renderer.setPresentation?.({
        fontSize: 16,
        fontFamilyGroup1: "yu-mincho",
        fontFamilyGroup2: "segoe-ui",
      });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("sizes each section in pixels before layout, including at the default size", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 22 },
        ),
      ).toBe("ready");
      const sized = document.implementation.createHTMLDocument();
      fontSizeHook(book)(sized);
      expect(sized.documentElement.style.fontSize).toBe("22px");
      renderer.dispose();

      // The chosen size replaces a root size the book sets itself.
      const authored = mockBook();
      const plain = epubRendererFactory(id)();
      await plain.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const document12 = document.implementation.createHTMLDocument();
      document12.documentElement.style.fontSize = "12px";
      fontSizeHook(authored.book)(document12);
      expect(document12.documentElement.style.fontSize).toBe("16px");
      plain.dispose();
    });

    it("reflows a horizontal page back to its first character and keeps that point", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const onProgress = vi.fn();
      const availability = vi.fn();
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          availability,
          undefined,
          undefined,
          binding,
          onProgress,
        ),
      ).toBe("ready");
      await vi.waitFor(() =>
        expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 10 })),
      );
      display.mockClear();

      // A larger size moves the old first character mid-page; the page now starts earlier.
      display.mockImplementationOnce(async () => {
        pageStart.offset = 21;
      });
      availability.mockClear();
      await renderer.setPresentation?.({ fontSize: 20 });
      const root = contents.document.documentElement;
      expect(root.style.fontSize).toBe("20px");
      // EPUB.js keeps loaded section documents and renders them again when revisited.
      expect(sections[0].document.documentElement.style.fontSize).toBe("20px");
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(availability.mock.calls[0][0]).toEqual({ canAdvance: false, canRetreat: false });
      expect(availability).toHaveBeenLastCalledWith(
        expect.objectContaining({ canAdvance: true, canRetreat: true }),
      );
      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 7 }));
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 21 / text.length }),
      );

      // Another change returns to the same point, not to the reflowed page's start.
      await renderer.setPresentation?.({ fontSize: 24 });
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      await renderer.setPresentation?.({ fontSize: 16 });
      expect(root.style.fontSize).toBe("16px");
      expect(sections[0].document.documentElement.style.fontSize).toBe("16px");
      expect(display).toHaveBeenCalledTimes(3);
      // The same size again changes nothing.
      await renderer.setPresentation?.({ fontSize: 16 });
      expect(display).toHaveBeenCalledTimes(3);

      // After a turn, the next change keeps the newly displayed first character.
      rendition.next.mockImplementationOnce(async () => {
        pageStart.offset = 60;
        rendition.emit("relocated");
      });
      await renderer.advancePage();
      await renderer.setPresentation?.({ fontSize: 18 });
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-60)"]);
      renderer.dispose();
    });

    it("pages a vertical reflow to the first character by page height", async () => {
      const text = "本文".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const contents = reflowingSection(rendition, 0, text, { offset: 40 });
      Object.defineProperty(contents.document, "defaultView", {
        value: { getComputedStyle: () => ({ writingMode: "vertical-rl" }) },
      });
      const host = document.createElement("div");
      Object.defineProperty(host, "clientHeight", { value: 780 });
      const renderer = epubRendererFactory(id)();
      expect(
        await renderer.mount(host, new AbortController().signal, vi.fn(), undefined, undefined),
      ).toBe("ready");
      display.mockClear();
      // jsdom has no layout: the larger text puts the kept character on the third page.
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      rangePrototype.getBoundingClientRect = () => ({ top: 1700, height: 20 }) as DOMRect;
      try {
        await renderer.setPresentation?.({ fontSize: 24 });
        expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
        expect(contents.cfiFromRange).not.toHaveBeenCalled();
        expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 2 * 780, true]]);
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
      }
    });

    it.each(["horizontal-tb", "vertical-rl"])(
      "keeps a %s page's first character in a paragraph without spaces that began earlier",
      async (writingMode) => {
        const vertical = writingMode === "vertical-rl";
        const html = `<p>${"あ".repeat(120)}</p>`;
        const { rendition, display } = mockBook(
          [section("Text/one.xhtml", "", true, html), section("Text/two.xhtml", "い".repeat(100))],
          [
            { label: "一章", href: "Text/one.xhtml" },
            { label: "二章", href: "Text/two.xhtml" },
          ],
        );
        const sectionDocument = document.implementation.createHTMLDocument();
        sectionDocument.body.innerHTML = html;
        const paragraph = sectionDocument.querySelector("p")!.firstChild!;
        // jsdom has no layout: the paragraph's characters 0-74 are on the previous page,
        // 75-109 on the displayed second page, and the rest on the next one. Its section's
        // iframe has moved one page along the reading axis.
        const page = (offset: number) => (offset < 75 ? 0 : offset < 110 ? 1 : 2);
        const frame = document.createElement("iframe");
        frame.getBoundingClientRect = () =>
          (vertical ? { top: -780, left: 0 } : { top: 0, left: -1066 }) as DOMRect;
        Object.defineProperty(sectionDocument, "defaultView", {
          value: { frameElement: frame, getComputedStyle: () => ({ writingMode }) },
        });
        const host = document.createElement("div");
        Object.defineProperty(host, "clientHeight", { value: 780 });
        host.getBoundingClientRect = () =>
          ({ top: 0, bottom: 780, left: 0, right: 1066 }) as DOMRect;
        const rangePrototype = Range.prototype as Partial<Pick<Range, "getClientRects">>;
        rangePrototype.getClientRects = function (this: Range) {
          if (this.startContainer !== paragraph) return [] as unknown as DOMRectList;
          const along = page(this.startOffset) * (vertical ? 780 : 1066) + 100;
          const box = vertical
            ? { top: along, left: 500, width: 20, height: 20 }
            : { top: 100, left: along, width: 20, height: 20 };
          return [box] as unknown as DOMRectList;
        };
        // EPUB.js splits text only at spaces, so it reports the whole paragraph as the
        // page's first and last range: its start on the previous page, its end on the next.
        const contents = {
          document: sectionDocument,
          sectionIndex: 0,
          cfiFromRange: vi.fn((range: Range) => `epubcfi(${range.startOffset},${range.endOffset})`),
          range: vi.fn((cfi: string) => {
            const range = sectionDocument.createRange();
            if (cfi === "epubcfi(page-end)") {
              range.setStart(paragraph, 119);
              range.setEnd(paragraph, 120);
            } else range.setStart(paragraph, 0);
            return range;
          }),
        };
        rendition.getContents.mockReturnValue([contents] as never);
        rendition.currentLocation.mockReturnValue({
          atStart: false,
          atEnd: false,
          start: { index: 0, cfi: "epubcfi(page-start)", displayed: { page: 2, total: 3 } },
          end: { index: 0, cfi: "epubcfi(page-end)", displayed: { page: 2, total: 3 } },
        } as never);
        const binding = positionBinding();
        const onProgress = vi.fn();
        const renderer = epubRendererFactory(id)();
        try {
          expect(
            await renderer.mount(
              host,
              new AbortController().signal,
              vi.fn(),
              undefined,
              undefined,
              binding,
              onProgress,
            ),
          ).toBe("ready");
          // The footer counts from the first displayed character, and the chapter is not
          // complete: the page ends before the paragraph that reaches the next chapter.
          await vi.waitFor(() =>
            expect(onProgress).toHaveBeenLastCalledWith({
              unit: "characters",
              current: 75,
              total: 220,
              chapter: { current: 75, total: 120, entryId: "toc.0" },
            }),
          );

          // A reflow shows the page holding that character and saves it.
          display.mockClear();
          await renderer.setPresentation?.({ fontSize: 20 });
          if (vertical) {
            expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
            expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 780, true]]);
          } else {
            // The character alone, so EPUB.js does not page to the paragraph's later end.
            expect(display.mock.calls).toEqual([["epubcfi(75,76)"]]);
          }
          expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ spineIndex: 0, progress: 75 / 120 }),
          );
        } finally {
          delete rangePrototype.getClientRects;
          renderer.dispose();
        }
      },
    );

    it("measures a paginated page's location and the text before its edges once a turn", async () => {
      const html = `<p>${"あ".repeat(60)}</p><p>${"い".repeat(90)}</p>`;
      const { rendition } = mockBook(
        [section("Text/one.xhtml", "", true, html)],
        [{ label: "一章", href: "Text/one.xhtml" }],
      );
      const sectionDocument = document.implementation.createHTMLDocument();
      sectionDocument.body.innerHTML = html;
      const [first, second] = [...sectionDocument.querySelectorAll("p")].map(
        (paragraph) => paragraph.firstChild as Text,
      );
      // Five pages of 30 characters. EPUB.js measures the displayed text again on every
      // location request, and a turn scrolls the reading area a page along.
      const starts: Array<[Text, number]> = [
        [first, 0],
        [first, 30],
        [second, 0],
        [second, 30],
        [second, 60],
        [second, 90],
      ];
      let page = 1;
      const container = document.createElement("div");
      const locate = vi.fn(() => ({
        atStart: page === 1,
        atEnd: false,
        start: { index: 0, cfi: `epubcfi(start-${page})`, displayed: { page, total: 5 } },
        end: { index: 0, cfi: `epubcfi(end-${page})`, displayed: { page, total: 5 } },
      }));
      const manager = Object.assign(rendition.manager, { container, currentLocation: locate });
      rendition.currentLocation.mockImplementation(() => manager.currentLocation() as never);
      rendition.next.mockImplementation(async () => {
        page++;
        container.scrollLeft += 1066;
        rendition.emit("relocated");
      });
      // A page's end is its last character.
      const contents = {
        document: sectionDocument,
        sectionIndex: 0,
        cfiFromRange: vi.fn(() => "epubcfi(point)"),
        range: vi.fn((cfi: string) => {
          const [, edge, number] = /(start|end)-(\d)/.exec(cfi)!;
          const range = sectionDocument.createRange();
          if (edge === "start") range.setStart(...starts[+number - 1]);
          else {
            const [node, offset] = starts[+number];
            range.setStart(offset ? node : first, offset ? offset - 1 : 59);
            range.setEnd(offset ? node : first, offset || 60);
          }
          return range;
        }),
      };
      rendition.getContents.mockReturnValue([contents] as never);
      const onProgress = vi.fn();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          positionBinding(),
          onProgress,
        );
        await vi.waitFor(() =>
          expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 0 })),
        );
        const walks = vi.spyOn(sectionDocument, "createTreeWalker");
        locate.mockClear();
        await renderer.advancePage();
        expect(onProgress).toHaveBeenLastCalledWith(
          expect.objectContaining({ current: 30, total: 150 }),
        );
        expect(locate).toHaveBeenCalledOnce();
        // Only the locator's measure of the section's length reads the whole section.
        expect(walks).toHaveBeenCalledOnce();

        // The next turn measures its own page.
        await renderer.advancePage();
        expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 60 }));
        expect(locate).toHaveBeenCalledTimes(2);
        // Text added to the section counts on the next page, scaled to the counted section.
        first.data = `う${first.data}`;
        await renderer.advancePage();
        expect(onProgress).toHaveBeenLastCalledWith(
          expect.objectContaining({ current: Math.round((91 / 151) * 150) }),
        );
      } finally {
        renderer.dispose();
      }
    });

    it("ignores a change before the book is ready, during a turn, or after disposal", async () => {
      const text = "ab ".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      reflowingSection(rendition, 0, text, { offset: 30 });
      const renderer = epubRendererFactory(id)();
      await renderer.setPresentation?.({ fontSize: 20 });
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      display.mockClear();

      let finish!: () => void;
      rendition.next.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            finish = () => {
              rendition.emit("relocated");
              resolve(undefined);
            };
          }),
      );
      const turning = renderer.advancePage();
      await renderer.setPresentation?.({ fontSize: 20 });
      expect(display).not.toHaveBeenCalled();
      finish();
      await turning;
      // Ignored changes were not recorded, so the same size still applies afterwards.
      await renderer.setPresentation?.({ fontSize: 20 });
      expect(display).toHaveBeenCalledOnce();

      renderer.dispose();
      await renderer.setPresentation?.({ fontSize: 22 });
      expect(display).toHaveBeenCalledOnce();
    });

    it("leaves the book's line spacing by default and replaces it for all text when chosen", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const own = document.implementation.createHTMLDocument();
      own.documentElement.style.lineHeight = "1.4";
      fontSizeHook(book)(own);
      expect(own.documentElement.style.lineHeight).toBe("1.4");
      expect(own.documentElement.hasAttribute("data-komori-line-height")).toBe(false);
      expect(own.querySelector("style")).toBeNull();
      renderer.dispose();

      // A section loaded by EPUB.js is an XHTML document serialized again for display.
      const chosen = mockBook();
      const spaced = epubRendererFactory(id)();
      await spaced.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 18, lineHeight: 1.85 },
      );
      const xhtml = new DOMParser().parseFromString(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>p { line-height: 1.2; }</style></head>' +
          "<body><p>本文<ruby>漢<rt>かん</rt></ruby></p></body></html>",
        "application/xhtml+xml",
      );
      xhtml.documentElement.style.lineHeight = "1.3";
      fontSizeHook(chosen.book)(xhtml);
      fontSizeHook(chosen.book)(xhtml);
      const root = xhtml.documentElement;
      expect(root.style.getPropertyValue("line-height")).toBe("1.85");
      expect(root.style.getPropertyPriority("line-height")).toBe("important");
      expect(root.style.fontSize).toBe("18px");
      const styles = xhtml.querySelectorAll("style[data-komori-line-height]");
      expect(styles).toHaveLength(1);
      expect(styles[0].namespaceURI).toBe("http://www.w3.org/1999/xhtml");
      // Every element but ruby annotations inherits the root's multiple over the book's rules.
      expect(styles[0].textContent).toContain(
        "body *:not(rt):not(rp) { line-height: inherit !important; }",
      );
      expect(new XMLSerializer().serializeToString(xhtml)).toContain(
        '<style data-komori-line-height="">',
      );
      spaced.dispose();
      // Returning to the book's spacing restores the root line height the book set.
      const restored = mockBook();
      const plain = epubRendererFactory(id)();
      await plain.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      fontSizeHook(restored.book)(xhtml);
      expect(root.style.lineHeight).toBe("1.3");
      expect(root.style.getPropertyPriority("line-height")).toBe("");
      expect(root.hasAttribute("data-komori-line-height")).toBe(false);
      plain.dispose();
    });

    it("reflows to the same point when the line height changes and when it returns to the book's", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 20 },
      );
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });

      await renderer.setPresentation?.({ fontSize: 20, lineHeight: 2 });
      const root = contents.document.documentElement;
      expect(root.style.lineHeight).toBe("2");
      expect(root.hasAttribute("data-komori-line-height")).toBe(true);
      expect(sections[0].document.documentElement.style.lineHeight).toBe("2");
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ progress: 24 / text.length }),
      );

      // Line height and font size keep the same point together, and the same choice is a no-op.
      await renderer.setPresentation?.({ fontSize: 24, lineHeight: 2 });
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      await renderer.setPresentation?.({ fontSize: 24, lineHeight: 2 });
      expect(display).toHaveBeenCalledTimes(2);

      await renderer.setPresentation?.({ fontSize: 24 });
      expect(root.style.lineHeight).toBe("");
      expect(root.hasAttribute("data-komori-line-height")).toBe(false);
      expect(sections[0].document.documentElement.style.lineHeight).toBe("");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(3);
      renderer.dispose();
    });

    const weightStyle = (target: Document) =>
      target.querySelector("style[data-komori-font-weight]")?.textContent ?? null;

    it("shifts every weight the book sets by a chosen font weight before layout", async () => {
      const { book } = mockBook();
      book.archive.request.mockImplementation((async (path: string) =>
        path === "/Styles/base/bold.css"
          ? `@import "../book.css"; .gfont.bold { font-weight: bold }`
          : path === "/Styles/book.css"
            ? `/* @import "ignored.css"; */ @import url("base/bold.css") screen;
             p { font-weight: normal }
             .bold { font-weight: bold }
             .heavy { font: 800 1em serif }
             .louder { font-weight: bolder }
             @media screen { .thin { font-weight: 200 !important } }`
            : path.endsWith(".xhtml")
              ? book.load(path)
              : null) as never);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, fontWeight: 700 },
      );
      const hook = fontSizeHook(book);
      const chapter = document.implementation.createHTMLDocument();
      chapter.head.innerHTML =
        '<link rel="stylesheet" href="../Styles/book.css"/><link rel="stylesheet" href="../Styles/book.css"/>' +
        "<style>h2.plain { font-weight: 400 }</style>";
      chapter.body.innerHTML =
        '<p>Body <span class="bold">bold</span> <b style="font-weight: 600">inline</b></p>';
      await hook(chapter, { url: "/Text/one.xhtml" });

      // The stylesheet is read from the archive once, relative to the section.
      expect(
        book.archive.request.mock.calls.filter((call) => (call as unknown[])[1] === "text"),
      ).toEqual([
        ["/Styles/book.css", "text"],
        ["/Styles/base/bold.css", "text"],
      ]);
      const rules = weightStyle(chapter)!.split("\n");
      expect(rules.slice(0, 2)).toEqual([
        "html { font-weight: 700; }",
        "h1, h2, h3, h4, h5, h6, th { font-weight: 1000; }",
      ]);
      // Each book rule comes again in order, shifted; a relative weight is left to follow.
      // An imported stylesheet's rules come first, within its media, and a cycle ends.
      expect(rules.slice(2, 7)).toEqual([
        "@media screen { .gfont.bold { font-weight: 1000; } }",
        "p { font-weight: 700; }",
        ".bold { font-weight: 1000; }",
        ".heavy { font-weight: 1000; }",
        "@media screen { .thin { font-weight: 500 !important; } }",
      ]);
      expect(rules.at(-1)).toBe("h2.plain { font-weight: 700; }");
      expect(rules).toHaveLength(13);
      // The rules follow the book's own stylesheets.
      expect(chapter.head.lastElementChild?.hasAttribute("data-komori-font-weight")).toBe(true);
      const inline = chapter.querySelector("b")!;
      expect(inline.style.fontWeight).toBe("900");
      expect(inline.getAttribute("data-komori-own-font-weight")).toBe("600");
      renderer.dispose();
    });

    it("styles sections whose linked stylesheets import each other", async () => {
      const { book } = mockBook();
      book.archive.request.mockImplementation((async (path: string) =>
        path === "/Styles/a.css"
          ? `@import "b.css"; @import "shared.css"; .a { font-weight: bold }`
          : path === "/Styles/b.css"
            ? `@import "a.css" print; @import "shared.css"; .b { font-weight: normal }`
            : path === "/Styles/shared.css"
              ? `.shared { font-weight: 800 }`
              : path.endsWith(".xhtml")
                ? book.load(path)
                : null) as never);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, fontWeight: 700 },
      );
      const hook = fontSizeHook(book);
      const chapter = (links: string[]) => {
        const target = document.implementation.createHTMLDocument();
        target.head.innerHTML = links
          .map((name) => `<link rel="stylesheet" href="../Styles/${name}"/>`)
          .join("");
        return target;
      };
      // A section hook that never settles keeps EPUB.js from displaying the section.
      const settled = (styling: Promise<void> | void) =>
        Promise.race([
          Promise.resolve(styling).then(() => "styled"),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 500)),
        ]);

      // Two sections, each linking one of the stylesheets, styled at the same time.
      const one = chapter(["a.css"]);
      const two = chapter(["b.css"]);
      expect(
        await Promise.all([
          settled(hook(one, { url: "/Text/one.xhtml" })),
          settled(hook(two, { url: "/Text/two.xhtml" })),
        ]),
      ).toEqual(["styled", "styled"]);
      // Each stylesheet's imports come first, within their media; a cycle ends, and a
      // stylesheet imported twice comes at both places.
      const bookRules = (target: Document) => weightStyle(target)!.split("\n").slice(2);
      expect(bookRules(one)).toEqual([
        ".shared { font-weight: 1000; }",
        ".b { font-weight: 700; }",
        ".shared { font-weight: 1000; }",
        ".a { font-weight: 1000; }",
      ]);
      expect(bookRules(two)).toEqual([
        "@media print { .shared { font-weight: 1000; } }",
        "@media print { .a { font-weight: 1000; } }",
        ".shared { font-weight: 1000; }",
        ".b { font-weight: 700; }",
      ]);

      // A section linking both, in either order, reuses the stylesheets already read.
      for (const [first, second] of [
        [one, two],
        [two, one],
      ]) {
        const both = chapter(first === one ? ["a.css", "b.css"] : ["b.css", "a.css"]);
        expect(await settled(hook(both, { url: "/Text/three.xhtml" }))).toBe("styled");
        expect(bookRules(both)).toEqual([...bookRules(first), ...bookRules(second)]);
      }
      expect(
        book.archive.request.mock.calls
          .filter((call) => (call as unknown[])[1] === "text")
          .map(([path]) => path)
          .sort(),
      ).toEqual(["/Styles/a.css", "/Styles/b.css", "/Styles/shared.css"]);
      renderer.dispose();
    });

    it("leaves the book's weights alone by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const chapter = document.implementation.createHTMLDocument();
      chapter.head.innerHTML = "<style>.bold { font-weight: bold }</style>";
      chapter.body.innerHTML = '<p style="font-weight: 600">Inline</p>';
      await fontSizeHook(book)(chapter, { url: "/Text/one.xhtml" });
      expect(weightStyle(chapter)).toBeNull();
      expect(chapter.querySelector("p")!.style.fontWeight).toBe("600");
      expect(chapter.querySelector("[data-komori-own-font-weight]")).toBeNull();
      renderer.dispose();
    });

    it("reflows to the same point when the font weight changes and when it returns to the book's", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      sections[0].document.head.innerHTML = "<style>.bold { font-weight: bold }</style>";
      const { book, rendition, display } = mockBook(sections);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      contents.document.body.firstElementChild!.setAttribute("style", "font-weight: 500");
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 20, lineHeight: 1.5 },
      );
      // EPUB.js loaded the section, and so collected its rules, before displaying it.
      await fontSizeHook(book)(sections[0].document, { url: "/Text/one.xhtml" });
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 26;
      });

      await renderer.setPresentation?.({ fontSize: 20, lineHeight: 1.5, fontWeight: 300 });
      // Displayed and cached documents both use the section's rules.
      for (const target of [contents.document, sections[0].document]) {
        expect(weightStyle(target)).toContain(".bold { font-weight: 600; }");
        expect(weightStyle(target)).toContain("html { font-weight: 300; }");
      }
      const paragraph = contents.document.querySelector("p")!;
      expect(paragraph.style.fontWeight).toBe("400");
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);

      // Weight and the other choices keep the same point together; the same choice is a no-op.
      await renderer.setPresentation?.({ fontSize: 22, lineHeight: 1.5, fontWeight: 900 });
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(weightStyle(contents.document)).toContain(".bold { font-weight: 1000; }");
      expect(paragraph.style.fontWeight).toBe("1000");
      await renderer.setPresentation?.({ fontSize: 22, lineHeight: 1.5, fontWeight: 900 });
      expect(display).toHaveBeenCalledTimes(2);

      await renderer.setPresentation?.({ fontSize: 22, lineHeight: 1.5 });
      expect(weightStyle(contents.document)).toBeNull();
      expect(weightStyle(sections[0].document)).toBeNull();
      expect(paragraph.style.fontWeight).toBe("500");
      expect(paragraph.hasAttribute("data-komori-own-font-weight")).toBe(false);
      expect(contents.document.documentElement.style.lineHeight).toBe("1.5");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(3);
      renderer.dispose();
    });

    const indentStyle = (target: Document) =>
      target.querySelector("style[data-komori-paragraph-indent]")?.textContent ?? null;
    const spaceIndented = (target: Document) =>
      Array.from(target.querySelectorAll("[data-komori-space-indent]")).map(
        (element) => element.textContent,
      );

    it("replaces the book's paragraph indentation with a chosen one before layout", async () => {
      const { book } = mockBook();
      book.archive.request.mockImplementation((async (path: string) =>
        path === "/Styles/book.css"
          ? `body, div, p { text-indent: 0 }
             p { text-indent: 20pt }
             p.noindent { text-indent: 0 }
             .indent-3em { text-indent: 3em }
             @media screen { .note { text-indent: 1.5em } }
             .hltr .h-indent-2em { text-indent: -2em; padding-left: 2em }
             .bold { font-weight: bold }`
          : path.endsWith(".xhtml")
            ? book.load(path)
            : null) as never);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, paragraphIndent: 2 },
      );
      const chapter = document.implementation.createHTMLDocument();
      chapter.documentElement.className = "hltr";
      chapter.head.innerHTML =
        '<link rel="stylesheet" href="../Styles/book.css"/>' +
        "<style>.quote { text-indent: inherit }</style>";
      chapter.body.innerHTML =
        "<p>　Narration</p>" +
        "<p>「Dialogue」</p>" +
        "<p>\n  <span><ruby>　<rt>x</rt></ruby>Spanned</span></p>" +
        "<p><ruby>漢<rt>　</rt></ruby>Ruby first</p>" +
        '<div class="h-indent-2em"><p>　Hanging note</p></div>' +
        '<p style="text-indent: 1em">Inline</p>' +
        '<p style="text-indent: -1em">Inline hanging</p>';
      await fontSizeHook(book)(chapter, { url: "/Text/one.xhtml" });

      // Each of the book's indentation rules comes again in order, within its media:
      // positive ones take the chosen indentation, and the rest keep the book's value.
      // (jsdom drops !important from text-indent; the font weight test covers priority.)
      expect(indentStyle(chapter)!.split("\n")).toEqual([
        "body, div, p { text-indent: 0; }",
        "p { text-indent: 2em; }",
        "p.noindent { text-indent: 0; }",
        ".indent-3em { text-indent: 2em; }",
        "@media screen { .note { text-indent: 2em; } }",
        ".hltr .h-indent-2em { text-indent: -2em; }",
        ".quote { text-indent: inherit; }",
        // A leading ideographic space is part of its paragraph's indentation.
        "p[data-komori-space-indent] { text-indent: 1em !important; }",
      ]);
      expect(chapter.head.lastElementChild?.hasAttribute("data-komori-paragraph-indent")).toBe(
        true,
      );
      // Only the weight a reader chooses changes the book's weights.
      expect(chapter.querySelector("style[data-komori-font-weight]")).toBeNull();
      // Ruby annotations and whitespace before the text do not count; hanging notes are kept.
      expect(spaceIndented(chapter)).toEqual(["　Narration", "\n  　xSpanned"]);
      const [inline, hanging] = Array.from(chapter.querySelectorAll<HTMLElement>("p[style]"));
      expect(inline.style.textIndent).toBe("2em");
      expect(inline.getAttribute("data-komori-own-text-indent")).toBe("1em");
      expect(hanging.style.textIndent).toBe("-1em");
      expect(hanging.hasAttribute("data-komori-own-text-indent")).toBe(false);
      renderer.dispose();
    });

    it("leaves the book's indentation alone by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const chapter = document.implementation.createHTMLDocument();
      chapter.head.innerHTML = "<style>p { text-indent: 1em }</style>";
      chapter.body.innerHTML = '<p>　Narration</p><p style="text-indent: 2em">Inline</p>';
      await fontSizeHook(book)(chapter, { url: "/Text/one.xhtml" });
      expect(indentStyle(chapter)).toBeNull();
      expect(spaceIndented(chapter)).toEqual([]);
      expect(chapter.querySelector<HTMLElement>("p[style]")!.style.textIndent).toBe("2em");
      expect(chapter.querySelector("[data-komori-own-text-indent]")).toBeNull();
      renderer.dispose();
    });

    it("reflows to the same point when the indentation changes and when it returns to the book's", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      sections[0].document.head.innerHTML = "<style>p { text-indent: 20pt }</style>";
      const { book, rendition, display } = mockBook(sections);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const narration = contents.document.createElement("p");
      narration.textContent = "　Narration";
      const inline = contents.document.createElement("p");
      inline.setAttribute("style", "text-indent: 1.5em");
      contents.document.body.append(narration, inline);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 20, lineHeight: 1.5, fontWeight: 600 },
      );
      // EPUB.js loaded the section, and so collected its rules, before displaying it.
      await fontSizeHook(book)(sections[0].document, { url: "/Text/one.xhtml" });
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 26;
      });

      const chosen = { fontSize: 20, lineHeight: 1.5, fontWeight: 600 };
      await renderer.setPresentation?.({ ...chosen, paragraphIndent: 3 });
      // Displayed and cached documents both use the section's rules.
      for (const target of [contents.document, sections[0].document]) {
        expect(indentStyle(target)).toContain("p { text-indent: 3em; }");
        expect(indentStyle(target)).toContain("text-indent: 2em !important;");
      }
      expect(spaceIndented(contents.document)).toEqual(["　Narration"]);
      expect(inline.style.textIndent).toBe("3em");
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);

      // Indentation and the other choices keep the same point together; none indents
      // the paragraph a space already indents by taking that space back.
      await renderer.setPresentation?.({ ...chosen, fontSize: 22, paragraphIndent: 0 });
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(indentStyle(contents.document)).toContain("p { text-indent: 0em; }");
      expect(indentStyle(contents.document)).toContain("text-indent: -1em !important;");
      expect(inline.style.textIndent).toBe("0em");
      await renderer.setPresentation?.({ ...chosen, fontSize: 22, paragraphIndent: 0 });
      expect(display).toHaveBeenCalledTimes(2);

      await renderer.setPresentation?.({ ...chosen, fontSize: 22 });
      expect(indentStyle(contents.document)).toBeNull();
      expect(indentStyle(sections[0].document)).toBeNull();
      expect(spaceIndented(contents.document)).toEqual([]);
      expect(inline.style.textIndent).toBe("1.5em");
      expect(inline.hasAttribute("data-komori-own-text-indent")).toBe(false);
      expect(weightStyle(contents.document)).toContain("html { font-weight: 600; }");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(3);
      renderer.dispose();
    });

    /** The gap EPUB.js reads for its next layout. */
    function pageGap(book: ReturnType<typeof mockBook>["book"]): number | undefined {
      const calls = book.renderTo.mock.calls as unknown as Array<[HTMLElement, { gap?: number }]>;
      return calls.at(-1)?.[1].gap;
    }

    const marginStyle = (target: Document) =>
      target.querySelector("style[data-komori-side-margin]")?.textContent ?? null;

    const writingModeStyle = (target: Document) =>
      target.querySelector("style[data-komori-writing-mode]")?.textContent ?? null;

    it("keeps each book's own writing mode and page direction by default", async () => {
      const { book, rendition } = mockBook();
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, changed);
      const styled = document.implementation.createHTMLDocument();
      styled.documentElement.style.writingMode = "vertical-rl";
      await fontSizeHook(book)(styled);
      expect(styled.documentElement.style.writingMode).toBe("vertical-rl");
      expect(writingModeStyle(styled)).toBeNull();
      expect(rendition.manager.direction).not.toHaveBeenCalled();
      expect(rendition.settings.direction).toBe("ltr");
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ forwardArrow: "ArrowRight" }),
      );
      renderer.dispose();
    });

    it.each([
      ["vertical", "ltr", null, "vertical-rl", "rtl", "ArrowLeft"],
      ["horizontal", "rtl", "vertical-rl", "horizontal-tb", "ltr", "ArrowRight"],
    ] as const)(
      "sets a chosen %s mode on every section before layout and turns in its direction",
      async (writingMode, progression, declared, css, direction, forwardArrow) => {
        const { book, rendition } = mockBook();
        Object.assign(book, { package: { ...book.package, metadata: { direction: progression } } });
        rendition.settings.direction = progression;
        rendition.manager.layout.settings.direction = progression;
        if (declared) {
          book.archive.request.mockResolvedValue(
            new DOMParser().parseFromString(
              `<package><metadata><meta name="primary-writing-mode" content="${declared}"/></metadata></package>`,
              "application/xml",
            ),
          );
        }
        const changed = vi.fn();
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          changed,
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, writingMode },
        );
        // Every content hook runs in order, as EPUB.js loads a section.
        const styled = document.implementation.createHTMLDocument();
        for (const [hook] of book.spine.hooks.content.register.mock.calls)
          await (hook as (document: Document) => unknown)(styled);
        const root = styled.documentElement;
        // jsdom keeps no priority for writing-mode; the app sets it as important.
        expect(root.style.getPropertyValue("writing-mode")).toBe(css);
        // The book's own modes on the body and its elements give way to the chosen one, in a
        // layer that outranks the book's important rules however specific they are.
        expect(writingModeStyle(styled)).toMatch(
          /^@layer komori-writing-mode \{ :root body, :root body \* \{ writing-mode: inherit !important;/,
        );
        expect(rendition.settings.direction).toBe(direction);
        // EPUB.js formats each section's columns in its layout's copy of the direction.
        expect(rendition.manager.layout.settings.direction).toBe(direction);
        expect(rendition.manager.direction).toHaveBeenCalledWith(direction);
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ forwardArrow }));
        // The chosen mode survives serialization into the displayed iframe.
        const serialized = new XMLSerializer().serializeToString(styled);
        expect(serialized).toContain("data-komori-writing-mode");
        renderer.dispose();
      },
    );

    it("reflows to the same point in a chosen writing mode and back to the book's own", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const { manager } = rendition;
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const changed = vi.fn();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        changed,
        undefined,
        undefined,
        binding,
      );
      display.mockClear();
      // EPUB.js renders the section afresh and reports its new axis as it does.
      display.mockImplementationOnce(async () => {
        manager.updateAxis("vertical");
      });

      await renderer.setPresentation?.({ fontSize: 16, writingMode: "vertical" });
      // EPUB.js's cached section document takes the mode before it is rendered again.
      expect(sections[0].document.documentElement.style.writingMode).toBe("vertical-rl");
      expect(contents.document.documentElement.style.writingMode).toBe("vertical-rl");
      expect(manager.clear).toHaveBeenCalledOnce();
      expect(manager.direction).toHaveBeenLastCalledWith("rtl");
      // The new axis lays the pages out again and pages by height.
      expect(manager.updateLayout).toHaveBeenCalledOnce();
      expect(manager.layout.delta).toBe(780);
      expect(display.mock.calls).toEqual([["Text/one.xhtml"], ["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 30 / text.length }),
      );
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ forwardArrow: "ArrowLeft", canAdvance: true }),
      );

      // The book's own mode and page direction return the same way.
      display.mockImplementationOnce(async () => {
        manager.updateAxis("horizontal");
      });
      await renderer.setPresentation?.({ fontSize: 16 });
      for (const target of [sections[0].document, contents.document]) {
        expect(target.documentElement.style.writingMode).toBe("");
        expect(target.documentElement.hasAttribute("data-komori-own-writing-mode")).toBe(false);
        expect(writingModeStyle(target)).toBeNull();
      }
      expect(manager.clear).toHaveBeenCalledTimes(2);
      expect(manager.direction).toHaveBeenLastCalledWith("ltr");
      expect(display.mock.calls.slice(2)).toEqual([["Text/one.xhtml"], ["epubcfi(offset-30)"]]);
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ forwardArrow: "ArrowRight" }),
      );

      // Other changes reflow in place, without rendering the section again.
      await renderer.setPresentation?.({ fontSize: 18 });
      expect(manager.clear).toHaveBeenCalledTimes(2);
      renderer.dispose();
    });

    it("restores a declared vertical mode when a chosen mode returns to the book's own", async () => {
      const { book } = mockBook();
      book.archive.request.mockResolvedValue(
        new DOMParser().parseFromString(
          '<package><metadata><meta name="primary-writing-mode" content="vertical-rl"/></metadata></package>',
          "application/xml",
        ),
      );
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, writingMode: "horizontal" },
      );
      const loaded = book.spine.get(0) as unknown as { document: Document };
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(loaded.document);
      expect(loaded.document.documentElement.style.writingMode).toBe("horizontal-tb");
      await renderer.setPresentation?.({ fontSize: 16 });
      expect(loaded.document.documentElement.style.writingMode).toBe("vertical-rl");
      expect(writingModeStyle(loaded.document)).toBeNull();
      renderer.dispose();
    });

    it("leaves a fixed-layout book's writing mode and page direction alone", async () => {
      const { book, rendition, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, writingMode: "vertical" },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(styled.documentElement.style.writingMode).toBe("");
      expect(writingModeStyle(styled)).toBeNull();
      expect(rendition.manager.direction).not.toHaveBeenCalled();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, writingMode: "horizontal" });
      expect(display).not.toHaveBeenCalled();
      expect(rendition.manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const orientationStyle = (target: Document) =>
      target.querySelector("style[data-komori-text-orientation]")?.textContent ?? null;

    it("keeps each book's own text orientation by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(orientationStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it.each(["mixed", "upright"] as const)(
      "sets a chosen %s orientation on every section before layout",
      async (textOrientation) => {
        const { book } = mockBook();
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, textOrientation },
        );
        const styled = document.implementation.createHTMLDocument();
        for (const [hook] of book.spine.hooks.content.register.mock.calls)
          await (hook as (document: Document) => unknown)(styled);
        // The book's own orientations on the root, body, and its elements give way.
        expect(orientationStyle(styled)).toBe(
          `:root, :root body, :root body * { text-orientation: ${textOrientation} !important; ` +
            `-webkit-text-orientation: ${textOrientation} !important; }`,
        );
        // Orientation leaves the writing mode, and so the page axis, to the book.
        expect(styled.documentElement.style.writingMode).toBe("");
        const serialized = new XMLSerializer().serializeToString(styled);
        expect(serialized).toContain("data-komori-text-orientation");
        renderer.dispose();
      },
    );

    it("reflows to the same point in a chosen text orientation and back to the book's own", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const { manager } = rendition;
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 16, writingMode: "vertical" },
      );
      display.mockClear();
      manager.clear.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });

      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        textOrientation: "upright",
      });
      for (const target of [sections[0].document, contents.document])
        expect(orientationStyle(target)).toContain("text-orientation: upright !important");
      // The axis stays, so the section reflows in place rather than rendering again.
      expect(manager.clear).not.toHaveBeenCalled();
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
      );

      // Changing to Mixed keeps the same point, and the same choice is a no-op.
      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        textOrientation: "mixed",
      });
      expect(orientationStyle(contents.document)).toContain("text-orientation: mixed !important");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        textOrientation: "mixed",
      });
      expect(display).toHaveBeenCalledTimes(2);

      await renderer.setPresentation?.({ fontSize: 16, writingMode: "vertical" });
      for (const target of [sections[0].document, contents.document])
        expect(orientationStyle(target)).toBeNull();
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(3);
      expect(manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("styles again a view rendered from a section serialized before a change", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { book, rendition } = mockBook(sections);
      reflowingSection(rendition, 0, text, { offset: 30 });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, textOrientation: "mixed" },
      );
      // EPUB.js serialized this view's section before the change, and loads it after.
      const stale = document.implementation.createHTMLDocument();
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(stale);
      await renderer.setPresentation?.({ fontSize: 18, textOrientation: "upright" });
      expect(orientationStyle(stale)).toContain("text-orientation: mixed");
      const rendered = rendition.on.mock.calls
        .filter(([name]) => name === "rendered")
        .map(([, listener]) => listener as (section: unknown, view: unknown) => void);
      const view = { contents: { document: stale, sectionIndex: 0, resizeCheck: vi.fn() } };
      for (const listener of rendered) listener(sections[0], view);
      expect(orientationStyle(stale)).toContain("text-orientation: upright");
      expect(stale.documentElement.style.fontSize).toBe("18px");
      expect(view.contents.resizeCheck).toHaveBeenCalledOnce();

      // A view rendered with the current presentation is left as it is.
      for (const listener of rendered) listener(sections[0], view);
      expect(view.contents.resizeCheck).toHaveBeenCalledOnce();
      renderer.dispose();
    });

    it("leaves a fixed-layout book's text orientation alone", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, textOrientation: "upright" },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(orientationStyle(styled)).toBeNull();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, textOrientation: "mixed" });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const furiganaStyle = (target: Document) =>
      target.querySelector("style[data-komori-hide-furigana]")?.textContent ?? null;

    it.each(["paginated", "continuous", "semi-continuous", "vn"] as const)(
      "applies interactive furigana styles without navigation in %s and both axes",
      async (viewMode) => {
        for (const writingMode of ["horizontal", "vertical"] as const) {
          const text = "ab ".repeat(50);
          const sections = [section("Text/one.xhtml", text)];
          const { book, rendition, display } = mockBook(sections);
          const contents = reflowingSection(rendition, 0, text, { offset: 30 });
          sections[0].document.body.insertAdjacentHTML("beforeend", "<ruby>漢<rt>かん</rt></ruby>");
          contents.document.body.insertAdjacentHTML("beforeend", "<ruby>漢<rt>かん</rt></ruby>");
          const renderer = epubRendererFactory(id)();
          const onProgress = vi.fn();
          await renderer.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            positionBinding(),
            onProgress,
            { fontSize: 16, writingMode, viewMode, hideFurigana: true, furiganaStyle: "toggle" },
          );
          await fontSizeHook(book)(sections[0].document);
          // A cached section and the live iframe receive the same mode; reveal never reflows.
          await renderer.setPresentation?.({
            fontSize: 16,
            writingMode,
            viewMode,
            hideFurigana: true,
            furiganaStyle: "full",
          });
          display.mockClear();
          contents.resizeCheck.mockClear();
          onProgress.mockClear();
          for (const mode of ["partial", "toggle", "full"] as const) {
            await renderer.setPresentation?.({
              fontSize: 16,
              writingMode,
              viewMode,
              hideFurigana: true,
              furiganaStyle: mode,
            });
            expect(furiganaStyle(contents.document)).toContain(
              mode === "partial" ? "opacity: 0.35" : "visibility: hidden",
            );
            expect(furiganaStyle(sections[0].document)).toBe(furiganaStyle(contents.document));
          }
          const ruby = contents.document.querySelector("ruby")!;
          ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          expect(ruby.hasAttribute("data-komori-furigana-revealed")).toBe(true);
          expect(
            sections[0].document
              .querySelector("ruby")!
              .hasAttribute("data-komori-furigana-revealed"),
          ).toBe(true);
          expect(display).not.toHaveBeenCalled();
          expect(contents.resizeCheck).not.toHaveBeenCalled();
          expect(onProgress).not.toHaveBeenCalled();
          renderer.dispose();
        }
      },
    );

    it("shows furigana by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, hideFurigana: false },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(furiganaStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it("hides every section's ruby annotations before layout", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, hideFurigana: true },
      );
      const styled = document.implementation.createHTMLDocument();
      styled.body.innerHTML = "<p><ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>字</p>";
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(styled);
      expect(furiganaStyle(styled)).toBe(
        ":root body rt, :root body rp { display: none !important; }",
      );
      // The ruby base stays, and the annotations stay in the document.
      expect(styled.querySelector("rt")?.textContent).toBe("かん");
      expect(styled.body.textContent).toBe("漢(かん)字");
      const serialized = new XMLSerializer().serializeToString(styled);
      expect(serialized).toContain("data-komori-hide-furigana");
      renderer.dispose();
    });

    it("reflows to the same point when furigana is hidden and shown again", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const { manager } = rendition;
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 16, writingMode: "vertical", hideFurigana: false },
      );
      display.mockClear();
      manager.clear.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });

      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        hideFurigana: true,
      });
      for (const target of [sections[0].document, contents.document])
        expect(furiganaStyle(target)).toContain("display: none !important");
      // The axis stays, so the section reflows in place rather than rendering again.
      expect(manager.clear).not.toHaveBeenCalled();
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
      );

      // The same choice is a no-op.
      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        hideFurigana: true,
      });
      expect(display).toHaveBeenCalledOnce();

      // Showing furigana again keeps the same point.
      await renderer.setPresentation?.({
        fontSize: 16,
        writingMode: "vertical",
        hideFurigana: false,
      });
      for (const target of [sections[0].document, contents.document])
        expect(furiganaStyle(target)).toBeNull();
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(2);
      expect(manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("leaves a fixed-layout book's furigana alone", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, hideFurigana: true },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(furiganaStyle(styled)).toBeNull();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, hideFurigana: false });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const blurStyle = (target: Document) =>
      target.querySelector("style[data-komori-blur-image]")?.textContent ?? null;

    it.each(["paginated", "continuous", "semi-continuous"] as const)(
      "applies contents scope and session reveals without navigation in %s and both writing modes",
      async (viewMode) => {
        for (const writingMode of ["horizontal", "vertical"] as const) {
          const sections = [
            section("Text/front.xhtml", "", true, '<img alt="Front" src="same.png">'),
            section(
              "toc.xhtml",
              "Contents",
              true,
              '<nav><a href="Text/chapter.xhtml">Chapter</a><img src="same.png"></nav>',
            ),
            section(
              "Text/chapter.xhtml",
              "Chapter",
              true,
              '<p>Chapter text</p><img alt="Art" src="same.png"><img alt="Repeated" src="same.png">',
            ),
          ];
          const { rendition, book, display } = mockBook(sections, [
            { label: "Chapter", href: "Text/chapter.xhtml" },
          ]);
          const shown = section("shown", "", true, sections[2].document.body.innerHTML).document;
          rendition.getContents.mockReturnValue([
            { document: shown, sectionIndex: 2, cfiFromRange: vi.fn(), resizeCheck: vi.fn() },
          ] as never);
          const binding = positionBinding();
          const progress = vi.fn();
          const renderer = epubRendererFactory(id)();
          const presentation = {
            fontSize: 16,
            viewMode,
            writingMode,
            blurImage: true,
            blurMode: "after-toc" as const,
          };
          await renderer.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            binding,
            progress,
            presentation,
          );
          for (const part of sections) {
            for (const [hook] of book.spine.hooks.content.register.mock.calls)
              await (hook as (doc: Document, section: unknown) => unknown)(part.document, part);
          }
          expect(renderer.getImageBlurBoundary?.()).toBe("available");
          expect(sections[0].document.querySelector("[data-komori-image-blurred]")).toBeNull();
          expect(sections[1].document.querySelector("[data-komori-image-blurred]")).toBeNull();
          expect(shown.querySelectorAll("[data-komori-image-blurred]")).toHaveLength(2);
          display.mockClear();
          binding.onLocationChanged.mockClear();
          progress.mockClear();
          shown.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          expect(shown.querySelectorAll("[data-komori-image-blurred]")).toHaveLength(1);
          expect(sections[2].document.querySelector("img")?.getAttribute("aria-pressed")).toBe(
            "true",
          );
          await renderer.setPresentation!({ ...presentation, blurMode: "all" });
          expect(sections[0].document.querySelector("[data-komori-image-blurred]")).not.toBeNull();
          expect(shown.querySelector("img")?.getAttribute("aria-pressed")).toBe("true");
          expect(display).not.toHaveBeenCalled();
          expect(binding.onLocationChanged).not.toHaveBeenCalled();
          expect(progress).not.toHaveBeenCalled();
          // A late serialized iframe is corrected even when its presentation key is current.
          const late = section(
            "late",
            "",
            true,
            '<p>Chapter text</p><img alt="Art"><img alt="Repeated">',
          ).document;
          const contents = {
            document: late,
            sectionIndex: 2,
            cfiFromRange: vi.fn(),
            resizeCheck: vi.fn(),
          };
          rendition.getContents.mockReturnValue([contents] as never);
          const rendered = rendition.on.mock.calls.find(([event]) => event === "rendered")?.[1];
          rendered?.({ contents } as never);
          expect(late.querySelector("img")?.getAttribute("aria-pressed")).toBe("true");
          late
            .querySelector("img")!
            .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          expect(late.querySelectorAll("[data-komori-image-blurred]")).toHaveLength(2);
          renderer.dispose();
          expect(book.destroy).toHaveBeenCalled();
        }
      },
    );

    it.each([
      { toc: [] },
      { toc: [{ label: "Chapter", href: "Text/one.xhtml" }] },
      { toc: [{ label: "External", href: "https://example.org" }] },
    ])("falls back to All without a usable in-spine contents page", async ({ toc }) => {
      const sections = [section("Text/one.xhtml", "", true, '<img alt="Art">')];
      const { book } = mockBook(sections, toc);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, blurImage: true, blurMode: "after-toc" },
      );
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (doc: Document, section: unknown) => unknown)(
          sections[0].document,
          sections[0],
        );
      expect(renderer.getImageBlurBoundary?.()).toBe("unavailable");
      expect(
        sections[0].document.querySelector("img")?.hasAttribute("data-komori-image-blurred"),
      ).toBe(true);
      renderer.dispose();
    });

    it("shows images unblurred by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, blurImage: false },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(blurStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it("blurs every section's images before layout", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, blurImage: true },
      );
      const styled = document.implementation.createHTMLDocument();
      const markup =
        '<p>Text <img src="a.png" width="20"/> text</p>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="b.png"/></svg>';
      styled.body.innerHTML = markup;
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(styled);
      // An outer svg blurs as a whole, so the images inside it are not blurred twice.
      expect(blurStyle(styled)).toContain("filter: blur(20px) !important");
      expect(styled.querySelectorAll("[data-komori-image-blurred]")).toHaveLength(2);
      expect(styled.querySelector("img")?.getAttribute("width")).toBe("20");
      expect(styled.body.textContent).toBe("Text  text");
      const serialized = new XMLSerializer().serializeToString(styled);
      expect(serialized).toContain("data-komori-blur-image");
      renderer.dispose();
    });

    it.each(["paginated", "continuous", "semi-continuous"] as const)(
      "blurs and restores images in place in %s view",
      async (viewMode) => {
        const text = "ab ".repeat(50);
        const sections = [section("Text/one.xhtml", text)];
        const { rendition, display } = mockBook(sections);
        const { manager } = rendition;
        const contents = reflowingSection(rendition, 0, text, { offset: 30 });
        sections[0].document.body.insertAdjacentHTML("beforeend", '<img src="a.png">');
        contents.document.body.insertAdjacentHTML("beforeend", '<img src="a.png">');
        const binding = positionBinding();
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
          undefined,
          { fontSize: 16, viewMode, blurImage: false },
        );
        display.mockClear();
        manager.clear.mockClear();
        binding.onLocationChanged.mockClear();

        await renderer.setPresentation?.({ fontSize: 16, viewMode, blurImage: true });
        for (const target of [sections[0].document, contents.document])
          expect(blurStyle(target)).toContain("filter: blur(20px) !important");
        // A blur changes no layout: nothing is displayed, measured, or published.
        expect(display).not.toHaveBeenCalled();
        expect(manager.clear).not.toHaveBeenCalled();
        expect(contents.resizeCheck).not.toHaveBeenCalled();
        expect(binding.onLocationChanged).not.toHaveBeenCalled();

        // The same choice is a no-op, and turning it off restores the images in place.
        await renderer.setPresentation?.({ fontSize: 16, viewMode, blurImage: true });
        await renderer.setPresentation?.({ fontSize: 16, viewMode, blurImage: false });
        for (const target of [sections[0].document, contents.document])
          expect(blurStyle(target)).toBeNull();
        expect(display).not.toHaveBeenCalled();
        expect(contents.resizeCheck).not.toHaveBeenCalled();
        expect(binding.onLocationChanged).not.toHaveBeenCalled();
        renderer.dispose();
      },
    );

    it.each(["landmark", "guide"])(
      "resolves an authored %s ToC before styling, including a same-section fragment",
      async (kind) => {
        const sections = [
          section(
            "Text/one.xhtml",
            "",
            true,
            '<img id="front"><nav id="contents"><a href="#chapter">Chapter</a><img id="toc-art"></nav><h1 id="chapter">Chapter</h1><img id="art">',
          ),
        ];
        const toc = [{ label: "Chapter", href: "Text/one.xhtml#chapter" }];
        const { book } = mockBook(sections, toc);
        if (kind === "landmark")
          book.loaded.navigation = Promise.resolve({
            toc,
            landmark: (type: string) =>
              type === "toc" ? { href: "Text/one.xhtml#contents" } : undefined,
          } as never);
        else
          book.archive.request.mockResolvedValue(
            new DOMParser().parseFromString(
              '<package><guide><reference type="toc" href="Text/one.xhtml#contents"/></guide></package>',
              "application/xml",
            ),
          );
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, blurImage: true, blurMode: "after-toc" },
        );
        for (const [hook] of book.spine.hooks.content.register.mock.calls)
          await (hook as (doc: Document, section: unknown) => unknown)(
            sections[0].document,
            sections[0],
          );
        expect(renderer.getImageBlurBoundary?.()).toBe("available");
        expect(
          [...sections[0].document.querySelectorAll("[data-komori-image-blurred]")].map(
            (e) => e.id,
          ),
        ).toEqual(["art"]);
        renderer.dispose();
      },
    );

    it("reflows a blur changed with another setting to the kept point", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const contents = reflowingSection(rendition, 0, text, { offset: 30 });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(),
        undefined,
        { fontSize: 16, blurImage: false },
      );
      display.mockClear();
      contents.document.body.insertAdjacentHTML("beforeend", '<img src="a.png">');
      await renderer.setPresentation?.({ fontSize: 18, blurImage: true });
      expect(blurStyle(contents.document)).not.toBeNull();
      expect(contents.document.documentElement.style.fontSize).toBe("18px");
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      renderer.dispose();
    });

    it("leaves a fixed-layout book's images unblurred", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, blurImage: true },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(blurStyle(styled)).toBeNull();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, blurImage: false });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const colorStyle = (target: Document) =>
      target.querySelector("style[data-komori-colors]")?.textContent ?? null;

    it("keeps each book's own colors without chosen ones", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16 },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(colorStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it("colors every section's text and selection before layout, keeping links distinct", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          textColor: "#d9dce3",
          selectionColor: "#3e4e6e",
          highlightColor: "#475B82",
        },
      );
      const styled = document.implementation.createHTMLDocument();
      const markup =
        '<p style="color: #000">Dark <span class="red">text</span> ' +
        '<a href="#note">link</a> <img src="a.png"></p>';
      styled.body.innerHTML = markup;
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(styled);
      // In a layer, the important colors outrank the book's own important ones.
      expect(colorStyle(styled)).toBe(
        [
          "@layer komori-colors {",
          ":root, :root body { background-color: transparent !important; }",
          ":root body *:not(img):not(svg):not(video) { background-color: transparent !important; }",
          ":root, :root body, :root body * { color: #d9dce3 !important; }",
          ":root body a[href], :root body a[href] * " +
            "{ color: color-mix(in srgb, #d9dce3 60%, #3d7be0) !important; }",
          ":root ::selection { background-color: transparent !important; }",
          ":root [data-komori-selection-marks] span { background-color: #3e4e6e !important; }",
          ":root [data-komori-lookup-marks] span { background-color: #3e4e6e !important; }",
          ":root [data-komori-note-marks] span { background-color: #475b82 !important; }",
          "}",
        ].join("\n"),
      );
      // The book's markup is unchanged.
      expect(styled.body.innerHTML).toBe(markup);
      const serialized = new XMLSerializer().serializeToString(styled);
      expect(serialized).toContain("data-komori-colors");
      // EPUB.js shows the section from that XHTML serialization, parsed again as HTML, where
      // an escaped character would stay literal in the style.
      const shown = new DOMParser().parseFromString(serialized, "text/html");
      expect(colorStyle(shown)).toBe(colorStyle(styled));
      renderer.dispose();
    });

    it("ignores colors that are not #rrggbb", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          textColor: "red; } body { display: none",
          selectionColor: "#12345",
          highlightColor: "url(evil)",
        },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(colorStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it.each(["paginated", "continuous"] as const)(
      "recolors the book in place in %s view",
      async (viewMode) => {
        const text = "ab ".repeat(50);
        const sections = [section("Text/one.xhtml", text)];
        const { rendition, display } = mockBook(sections);
        const { manager } = rendition;
        const contents = reflowingSection(rendition, 0, text, { offset: 30 });
        const binding = positionBinding();
        const renderer = epubRendererFactory(id)();
        const paper = { textColor: "#26292e", selectionColor: "#cadcfb" };
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
          undefined,
          { fontSize: 16, viewMode, ...paper },
        );
        display.mockClear();
        manager.clear.mockClear();
        binding.onLocationChanged.mockClear();

        await renderer.setPresentation?.({
          fontSize: 16,
          viewMode,
          textColor: "#cdd6f4",
          selectionColor: "#585b70",
          highlightColor: "#89b4fa",
        });
        for (const target of [sections[0].document, contents.document]) {
          expect(colorStyle(target)).toContain("color: #cdd6f4 !important");
          expect(colorStyle(target)).toContain("background-color: #585b70 !important");
          expect(target.querySelectorAll("style[data-komori-colors]")).toHaveLength(1);
        }
        // Colors change no layout: nothing is displayed, measured, or published.
        expect(display).not.toHaveBeenCalled();
        expect(manager.clear).not.toHaveBeenCalled();
        expect(contents.resizeCheck).not.toHaveBeenCalled();
        expect(binding.onLocationChanged).not.toHaveBeenCalled();

        // A selection color alone changes too, and the same colors are a no-op.
        await renderer.setPresentation?.({
          fontSize: 16,
          viewMode,
          textColor: "#cdd6f4",
          selectionColor: "#123456",
          highlightColor: "#89b4fa",
        });
        expect(colorStyle(contents.document)).toContain("background-color: #123456 !important");
        for (const target of [sections[0].document, contents.document]) {
          // A lookup's match paints as selected text does.
          expect(colorStyle(target)).toContain(
            ":root [data-komori-lookup-marks] span { background-color: #123456 !important; }",
          );
          expect(colorStyle(target)).toContain(
            ":root [data-komori-note-marks] span { background-color: #89b4fa !important; }",
          );
        }
        // Highlight alone changes in displayed and cached sections, with Selection kept.
        await renderer.setPresentation?.({
          fontSize: 16,
          viewMode,
          textColor: "#cdd6f4",
          selectionColor: "#123456",
          highlightColor: "#ABCDEF",
        });
        for (const target of [sections[0].document, contents.document]) {
          expect(colorStyle(target)).toContain(
            ":root [data-komori-selection-marks] span { background-color: #123456 !important; }",
          );
          expect(colorStyle(target)).toContain(
            ":root [data-komori-note-marks] span { background-color: #abcdef !important; }",
          );
        }
        await renderer.setPresentation?.({
          fontSize: 16,
          viewMode,
          textColor: "#cdd6f4",
          selectionColor: "#123456",
          highlightColor: "#abcdef",
        });
        // Without colors, each book keeps its own.
        await renderer.setPresentation?.({ fontSize: 16, viewMode });
        for (const target of [sections[0].document, contents.document])
          expect(colorStyle(target)).toBeNull();
        expect(display).not.toHaveBeenCalled();
        expect(contents.resizeCheck).not.toHaveBeenCalled();
        expect(binding.onLocationChanged).not.toHaveBeenCalled();
        renderer.dispose();
      },
    );

    it("reflows colors changed with another setting to the kept point", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const contents = reflowingSection(rendition, 0, text, { offset: 30 });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(),
        undefined,
        { fontSize: 16 },
      );
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 18, textColor: "#5b4636" });
      expect(colorStyle(contents.document)).toContain("color: #5b4636 !important");
      expect(contents.document.documentElement.style.fontSize).toBe("18px");
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      renderer.dispose();
    });

    it("leaves a fixed-layout book's colors alone", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fontSize: 16,
          textColor: "#d9dce3",
          selectionColor: "#3e4e6e",
          highlightColor: "#475B82",
        },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(colorStyle(styled)).toBeNull();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, textColor: "#26292e" });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const imageMarkup =
      '<p id="running">Text <img id="inline" src="a.png" width="20"/> text</p>' +
      '<p id="alone"><span><img id="wrapped" src="b.png" width="300"/></span></p>' +
      '<div id="illustration"><p><a href="#x"><img src="c.png"/></a></p></div>' +
      '<div id="figure"><img id="lone" src="d.png"/><p id="caption">Caption</p></div>' +
      '<div id="cover"><svg id="page" xmlns="http://www.w3.org/2000/svg"><image href="e.png"/></svg></div>' +
      '<h2 id="heading"><img id="title" src="f.png"/></h2>' +
      '<p id="gaiji">Glyph <ruby><img id="ruby" src="g.png"/><rt>x</rt></ruby></p>';
    const centered = (target: Document) =>
      Array.from(target.querySelectorAll("[data-komori-image-block]"), (element) => element.id);
    const loneImages = (target: Document) =>
      Array.from(target.querySelectorAll("[data-komori-lone-image]"), (element) => element.id);
    const centerImagesStyles = (target: Document) =>
      Array.from(
        target.querySelectorAll("style[data-komori-center-images]"),
        (style) => style.textContent,
      );

    it.each(["horizontal", "vertical"] as const)(
      "centers images alone on their lines in %s text before layout",
      async (writingMode) => {
        const { book } = mockBook();
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, writingMode },
        );
        const styled = document.implementation.createHTMLDocument();
        styled.body.innerHTML = imageMarkup;
        for (const [hook] of book.spine.hooks.content.register.mock.calls)
          await (hook as (document: Document) => unknown)(styled);
        // Blocks holding only images, however wrapped, center their lines; images in
        // running text, ruby, and headings keep the book's own placement.
        expect(centered(styled)).toEqual(["alone", "", "cover"]);
        expect(
          styled.querySelector("#illustration > p")?.hasAttribute("data-komori-image-block"),
        ).toBe(true);
        expect(loneImages(styled)).toEqual(["lone"]);
        for (const kept of ["#running", "#caption", "#heading", "#gaiji", "#figure"])
          expect(styled.querySelector(kept)?.hasAttribute("data-komori-image-block")).toBe(false);
        // Logical properties center along the inline axis in either writing mode.
        expect(centerImagesStyles(styled)).toEqual([
          ":root body [data-komori-image-block] { text-align: center !important; text-indent: 0 !important; } " +
            ":root body [data-komori-image-block] img, :root body [data-komori-image-block] svg, " +
            ":root body [data-komori-lone-image] { margin-inline: auto !important; }",
        ]);
        expect(styled.documentElement.style.writingMode).toBe(
          writingMode === "vertical" ? "vertical-rl" : "horizontal-tb",
        );
        // The book's own sizing and the text stay as they are.
        expect(styled.querySelector("#wrapped")?.getAttribute("width")).toBe("300");
        expect(styled.querySelector("#inline")?.getAttribute("width")).toBe("20");
        expect(styled.body.textContent).toBe("Text  textCaptionGlyph x");
        const serialized = new XMLSerializer().serializeToString(styled);
        expect(serialized).toContain("data-komori-center-images");
        expect(serialized).toContain('data-komori-image-block=""');
        expect(styled.querySelector("#alone")!.hasAttribute("data-komori-image-block")).toBe(true);
        renderer.dispose();
      },
    );

    it("centers images in displayed and cached sections once across reflows", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text, true, `<p>${text}</p>${imageMarkup}`)];
      const { rendition, display } = mockBook(sections);
      const contents = reflowingSection(rendition, 0, text, { offset: 30 });
      contents.document.body.insertAdjacentHTML("beforeend", imageMarkup);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        positionBinding(),
        undefined,
        { fontSize: 16, writingMode: "vertical" },
      );
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 18, writingMode: "vertical" });
      await renderer.setPresentation?.({ fontSize: 20, writingMode: "vertical" });
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"], ["epubcfi(offset-30)"]]);
      for (const target of [sections[0].document, contents.document]) {
        expect(centerImagesStyles(target)).toHaveLength(1);
        expect(target.querySelectorAll("[data-komori-image-block]")).toHaveLength(3);
        expect(loneImages(target)).toEqual(["lone"]);
      }
      renderer.dispose();
    });

    it("leaves a fixed-layout book's images where the book places them", async () => {
      const { book } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const styled = document.implementation.createHTMLDocument();
      styled.body.innerHTML = imageMarkup;
      await fontSizeHook(book)(styled);
      expect(centerImagesStyles(styled)).toEqual([]);
      expect(styled.querySelector("style[data-komori-continuous-images]")).toBeNull();
      expect(centered(styled)).toEqual([]);
      expect(loneImages(styled)).toEqual([]);
      renderer.dispose();
    });

    const headingMarkup =
      '<div class="start-3em" id="wrap"><p><br/></p><p id="chapter"><a id="toc-1"></a><span>Chapter One</span></p></div>' +
      '<p id="body">Body text that follows the heading.</p>' +
      '<h2 id="toc-2"><img id="title" src="../Images/title.png"/></h2>' +
      '<div id="outer"><a id="toc-3"></a> <p id="after">Two</p><p id="rest">More text.</p></div>' +
      `<p id="toc-4">${"Long passage ".repeat(10)}</p>` +
      '<p id="middle">Text before <a id="toc-5"></a>the anchor.</p>' +
      '<p id="toc-6"><br/></p>' +
      '<h2 id="signature">Author</h2>';
    const headingToc = [1, 2, 3, 4, 5, 6].map((index) => ({
      label: `Entry ${index}`,
      href: `Text/one.xhtml#toc-${index}`,
    }));
    const headings = (target: Document) =>
      Array.from(target.querySelectorAll("[data-komori-heading]"), (element) => element.id);
    const centerHeadingStyles = (target: Document) =>
      Array.from(
        target.querySelectorAll("style[data-komori-center-headings]"),
        (style) => style.textContent,
      );
    async function runHooks(
      book: ReturnType<typeof mockBook>["book"],
      target: Document,
      item?: ReturnType<typeof section>,
    ) {
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document, section?: unknown) => unknown)(target, item);
    }

    it.each(
      (["paginated", "continuous", "semi-continuous"] as const).flatMap((viewMode) =>
        (["horizontal", "vertical"] as const).map((writingMode) => ({ viewMode, writingMode })),
      ),
    )(
      "keeps text-image sizing and title hierarchy through $viewMode/$writingMode reflow",
      async ({ viewMode, writingMode }) => {
        const markup =
          '<div><h2 id="chapter">Title <small>subtitle</small></h2></div>' +
          '<p>Body <img class="gaiji" src="glyph.png" width="128" height="128"> text.</p>' +
          '<p><img src="plate.png" width="800"></p>';
        const one = section("Text/one.xhtml", "", true, markup);
        const { book, rendition } = mockBook(
          [one],
          [{ label: "Title", href: "Text/one.xhtml#chapter" }],
        );
        const shown = document.implementation.createHTMLDocument();
        shown.body.innerHTML = markup;
        rendition.getContents.mockReturnValue([
          { document: shown, sectionIndex: 0, resizeCheck: vi.fn() },
        ] as never);
        const renderer = epubRendererFactory(id)();
        const presentation = { fontSize: 20, viewMode, writingMode };
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          presentation,
        );
        await runHooks(book, one.document, one);
        await runHooks(book, shown, one);
        for (const fontSize of [22, 24, 20]) {
          await renderer.setPresentation!({ ...presentation, fontSize });
          for (const doc of [one.document, shown]) {
            expect(doc.documentElement.style.fontSize).toBe(`${fontSize}px`);
            expect(doc.querySelector<HTMLElement>(".gaiji")!.style.width).toBe("1em");
            expect(doc.querySelector('img[src="plate.png"]')!.getAttribute("width")).toBe("800");
            expect(doc.querySelectorAll("[data-komori-text-heading]")).toHaveLength(1);
            expect(doc.querySelector("style[data-komori-center-headings]")!.textContent).toContain(
              "zoom: 1.1",
            );
            expect(doc.querySelector("small")!.hasAttribute("style")).toBe(false);
            expect(doc.body.textContent).toBe("Title subtitleBody  text.");
            expect(doc.querySelectorAll("style[data-komori-book-images]")).toHaveLength(1);
          }
        }
        renderer.dispose();
      },
    );

    it.each(["horizontal", "vertical"] as const)(
      "adds block-axis space after an image-only chapter heading in %s continuous view",
      async (writingMode) => {
        const markup =
          '<div id="wrapper"><h2 id="title"><img src="title.png" width="146" height="1920"></h2></div>' +
          '<p id="first">First paragraph.</p><h2 id="other"><img src="other.png"></h2>';
        const one = section("Text/one.xhtml", "", true, markup);
        const { book } = mockBook([one], [{ label: "Title", href: "Text/one.xhtml#title" }]);
        const renderer = epubRendererFactory(id)();
        const host = document.createElement("div");
        Object.defineProperties(host, {
          clientWidth: { value: 1000 },
          clientHeight: { value: 700 },
        });
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 20, viewMode: "continuous", writingMode },
        );
        const styled = document.implementation.createHTMLDocument();
        styled.body.innerHTML = markup;
        await runHooks(book, styled, one);
        expect(styled.querySelectorAll("[data-komori-image-heading]")).toHaveLength(1);
        expect(styled.querySelector("#wrapper")?.hasAttribute("data-komori-image-heading")).toBe(
          true,
        );
        expect(styled.querySelector("#title img")?.getAttribute("height")).toBe("1920");
        expect(styled.querySelector("#first")?.hasAttribute("data-komori-image-heading")).toBe(
          false,
        );
        expect(styled.querySelector("#other")?.hasAttribute("data-komori-image-heading")).toBe(
          false,
        );
        expect(styled.querySelector("style[data-komori-book-images]")?.textContent).toContain(
          "padding-block: 0 1.5em !important",
        );
        expect(styled.querySelector("#wrapper")!.hasAttribute("data-komori-image-spacing")).toBe(
          true,
        );
        // The same logical block-end rule separates the next paragraph in either axis.
        expect(styled.documentElement.style.writingMode).toBe(
          writingMode === "vertical" ? "vertical-rl" : "horizontal-tb",
        );
        await runHooks(book, styled, one);
        expect(styled.querySelectorAll("[data-komori-image-heading]")).toHaveLength(1);
        renderer.dispose();
      },
    );

    it.each(["horizontal", "vertical"] as const)(
      "centers the chapter headings contents entries begin in %s text before layout",
      async (writingMode) => {
        const one = section("Text/one.xhtml", "", true, headingMarkup);
        const { book } = mockBook([one], headingToc);
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16, writingMode },
        );
        const styled = document.implementation.createHTMLDocument();
        styled.body.innerHTML = headingMarkup;
        await runHooks(book, styled, one);
        // The heading an anchor begins and the wrapper holding only it, an image heading,
        // and the heading just after an empty anchor. A passage too long for a title,
        // an anchor within text, an empty block, and headings no entry begins are kept.
        expect(headings(styled)).toEqual(["wrap", "chapter", "toc-2", "after"]);
        // Logical properties center along the inline axis in either writing mode.
        const outrank = ":not(#komori-heading):not(#komori-heading)";
        expect(centerHeadingStyles(styled)).toEqual([
          `:root body [data-komori-heading]${outrank} { text-align: center !important; ` +
            "text-align-last: auto !important; text-indent: 0 !important; " +
            "margin-inline: auto !important; padding-inline: 0 !important; } " +
            `:root body [data-komori-heading] img${outrank}, ` +
            `:root body [data-komori-heading] svg${outrank} { margin-inline: auto !important; } ` +
            ":root body [data-komori-text-heading] { zoom: 1.1; } " +
            // A heading image's measured content shift applies along the inline axis.
            `:root body [data-komori-heading] img[data-komori-ink-centered]${outrank} { ` +
            "transform: translateX(var(--komori-ink-x)) !important; clip-path: inset(0 " +
            "max(0%, var(--komori-ink-x)) 0 max(0%, calc(-1 * var(--komori-ink-x)))) !important; } " +
            `:root[data-komori-vertical] body [data-komori-heading] img[data-komori-ink-centered]${outrank} { ` +
            "transform: translateY(var(--komori-ink-y)) !important; clip-path: inset(" +
            "max(0%, calc(-1 * var(--komori-ink-y))) 0 max(0%, var(--komori-ink-y)) 0) !important; }",
        ]);
        expect(styled.documentElement.style.writingMode).toBe(
          writingMode === "vertical" ? "vertical-rl" : "horizontal-tb",
        );
        expect(styled.documentElement.hasAttribute("data-komori-vertical")).toBe(
          writingMode === "vertical",
        );
        // Only the actual text heading enlarges; wrappers never compound its size.
        expect([...styled.querySelectorAll("[data-komori-text-heading]")].map((e) => e.id)).toEqual(
          ["chapter", "after"],
        );
        expect(styled.body.textContent).toBe(one.document.body.textContent);
        expect(styled.querySelector("#chapter")?.getAttribute("style")).toBeNull();
        const serialized = new XMLSerializer().serializeToString(styled);
        expect(serialized).toContain("data-komori-center-headings");
        expect(serialized).toContain('id="chapter" data-komori-heading=""');
        // A section styled again keeps a single rule.
        await runHooks(book, styled, one);
        expect(centerHeadingStyles(styled)).toHaveLength(1);
        renderer.dispose();
      },
    );

    it("centers a section's first heading when a contents entry opens the section", async () => {
      const opening = section(
        "Text/one.xhtml",
        "",
        true,
        '<section><div class="art"><img src="a.png"/></div><h1 id="first">Chapter 1</h1>' +
          '<p>Text.</p><h2 id="later">Part</h2></section>',
      );
      const late = section(
        "Text/two.xhtml",
        "",
        true,
        '<p>Opening text.</p><h1 id="late">Chapter 2</h1>',
      );
      const unlisted = section("Text/three.xhtml", "", true, '<h1 id="unlisted">Notes</h1>');
      const { book } = mockBook(
        [opening, late, unlisted],
        [
          { label: "One", href: "Text/one.xhtml" },
          { label: "Two", href: "Text/two.xhtml" },
        ],
      );
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      for (const item of [opening, late, unlisted]) await runHooks(book, item.document, item);
      expect(headings(opening.document)).toEqual(["first"]);
      expect(headings(late.document)).toEqual([]);
      expect(headings(unlisted.document)).toEqual([]);
      expect(centerHeadingStyles(late.document)).toEqual([]);
      renderer.dispose();
    });

    it("keeps heading centering out of the book's indentation rules", async () => {
      const one = section("Text/one.xhtml", "", true, headingMarkup);
      const { book } = mockBook([one], headingToc);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, paragraphIndent: 2 },
      );
      await runHooks(book, one.document, one);
      const indentation = one.document.querySelector("style[data-komori-paragraph-indent]");
      expect(indentation?.textContent).not.toContain("komori-heading");
      renderer.dispose();
    });

    it("moves heading image content along the axis of the chosen writing mode", async () => {
      const one = section("Text/one.xhtml", "", true, headingMarkup);
      const { book } = mockBook([one], headingToc);
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, writingMode: "vertical" },
      );
      await runHooks(book, one.document, one);
      const root = one.document.documentElement;
      expect(root.hasAttribute("data-komori-vertical")).toBe(true);
      await renderer.setPresentation?.({ fontSize: 16, writingMode: "horizontal" });
      expect(root.hasAttribute("data-komori-vertical")).toBe(false);
      await renderer.setPresentation?.({ fontSize: 16, writingMode: "vertical" });
      expect(root.hasAttribute("data-komori-vertical")).toBe(true);
      renderer.dispose();
    });

    it("centers a heading image's drawn content in its box, measured once", async () => {
      const markup = '<h2 id="toc-2"><img id="title" src="../Images/title.png"/></h2>';
      const one = section("Text/one.xhtml", "", true, markup);
      const two = section("Text/two.xhtml", "", true, markup);
      const { book } = mockBook(
        [one, two],
        [
          { label: "One", href: "Text/one.xhtml#toc-2" },
          { label: "Two", href: "Text/two.xhtml#toc-2" },
        ],
      );
      const blob = new Blob(["image"]);
      book.archive.request.mockImplementation((async (path: string) =>
        path === "/Images/title.png"
          ? blob
          : path.endsWith(".xhtml")
            ? book.load(path)
            : null) as never);
      vi.mocked(imageInkShift).mockResolvedValue({ x: -0.05, y: 0.25 });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      for (const item of [one, two]) await runHooks(book, item.document, item);
      for (const item of [one, two]) {
        const image = item.document.querySelector("#title") as HTMLElement;
        expect(image.hasAttribute("data-komori-ink-centered")).toBe(true);
        expect(image.style.getPropertyValue("--komori-ink-x")).toBe("-5%");
        expect(image.style.getPropertyValue("--komori-ink-y")).toBe("25%");
        expect(new XMLSerializer().serializeToString(item.document)).toContain(
          "--komori-ink-y: 25%",
        );
      }
      expect(
        book.archive.request.mock.calls.filter(
          (call: unknown[]) => call[0] === "/Images/title.png",
        ),
      ).toHaveLength(1);
      expect(imageInkShift).toHaveBeenCalledExactlyOnceWith(blob);
      vi.mocked(imageInkShift).mockReset();
      renderer.dispose();
    });

    it("leaves a fixed-layout book's headings where the book places them", async () => {
      const one = section("Text/one.xhtml", "", true, headingMarkup);
      const { book } = mockBook([one], headingToc);
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      await runHooks(book, one.document, one);
      expect(headings(one.document)).toEqual([]);
      expect(one.document.querySelector("style[data-komori-book-images]")).toBeNull();
      expect(one.document.querySelector("[data-komori-text-heading]")).toBeNull();
      expect(centerHeadingStyles(one.document)).toEqual([]);
      expect(imageInkShift).not.toHaveBeenCalled();
      renderer.dispose();
    });

    const paragraphLayoutStyle = (target: Document) =>
      target.querySelector("style[data-komori-paragraph-layout]")?.textContent ?? null;

    it.each(["paginated", "continuous", "semi-continuous"] as const)(
      "applies independent paragraph choices before serialization and to cached/displayed/late sections in %s",
      async (viewMode) => {
        for (const writingMode of ["horizontal", "vertical"] as const) {
          const text = "ab ".repeat(50);
          const sections = [section("Text/one.xhtml", text), section("Text/two.xhtml", text)];
          const { book, rendition } = mockBook(sections);
          const contents = reflowingSection(rendition, 0, text, { offset: 30 });
          const renderer = epubRendererFactory(id)();
          const presentation: ReaderPresentation = { fontSize: 16, viewMode, writingMode };
          await renderer.mount(
            document.createElement("div"),
            new AbortController().signal,
            vi.fn(),
            undefined,
            undefined,
            undefined,
            undefined,
            presentation,
          );
          await runHooks(book, sections[0].document, sections[0]);
          expect(paragraphLayoutStyle(sections[0].document)).toBeNull();
          const stale = new DOMParser().parseFromString(
            new XMLSerializer().serializeToString(sections[0].document),
            "application/xhtml+xml",
          );
          await renderer.setPresentation?.({ ...presentation, textJustification: true });
          for (const doc of [contents.document, ...sections.map((item) => item.document)]) {
            expect(paragraphLayoutStyle(doc)).toContain("text-align: justify !important");
            expect(paragraphLayoutStyle(doc)).not.toContain("text-wrap: pretty");
          }
          await renderer.setPresentation?.({
            ...presentation,
            textJustification: true,
            prettyTextWrap: true,
          });
          const rendered = rendition.on.mock.calls
            .filter(([name]) => name === "rendered")
            .map(([, listener]) => listener as (section: unknown, view: unknown) => void);
          const view = { contents: { document: stale, sectionIndex: 0, resizeCheck: vi.fn() } };
          for (const listener of rendered) listener(sections[0], view);
          expect(paragraphLayoutStyle(stale)).toContain("text-wrap: pretty !important");
          expect(view.contents.resizeCheck).toHaveBeenCalledOnce();
          for (const listener of rendered) listener(sections[0], view);
          expect(view.contents.resizeCheck).toHaveBeenCalledOnce();
          // A section loaded after both changes gets the current choices immediately.
          const late = document.implementation.createHTMLDocument();
          late.body.innerHTML = "<p>日本語<ruby>漢<rt>かん</rt></ruby> Latin text.</p>";
          const original = late.body.innerHTML;
          await runHooks(book, late);
          expect(paragraphLayoutStyle(late)).toContain("text-align: justify");
          expect(paragraphLayoutStyle(late)).toContain("text-wrap: pretty");
          expect(late.body.innerHTML).toBe(original);
          await renderer.setPresentation?.({ ...presentation, prettyTextWrap: true });
          expect(paragraphLayoutStyle(contents.document)).not.toContain("text-align:");
          expect(paragraphLayoutStyle(contents.document)).toContain("text-wrap: pretty");
          await renderer.setPresentation?.(presentation);
          expect(paragraphLayoutStyle(contents.document)).toBeNull();
          expect(book.renderTo).toHaveBeenCalledOnce();
          renderer.dispose();
        }
      },
    );

    it("keeps a paginated reading anchor across repeated paragraph choices, publishes and ignores equal choices", async () => {
      const text = "ab ".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const selection = vi.fn();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 16 },
        selection,
      );
      display.mockClear();
      selection.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });
      for (const options of [
        { textJustification: true },
        { textJustification: true, prettyTextWrap: true },
        { prettyTextWrap: true },
        {},
      ]) {
        const presentation = { fontSize: 16, ...options };
        await renderer.setPresentation?.(presentation);
        expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
        const calls = display.mock.calls.length;
        await renderer.setPresentation?.(presentation);
        expect(display).toHaveBeenCalledTimes(calls);
      }
      expect(contents.resizeCheck).toHaveBeenCalledTimes(4);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
      );
      expect(selection).not.toHaveBeenCalled();
      expect(rendition.manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("keeps fixed-layout paragraph composition and headings/image-only lines untouched", async () => {
      const one = section(
        "Text/one.xhtml",
        "",
        true,
        '<p id="title" style="text-align: right !important">Title</p><p><img src="art.png"></p><p>Prose</p>',
      );
      const { book, display } = mockBook(
        [one],
        [{ label: "Chapter", href: "Text/one.xhtml#title" }],
      );
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, textJustification: true, prettyTextWrap: true },
      );
      await runHooks(book, one.document, one);
      expect(one.document.getElementById("title")!.style.textAlign).toBe("right");
      expect(
        one.document.getElementById("title")!.hasAttribute("data-komori-own-paragraph-align"),
      ).toBe(false);
      expect(one.document.querySelector("[data-komori-image-block]")).not.toBeNull();
      renderer.dispose();
      const fixed = mockBook([section("Text/one.xhtml", "", true, "<p>Original page</p>")]);
      Object.assign(fixed.book, {
        package: { ...fixed.book.package, metadata: { layout: "pre-paginated" } },
      });
      const page = epubRendererFactory(id)();
      await page.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, textJustification: true, prettyTextWrap: true },
      );
      const doc = document.implementation.createHTMLDocument();
      await runHooks(fixed.book, doc);
      expect(paragraphLayoutStyle(doc)).toBeNull();
      fixed.display.mockClear();
      await page.setPresentation?.({ fontSize: 16, prettyTextWrap: true });
      expect(fixed.display).not.toHaveBeenCalled();
      expect(display).toHaveBeenCalled();
      page.dispose();
    });

    it.each(["rendition:layout", "iBooks display options"])(
      "keeps a fixed-layout book's typography and spreads when %s declare it",
      async (declaration) => {
        const { book, display } = mockBook();
        Object.assign(
          book,
          declaration === "rendition:layout"
            ? { package: { ...book.package, metadata: { layout: "pre-paginated" } } }
            : { displayOptions: { fixedLayout: "true" } },
        );
        const renderer = epubRendererFactory(id)();
        await renderer.mount(
          document.createElement("div"),
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          {
            fontSize: 40,
            lineHeight: 3,
            fontWeight: 900,
            paragraphIndent: 8,
            pageLayout: "double",
            viewMode: "continuous",
          },
        );
        const options = (book.renderTo.mock.calls as unknown[][])[0][1] as Record<string, unknown>;
        expect(options.manager).toBeUndefined();
        expect(options.spread).toBeUndefined();
        const page = document.implementation.createHTMLDocument();
        page.documentElement.style.fontSize = "12px";
        page.body.innerHTML = '<p style="font-weight: 700">Page</p>';
        await runHooks(book, page);
        expect(page.documentElement.style.fontSize).toBe("12px");
        expect(page.documentElement.style.lineHeight).toBe("");
        expect(page.documentElement.hasAttribute("data-komori-line-height")).toBe(false);
        expect(page.querySelector("style[data-komori-font-weight]")).toBeNull();
        expect(page.querySelector("style[data-komori-paragraph-indent]")).toBeNull();
        expect(page.querySelector("p")!.style.fontWeight).toBe("700");
        display.mockClear();
        await renderer.setPresentation?.({
          fontSize: 20,
          lineHeight: 1.5,
          fontWeight: 300,
          paragraphIndent: 2,
          pageLayout: "single",
        });
        expect(display).not.toHaveBeenCalled();
        renderer.dispose();
      },
    );

    const textSpacingStyle = (target: Document) =>
      target.querySelector("style[data-komori-text-spacing]")?.textContent ?? null;

    it("reflows to the same point at chosen letter and word spacing and back to the book's own", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const { manager } = rendition;
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 16, letterSpacing: 0, wordSpacing: 0 },
      );
      // 0 keeps the book's own spacing.
      expect(textSpacingStyle(contents.document)).toBeNull();
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 20;
      });

      await renderer.setPresentation?.({ fontSize: 16, letterSpacing: 3, wordSpacing: 0 });
      for (const target of [sections[0].document, contents.document]) {
        const rule = textSpacingStyle(target)!;
        expect(rule).toContain("letter-spacing: 3px !important;");
        expect(rule).not.toContain("word-spacing: 0px");
        // Ruby annotations keep normal spacing; the rule is in the first important layer.
        expect(rule).toContain(":root body rt, :root body rp { letter-spacing: normal !important");
        expect(target.head.firstElementChild?.hasAttribute("data-komori-text-spacing")).toBe(true);
      }
      expect(manager.clear).not.toHaveBeenCalled();
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 20 / text.length }),
      );

      await renderer.setPresentation?.({ fontSize: 16, letterSpacing: -2, wordSpacing: 12 });
      expect(textSpacingStyle(contents.document)).toContain(
        "letter-spacing: -2px !important; word-spacing: 12px !important;",
      );
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      // The same spacing is a no-op; out-of-range values are clamped.
      await renderer.setPresentation?.({ fontSize: 16, letterSpacing: -2, wordSpacing: 12 });
      expect(display).toHaveBeenCalledTimes(2);
      await renderer.setPresentation?.({ fontSize: 16, letterSpacing: 900, wordSpacing: 12 });
      expect(textSpacingStyle(contents.document)).toContain("letter-spacing: 60px !important;");

      await renderer.setPresentation?.({ fontSize: 16, letterSpacing: 0, wordSpacing: 0 });
      for (const target of [sections[0].document, contents.document])
        expect(textSpacingStyle(target)).toBeNull();
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("keeps a fixed-layout book's own text spacing", async () => {
      const fixed = mockBook([section("Text/one.xhtml", "", true, "<p>Original page</p>")]);
      Object.assign(fixed.book, {
        package: { ...fixed.book.package, metadata: { layout: "pre-paginated" } },
      });
      const page = epubRendererFactory(id)();
      await page.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, letterSpacing: 4, wordSpacing: 8 },
      );
      const doc = document.implementation.createHTMLDocument();
      await runHooks(fixed.book, doc);
      expect(textSpacingStyle(doc)).toBeNull();
      fixed.display.mockClear();
      await page.setPresentation?.({ fontSize: 16, letterSpacing: 6 });
      expect(fixed.display).not.toHaveBeenCalled();
      page.dispose();
    });

    const paragraphMarginStyle = (target: Document) =>
      target.querySelector("style[data-komori-paragraph-margin]")?.textContent ?? null;

    it("keeps each book's own paragraph margins by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(paragraphMarginStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it("sets a chosen paragraph margin on every section's paragraphs before layout", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, paragraphMargin: 0 },
      );
      const styled = document.implementation.createHTMLDocument();
      for (const [hook] of book.spine.hooks.content.register.mock.calls)
        await (hook as (document: Document) => unknown)(styled);
      // Only paragraphs, along their own block direction in either writing mode.
      expect(paragraphMarginStyle(styled)).toBe(
        ":root body p { margin-block-start: 0px !important; margin-block-end: 0px !important; }",
      );
      const serialized = new XMLSerializer().serializeToString(styled);
      expect(serialized).toContain("data-komori-paragraph-margin");
      renderer.dispose();
    });

    it("reflows to the same point at a chosen paragraph margin and back to the book's own", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { rendition, display } = mockBook(sections);
      const { manager } = rendition;
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        { fontSize: 16 },
      );
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });

      await renderer.setPresentation?.({ fontSize: 16, paragraphMargin: 24 });
      for (const target of [sections[0].document, contents.document])
        expect(paragraphMarginStyle(target)).toContain("margin-block-start: 24px !important");
      // The axis stays, so the section reflows in place rather than rendering again.
      expect(manager.clear).not.toHaveBeenCalled();
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
      );

      // A smaller margin keeps the same point, and the same margin is a no-op.
      await renderer.setPresentation?.({ fontSize: 16, paragraphMargin: 8 });
      expect(paragraphMarginStyle(contents.document)).toContain("margin-block-end: 8px !important");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      await renderer.setPresentation?.({ fontSize: 16, paragraphMargin: 8 });
      expect(display).toHaveBeenCalledTimes(2);

      await renderer.setPresentation?.({ fontSize: 16 });
      for (const target of [sections[0].document, contents.document])
        expect(paragraphMarginStyle(target)).toBeNull();
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(3);
      expect(manager.clear).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("leaves a fixed-layout book's paragraph margins alone", async () => {
      const { book, display } = mockBook();
      Object.assign(book, { package: { ...book.package, metadata: { layout: "pre-paginated" } } });
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, paragraphMargin: 20 },
      );
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(paragraphMarginStyle(styled)).toBeNull();
      display.mockClear();
      await renderer.setPresentation?.({ fontSize: 16, paragraphMargin: 30 });
      expect(display).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("keeps EPUB.js's automatic margins by default", async () => {
      const { book } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(document.createElement("div"), new AbortController().signal, vi.fn());
      expect(pageGap(book)).toBeUndefined();
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(marginStyle(styled)).toBeNull();
      renderer.dispose();
    });

    it("gives every page the chosen margin before layout, up to a quarter of the page", async () => {
      const { book, rendition } = mockBook();
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, sideMargin: 60 },
      );
      // Horizontal columns have half of EPUB.js's gap on each side, so both pages of a
      // spread have the margin on their left and right.
      expect(pageGap(book)).toBe(120);
      // A 533px page of a spread keeps at least half its width for text.
      await renderer.setPresentation?.({ fontSize: 16, sideMargin: 200 });
      expect(pageGap(book)).toBe(266);
      // The gap follows each layout, such as one for a narrower window with single pages.
      rendition.manager._stageSize.width = 700;
      expect(pageGap(book)).toBe(350);
      rendition.manager._stageSize.width = 1920;
      expect(pageGap(book)).toBe(400);

      // Vertical pages' sides are the body's padding, which EPUB.js sets to 20px.
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(marginStyle(styled)).toBe(
        "body { padding-left: min(200px, 25vw) !important; padding-right: min(200px, 25vw) !important; }",
      );
      renderer.dispose();
    });

    it("keeps a vertical section's automatic gap, the space above and below its pages", async () => {
      // Most vertical books say so only in their CSS, which EPUB.js finds as each
      // section loads, after its layout and before formatting the section.
      const { book, rendition } = mockBook();
      const { manager } = rendition;
      const renderer = epubRendererFactory(id)();
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        { fontSize: 16, sideMargin: 60 },
      );
      expect(pageGap(book)).toBe(120);
      manager.updateLayout.mockClear();

      // A vertical section lays the pages out again with the automatic gap first.
      manager.updateAxis("vertical");
      expect(manager.settings.axis).toBe("vertical");
      expect(pageGap(book)).toBeUndefined();
      expect(manager.updateLayout).toHaveBeenCalledOnce();
      expect(manager.layout.delta).toBe(780);
      manager.updateAxis("vertical");
      expect(manager.updateLayout).toHaveBeenCalledOnce();
      const styled = document.implementation.createHTMLDocument();
      await fontSizeHook(book)(styled);
      expect(marginStyle(styled)).toContain("padding-left: min(60px, 25vw) !important;");

      // A horizontal section after it takes the margin's gap again.
      manager.updateAxis("horizontal");
      expect(pageGap(book)).toBe(120);
      expect(manager.updateLayout).toHaveBeenCalledTimes(2);

      // Automatic margins need no second layout when the axis changes.
      await renderer.setPresentation?.({ fontSize: 16 });
      manager.updateLayout.mockClear();
      manager.updateAxis("vertical");
      expect(manager.updateLayout).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it("reflows to the same point when the margin changes and when it returns to automatic", async () => {
      const text = "ab ".repeat(50);
      const sections = [section("Text/one.xhtml", text)];
      const { book, rendition, display } = mockBook(sections);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      const chosen = { fontSize: 20, lineHeight: 1.5, fontWeight: 600, paragraphIndent: 2 };
      await renderer.mount(
        document.createElement("div"),
        new AbortController().signal,
        vi.fn(),
        undefined,
        undefined,
        binding,
        undefined,
        chosen,
      );
      display.mockClear();
      display.mockImplementationOnce(async () => {
        pageStart.offset = 24;
      });

      await renderer.setPresentation?.({ ...chosen, sideMargin: 80 });
      expect(pageGap(book)).toBe(160);
      // EPUB.js lays the displayed pages out again with the new gap before the reflow.
      expect(rendition.manager.updateLayout).toHaveBeenCalledOnce();
      for (const target of [contents.document, sections[0].document])
        expect(marginStyle(target)).toContain("min(80px, 25vw)");
      expect(contents.resizeCheck).toHaveBeenCalledOnce();
      expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
      expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
      );

      // The margin and the Typography choices keep the same point together.
      await renderer.setPresentation?.({ ...chosen, fontSize: 22, sideMargin: 80 });
      expect(rendition.manager.updateLayout).toHaveBeenCalledOnce();
      await renderer.setPresentation?.({ ...chosen, fontSize: 22, sideMargin: 0 });
      expect(pageGap(book)).toBe(0);
      expect(marginStyle(contents.document)).toContain("min(0px, 25vw)");
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);

      await renderer.setPresentation?.({ ...chosen, fontSize: 22 });
      expect(pageGap(book)).toBeUndefined();
      expect(marginStyle(contents.document)).toBeNull();
      expect(marginStyle(sections[0].document)).toBeNull();
      expect(rendition.manager.updateLayout).toHaveBeenCalledTimes(3);
      expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);
      expect(display).toHaveBeenCalledTimes(4);
      renderer.dispose();
    });

    it("caps the host's height before layout and reflows to the same point when it changes", async () => {
      const observers: Array<() => void> = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            observers.push(callback);
          }
          observe() {}
          disconnect() {}
        },
      );
      const text = "ab ".repeat(50);
      const { book, rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const pageStart = { offset: 30 };
      reflowingSection(rendition, 0, text, pageStart);
      // The Reader's stylesheet caps the host at the chosen height.
      const host = document.createElement("div");
      const cap = () => parseFloat(host.style.getPropertyValue("--reader-max-height")) || 780;
      Object.defineProperty(host, "clientWidth", { get: () => 1066 });
      Object.defineProperty(host, "clientHeight", { get: () => Math.min(780, cap()) });
      let heightAtRender: string | undefined;
      book.renderTo.mockImplementationOnce(() => {
        heightAtRender = host.style.getPropertyValue("--reader-max-height");
        return rendition;
      });
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
          undefined,
          { fontSize: 16, maxHeight: 600 },
        );
        // EPUB.js measures the capped host as its view manager attaches.
        expect(heightAtRender).toBe("600px");
        // A layout sizes new views to the host; a displayed view keeps its height until sized.
        const view = { size: vi.fn() };
        const manager = Object.assign(rendition.manager, {
          views: { all: () => [view], displayed: () => [view], remove: vi.fn() },
          viewSettings: { width: 1066, height: 600 },
        });
        manager.updateLayout.mockImplementation(() => {
          manager.viewSettings = { width: host.clientWidth, height: host.clientHeight };
        });
        display.mockClear();
        rendition.manager.updateLayout.mockClear();
        display.mockImplementationOnce(async () => {
          pageStart.offset = 24;
        });

        await renderer.setPresentation?.({ fontSize: 16, maxHeight: 400 });
        expect(host.style.getPropertyValue("--reader-max-height")).toBe("400px");
        // EPUB.js lays the pages out again at the new height, then shows the kept point.
        expect(rendition.manager.updateLayout).toHaveBeenCalledOnce();
        expect(view.size).toHaveBeenLastCalledWith(1066, 400);
        expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
        expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
          expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
        );
        // The margin keeps its own job.
        expect(pageGap(book)).toBeUndefined();

        // The host's observer finds the book already laid out at the new height.
        observers[0]();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(rendition.manager.updateLayout).toHaveBeenCalledOnce();
        expect(display).toHaveBeenCalledOnce();

        // Consecutive changes keep the same point, and Auto removes the cap.
        await renderer.setPresentation?.({ fontSize: 16, maxHeight: 400, sideMargin: 40 });
        await renderer.setPresentation?.({ fontSize: 16, sideMargin: 40 });
        expect(host.style.getPropertyValue("--reader-max-height")).toBe("");
        expect(view.size).toHaveBeenLastCalledWith(1066, 780);
        expect(pageGap(book)).toBe(80);
        expect(rendition.manager.updateLayout).toHaveBeenCalledTimes(3);
        expect(display.mock.calls.at(-1)).toEqual(["epubcfi(offset-30)"]);

        await renderer.setPresentation?.({ fontSize: 16, sideMargin: 40, maxHeight: 500 });
        renderer.dispose();
        expect(host.style.getPropertyValue("--reader-max-height")).toBe("");
      } finally {
        renderer.dispose();
        vi.unstubAllGlobals();
      }
    });

    it("follows a host the Reader's layout resizes to the same reading point", async () => {
      const observers: Array<() => void> = [];
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            observers.push(callback);
          }
          observe() {}
          disconnect = disconnect;
        },
      );
      const text = "ab ".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const pageStart = { offset: 30 };
      reflowingSection(rendition, 0, text, pageStart);
      const host = document.createElement("div");
      const size = { width: 1066, height: 780 };
      Object.defineProperty(host, "clientWidth", { get: () => size.width });
      Object.defineProperty(host, "clientHeight", { get: () => size.height });
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
        );
        expect(observers).toHaveLength(1);
        display.mockClear();
        rendition.manager.updateLayout.mockClear();
        const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

        // The host's size is unchanged.
        observers[0]();
        await settle();
        expect(rendition.manager.updateLayout).not.toHaveBeenCalled();
        expect(display).not.toHaveBeenCalled();

        // A window resize: EPUB.js lays the pages out and shows the start of the
        // paragraph it last reported, pages before the reading point. The kept point
        // follows once EPUB.js has relocated.
        size.height = 700;
        rendition.emit("resized");
        pageStart.offset = 3;
        observers[0]();
        await settle();
        expect(display).not.toHaveBeenCalled();
        display.mockImplementationOnce(async () => {
          pageStart.offset = 27;
        });
        rendition.emit("relocated");
        await vi.waitFor(() =>
          expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ spineIndex: 0, progress: 27 / text.length }),
          ),
        );
        expect(rendition.manager.updateLayout).toHaveBeenCalledOnce();
        expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);

        // Pinning the sidebar narrows the host. Reading the location afterwards would
        // already give the narrower layout's page, so the same point is kept, as it is
        // across consecutive resizes until a turn.
        pageStart.offset = 45;
        size.width = 640;
        display.mockImplementationOnce(async () => {
          pageStart.offset = 24;
        });
        observers[0]();
        observers[0]();
        await vi.waitFor(() =>
          expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ spineIndex: 0, progress: 24 / text.length }),
          ),
        );
        expect(rendition.manager.updateLayout).toHaveBeenCalledTimes(2);
        expect(display.mock.calls).toEqual([["epubcfi(offset-30)"], ["epubcfi(offset-30)"]]);
        renderer.dispose();
        expect(disconnect).toHaveBeenCalled();
      } finally {
        renderer.dispose();
        vi.unstubAllGlobals();
      }
    });

    it("follows a window resize whose EPUB.js display reports no location", async () => {
      const observers: Array<() => void> = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            observers.push(callback);
          }
          observe() {}
          disconnect() {}
        },
      );
      const text = "ab ".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      // EPUB.js's queue runs its displays and location reports one after another.
      let tail: Promise<unknown> = Promise.resolve();
      const enqueue = (task: () => unknown) => {
        const run = tail.then(task);
        tail = run.catch(() => undefined);
        return run;
      };
      Object.assign(rendition, { q: { enqueue } });
      const pageStart = { offset: 30 };
      reflowingSection(rendition, 0, text, pageStart);
      const host = document.createElement("div");
      const size = { width: 1066, height: 780 };
      Object.defineProperty(host, "clientWidth", { get: () => size.width });
      Object.defineProperty(host, "clientHeight", { get: () => size.height });
      const turns = vi.fn();
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          host,
          new AbortController().signal,
          turns,
          undefined,
          undefined,
          binding,
        );
        display.mockClear();

        // A window drag: EPUB.js shows the paragraph start it last reported, and its
        // report after that display finds no location while the views resize, so it
        // never relocates.
        size.width = 900;
        let shown!: () => void;
        rendition.emit("resized");
        void enqueue(
          () =>
            new Promise<void>((resolve) => {
              shown = () => {
                pageStart.offset = 3;
                void enqueue(() => undefined);
                resolve();
              };
            }),
        );
        observers[0]();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(display).not.toHaveBeenCalled();
        expect(turns).toHaveBeenLastCalledWith({ canAdvance: false, canRetreat: false });

        // Once EPUB.js's display and report are done, the kept point follows.
        display.mockImplementationOnce(async () => {
          pageStart.offset = 27;
        });
        shown();
        await vi.waitFor(() =>
          expect(binding.onLocationChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ spineIndex: 0, progress: 27 / text.length }),
          ),
        );
        expect(display.mock.calls).toEqual([["epubcfi(offset-30)"]]);
        await vi.waitFor(() =>
          expect(turns).toHaveBeenLastCalledWith(expect.objectContaining({ canAdvance: true })),
        );
      } finally {
        renderer.dispose();
        vi.unstubAllGlobals();
      }
    });

    it("applies an appearance chosen during a host reflow once the reflow ends, at the same point", async () => {
      const observers: Array<() => void> = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            observers.push(callback);
          }
          observe() {}
          disconnect() {}
        },
      );
      const text = "ab ".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const pageStart = { offset: 30 };
      const contents = reflowingSection(rendition, 0, text, pageStart);
      const host = document.createElement("div");
      const size = { width: 1066, height: 780 };
      Object.defineProperty(host, "clientWidth", { get: () => size.width });
      Object.defineProperty(host, "clientHeight", { get: () => size.height });
      const binding = positionBinding();
      const renderer = epubRendererFactory(id)();
      try {
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          binding,
        );
        display.mockClear();
        // Pinning the sidebar narrows the host, and its reflow is still showing the kept
        // point when a setting changes.
        let release!: () => void;
        display.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve) => {
              release = () => {
                pageStart.offset = 24;
                resolve(undefined);
              };
            }),
        );
        size.width = 640;
        observers[0]();
        await vi.waitFor(() => expect(display).toHaveBeenCalledOnce());

        const root = contents.document.documentElement;
        await renderer.setPresentation?.({ fontSize: 16, lineHeight: 2 });
        expect(root.style.lineHeight).toBe("");

        release();
        await vi.waitFor(() => expect(root.style.lineHeight).toBe("2"));
        await vi.waitFor(() => expect(display).toHaveBeenCalledTimes(2));
        expect(display.mock.calls).toEqual([["epubcfi(offset-30)"], ["epubcfi(offset-30)"]]);
        renderer.dispose();
      } finally {
        renderer.dispose();
        vi.unstubAllGlobals();
      }
    });

    it("pages a vertical book back to its first character after a window resize", async () => {
      const observers: Array<() => void> = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            observers.push(callback);
          }
          observe() {}
          disconnect() {}
        },
      );
      const text = "本文".repeat(50);
      const { rendition, display } = mockBook([section("Text/one.xhtml", text)]);
      const contents = reflowingSection(rendition, 0, text, { offset: 40 });
      Object.defineProperty(contents.document, "defaultView", {
        value: { getComputedStyle: () => ({ writingMode: "vertical-rl" }) },
      });
      const host = document.createElement("div");
      const size = { width: 1066, height: 780 };
      Object.defineProperty(host, "clientWidth", { get: () => size.width });
      Object.defineProperty(host, "clientHeight", { get: () => size.height });
      const renderer = epubRendererFactory(id)();
      const rangePrototype = Range.prototype as Partial<Pick<Range, "getBoundingClientRect">>;
      try {
        expect(
          await renderer.mount(host, new AbortController().signal, vi.fn(), undefined, undefined),
        ).toBe("ready");
        display.mockClear();
        // A narrower window: EPUB.js shows its own, earlier page. jsdom has no layout:
        // the kept character is now on the third page.
        size.width = 640;
        rendition.emit("resized");
        rendition.emit("relocated");
        rangePrototype.getBoundingClientRect = () => ({ top: 1700, height: 20 }) as DOMRect;
        observers[0]();
        await vi.waitFor(() => expect(rendition.manager.scrollBy).toHaveBeenCalled());
        expect(display.mock.calls).toEqual([["Text/one.xhtml"]]);
        expect(contents.cfiFromRange).not.toHaveBeenCalled();
        expect(rendition.manager.scrollBy.mock.calls).toEqual([[0, 2 * 780, true]]);
      } finally {
        delete rangePrototype.getBoundingClientRect;
        renderer.dispose();
        vi.unstubAllGlobals();
      }
    });
  });

  describe("text selection", () => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const domRect = ({ left, top, right, bottom }: Box) =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect;

    /** A displayed section in a real iframe at (40, 30) inside a 500x400 reading area. */
    async function mountSelectable(html: string) {
      const { rendition } = mockBook();
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const contentDocument = iframe.contentDocument!;
      contentDocument.body.innerHTML = html;
      iframe.getBoundingClientRect = () => domRect({ left: 40, top: 30, right: 1540, bottom: 430 });
      rendition.getContents.mockReturnValue([
        { document: contentDocument, sectionIndex: 0, cfiFromRange: vi.fn() },
      ] as never);
      const host = document.createElement("div");
      host.getBoundingClientRect = () => domRect({ left: 0, top: 0, right: 500, bottom: 400 });
      const selected = vi.fn();
      const renderer = epubRendererFactory(id)();
      renderer.setLookupTriggers?.({ ...defaultLookupTriggers, readerPopupMouseSelection: true });
      expect(
        await renderer.mount(
          host,
          new AbortController().signal,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          { fontSize: 16 },
          selected,
        ),
      ).toBe("ready");
      /** Select from one point to another, the range's boxes given in the section's pixels. */
      const select = (
        start: [Node, number],
        end: [Node, number],
        boxes: Box[] = [{ left: 10, top: 5, right: 70, bottom: 29 }],
      ) => {
        const range = contentDocument.createRange();
        range.setStart(...start);
        range.setEnd(...end);
        range.getClientRects = () => boxes.map(domRect) as unknown as DOMRectList;
        const selection = contentDocument.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const release = async () => {
        contentDocument.dispatchEvent(new Event("pointerup"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      return { contentDocument, iframe, renderer, rendition, selected, select, release };
    }

    /** Simulate the browser's caret hit-testing and character geometry, not a selection. */
    function pointAt(
      view: Awaited<ReturnType<typeof mountSelectable>>,
      node: Node,
      offset: number,
    ) {
      const doc = view.contentDocument;
      const createRange = doc.createRange.bind(doc);
      vi.spyOn(doc, "createRange").mockImplementation(() => {
        const range = createRange();
        range.getClientRects = () =>
          [domRect({ left: 10, top: 5, right: 30, bottom: 29 })] as unknown as DOMRectList;
        return range;
      });
      const caret = createRange();
      caret.setStart(node, offset);
      caret.collapse(true);
      Object.defineProperty(doc, "caretRangeFromPoint", { configurable: true, value: () => caret });
      const move = (shiftKey = true, x = 20, y = 15) =>
        doc.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, shiftKey }));
      return { move, caret };
    }

    it("scans from the pointer through inline text without ruby, preserving the selection", async () => {
      const view = await mountSelectable(
        "<p>本を<ruby>読<rt>よ</rt><rp>(よ)</rp></ruby><span>むのが好き</span></p><p>次の段落</p>",
      );
      try {
        const paragraph = view.contentDocument.querySelector("p")!;
        view.select([paragraph.firstChild!, 0], [paragraph.firstChild!, 1]);
        const original = view.contentDocument.getSelection()!.getRangeAt(0);
        const hit = pointAt(view, paragraph.querySelector("ruby")!.firstChild!, 0);
        hit.move(false);
        expect(view.selected).not.toHaveBeenCalled();
        // Shift pressed in the focused app also scans the stationary pointer in the iframe.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
        expect(view.selected).toHaveBeenLastCalledWith({
          origin: "shift",
          scanId: expect.any(Number),
          text: "読むのが好き",
          sentence: "本を読むのが好き",
          rect: { left: 50, top: 35, right: 70, bottom: 59 },
          writingMode: "horizontal",
        });
        expect(view.contentDocument.getSelection()!.getRangeAt(0)).toBe(original);
        hit.move();
        expect(view.selected).toHaveBeenCalledTimes(1);
        hit.caret.setStart(paragraph.querySelector("span")!.firstChild!, 1);
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "のが好き" }),
        );
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
        expect(view.selected).toHaveBeenCalledTimes(2);
        view.renderer.dispose();
        hit.move();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
        expect(view.selected).toHaveBeenCalledTimes(2);
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it("paints only the matched Unicode start across ruby and inline text as selected text, replaces and clears without changing selection or markup", async () => {
      const view = await mountSelectable(
        '<p style="writing-mode: vertical-rl">本<ruby>𠮷<rt>よし</rt><rp>(よし)</rp></ruby><span>読む</span></p>',
      );
      const layer = () =>
        view.contentDocument.documentElement.querySelector(":scope > [data-komori-lookup-marks]");
      // While a match paints, each piece of text it measures lies on a row of its own, so
      // every mark names its text.
      const measured: string[] = [];
      let painting = false;
      const paint = () =>
        [...(layer()?.children ?? [])].map(
          (mark) => measured[Math.round(parseFloat((mark as HTMLElement).style.top) / 100)],
        );
      const match = (scanId: number | null, length?: number) => {
        painting = true;
        try {
          view.renderer.highlightPointerMatch!(scanId, length);
        } finally {
          painting = false;
        }
      };
      try {
        const paragraph = view.contentDocument.querySelector("p")!;
        const html = paragraph.outerHTML;
        view.select([paragraph.firstChild!, 0], [paragraph.firstChild!, 1]);
        const original = view.contentDocument.getSelection()!.getRangeAt(0);
        const hit = pointAt(view, paragraph.querySelector("ruby")!.firstChild!, 0);
        const scanRange = vi.mocked(view.contentDocument.createRange).getMockImplementation()!;
        vi.mocked(view.contentDocument.createRange).mockImplementation(() => {
          const range = scanRange();
          const rects = range.getClientRects;
          range.getClientRects = () => {
            if (!painting) return rects();
            measured.push(range.toString());
            return [new DOMRect(10, (measured.length - 1) * 100, 20, 20)] as unknown as DOMRectList;
          };
          return range;
        });
        hit.move();
        const firstId = view.selected.mock.lastCall![0].scanId;
        match(firstId, 2);
        // The selection's marks, outside the book's markup, without its ruby annotations.
        expect(paint()).toEqual(["𠮷", "読"]);
        expect(layer()!.getAttribute("aria-hidden")).toBe("true");
        expect(view.contentDocument.getSelection()!.getRangeAt(0)).toBe(original);
        expect(paragraph.outerHTML).toBe(html);
        hit.caret.setStart(paragraph.querySelector("span")!.firstChild!, 1);
        hit.move();
        expect(paint()).toEqual([]);
        const secondId = view.selected.mock.lastCall![0].scanId;
        match(secondId, 1);
        expect(paint()).toEqual(["む"]);
        match(firstId, 0);
        match(firstId, 2);
        expect(paint()).toEqual(["む"]);
        match(secondId, 0);
        expect(paint()).toEqual([]);
        match(secondId, 1);
        view.rendition.emit("resized");
        expect(paint()).toEqual([]);
        match(secondId, 1);
        expect(paint()).toEqual([]);
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
        hit.move();
        match(view.selected.mock.lastCall![0].scanId, 1);
        expect(paint().length).toBe(1);
        match(null);
        expect(paint()).toEqual([]);
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
        hit.move();
        match(view.selected.mock.lastCall![0].scanId, 1);
        view.renderer.dispose();
        expect(paint()).toEqual([]);
        expect(view.contentDocument.getSelection()!.getRangeAt(0)).toBe(original);
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it("starts at the touched character when the nearest caret is after it, including supplementary characters", async () => {
      const view = await mountSelectable('<p style="writing-mode: vertical-rl">本𠮷読む</p>');
      try {
        const node = view.contentDocument.querySelector("p")!.firstChild!;
        const hit = pointAt(view, node, 3);
        vi.mocked(view.contentDocument.createRange).mockImplementation(() => {
          const range = view.contentDocument.implementation.createHTMLDocument().createRange();
          range.getClientRects = () =>
            [
              domRect({
                left: range.startOffset === 1 ? 10 : 40,
                top: 5,
                right: range.startOffset === 1 ? 30 : 60,
                bottom: 29,
              }),
            ] as unknown as DOMRectList;
          return range;
        });
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "𠮷読む", writingMode: "vertical-rl" }),
        );
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it("bounds scans by the scan length (16 by default) and the containing block or line break", async () => {
      const long = `𠮷${"読".repeat(300)}`;
      const view = await mountSelectable(
        `<div><p>${long}</p><p>別段落</p></div><p>本<span>を読む</span><br>次の行</p><div>最初<p>入れ子</p>終わり</div>`,
      );
      try {
        const paragraphs = view.contentDocument.querySelectorAll("p");
        const hit = pointAt(view, paragraphs[0].firstChild!, 0);
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: `𠮷${"読".repeat(15)}` }),
        );
        hit.caret.setStart(paragraphs[0].firstChild!, 300);
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(expect.objectContaining({ text: "読読" }));
        hit.caret.setStart(paragraphs[2].firstChild!, 0);
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "本を読む" }),
        );
        hit.caret.setStart(view.contentDocument.body.lastChild!.firstChild!, 0);
        hit.move();
        expect(view.selected).toHaveBeenLastCalledWith(expect.objectContaining({ text: "最初" }));
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it("does not scan whitespace, ruby annotations, elements, or a nearest caret off text", async () => {
      const view = await mountSelectable("<p> 本<ruby>読<rt>よ</rt></ruby></p>");
      try {
        const p = view.contentDocument.querySelector("p")!;
        const hit = pointAt(view, p.firstChild!, 1);
        hit.move(true, 200, 200);
        hit.caret.setStart(p.firstChild!, 0);
        hit.move();
        hit.caret.setStart(p.querySelector("rt")!.firstChild!, 0);
        hit.move();
        hit.caret.setStart(p, 0);
        hit.move();
        expect(view.selected).not.toHaveBeenCalled();
        // The browser's root pointerleave does not bubble to the document.
        view.contentDocument.documentElement.dispatchEvent(new Event("pointerleave"));
        hit.caret.setStart(p.firstChild!, 1);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
        expect(view.selected).not.toHaveBeenCalled();
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it.each(["textJustification", "prettyTextWrap"] as const)(
      "dismisses active lookup on a %s reflow and permits a fresh selection",
      async (choice) => {
        const view = await mountSelectable("<p>読む</p>");
        try {
          const text = view.contentDocument.querySelector("p")!.firstChild!;
          view.select([text, 0], [text, 2]);
          await view.release();
          expect(view.selected).toHaveBeenCalledWith(expect.objectContaining({ text: "読む" }));
          await view.renderer.setPresentation?.({ fontSize: 16, [choice]: true });
          expect(view.selected).toHaveBeenLastCalledWith(null);
          const calls = view.selected.mock.calls.length;
          view.contentDocument.dispatchEvent(new Event("keyup"));
          expect(view.selected).toHaveBeenCalledTimes(calls);
          await view.release();
          expect(view.selected).toHaveBeenLastCalledWith(expect.objectContaining({ text: "読む" }));
        } finally {
          view.renderer.dispose();
          view.iframe.remove();
        }
      },
    );

    it("invalidates a selection once when resizing makes its rectangle stale", async () => {
      const view = await mountSelectable("<p>読む</p>");
      try {
        const text = view.contentDocument.querySelector("p")!.firstChild!;
        view.select([text, 0], [text, 2]);
        await view.release();
        expect(view.selected).toHaveBeenCalledTimes(1);
        view.rendition.emit("resized");
        view.rendition.emit("resized");
        expect(view.selected).toHaveBeenCalledTimes(2);
        expect(view.selected).toHaveBeenLastCalledWith(null);
        // Releasing a key in the old range cannot reopen the popup at a stale rectangle.
        view.contentDocument.dispatchEvent(new Event("keyup"));
        expect(view.selected).toHaveBeenCalledTimes(2);
        // A deliberate new pointer selection can open it again.
        await view.release();
        expect(view.selected).toHaveBeenCalledTimes(3);
        expect(view.selected).toHaveBeenLastCalledWith(expect.objectContaining({ text: "読む" }));
      } finally {
        view.renderer.dispose();
        view.iframe.remove();
      }
    });

    it("reports the selected text without ruby annotations and where it shows in the reading area", async () => {
      const view = await mountSelectable(
        "<p>本を<ruby>読<rp>(</rp><rt>よ</rt><rp>)</rp></ruby>むのが好き</p>",
      );
      const paragraph = view.contentDocument.querySelector("p")!;
      // One box on the displayed page, one on a page beyond the reading area's right edge.
      view.select(
        [paragraph.firstChild!, 0],
        [paragraph.lastChild!, 1],
        [
          { left: 10, top: 5, right: 70, bottom: 29 },
          { left: 600, top: 5, right: 640, bottom: 29 },
        ],
      );
      await view.release();
      expect(view.selected).toHaveBeenCalledTimes(1);
      expect(view.selected).toHaveBeenLastCalledWith({
        origin: "pointer",
        text: "本を読む",
        sentence: "本を読むのが好き",
        rect: { left: 50, top: 35, right: 110, bottom: 59 },
        writingMode: "horizontal",
      });

      // A key reports only a changed selection, so releasing a page-turn key reports nothing.
      view.contentDocument.dispatchEvent(new Event("keyup"));
      expect(view.selected).toHaveBeenCalledTimes(1);
      view.select([paragraph.lastChild!, 1], [paragraph.lastChild!, 5]);
      view.contentDocument.dispatchEvent(new Event("keyup"));
      expect(view.selected).toHaveBeenLastCalledWith(
        expect.objectContaining({ origin: "keyboard", text: "のが好き" }),
      );
      // A pointer reports the same selection again, as when a word is selected again.
      await view.release();
      expect(view.selected).toHaveBeenCalledTimes(3);

      view.contentDocument.getSelection()!.removeAllRanges();
      view.contentDocument.dispatchEvent(new Event("selectionchange"));
      expect(view.selected).toHaveBeenLastCalledWith(null);
      view.contentDocument.dispatchEvent(new Event("selectionchange"));
      expect(view.selected).toHaveBeenCalledTimes(4);

      view.renderer.dispose();
      view.select([paragraph.firstChild!, 0], [paragraph.firstChild!, 1]);
      await view.release();
      expect(view.selected).toHaveBeenCalledTimes(4);
      view.iframe.remove();
    });

    it("reports a selection's boxes across elements, off the page, and in vertical text", async () => {
      const view = await mountSelectable(
        '<p style="writing-mode: vertical-rl">一行目</p>\n<p>二行目</p>',
      );
      const [first, second] = view.contentDocument.querySelectorAll("p");
      view.select(
        [first.firstChild!, 1],
        [second.firstChild!, 2],
        [
          { left: 400, top: 10, right: 424, bottom: 70 },
          { left: 360, top: 0, right: 384, bottom: 48 },
        ],
      );
      await view.release();
      expect(view.selected).toHaveBeenLastCalledWith({
        origin: "pointer",
        text: "行目\n二行",
        sentence: "一行目",
        rect: { left: 400, top: 30, right: 464, bottom: 100 },
        writingMode: "vertical-rl",
      });

      // Wholly on a page turned away, its boxes are kept as they are.
      view.select(
        [second.firstChild!, 0],
        [second.firstChild!, 1],
        [{ left: 900, top: 10, right: 924, bottom: 34 }],
      );
      await view.release();
      expect(view.selected).toHaveBeenLastCalledWith({
        origin: "pointer",
        text: "二",
        sentence: "二行目",
        rect: { left: 940, top: 40, right: 964, bottom: 64 },
        writingMode: "horizontal",
      });

      // Only ruby annotations or whitespace are no selected text.
      view.select([view.contentDocument.body, 1], [view.contentDocument.body, 2]);
      await view.release();
      expect(view.selected).toHaveBeenLastCalledWith(null);
      view.renderer.dispose();
      view.iframe.remove();
    });
  });
});
