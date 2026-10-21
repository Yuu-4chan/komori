import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import type { AppearancePreferences } from "../appearance/appearancePreferences";
import {
  listDictionaries,
  lookupKanji,
  lookupTerms,
  type DictionarySummary,
  type TermGroup,
  type TermLookup,
} from "../dictionary/dictionaryApi";
import type { ReaderRendererFactory, ReaderSelection } from "./renderer";
import { ReaderShell } from "./ReaderShell";
import { readerFooterChoices } from "./footerPreferences";
import { watchTextSelection } from "./textSelection";
import { defaultLookupTriggers } from "./lookupTriggers";
import { dictionariesChanged } from "../dictionary/sourcePolicy";
import { getWordAudio } from "../dictionary/wordAudio";
import readerCss from "../../styles/reader.css?raw";
import {
  loadAnki,
  cachedAnki,
  discoverAnki,
  createNote,
  noteStatus,
  browseNote,
} from "../anki/ankiApi";

vi.mock("../anki/ankiApi", async (original) => ({
  ...(await original<typeof import("../anki/ankiApi")>()),
  loadAnki: vi.fn(),
  cachedAnki: vi.fn(),
  discoverAnki: vi.fn(),
  createNote: vi.fn(),
  browseNote: vi.fn(async () => {}),
  noteStatus: vi.fn(async () => ({ status: "missing" })),
}));

// The desktop app's window controls, for tests that run as the desktop app.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

vi.mock("../dictionary/wordAudio", async (original) => ({
  ...(await original<typeof import("../dictionary/wordAudio")>()),
  getWordAudio: vi.fn(),
}));

vi.mock("../dictionary/dictionaryApi", () => ({
  lookupTerms: vi.fn(),
  lookupKanji: vi.fn(),
  listDictionaries: vi.fn(),
}));

/** Plays nothing; records each recording Voice plays. */
class MockAudio {
  static played: MockAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  constructor(public src: string) {}
  play() {
    MockAudio.played.push(this);
    return Promise.resolve();
  }
}

/** The desktop app's recordings: every word has one. */
function stubWordAudio() {
  MockAudio.played = [];
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("Audio", MockAudio);
  URL.createObjectURL = vi.fn(() => "blob:word");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(getWordAudio).mockResolvedValue(new Blob(["ID3"], { type: "audio/mpeg" }));
}

function summary(id: number, title: string, hasDefinitions: boolean): DictionarySummary {
  return {
    id,
    title,
    revision: "1",
    enabled: true,
    termCount: hasDefinitions ? 1 : 0,
    termMetaCount: hasDefinitions ? 0 : 1,
    kanjiCount: 0,
    kanjiMetaCount: 0,
    hasDefinitions,
    hasFrequency: !hasDefinitions,
    hasPitch: false,
  };
}
const listMock = vi.mocked(listDictionaries);
listMock.mockResolvedValue([summary(1, "Jitendex", true)]);

const lookupMock = vi.mocked(lookupTerms);
const kanjiMock = vi.mocked(lookupKanji);

function group(expression: string, reading: string, text: string, gloss: string): TermGroup {
  return {
    expression,
    reading,
    text,
    deinflection: null,
    terms: [
      {
        dictionaryId: 1,
        dictionaryTitle: "Jitendex",
        definitionTags: "n",
        rules: "",
        score: 0,
        sequence: 1,
        termTags: "",
        tags: [],
        glossary: [gloss],
      },
    ],
    frequencies: [],
    pitches: [],
  };
}

const dokusho: TermLookup = {
  text: "読書",
  groups: [
    group("読書", "どくしょ", "読書", "reading books"),
    group("読", "とく", "読", "reading"),
  ],
};

function DictionaryLocation() {
  const location = useLocation();
  return <h1>{`Dictionary ${decodeURIComponent(location.search)}`}</h1>;
}

function PopupControl() {
  const triggers = useAppearance();
  const { readerPopupShowFrequency, setReaderPopupShowFrequency } = useAppearance();
  const { readerPopupShowPitch, setReaderPopupShowPitch } = useAppearance();
  const { readerPopupShowDictionaryNames, setReaderPopupShowDictionaryNames } = useAppearance();
  const { readerPopupEnabled, setReaderPopupEnabled } = useAppearance();
  const { readerPopupMouseSelection, setReaderPopupMouseSelection } = useAppearance();
  const { readerPopupVoiceAction, setReaderPopupVoiceAction } = useAppearance();
  return (
    <>
      {readerFooterChoices.map(({ key }) => (
        <button key={key} onClick={() => triggers.setReaderFooter({ [key]: !triggers[key] })}>
          Toggle {key}
        </button>
      ))}
      <button onClick={() => triggers.setReaderPopupSources("definitions", { mode: "none" })}>
        No definition sources
      </button>
      <button onClick={() => triggers.setReaderPopupSources("frequency", { mode: "none" })}>
        No frequency sources
      </button>
      {(
        [
          "readerPopupShiftLookup",
          "readerPopupKeyboardShortcut",
          "readerPopupClickLookup",
          "readerPopupHoverLookup",
          "readerPopupCjkOnly",
        ] as const
      ).map((field) => (
        <button
          key={field}
          onClick={() => triggers.setReaderPopupTriggers({ [field]: !triggers[field] })}
        >
          {field}
        </button>
      ))}
      {(["escape-outside", "outside", "persistent"] as const).map((behavior) => (
        <button
          key={behavior}
          onClick={() => triggers.setReaderPopupTriggers({ readerPopupCloseBehavior: behavior })}
        >
          {behavior}
        </button>
      ))}
      <button onClick={() => setReaderPopupShowFrequency(!readerPopupShowFrequency)}>
        Toggle frequency
      </button>
      <button onClick={() => setReaderPopupShowPitch(!readerPopupShowPitch)}>Toggle pitch</button>
      <button onClick={() => setReaderPopupShowDictionaryNames(!readerPopupShowDictionaryNames)}>
        Toggle names
      </button>
      <button onClick={() => setReaderPopupEnabled(!readerPopupEnabled)}>Toggle popup</button>
      <button onClick={() => setReaderPopupMouseSelection(!readerPopupMouseSelection)}>
        Toggle mouse selection
      </button>
      <button onClick={() => setReaderPopupVoiceAction(!readerPopupVoiceAction)}>
        Toggle voice
      </button>
    </>
  );
}

/** The Reader with a renderer that publishes selections as the adapter would. */
async function openReader(
  canAdvance = true,
  area = { left: 0, top: 0, right: 1000, bottom: 800 },
  popupSize?: Partial<AppearancePreferences>,
) {
  const pageActions = {
    setLookupTriggers: vi.fn(),
    setPresentation: vi.fn(async () => undefined),
    highlightPointerMatch: vi.fn(),
    advancePage: vi.fn(async () => undefined),
    retreatPage: vi.fn(async () => undefined),
  };
  let select!: (selection: ReaderSelection | null) => void;
  let publishDocument!: (document: Document) => void;
  const mounted = vi.fn();
  const factory: ReaderRendererFactory = () => ({
    ...pageActions,
    mount: async (
      _host,
      _signal,
      changed,
      onContentDocument,
      _contents,
      _position,
      _progress,
      _presentation,
      onSelectionChanged,
    ) => {
      mounted();
      select = onSelectionChanged!;
      publishDocument = onContentDocument!;
      changed({ canAdvance, canRetreat: false });
      return "ready";
    },
    dispose: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = this.classList.contains("reader-viewport")
      ? area
      : this.classList.contains("reader-reading-area")
        ? { left: 0, top: 0, right: area.right, bottom: area.bottom }
        : { left: 0, top: 0, right: 0, bottom: 0 };
    return {
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    } as DOMRect;
  });
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <AppearanceProvider
        store={{
          load: async () => ({ readerPopupMouseSelection: true, ...popupSize }),
          save: async () => {},
        }}
      >
        <PopupControl />
        <Routes>
          <Route path="/reader" element={<ReaderShell rendererFactory={factory} />} />
          <Route path="/dictionary" element={<DictionaryLocation />} />
        </Routes>
      </AppearanceProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
  return {
    mounted,
    ...pageActions,
    select: (selection: ReaderSelection | null) => act(() => select(selection)),
    publishDocument: (document: Document) => act(() => publishDocument(document)),
  };
}

function horizontal(text: string, left = 100, top = 100): ReaderSelection {
  return {
    text,
    rect: { left, top, right: left + 60, bottom: top + 24 },
    writingMode: "horizontal",
  };
}

function popupStyle() {
  const popup = screen.getByRole("dialog", { name: /^Lookup: / });
  return {
    left: popup.style.left,
    top: popup.style.top,
    width: popup.style.width,
    height: popup.style.height,
  };
}

/** Feed real modifier events through the adapter's watcher into the Reader contract. */
function scannedBook(reader: Awaited<ReturnType<typeof openReader>>) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const book = iframe.contentDocument!;
  book.body.innerHTML = "<p>読書する</p><p>本を読む</p>";
  const paragraphs = book.querySelectorAll("p");
  const createRange = book.createRange.bind(book);
  vi.spyOn(book, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getClientRects = () =>
      [
        { left: 100, top: 100, right: 124, bottom: 124, width: 24, height: 24 },
      ] as unknown as DOMRectList;
    return range;
  });
  const caret = createRange();
  Object.defineProperty(book, "caretRangeFromPoint", { value: () => caret });
  let scanIds = 0;
  const stop = watchTextSelection(
    book,
    () => undefined,
    reader.select,
    () => ++scanIds,
    { ...defaultLookupTriggers, readerPopupMouseSelection: true },
  );
  return {
    selection: () => book.getSelection()!.toString(),
    select: async (paragraph: number, origin: "pointer" | "keyboard") => {
      const range = book.createRange();
      range.setStart(paragraphs[paragraph].firstChild!, 0);
      range.setEnd(paragraphs[paragraph].firstChild!, 1);
      book.getSelection()!.removeAllRanges();
      book.getSelection()!.addRange(range);
      await act(async () => {
        book.dispatchEvent(new Event(origin === "pointer" ? "pointerup" : "keyup"));
        if (origin === "pointer") await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    scan: (paragraph: number) =>
      act(() => {
        caret.setStart(paragraphs[paragraph].firstChild!, 0);
        book.dispatchEvent(
          new MouseEvent("pointermove", { clientX: 110, clientY: 110, shiftKey: true }),
        );
      }),
    dispose: () => {
      stop();
      iframe.remove();
    },
  };
}

describe("Reader lookup popup", () => {
  it("rejects English gestures when CJK only is on and closes an existing English popup when enabled", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupCjkOnly: true });
    reader.select(horizontal("English"));
    expect(lookupMock).not.toHaveBeenCalled();
    reader.select(horizontal("読書"));
    await screen.findByText("reading books");
    fireEvent.click(screen.getByRole("button", { name: "readerPopupCjkOnly" }));
    reader.select(horizontal("English"));
    await screen.findByRole("dialog", { name: "Lookup: English" });
    const calls = lookupMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "readerPopupCjkOnly" }));
    expect(screen.queryByRole("dialog", { name: "Lookup: English" })).toBeNull();
    expect(lookupMock).toHaveBeenCalledTimes(calls);
    expect(reader.mounted).toHaveBeenCalledOnce();
  });

  it("uses expression-line alignment for Above in both parent and child popups", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupReadingPosition: "above" });
    reader.select(horizontal("読書"));
    const parent = await screen.findByRole("dialog", { name: "Lookup: 読書" });
    await within(parent).findByText("reading books");
    fireEvent.click(within(parent).getByRole("button", { name: "Search kanji 書" }));
    const child = await screen.findByRole("dialog", { name: "Lookup: 書" });
    await within(child).findByText("reading books");
    for (const popup of [parent, child]) {
      const entry = popup.querySelector(".lookup-entry--furigana")!;
      expect(entry.querySelector("rt")).toBeInTheDocument();
      expect(
        entry.querySelector(".lookup-entry__headline > .lookup-entry__actions"),
      ).toBeInTheDocument();
    }
    // Ruby annotations are out of the row's layout. Both action and word rows share
    // the annotation inset and the expression's 42px line rather than the full ruby height.
    expect(readerCss).toMatch(
      /\.lookup-entry__expression rt\s*\{[^}]*position: absolute;[^}]*bottom: 100%/,
    );
    expect(readerCss).toMatch(
      /\.lookup-entry__word\s*\{[^}]*padding-top: var\(--lookup-reading-line\)/,
    );
    expect(readerCss).toMatch(
      /\.lookup-entry__headline > \.lookup-entry__actions\s*\{[^}]*height: var\(--lookup-headword-line\);[^}]*margin-top: var\(--lookup-reading-line\)/,
    );
  });

  it("filters automatic English selections inside a popup while allowing them when switched off", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupCjkOnly: true });
    reader.select(horizontal("読書"));
    const text = await screen.findByText("reading books");
    const range = document.createRange();
    range.selectNodeContents(text);
    range.getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 160, bottom: 124 }) as DOMRect;
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent.pointerUp(text, { button: 0 });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(lookupMock).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "readerPopupCjkOnly" }));
    fireEvent.pointerUp(text, { button: 0 });
    expect(
      await screen.findByRole("dialog", { name: "Lookup: reading books" }),
    ).toBeInTheDocument();
    document.getSelection()!.removeAllRanges();
  });

  it("Alt+wheel targets real Anki actions from EPUB focus and child popup takes precedence", async () => {
    const prefs = {
      port: 8765,
      key: "",
      deck: "Study",
      deckId: 1,
      model: "Basic",
      mappings: {
        Basic: {
          modelId: 2,
          fields: ["Front", "Back"],
          templates: { Front: "{{expression}}", Back: "{{definition}}" },
        },
      },
    };
    vi.mocked(cachedAnki).mockResolvedValue(prefs);
    vi.mocked(loadAnki).mockResolvedValue(prefs);
    vi.mocked(discoverAnki).mockResolvedValue({
      deckIds: { Study: 1 },
      modelIds: { Basic: 2 },
      decks: ["Study"],
      models: ["Basic"],
      fields: ["Front", "Back"],
      lapis: "missing",
    });
    vi.mocked(createNote).mockResolvedValue({ status: "created", id: 321 });
    vi.mocked(noteStatus).mockResolvedValue({ status: "missing" });
    lookupMock.mockResolvedValue(dokusho);
    kanjiMock.mockResolvedValue({ entries: [], frequencies: [] });
    const reader = await openReader();
    reader.select(horizontal("読書"));
    const popup = await screen.findByRole("dialog", { name: "Lookup: 読書" });
    await within(popup).findByRole("button", { name: "Add 読 to Anki" });
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const book = iframe.contentDocument!;
    reader.publishDocument(book);
    fireEvent.wheel(book.body, { altKey: true, deltaY: 100 });
    fireEvent.keyDown(book.body, { altKey: true, key: "b" });
    expect(createNote).not.toHaveBeenCalled();
    expect(browseNote).not.toHaveBeenCalled();
    fireEvent.keyDown(book.body, { altKey: true, key: "e" });
    await waitFor(() =>
      expect(createNote).toHaveBeenCalledWith(
        expect.any(String),
        prefs,
        { Front: "読", Back: "reading" },
        expect.any(Object),
      ),
    );
    await within(popup).findByRole("button", { name: "Edit 読 in Anki Browser" });
    const entry = within(popup).getByRole("article", { name: "読 (とく)" });
    const dictionary = within(entry).getByRole("button", { name: "Open 読 in dictionary" });
    const browse = within(entry).getByRole("button", { name: "Edit 読 in Anki Browser" });
    const add = within(entry).getByRole("button", { name: "読 saved in Anki" });
    expect(
      dictionary.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(browse.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(book.body, { altKey: true, key: "b" });
    await waitFor(() => expect(browseNote).toHaveBeenCalledWith(321));
    fireEvent.click(within(popup).getAllByRole("button", { name: "Search kanji 読" })[0]);
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
    const child = screen.getAllByRole("dialog")[1];
    await within(child).findByRole("button", { name: "Add 読書 to Anki" });
    fireEvent.keyDown(book.body, { altKey: true, key: "e" });
    await waitFor(() =>
      expect(createNote).toHaveBeenLastCalledWith(
        expect.any(String),
        prefs,
        { Front: "読書", Back: "reading books" },
        expect.any(Object),
      ),
    );
    expect(reader.advancePage).not.toHaveBeenCalled();
    expect(reader.mounted).toHaveBeenCalledOnce();
    iframe.remove();
  });

  it("keeps lookup and definition state when every footer choice changes", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select(horizontal("読書"));
    const popup = await screen.findByRole("dialog", { name: "Lookup: 読書" });
    await within(popup).findByText("reading books");
    fireEvent.click(
      within(popup).getAllByRole("button", { name: "Collapse Jitendex definition 1" })[0],
    );
    for (const { key } of readerFooterChoices) {
      fireEvent.click(screen.getByRole("button", { name: `Toggle ${key}` }));
      expect(popup).toBeInTheDocument();
      expect(
        within(popup).getByRole("button", { name: "Expand Jitendex definition 1" }),
      ).toBeInTheDocument();
      expect(within(popup).getByText("reading")).toBeInTheDocument();
    }
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(reader.mounted).toHaveBeenCalledOnce();
    expect(reader.setPresentation).not.toHaveBeenCalled();
    expect(reader.advancePage).not.toHaveBeenCalled();
  });
  it("mines Reader context from its upper-right actions without dismissing lookup or turning the book", async () => {
    const prefs = {
      port: 8765,
      key: "",
      deck: "Study",
      deckId: 1,
      model: "Basic",
      mappings: {
        Basic: {
          modelId: 2,
          fields: ["Front", "Back"],
          templates: { Front: "{{expression}}", Back: "{{definition}}\n{{source}}\n{{sentence}}" },
        },
      },
    };
    vi.mocked(loadAnki).mockResolvedValue(prefs);
    vi.mocked(cachedAnki).mockResolvedValue(prefs);
    vi.mocked(discoverAnki).mockResolvedValue({
      deckIds: { Study: 1 },
      modelIds: { Basic: 2 },
      decks: ["Study"],
      models: ["Basic"],
      fields: ["Front", "Back"],
      lapis: "missing",
    });
    vi.mocked(createNote).mockResolvedValue({ status: "created", id: 123 });
    lookupMock.mockResolvedValue(dokusho);
    kanjiMock.mockResolvedValue({ entries: [], frequencies: [] });
    const reader = await openReader();
    reader.select({ ...horizontal("読書"), sentence: "毎日読書する。" });
    const popup = await screen.findByRole("dialog", { name: "Lookup: 読書" });
    vi.mocked(noteStatus).mockResolvedValue({ status: "missing" });
    fireEvent.click(await within(popup).findByRole("button", { name: "Add 読書 to Anki" }));
    await screen.findByText("Card added.");
    expect(createNote).toHaveBeenCalledWith(
      expect.any(String),
      prefs,
      {
        Front: "読書",
        Back: "reading books\nJitendex\n毎日読書する。",
      },
      expect.objectContaining({ fieldParts: expect.any(Object), bookId: undefined }),
    );
    // Both actions share the headword's row.
    const headline = within(popup)
      .getByRole("button", { name: "Open 読書 in dictionary" })
      .closest(".lookup-entry__headline");
    expect(headline?.querySelector(".lookup-entry__expression")).toHaveTextContent("読書");
    expect(
      within(popup)
        .getByRole("button", { name: "読書 saved in Anki" })
        .closest(".lookup-entry__headline"),
    ).toBe(headline);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(popup).toBeInTheDocument();
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(reader.mounted).toHaveBeenCalledTimes(1);
    expect(reader.advancePage).not.toHaveBeenCalled();
  });
  it.each([
    ["shift", "readerPopupShiftLookup"],
    ["shortcut", "readerPopupKeyboardShortcut"],
    ["click", "readerPopupClickLookup"],
    ["hover", "readerPopupHoverLookup"],
  ] as const)(
    "gates %s, dismisses its pending popup on disable, and waits for a deliberate new trigger",
    async (origin, field) => {
      let resolve!: (value: TermLookup) => void;
      lookupMock.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const reader = await openReader(true, undefined, { [field]: false });
      const selection = {
        ...horizontal("読書する"),
        origin,
        ...(origin !== "shortcut" ? { scanId: 10 } : {}),
      };
      reader.select(selection);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(kanjiMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: field }));
      reader.select(selection);
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: field }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(null, undefined);
      fireEvent.click(screen.getByRole("button", { name: field }));
      await act(async () => resolve(dokusho));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(reader.highlightPointerMatch).not.toHaveBeenCalledWith(10, 2);
      lookupMock.mockResolvedValue(dokusho);
      reader.select(selection);
      await screen.findByText("reading books");
      expect(reader.mounted).toHaveBeenCalledTimes(1);
      expect(reader.setPresentation).not.toHaveBeenCalled();
      expect(reader.setLookupTriggers).toHaveBeenLastCalledWith(
        expect.objectContaining({ [field]: true }),
      );
    },
  );

  it.each(["escape-outside", "outside", "persistent"] as const)(
    "applies %s to Escape and outside presses in both app and book, while navigation still closes",
    async (behavior) => {
      lookupMock.mockResolvedValue(dokusho);
      const reader = await openReader(true, undefined, { readerPopupCloseBehavior: behavior });
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const book = frame.contentDocument!;
      reader.publishDocument(book);
      try {
        for (const target of [screen.getByRole("main"), book.body]) {
          reader.select(horizontal("読書"));
          await screen.findByText("reading books");
          fireEvent.keyDown(target, { key: "Escape" });
          expect(!!screen.queryByRole("dialog")).toBe(behavior !== "escape-outside");
          reader.select(horizontal("読書"));
          await screen.findByText("reading books");
          fireEvent.pointerDown(target);
          expect(!!screen.queryByRole("dialog")).toBe(behavior === "persistent");
        }
        reader.select(horizontal("読書"));
        await screen.findByText("reading books");
        fireEvent.pointerDown(screen.getByRole("dialog"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        fireEvent.keyDown(book.body, { key: "ArrowRight" });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(reader.advancePage).toHaveBeenCalledTimes(1);
        reader.select(horizontal("読書"));
        await screen.findByText("reading books");
        fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        frame.remove();
      }
    },
  );

  it("suppresses mouse releases before lookup while preserving keyboard and Shift triggers", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupMouseSelection: false });
    const book = scannedBook(reader);
    try {
      await book.select(1, "pointer");
      expect(lookupMock).not.toHaveBeenCalled();
      expect(kanjiMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(book.selection()).toBe("本");
      await book.select(0, "keyboard");
      await screen.findByText("reading books");
      book.scan(1);
      await screen.findByRole("dialog", { name: "Lookup: 本を読む" });
      const calls = lookupMock.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
      expect(book.selection()).toBe("読");
      expect(screen.getByRole("dialog", { name: "Lookup: 本を読む" })).toBeInTheDocument();
      expect(lookupMock).toHaveBeenCalledTimes(calls);
      await book.select(0, "pointer");
      await screen.findByRole("dialog", { name: "Lookup: 読" });
      expect(lookupMock).toHaveBeenCalledTimes(calls + 1);
      expect(reader.mounted).toHaveBeenCalledTimes(1);
      expect(reader.setPresentation).not.toHaveBeenCalled();
    } finally {
      book.dispose();
    }
  });

  it("dismisses only a mouse-selection popup and discards its pending response after off/on", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select({ ...horizontal("読書"), origin: "pointer" });
    await screen.findByText("reading books");
    screen.getAllByRole("button", { name: /^Open .+ in dictionary$/ })[0].focus();
    fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
    let resolve!: (lookup: TermLookup) => void;
    lookupMock.mockImplementationOnce(
      () =>
        new Promise((answer) => {
          resolve = answer;
        }),
    );
    reader.select({ ...horizontal("読書"), origin: "pointer" });
    fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
    await act(async () => resolve(dokusho));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    reader.select({ ...horizontal("読書"), origin: "keyboard" });
    await screen.findByText("reading books");
    const calls = lookupMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Toggle mouse selection" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(lookupMock).toHaveBeenCalledTimes(calls);
    expect(reader.mounted).toHaveBeenCalledTimes(1);
    expect(reader.setPresentation).not.toHaveBeenCalled();
  });

  it("suppresses selection and Shift lookup when saved off, then restores both without remounting", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupEnabled: false });
    const book = scannedBook(reader);
    try {
      reader.select(horizontal("読"));
      book.scan(0);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(kanjiMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(null, undefined);
      fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
      reader.select(horizontal("読書"));
      await screen.findByText("reading books");
      expect(lookupMock).toHaveBeenCalledWith("読書", undefined, 5);
      book.scan(1);
      await screen.findByRole("dialog", { name: "Lookup: 本を読む" });
      expect(lookupMock).toHaveBeenCalledWith("本を読む", undefined, 5);
      expect(reader.mounted).toHaveBeenCalledTimes(1);
    } finally {
      book.dispose();
    }
  });

  it("dismisses a painted popup on disable and ignores a pending scan after disabling and reenabling", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select({ ...horizontal("読書する"), scanId: 1 });
    await screen.findByText("reading books");
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(1, 2);
    const link = screen.getAllByRole("button", { name: /^Open .+ in dictionary$/ })[0];
    link.focus();
    fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(null, undefined);
    expect(screen.getByRole("main")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
    let resolve!: (lookup: TermLookup) => void;
    lookupMock.mockImplementationOnce(
      () =>
        new Promise((answer) => {
          resolve = answer;
        }),
    );
    reader.select({ ...horizontal("読書する"), scanId: 2 });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
    reader.highlightPointerMatch.mockClear();
    await act(async () => resolve(dokusho));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reader.highlightPointerMatch).not.toHaveBeenCalled();
    expect(reader.mounted).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 0, 18, 28])(
    "uses saved popup corners (%s) with independent palette and dimensions",
    async (radius) => {
      lookupMock.mockResolvedValue(dokusho);
      const reader = await openReader(
        true,
        { left: 0, top: 0, right: 1400, bottom: 1000 },
        {
          ...(radius !== undefined && { readerPopupRadius: radius }),
          readerPopupTheme: "paper",
          readerPopupWidth: 800,
          readerPopupHeight: 600,
        },
      );
      reader.select(horizontal("読書"));
      const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
      await within(popup).findByText("reading books");
      expect(popup).toHaveStyle({
        borderRadius: `${radius ?? 18}px`,
        width: "800px",
        height: "600px",
      });
      expect(popup).toHaveAttribute("data-popup-theme", "paper");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it.each([
    ["classic", "#fff7f1", "#1f2433", "#f48370", "#ead7cb", "#fff0ea"],
    ["paper", "#fffdf8", "#2a2e3a", "#f0a25d", "#e6ddd0", "#f6efe3"],
    ["night", "#15192a", "#eef1ff", "#7b90ff", "#313753", "#222844"],
    ["custom", "#121826", "#eaf0ff", "#80a0ff", "#405070", "#253040"],
    ["application", "", "", "", "", ""],
  ] as const)(
    "scopes the %s palette to Reader results independently of book/application themes",
    async (theme, background, text, accent, border, tag) => {
      lookupMock.mockResolvedValue(dokusho);
      const reader = await openReader(true, undefined, {
        readerPopupTheme: theme,
        ...(theme === "custom" && {
          readerPopupCustomPalette: { background, text, accent, border, tag },
        }),
        theme: "dark",
        readerTheme: "sepia",
        accentColor: "#123456",
      });
      const rootStyle = document.documentElement.style.cssText;
      reader.select(horizontal("読書"));
      const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
      await within(popup).findByText("reading books");
      expect(popup).toHaveAttribute("data-popup-theme", theme);
      for (const [token, color] of [
        ["--surface-card", background],
        ["--text-primary", text],
        ["--accent-base", accent],
        ["--border-soft", border],
        ["--popup-tag", tag],
      ]) {
        expect(popup.style.getPropertyValue(token)).toBe(color);
      }
      expect(popup.style.colorScheme).toBe(
        theme === "application" ? "" : theme === "night" || theme === "custom" ? "dark" : "light",
      );
      expect(document.documentElement.style.cssText).toBe(rootStyle);
      fireEvent.click(within(popup).getAllByRole("button", { name: /^Open .+ in dictionary$/ })[0]);
      await screen.findByRole("heading", { name: /^Dictionary/ });
      expect(document.querySelector("[data-popup-theme]")).toBeNull();
      expect(document.documentElement.style.cssText).toBe(rootStyle);
    },
  );

  it("uses saved popup dimensions and fits them within a smaller reading area", async () => {
    const reader = await openReader(
      true,
      { left: 300, top: 0, right: 700, bottom: 300 },
      { readerPopupWidth: 800, readerPopupHeight: 600 },
    );
    reader.select(horizontal("word", 320, 20));
    expect(popupStyle()).toEqual({ left: "308px", top: "54px", width: "384px", height: "238px" });
  });

  it("uses saved popup dimensions when there is enough room", async () => {
    const reader = await openReader(
      true,
      { left: 0, top: 0, right: 1400, bottom: 1000 },
      { readerPopupWidth: 800, readerPopupHeight: 600 },
    );
    reader.select(horizontal("word"));
    expect(popupStyle()).toEqual({ left: "100px", top: "134px", width: "800px", height: "600px" });
    const popup = screen.getByRole("dialog", { name: "Lookup: word" });
    expect(within(popup).queryByText("Looking up")).not.toBeInTheDocument();
    expect(within(popup).queryByRole("button", { name: "Close lookup" })).not.toBeInTheDocument();
  });
  it.each([true, false])(
    "hides and restores metadata for each headword while preserving metadata and disclosures (names %s)",
    async (showNames) => {
      const entries = dokusho.groups.map((original, index) => ({
        ...original,
        terms: [
          ...original.terms,
          { ...original.terms[0], dictionaryId: 2, dictionaryTitle: "Second source" },
        ],
        frequencies: Array.from({ length: 8 }, (_, rank) => ({
          dictionaryId: rank + 10,
          dictionaryTitle: `Frequency ${rank}`,
          data: rank + index,
        })),
        pitches: [
          {
            dictionaryId: 3,
            dictionaryTitle: "Pitch source",
            data: {
              reading: original.reading,
              pitches: [{ position: 0 }, { position: 2, nasal: 1, devoice: 2, tags: ["noun"] }],
            },
          },
        ],
      }));
      lookupMock.mockResolvedValue({ text: dokusho.text, groups: entries });
      const reader = await openReader(true, undefined, {
        readerPopupShowDictionaryNames: showNames,
      });
      reader.select(horizontal(dokusho.text));
      const popup = screen.getByRole("dialog");
      await within(popup).findAllByText("reading books");
      const articles = within(popup).getAllByRole("article");
      const snapshots = articles.map((article) => {
        const ui = within(article);
        fireEvent.click(ui.getByRole("button", { name: "+2 more" }));
        fireEvent.click(ui.getByRole("button", { name: "Collapse Jitendex definition 1" }));
        return {
          pitch: ui.getByRole("region", { name: "Pitch positions" }).innerHTML,
          frequency: ui.getByRole("list", { name: "Frequency" }).innerHTML,
          definitions: article.querySelector(".lookup-entry__definitions"),
        };
      });
      const verify = () =>
        articles.forEach((article, index) => {
          const ui = within(article);
          const pitch = ui.getByRole("region", { name: "Pitch positions" });
          const definitions = article.querySelector(".lookup-entry__definitions")!;
          expect(
            pitch.compareDocumentPosition(definitions) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
          expect(pitch.innerHTML).toBe(snapshots[index].pitch);
          expect(definitions).toBe(snapshots[index].definitions);
          expect(ui.getByRole("list", { name: "Frequency" }).innerHTML).toBe(
            snapshots[index].frequency,
          );
          expect(ui.getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
          expect(ui.getByRole("button", { name: "Expand Jitendex definition 1" })).toHaveAttribute(
            "aria-expanded",
            "false",
          );
          expect(
            ui.getByRole("button", { name: "Collapse Second source definition 2" }),
          ).toHaveAttribute("aria-expanded", "true");
        });
      verify();
      fireEvent.click(screen.getByRole("button", { name: "Toggle pitch" }));
      expect(within(popup).queryAllByRole("region", { name: "Pitch positions" })).toHaveLength(0);
      expect(within(popup).getAllByRole("list", { name: "Frequency" })).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Toggle frequency" }));
      expect(within(popup).queryAllByRole("list", { name: "Frequency" })).toHaveLength(0);
      expect(
        within(popup).getAllByRole("button", { name: "Expand Jitendex definition 1" }),
      ).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Toggle pitch" }));
      expect(within(popup).getAllByRole("region", { name: "Pitch positions" })).toHaveLength(2);
      expect(within(popup).queryAllByRole("list", { name: "Frequency" })).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Toggle frequency" }));
      verify();
      expect(reader.mounted).toHaveBeenCalledTimes(1);
      expect(lookupMock).toHaveBeenCalledTimes(1);
    },
  );

  it("loads both metadata controls off without hiding definitions", async () => {
    lookupMock.mockResolvedValue({
      ...dokusho,
      groups: [
        {
          ...dokusho.groups[0],
          frequencies: [{ dictionaryId: 2, dictionaryTitle: "Frequency source", data: 12 }],
          pitches: [
            {
              dictionaryId: 3,
              dictionaryTitle: "Pitch source",
              data: {
                reading: dokusho.groups[0].reading,
                pitches: [{ position: 0 }],
              },
            },
          ],
        },
        dokusho.groups[1],
      ],
    });
    const reader = await openReader(true, undefined, {
      readerPopupShowPitch: false,
      readerPopupShowFrequency: false,
    });
    reader.select(horizontal(dokusho.text));
    const popup = screen.getByRole("dialog");
    await within(popup).findByText("reading books");
    expect(within(popup).getAllByRole("article")).toHaveLength(2);
    expect(
      within(popup).queryByRole("region", { name: "Pitch positions" }),
    ).not.toBeInTheDocument();
    expect(within(popup).queryByRole("list", { name: "Frequency" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle pitch" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle frequency" }));
    expect(within(popup).getAllByRole("region", { name: "Pitch positions" })).toHaveLength(1);
    expect(within(popup).getAllByRole("list", { name: "Frequency" })).toHaveLength(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("hides metadata sources while preserving values, pitch patterns, order, and disclosure state", async () => {
    const entry = group("読書", "どくしょ", "読書", "reading books");
    entry.frequencies = Array.from({ length: 8 }, (_, index) => ({
      dictionaryId: (index % 2) + 1,
      dictionaryTitle: `Frequency ${index % 2}`,
      data: { frequency: { value: index, displayValue: `Rank ${index}` } },
    }));
    entry.pitches = ["Pitch A", "Pitch B", "Pitch A"].map((dictionaryTitle, index) => ({
      dictionaryId: index + 1,
      dictionaryTitle,
      data: {
        reading: "どくしょ",
        pitches: [{ position: 0 }, { position: 2, nasal: 1, devoice: 2, tags: ["noun"] }],
      },
    }));
    lookupMock.mockResolvedValue({ text: entry.text, groups: [entry] });
    const reader = await openReader();
    reader.select(horizontal(entry.text));
    const popup = screen.getByRole("dialog");
    await within(popup).findByText("reading books");
    const frequencies = within(popup).getByRole("list", { name: "Frequency" });
    expect(within(frequencies).getAllByText(/^Rank/)).toHaveLength(6);
    fireEvent.click(within(frequencies).getByRole("button", { name: "+2 more" }));
    const values = () =>
      within(frequencies)
        .getAllByText(/^Rank/)
        .map((value) => value.textContent);
    const originalValues = values();
    const pitch = within(popup).getByRole("region", { name: "Pitch positions" });
    const originalPitch = pitch.innerHTML;
    expect(pitch.querySelectorAll(".dictionary-pitch__contour")).toHaveLength(2);
    fireEvent.click(within(popup).getByRole("button", { name: "Collapse Jitendex definition 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle names" }));
    expect(values()).toEqual(originalValues);
    expect(within(frequencies).getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
    for (const source of within(frequencies).getAllByText(/^Frequency [01]$/)) {
      expect(source).toHaveClass("visually-hidden");
      expect(source.closest("li")).toHaveAttribute("title", source.textContent);
    }
    const sources = pitch.querySelectorAll(".visually-hidden");
    expect([...sources].map((source) => source.textContent)).toEqual([
      "Pitch A, Pitch B, Pitch A",
      "Pitch A, Pitch B, Pitch A",
    ]);
    for (const source of sources) {
      expect(source).not.toHaveAttribute("aria-hidden");
      expect(source.closest("li")).toHaveAttribute("title", "Pitch A, Pitch B, Pitch A");
    }
    expect(pitch.querySelectorAll(".dictionary-pitch__contour")).toHaveLength(2);
    expect(within(pitch).getByText("Position 2")).toBeInTheDocument();
    expect(within(pitch).getByText("noun")).toBeInTheDocument();
    expect(within(pitch).getByText(/Nasal.*Devoiced/)).toBeInTheDocument();
    expect(
      within(popup).getByRole("button", { name: "Expand Jitendex definition 1" }),
    ).toHaveTextContent("Jitendex");
    fireEvent.click(screen.getByRole("button", { name: "Toggle names" }));
    expect(pitch.innerHTML).toBe(originalPitch);
    for (const source of within(frequencies).getAllByText(/^Frequency [01]$/)) {
      expect(source).not.toHaveClass("visually-hidden");
    }
    expect(reader.mounted).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("applies saved hidden names to kanji frequency sources and leaves definitions visible", async () => {
    kanjiMock.mockResolvedValue({
      entries: [
        {
          dictionaryId: 1,
          dictionaryTitle: "Kanji source",
          character: "本",
          onyomi: "ホン",
          kunyomi: "もと",
          tags: "",
          resolvedTags: [],
          statTags: [],
          meanings: ["book"],
          stats: {},
        },
      ],
      frequencies: [{ dictionaryId: 2, dictionaryTitle: "Kanji frequency", data: 12 }],
    });
    const reader = await openReader(true, undefined, { readerPopupShowDictionaryNames: false });
    reader.select(horizontal("本"));
    const popup = screen.getByRole("dialog");
    const card = await within(popup).findByRole("article", { name: "Kanji 本" });
    expect(within(card).getByText("Kanji frequency")).toHaveClass("visually-hidden");
    expect(within(card).getByRole("term", { name: "Kanji frequency" })).not.toHaveAttribute(
      "aria-hidden",
    );
    expect(within(card).getByText("12")).toHaveAttribute("title", "Kanji frequency");
    expect(within(card).getByText("Kanji source")).not.toHaveClass("visually-hidden");
    const originalCard = card;
    fireEvent.click(screen.getByRole("button", { name: "Toggle frequency" }));
    expect(within(card).queryByText("Kanji frequency")).not.toBeInTheDocument();
    expect(within(card).getByText("book")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle frequency" }));
    expect(within(card).getByText("Kanji frequency")).toHaveClass("visually-hidden");
    expect(within(popup).getByRole("article", { name: "Kanji 本" })).toBe(originalCard);
    fireEvent.click(screen.getByRole("button", { name: "Toggle names" }));
    expect(within(card).getByText("Kanji frequency")).not.toHaveClass("visually-hidden");
    expect(kanjiMock).toHaveBeenCalledTimes(1);
  });

  it("hides every popup voice action without changing results, disclosures, or renderer", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader(true, undefined, { readerPopupVoiceAction: false });
    reader.select(horizontal("読書"));
    const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
    await within(popup).findByText("reading books");
    expect(within(popup).queryAllByRole("button", { name: /^Play pronunciation/ })).toHaveLength(0);
    fireEvent.click(
      within(popup).getAllByRole("button", { name: "Collapse Jitendex definition 1" })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle voice" }));
    expect(within(popup).getAllByRole("button", { name: /^Play pronunciation/ })).toHaveLength(2);
    expect(within(popup).getAllByRole("button", { name: /^Play pronunciation/ })[0]).toBeDisabled();
    expect(
      within(popup).getByRole("button", { name: "Expand Jitendex definition 1" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle voice" }));
    expect(within(popup).queryAllByRole("button", { name: /^Play pronunciation/ })).toHaveLength(0);
    expect(reader.mounted).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("plays the headword's recording and stops it when its popup control is hidden", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    // The popup asks for recordings as the desktop app does; the Reader opened as in tests.
    stubWordAudio();
    reader.select(horizontal("読書"));
    const button = await screen.findByRole("button", { name: "Play pronunciation for 読書" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(getWordAudio).toHaveBeenCalledWith("読書", "どくしょ");
    fireEvent.click(screen.getByRole("button", { name: "Toggle voice" }));
    expect(MockAudio.played[0].pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Toggle voice" }));
    expect(screen.getByRole("button", { name: "Play pronunciation for 読書" })).toBeEnabled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lookupMock.mockResolvedValue({ text: "", groups: [] });
    kanjiMock.mockResolvedValue({ entries: [], frequencies: [] });
    listMock.mockResolvedValue([summary(1, "Jitendex", true)]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the existing popup beside a Shift-scanned character with its word results", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    const book = scannedBook(reader);
    try {
      book.scan(0);
      const popup = screen.getByRole("dialog", { name: "Lookup: 読書する" });
      expect(lookupMock).toHaveBeenCalledWith("読書する", undefined, 5);
      expect(await within(popup).findByText("reading books")).toBeInTheDocument();
      expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(1, 2);
      expect(popupStyle()).toEqual({
        left: "100px",
        top: "134px",
        width: "480px",
        height: "440px",
      });
    } finally {
      book.dispose();
    }
  });

  it("refreshes retained source policy, clears obsolete paint and rejects pending responses without remounting or selection changes", async () => {
    const answers: ((lookup: TermLookup) => void)[] = [];
    lookupMock.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const reader = await openReader();
    const book = scannedBook(reader);
    try {
      book.scan(0);
      await act(async () => answers[0](dokusho));
      expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(1, 2);
      const mounted = reader.mounted.mock.calls.length;
      const selection = book.selection();
      fireEvent.click(screen.getByRole("button", { name: "No definition sources" }));
      expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(1, 0);
      await waitFor(() => expect(lookupMock).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole("button", { name: "No frequency sources" }));
      await waitFor(() => expect(lookupMock).toHaveBeenCalledTimes(3));
      await act(async () => answers[1](dokusho));
      expect(screen.queryByText("reading books")).not.toBeInTheDocument();
      await act(async () => answers[2]({ text: "読書する", groups: [] }));
      await screen.findByText("No matches");
      act(() => window.dispatchEvent(new Event(dictionariesChanged)));
      await waitFor(() => expect(lookupMock).toHaveBeenCalledTimes(4));
      fireEvent.click(screen.getByRole("button", { name: "Toggle popup" }));
      await act(async () => answers[3](dokusho));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(reader.mounted.mock.calls.length).toBe(mounted);
      expect(book.selection()).toBe(selection);
    } finally {
      book.dispose();
    }
  });

  it("replaces a pending scan when Shift moves to another character, discarding its stale response", async () => {
    const answers = new Map<string, (lookup: TermLookup) => void>();
    lookupMock.mockImplementation((query) => new Promise((resolve) => answers.set(query, resolve)));
    const reader = await openReader();
    const book = scannedBook(reader);
    try {
      book.scan(0);
      book.scan(1);
      await act(async () =>
        answers.get("本を読む")!({ text: "本", groups: [group("本", "ほん", "本", "book")] }),
      );
      await act(async () => answers.get("読書する")!(dokusho));
      const popup = screen.getByRole("dialog", { name: "Lookup: 本を読む" });
      expect(within(popup).getByText("book")).toBeInTheDocument();
      expect(within(popup).queryByText("reading books")).not.toBeInTheDocument();
      expect(reader.highlightPointerMatch.mock.calls.filter(([id]) => id !== null)).toEqual([
        [2, 1],
      ]);
    } finally {
      book.dispose();
    }
  });

  it("clears failed and unmatched scans, counts supplementary characters, and leaves selection lookups unpainted", async () => {
    const reader = await openReader();
    lookupMock.mockResolvedValueOnce({
      text: "𠮷読",
      groups: [group("𠮷読", "よしよみ", "𠮷読", "match")],
    });
    reader.select({ ...horizontal("𠮷読む"), scanId: 1 });
    await screen.findByText("match");
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(1, 2);
    reader.select({ ...horizontal("見つからない"), scanId: 2 });
    await screen.findByText("No matches");
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(2, 0);
    lookupMock.mockRejectedValueOnce(new Error("failed"));
    reader.select({ ...horizontal("失敗"), scanId: 3 });
    await screen.findByRole("alert");
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(3, 0);
    reader.highlightPointerMatch.mockClear();
    lookupMock.mockResolvedValue(dokusho);
    reader.select(horizontal("読書"));
    await screen.findByText("reading books");
    expect(reader.highlightPointerMatch.mock.calls).toEqual([[null, undefined]]);
  });

  it("reads the installed dictionaries once per open book, not once per popup", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select(horizontal("読書"));
    await screen.findByText("reading books");
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    reader.select(horizontal("読書する"));
    await screen.findByText("reading books");
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("offers Get dictionaries instead of No matches until a source can supply definitions", async () => {
    listMock.mockResolvedValue([summary(2, "Jiten frequency", false)]);
    const reader = await openReader();
    reader.select(horizontal("見つからない"));
    const popup = await screen.findByRole("dialog");
    expect(await within(popup).findByText("No dictionaries yet")).toBeInTheDocument();
    expect(within(popup).queryByText("No matches")).not.toBeInTheDocument();
    expect(within(popup).getByRole("link", { name: "Get dictionaries" })).toHaveAttribute(
      "href",
      "/settings?section=dictionary",
    );
    listMock.mockResolvedValue([
      summary(2, "Jiten frequency", false),
      summary(1, "Jitendex", true),
    ]);
    act(() => window.dispatchEvent(new Event(dictionariesChanged)));
    expect(await within(popup).findByText("No matches")).toBeInTheDocument();
    expect(within(popup).queryByRole("link", { name: "Get dictionaries" })).toBeNull();
  });

  it("clears a scan on close and never paints its late response", async () => {
    let resolve!: (lookup: TermLookup) => void;
    lookupMock.mockImplementation(
      () =>
        new Promise((answer) => {
          resolve = answer;
        }),
    );
    const reader = await openReader();
    reader.select({ ...horizontal("読書する"), scanId: 1 });
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    expect(reader.highlightPointerMatch).toHaveBeenLastCalledWith(null, undefined);
    reader.highlightPointerMatch.mockClear();
    await act(async () => resolve(dokusho));
    expect(reader.highlightPointerMatch).not.toHaveBeenCalled();
  });

  it("opens beside a selection with each matched headword as an entry, definitions open", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select(horizontal("  読書する本\n"));

    const popup = screen.getByRole("dialog", { name: "Lookup: 読書する本" });
    expect(within(popup).getByText("Searching…")).toBeInTheDocument();
    expect(lookupMock).toHaveBeenCalledWith("読書する本", undefined, 5);
    // A longer text asks for no kanji, as on the Dictionary page.
    expect(kanjiMock).not.toHaveBeenCalled();
    await within(popup).findByText("reading books");
    expect(within(popup).queryByText("Showing results for")).not.toBeInTheDocument();
    expect(within(popup).queryByText("2 entries")).not.toBeInTheDocument();
    // Below the selection, starting at its left edge.
    expect(popupStyle()).toEqual({ left: "100px", top: "134px", width: "480px", height: "440px" });
    const entries = within(popup).getAllByRole("article");
    expect(entries.map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "読書 (どくしょ)",
      "読 (とく)",
    ]);
    // Each dictionary's definitions are a numbered section, open until collapsed.
    const section = within(entries[0]).getByRole("button", {
      name: "Collapse Jitendex definition 1",
    });
    expect(section).toHaveAttribute("aria-expanded", "true");
    expect(within(popup).getByText("reading books")).toBeVisible();
    fireEvent.click(section);
    expect(section).toHaveAttribute("aria-expanded", "false");
    expect(within(popup).getByText("reading books")).not.toBeVisible();
    // The shorter start's entry names its start, and headword kanji search themselves.
    expect(within(entries[1]).getByTitle("Matched: 読")).toBeInTheDocument();
    expect(within(entries[0]).getByRole("button", { name: "Search kanji 書" })).toBeInTheDocument();
    fireEvent.click(within(popup).getAllByRole("button", { name: /^Open .+ in dictionary$/ })[0]);
    expect(await screen.findByRole("heading", { name: "Dictionary ?q=読書" })).toBeInTheDocument();
  });

  it("looks up a one-character selection's kanji and the first 256 characters of a longer one", async () => {
    const reader = await openReader();
    reader.select(horizontal("本"));
    await waitFor(() => expect(kanjiMock).toHaveBeenCalledWith("本"));
    expect(await screen.findByText("No matches")).toBeInTheDocument();

    const long = `${"読".repeat(250)}𠮷${"書".repeat(49)}`;
    reader.select(horizontal(long));
    expect(lookupMock).toHaveBeenLastCalledWith(
      `${"読".repeat(250)}𠮷${"書".repeat(5)}`,
      undefined,
      5,
    );
  });

  it("keeps a long query in the accessible dialog name without a visible summary", async () => {
    const query = `読書する${"長い文章".repeat(60)}`;
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select(horizontal(query));
    const popup = screen.getByRole("dialog", { name: `Lookup: ${query}` });
    expect(popup).toHaveAccessibleName(`Lookup: ${query}`);
    await within(popup).findByText("reading books");
    expect(within(popup).getByText("reading books")).toBeInTheDocument();
    expect(within(popup).queryByRole("button", { name: "Close lookup" })).not.toBeInTheDocument();
  });

  it("stays within the reading area beside horizontal and vertical selections", async () => {
    const reader = await openReader();
    // Near the bottom-right corner: above the selection, moved in from the right edge.
    reader.select(horizontal("読む", 900, 700));
    expect(popupStyle()).toEqual({ left: "512px", top: "250px", width: "480px", height: "440px" });

    // Right-to-left vertical text: before the line, to its left, from its top.
    reader.select({
      text: "読む",
      rect: { left: 500, top: 50, right: 530, bottom: 300 },
      writingMode: "vertical-rl",
    });
    expect(popupStyle()).toEqual({ left: "10px", top: "50px", width: "480px", height: "440px" });

    // Without room on its left, it shows on the right, and never below the area's bottom.
    reader.select({
      text: "読む",
      rect: { left: 100, top: 700, right: 130, bottom: 790 },
      writingMode: "vertical-rl",
    });
    expect(popupStyle()).toEqual({ left: "140px", top: "352px", width: "480px", height: "440px" });
  });

  it("shrinks into a small reading area and is placed relative to the area beside a pinned sidebar", async () => {
    const reader = await openReader(true, { left: 300, top: 0, right: 700, bottom: 300 });
    reader.select(horizontal("読む", 320, 20));
    // 400px wide less its margins; below the selection with 246px of room.
    expect(popupStyle()).toEqual({ left: "308px", top: "54px", width: "384px", height: "238px" });
  });

  it("closes on Escape in the reader and in the book without hiding the sidebar", async () => {
    const reader = await openReader();
    const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
    const shown = sidebar.className;
    reader.select(horizontal("読む"));
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
    expect(sidebar.className).toBe(shown);

    const book = document.implementation.createHTMLDocument();
    reader.publishDocument(book);
    reader.select(horizontal("読む"));
    // A section document has no window of its own here.
    act(() => {
      book.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
  });

  it("closes on a click outside it, in the reader or the book, but not on one inside it", async () => {
    lookupMock.mockResolvedValue(dokusho);
    const reader = await openReader();
    reader.select(horizontal("読書"));
    const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
    const [, second] = await within(popup).findAllByRole("button", {
      name: "Collapse Jitendex definition 1",
    });
    fireEvent.pointerDown(second);
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(within(popup).getByRole("button", { name: "Expand Jitendex definition 1" })).toBe(
      second,
    );
    fireEvent.pointerDown(screen.getByRole("main"));
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();

    reader.select(horizontal("読書"));
    fireEvent.pointerDown(screen.getByRole("complementary", { name: "Reader sidebar" }));
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();

    const book = document.implementation.createHTMLDocument();
    reader.publishDocument(book);
    reader.select(horizontal("読書"));
    act(() => {
      book.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
  });

  it("closes on a page turn, when the selection is cleared, and on Escape", async () => {
    const reader = await openReader();
    reader.select(horizontal("読む"));
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(reader.advancePage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();

    reader.select(horizontal("読む"));
    reader.select(null);
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();

    reader.select(horizontal("読む"));
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
    // Whitespace alone looks nothing up.
    reader.select(horizontal(" \n "));
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
    expect(lookupMock).toHaveBeenCalledTimes(3);
  });

  it("replaces a pending lookup with a newer selection's and discards the stale response", async () => {
    const answers = new Map<string, (lookup: TermLookup) => void>();
    lookupMock.mockImplementation((query) => new Promise((resolve) => answers.set(query, resolve)));
    const reader = await openReader();
    reader.select(horizontal("読書"));
    reader.select(horizontal("本を", 200, 200));
    await act(async () =>
      answers.get("本を")!({ text: "本", groups: [group("本", "ほん", "本", "book")] }),
    );
    await act(async () => answers.get("読書")!(dokusho));
    const popup = screen.getByRole("dialog", { name: "Lookup: 本を" });
    expect(within(popup).getByText("book")).toBeInTheDocument();
    expect(within(popup).queryByText("reading books")).not.toBeInTheDocument();

    // A response for a closed popup does not bring it back.
    reader.select(horizontal("読む"));
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    await act(async () => answers.get("読む")!(dokusho));
    expect(screen.queryByRole("dialog", { name: /^Lookup: / })).not.toBeInTheDocument();
  });

  it("shows a failure, and opens a headword kanji in a child popup", async () => {
    lookupMock.mockRejectedValueOnce(new Error("native detail"));
    const reader = await openReader();
    reader.select(horizontal("読む"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Lookup could not be completed.");
    expect(screen.queryByText(/native detail/)).not.toBeInTheDocument();

    lookupMock.mockResolvedValue(dokusho);
    reader.select(horizontal("読書"));
    fireEvent.click(await screen.findByRole("button", { name: "Search kanji 書" }));
    // The child opens over the book; the parent stays, and Escape closes the child first.
    expect(await screen.findByRole("dialog", { name: "Lookup: 書" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Lookup: 読書" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Lookup: 書" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Lookup: 書" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Lookup: 読書" })).toBeInTheDocument();
  });

  it("opens a glossary link's target in a child popup, or the Dictionary page without child popups", async () => {
    lookupMock.mockResolvedValue({
      text: "読書",
      groups: [
        {
          ...group("読書", "どくしょ", "読書", ""),
          terms: [
            {
              ...group("読書", "どくしょ", "読書", "").terms[0],
              glossary: [
                {
                  type: "structured-content",
                  content: { tag: "a", href: "?query=読む", content: "読む" },
                },
              ],
            },
          ],
        },
      ],
    });
    const reader = await openReader();
    reader.select(horizontal("読書"));
    const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
    fireEvent.click(await within(popup).findByRole("button", { name: /読む/ }));
    expect(await screen.findByRole("dialog", { name: "Lookup: 読む" })).toBeInTheDocument();
    // Open in dictionary still hands off to the Dictionary page.
    fireEvent.click(within(popup).getByRole("button", { name: "Open 読書 in dictionary" }));
    expect(await screen.findByRole("heading", { name: "Dictionary ?q=読書" })).toBeInTheDocument();
  });

  it("shows only headwords, furigana and each dictionary's numbered definitions in the Dictionary style", async () => {
    const base = group("読書", "どくしょ", "読書", "reading books");
    const term = base.terms[0];
    lookupMock.mockResolvedValue({
      text: "読書",
      groups: [
        {
          ...base,
          deinflection: {
            inflections: ["past"],
            rules: [],
          } as unknown as TermGroup["deinflection"],
          terms: [
            {
              ...term,
              glossary: ["reading books", "", "reading"],
              tags: [
                { name: "n", category: "partOfSpeech", notes: "noun", order: 0, score: 0 },
              ] as unknown as typeof term.tags,
            },
            {
              ...term,
              dictionaryId: 2,
              dictionaryTitle: "国語",
              sequence: 2,
              glossary: ["本を読むこと。"],
            },
            { ...term, sequence: 3, glossary: ["perusal"] },
          ],
          frequencies: [{ dictionaryId: 3, dictionaryTitle: "Frequency source", data: 12 }],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Pitch source",
              data: { reading: "どくしょ", pitches: [{ position: 1 }] },
            },
          ],
        },
        group("読", "とく", "読", "reading"),
      ],
    });
    const reader = await openReader(true, undefined, {
      readerPopupStyle: "dictionary",
      readerPopupFont: { source: "system", family: "Yu Mincho" },
      readerPopupReadingPosition: "beside",
    });
    reader.select(horizontal("読書"));
    const popup = screen.getByRole("dialog", { name: "Lookup: 読書" });
    await within(popup).findByText("reading books; reading");
    expect(popup).toHaveClass("reader-lookup--dictionary");
    expect(popup.style.getPropertyValue("--popup-font")).toBe(
      '"Yu Mincho", "Komori Google zen-old-mincho", serif',
    );
    const [entry, shorter] = within(popup).getAllByRole("article");
    expect(entry).toHaveAccessibleName("読書 (どくしょ)");
    // Readings are furigana above their kanji, whatever the reading position.
    expect([...entry.querySelectorAll("rt")].map((rt) => rt.textContent)).toEqual(["どくしょ"]);
    expect(entry.querySelector(".dictionary-entry__headword")).toHaveAttribute("lang", "ja");
    // Each dictionary's definitions together under its name, numbered when it has more than one.
    const jitendex = within(entry).getByRole("region", { name: "Jitendex" });
    expect(within(jitendex).getByText("Jitendex")).toHaveClass("dictionary-entry__name");
    expect(
      within(jitendex)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["reading books; reading", "perusal"]);
    expect(within(jitendex).getByRole("list")).not.toHaveClass("dictionary-entry__senses--single");
    const kokugo = within(entry).getByRole("region", { name: "国語" });
    expect(within(kokugo).getByRole("list")).toHaveClass("dictionary-entry__senses--single");
    expect(
      within(popup)
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Jitendex", "国語", "Jitendex"]);
    // Nothing but the headword kanji's own lookups: no voice, tags, notes, pitch, frequency,
    // Anki or Dictionary actions.
    for (const button of within(popup).getAllByRole("button"))
      expect(button).toHaveAccessibleName(/^Search kanji /);
    expect(within(popup).queryByText("n")).not.toBeInTheDocument();
    expect(within(popup).queryByText("12")).not.toBeInTheDocument();
    expect(
      within(popup).queryByRole("region", { name: "Pitch positions" }),
    ).not.toBeInTheDocument();
    expect(within(shorter).queryByTitle("Matched: 読")).not.toBeInTheDocument();
    expect(readerCss).toMatch(/@counter-style komori-circled\s*\{[^}]*symbols: "①" "②"/);
    expect(readerCss).toMatch(
      /\.reader-lookup--dictionary \.reader-lookup__entries\s*\{[^}]*font-family: var\(--popup-font\)/,
    );
    // Names follow their setting, and headword kanji still open child popups in the same style.
    fireEvent.click(screen.getByRole("button", { name: "Toggle names" }));
    expect(within(jitendex).queryByText("Jitendex")).not.toBeInTheDocument();
    expect(jitendex).toHaveAccessibleName("Jitendex");
    fireEvent.click(within(entry).getByRole("button", { name: "Search kanji 書" }));
    const child = await screen.findByRole("dialog", { name: "Lookup: 書" });
    expect(child).toHaveClass("reader-lookup--dictionary");
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the Kanji card and No matches without frequencies or actions in the Dictionary style", async () => {
    kanjiMock.mockResolvedValue({
      entries: [
        {
          dictionaryId: 1,
          dictionaryTitle: "Kanji source",
          character: "本",
          onyomi: "ホン",
          kunyomi: "もと",
          tags: "",
          resolvedTags: [],
          statTags: [],
          meanings: ["book"],
          stats: {},
        },
      ],
      frequencies: [{ dictionaryId: 2, dictionaryTitle: "Kanji frequency", data: 12 }],
    });
    const reader = await openReader(true, undefined, { readerPopupStyle: "dictionary" });
    reader.select(horizontal("本"));
    const popup = screen.getByRole("dialog", { name: "Lookup: 本" });
    const card = await within(popup).findByRole("article", { name: "Kanji 本" });
    expect(within(card).getByText("book")).toBeInTheDocument();
    expect(within(card).queryByText("Kanji frequency")).not.toBeInTheDocument();
    expect(within(popup).queryByRole("button", { name: "Open 本 in dictionary" })).toBeNull();
    // The default popup font is the included Zen Old Mincho.
    expect(popup.style.getPropertyValue("--popup-font")).toBe(
      '"Komori Google zen-old-mincho", serif',
    );

    kanjiMock.mockResolvedValue({ entries: [], frequencies: [] });
    reader.select(horizontal("木"));
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open 木 in dictionary" })).toBeNull();
  });
});
