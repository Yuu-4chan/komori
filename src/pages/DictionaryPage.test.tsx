import {
  act,
  cleanup,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listDictionaries,
  lookupKanji,
  lookupTerms,
  type DictionarySummary,
  type KanjiLookup,
  type TermGroup,
  type TermLookup,
} from "../features/dictionary/dictionaryApi";
import dictionaryCss from "../styles/dictionary.css?raw";
import readerCss from "../styles/reader.css?raw";
import tokensCss from "../styles/tokens.css?raw";
import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { getWordAudio } from "../features/dictionary/wordAudio";
import { MobileHeaderContext } from "../components/layout/mobileHeader";
import { DictionaryPage } from "./DictionaryPage";

// The production Dictionary page lives in the app router, including the Anki
// setup handoff surfaced by its automatic connection/existence checks.
function render(ui: Parameters<typeof renderComponent>[0]) {
  return renderComponent(
    <MemoryRouter>
      <AppearanceProvider store={null}>{ui}</AppearanceProvider>
    </MemoryRouter>,
  );
}

vi.mock("../features/dictionary/wordAudio", async (original) => ({
  ...(await original<typeof import("../features/dictionary/wordAudio")>()),
  getWordAudio: vi.fn(),
}));

vi.mock("../features/dictionary/dictionaryApi", () => ({
  lookupTerms: vi.fn(),
  lookupKanji: vi.fn(),
  listDictionaries: vi.fn(),
}));

const lookupMock = vi.mocked(lookupTerms);
const kanjiMock = vi.mocked(lookupKanji);
const listMock = vi.mocked(listDictionaries);
const dictionaries: DictionarySummary[] = [
  {
    id: 1,
    title: "Jitendex",
    revision: "1",
    enabled: true,
    termCount: 10,
    termMetaCount: 0,
    kanjiCount: 0,
    kanjiMetaCount: 0,
    hasFrequency: true,
    hasPitch: false,
    language: "ja",
    hasDefinitions: true,
  },
  {
    id: 3,
    title: "見本国語辞典",
    revision: "2",
    enabled: true,
    termCount: 10,
    termMetaCount: 0,
    kanjiCount: 0,
    kanjiMetaCount: 0,
    hasFrequency: true,
    hasPitch: false,
    language: "ja",
    hasDefinitions: true,
  },
];
const result: GroupFixture = {
  expression: "読む",
  reading: "よむ",
  deinflection: null,
  terms: [
    {
      dictionaryId: 1,
      dictionaryTitle: "Jitendex",
      definitionTags: "v5 common",
      rules: "v5",
      score: 10,
      sequence: 1,
      termTags: "popular",
      tags: [
        { name: "v5", category: "partOfSpeech", order: -3, notes: "Godan verb", score: 0 },
        { name: "common" },
        { name: "popular" },
      ],
      glossary: [
        "to read",
        {
          type: "structured-content",
          content: {
            tag: "div",
            content: [
              "written words",
              { tag: "a", content: "linked text" },
              { type: "image", path: "private" },
            ],
          },
        },
      ],
    },
  ],
  frequencies: [
    {
      dictionaryId: 2,
      dictionaryTitle: "Sample frequency",
      data: { frequency: { displayValue: "7", value: 7 } },
    },
  ],
  transcriptions: [],
  pitches: [],
};

/** A returned group without the start it matched, which `matched` and `exact` give it. */
type GroupFixture = Omit<TermGroup, "text">;

/**
 * A lookup whose `groups` match `text`, followed by each shorter start's groups, as
 * `[start, groups]` pairs.
 */
function matched(
  text: string,
  groups: GroupFixture[],
  ...shorter: [string, GroupFixture[]][]
): TermLookup {
  return {
    text,
    groups: [[text, groups] as const, ...shorter].flatMap(([start, startGroups]) =>
      startGroups.map((group) => ({ ...group, text: start })),
    ),
  };
}

/** Answers a lookup with `groups` as an exact match of its query. */
function exact(groups: GroupFixture[]) {
  return async (query: string): Promise<TermLookup> => matched(query.trim(), groups);
}

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

// Every tag beside a dictionary's name, including those waiting behind "+N more".
async function sourceTags(user: ReturnType<typeof userEvent.setup>, source: HTMLElement) {
  const more = within(source).queryByRole("button", { name: /^\+\d+ more$/ });
  if (more) await user.click(more);
  return [...source.querySelectorAll(".lookup-source__tags > span")];
}

// The Pitch row's patterns as one note: their tooltips line by line, and what a screen reader says.
function pitchNote(card: HTMLElement) {
  const items = [...card.querySelectorAll<HTMLElement>(".lookup-entry__pitch li")];
  if (items.length === 0) return null;
  const note = document.createElement("span");
  note.title = items.map((item) => item.title).join("\n");
  note.textContent = `Pitch: ${items.map((item) => item.querySelector(".visually-hidden")!.textContent).join(". ")}`;
  return note;
}

// The first pitch pattern's drawn reading in the Pitch row.
function firstPitch(card: HTMLElement) {
  return card.querySelector(".lookup-entry__pitch li:first-child .lookup-entry__pitch-reading");
}

// The kana the first pitch pattern draws high.
function highKana(card: HTMLElement) {
  return [...(firstPitch(card)?.querySelectorAll(".pitch-kana--high") ?? [])].map(
    (kana) => kana.textContent,
  );
}

describe("Dictionary page", () => {
  it("manual English search is independent of the CJK-only Reader preference", async () => {
    render(
      <AppearanceProvider
        store={{ load: async () => ({ readerPopupCjkOnly: true }), save: async () => {} }}
      >
        <DictionaryPage />
      </AppearanceProvider>,
    );
    const input = await screen.findByRole("textbox", { name: "Dictionary search" });
    // A query is not prose: no spelling squiggles.
    expect(input).toHaveAttribute("spellcheck", "false");
    await userEvent.type(input, "English{Enter}");
    expect(lookupMock).toHaveBeenCalledWith("English");
  });

  it("Escape releases Dictionary search focus without clearing its query", async () => {
    render(<DictionaryPage />);
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    await userEvent.type(input, "読む");
    await userEvent.keyboard("{Escape}");
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue("読む");
  });

  it("keeps metadata sources and pitch layout when Reader popup names, pitch, and frequency are off", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Pitch source",
              data: { reading: result.reading, pitches: [{ position: 0 }] },
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(
      <AppearanceProvider
        store={{
          load: async () => ({
            readerPopupShowDictionaryNames: false,
            readerPopupShowPitch: false,
            readerPopupShowFrequency: false,
          }),
          save: async () => {},
        }}
      >
        <DictionaryPage />
      </AppearanceProvider>,
    );
    await user.type(await screen.findByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const frequencies = within(card).getByRole("list", { name: "Frequency" });
    expect(within(frequencies).getByText("Sample frequency")).not.toHaveClass("visually-hidden");
    expect(within(frequencies).getByText("7")).toBeInTheDocument();
    const pitch = pitchNote(card)!;
    const row = within(card).getByRole("list", { name: "Pitch" });
    // The Pitch row follows the frequencies, before the definitions.
    expect(frequencies.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      row.compareDocumentPosition(within(card).getByText("to read")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(row.querySelector(".lookup-entry__pitch-sources")).toHaveTextContent("Pitch source");
    expect(pitch).toHaveAttribute("title", "[0] Pitch source");
    expect(pitch).toHaveTextContent("Position 0; Pitch source");
    expect(highKana(card)).toEqual(["む"]);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Entries after the first few render once the page is idle; here at once, unless a test waits.
    vi.stubGlobal("requestIdleCallback", (run: () => void) => {
      run();
      return 0;
    });
    vi.stubGlobal("cancelIdleCallback", () => {});
    lookupMock.mockImplementation(exact([]));
    kanjiMock.mockResolvedValue({ entries: [], frequencies: [] });
    listMock.mockResolvedValue(dictionaries);
  });

  it("searches on submit and shows grouped terms, tags, frequencies, and safe glossary text", async () => {
    lookupMock.mockImplementation(exact([result]));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    expect(screen.getByText("Search your dictionaries")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), " 読む ");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(lookupMock).toHaveBeenCalledWith("読む");
    const card = await screen.findByRole("article", { name: "読む (よむ)" });
    // The lookup popup's entry: headword, reading, frequency, then each dictionary's
    // definitions under its name with its tags.
    expect(card.closest(".dictionary-sheet")).not.toBeNull();
    expect(card.querySelector(".lookup-entry__expression")).toHaveTextContent(/^読む$/);
    expect(card.querySelector(".lookup-entry__reading")).toHaveTextContent("よむ");
    expect(within(card).getByRole("region", { name: "Jitendex" })).toHaveTextContent(
      "Jitendexv5commonpopular",
    );
    expect(card).toHaveTextContent("7");
    expect(card).toHaveTextContent("to read");
    expect(card).toHaveTextContent("written words linked text");
    expect(card).not.toHaveTextContent("private");
    // The page is the Dictionary already, so entries offer no Open in dictionary.
    expect(within(card).queryByRole("button", { name: /in dictionary/ })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Collapse Jitendex definitions" }));
    expect(within(card).getByText("to read")).not.toBeVisible();
  });

  it("searches the query it opens with, as the Reader's lookup popup opens it", async () => {
    lookupMock.mockImplementation(exact([result]));
    render(<DictionaryPage initialQuery=" 読む " />);
    expect(screen.getByRole("textbox", { name: "Dictionary search" })).toHaveValue(" 読む ");
    const card = await screen.findByRole("article");
    expect(card).toHaveTextContent("to read");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith("読む");
  });

  it("explains each dictionary's tags with their first returned notes, once per name in source order", async () => {
    const definition = { category: "partOfSpeech", order: 0, score: 0 };
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            {
              ...result.terms[0],
              tags: [
                { name: "v5", ...definition, notes: "Godan verb" },
                { name: "common" },
                { name: "n" },
                { name: "blank", ...definition, notes: "  " },
                { name: "empty", ...definition, notes: "" },
              ],
            },
            {
              ...result.terms[0],
              dictionaryId: 3,
              dictionaryTitle: "見本国語辞典",
              tags: [
                { name: "n", ...definition, notes: "noun" },
                { name: "v5", ...definition, notes: "Another dictionary's note" },
                { name: "common", ...definition, notes: "common word" },
                { name: "n", ...definition, notes: "Repeated noun" },
                { name: "vt", ...definition, notes: " transitive verb " },
              ],
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const jitendex = within(card).getByRole("region", { name: "Jitendex" });
    const other = within(card).getByRole("region", { name: "見本国語辞典" });
    // Four tags show beside a dictionary's name, and the rest wait behind "+N more".
    expect(jitendex.querySelectorAll(".lookup-source__tags > span")).toHaveLength(4);
    expect(within(jitendex).getByRole("button", { name: "+1 more" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const describe = (tags: Element[]) =>
      tags.map((tag) => [tag.textContent, tag.getAttribute("title"), tag.getAttribute("class")]);
    const tags = await sourceTags(user, jitendex);
    expect(describe(tags)).toEqual([
      ["v5", "Godan verb", "lookup-source__tag--noted"],
      ["blank", null, null],
      ["empty", null, null],
      ["common", null, null],
      ["n", null, null],
    ]);
    // Each dictionary names its own tags, the first returned notes once per name.
    expect(describe(await sourceTags(user, other))).toEqual([
      ["n", "noun", "lookup-source__tag--noted"],
      ["v5", "Another dictionary's note", "lookup-source__tag--noted"],
      ["common", "common word", "lookup-source__tag--noted"],
      ["vt", "transitive verb", "lookup-source__tag--noted"],
    ]);
    expect(tags[0]).toHaveAccessibleDescription("Godan verb");
    expect(tags[1]).toHaveAccessibleDescription("");
    expect(tags[1]).not.toHaveAttribute("aria-description");
    expect(card).not.toHaveTextContent("Godan verb");
  });

  it("shows tag names without notes as before", async () => {
    lookupMock.mockImplementation(
      exact([
        { ...result, terms: [{ ...result.terms[0], tags: [{ name: "v5" }, { name: "popular" }] }] },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const tags = await sourceTags(user, within(card).getByRole("region", { name: "Jitendex" }));
    expect(tags.map((tag) => tag.textContent)).toEqual(["v5", "popular"]);
    for (const tag of tags) {
      expect(tag).not.toHaveAttribute("title");
      expect(tag).not.toHaveAttribute("class");
      expect(tag).toHaveAccessibleDescription("");
    }
  });

  it("leaves sense numbers out of a dictionary's tags, as definitions are numbered", async () => {
    const sense = (name: string) => ({
      name,
      category: "",
      order: -10,
      notes: `JMdict Sense #${name}`,
    });
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: ["1", "2", "10"].map((name) => ({
            ...result.terms[0],
            tags: [
              sense(name),
              { name: "v1", category: "partOfSpeech", order: -3, notes: "Ichidan verb" },
            ],
          })),
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "開ける");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const tags = await sourceTags(user, within(card).getByRole("region", { name: "Jitendex" }));
    expect(tags.map((tag) => tag.textContent)).toEqual(["v1"]);
  });

  it("puts a common word's star beside the headword instead of listing it as a tag", async () => {
    const definition = (category: string, notes = "") => ({ category, order: 0, notes, score: 0 });
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            {
              ...result.terms[0],
              tags: [
                { name: "v5", ...definition("partOfSpeech", "Godan verb") },
                { name: "⭐", ...definition("popular", "common word") },
                { name: "arch", ...definition("archaism", "archaic") },
              ],
            },
            {
              ...result.terms[0],
              dictionaryId: 3,
              dictionaryTitle: "見本国語辞典",
              tags: [{ name: "⭐", ...definition("popular") }],
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const stars = card.querySelector(".lookup-entry__word .lookup-entry__stars")!;
    expect(stars).toHaveTextContent(/^⭐$/);
    expect(within(card).getByText("⭐")).toHaveAttribute("title", "common word");
    expect(within(card).getByRole("list", { name: "Frequency" })).not.toHaveTextContent("⭐");
    const tags = await sourceTags(user, within(card).getByRole("region", { name: "Jitendex" }));
    expect(tags.map((tag) => tag.textContent)).toEqual(["v5", "arch"]);
    // Tags are plain italic text; their categories no longer color them.
    for (const tag of tags) expect(tag).not.toHaveAttribute("data-category");
    expect(
      within(card)
        .getByRole("region", { name: "見本国語辞典" })
        .querySelector(".lookup-source__tags"),
    ).toBeNull();
  });

  it("orders a dictionary's tags by their definition's order, keeping source order for ties", async () => {
    const definition = (order: number, notes = "", category = "partOfSpeech") => ({
      category,
      order,
      notes,
      score: 0,
    });
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            {
              ...result.terms[0],
              tags: [
                { name: "bare" },
                { name: "news", ...definition(4, "news corpus", "frequent") },
                { name: "vt", ...definition(0, "transitive verb") },
                { name: "late" },
                { name: "v5", ...definition(0, "Godan verb") },
                { name: "⭐", ...definition(-10, "", "popular") },
                { name: "uk", ...definition(0.5) },
                { name: "arch", ...definition(-2.5, "archaic", "archaism") },
              ],
            },
            {
              ...result.terms[0],
              sequence: 2,
              tags: [
                { name: "late", ...definition(-100, "defined later") },
                { name: "news", ...definition(-100, "A later definition's order") },
                { name: "n", ...definition(0, "noun") },
                { name: "unknown" },
                { name: "bare" },
              ],
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const tags = await sourceTags(user, within(card).getByRole("region", { name: "Jitendex" }));
    expect(tags.map((tag) => [tag.textContent, tag.getAttribute("title")])).toEqual([
      // A name-only tag takes a later definition's notes, and with them its order.
      ["late", "defined later"],
      ["arch", "archaic"],
      ["vt", "transitive verb"],
      ["v5", "Godan verb"],
      ["n", "noun"],
      ["uk", null],
      // The first returned definition's order wins over a later one's.
      ["news", "news corpus"],
      ["bare", null],
      ["unknown", null],
    ]);
    expect(tags[3]).toHaveAccessibleDescription("Godan verb");
  });

  it("keeps name-only tags in source order after every defined tag", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            {
              ...result.terms[0],
              tags: [
                { name: "common" },
                { name: "v5", category: "partOfSpeech", order: 100, notes: "", score: 0 },
                { name: "popular" },
                { name: "ichi" },
              ],
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const tags = await sourceTags(user, within(card).getByRole("region", { name: "Jitendex" }));
    expect(tags.map((tag) => tag.textContent)).toEqual(["v5", "common", "popular", "ichi"]);
  });

  it("names every source on its own numbered definition in returned order", async () => {
    const names = [
      "Jitendex",
      "見本国語辞典 第二版",
      "A very long imported dictionary title that must remain inspectable",
      "JMdict",
      "Jitendex",
      "Open Wordlist",
    ];
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: names.map((name, index) => ({
            ...result.terms[0],
            dictionaryId: index + 1,
            dictionaryTitle: name,
            sequence: index + 1,
          })),
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    expect(card.querySelector(".lookup-entry__expression")).toHaveTextContent(/^読む$/);
    expect(
      within(card).getByRole("button", { name: "Play pronunciation for 読む" }),
    ).toBeInTheDocument();
    expect(
      [...card.querySelectorAll(".lookup-source__name")].map((source) => source.textContent),
    ).toEqual(names);
    const third = within(card).getByRole("button", {
      name: `Collapse ${names[2]} definitions`,
    });
    third.focus();
    await user.keyboard("{Enter}");
    expect(third).toHaveAttribute("aria-expanded", "false");
    expect(within(card).getByRole("button", { name: `Collapse ${names[3]} definitions` }));
  });

  it("labels each frequency value with its source in returned order", async () => {
    const frequencies = [
      {
        title: "Samplev2㋕",
        data: { frequency: { displayValue: "312", value: 312 } },
        value: "312",
      },
      {
        title: "Samplev2㋕",
        data: { frequency: { displayValue: "19896㋕", value: 19896 } },
        value: "19896㋕",
      },
      { title: "BCCWJ", data: { frequency: 292, reading: "よむ" }, value: "292" },
      { title: "Novels", data: 423, value: "423" },
      { title: "Youtube", data: "417", value: "417" },
      { title: "A very long imported frequency title", data: { value: 9 }, value: "9" },
      { title: "Unreadable", data: null, value: "—" },
      { title: "Anime", data: 1200, value: "1200" },
    ];
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          frequencies: frequencies.map(({ title, data }, index) => ({
            dictionaryId: index < 2 ? 2 : index + 2,
            dictionaryTitle: title,
            data,
          })),
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const list = within(card).getByRole("list", { name: "Frequency" });
    const rows = () =>
      [...list.querySelectorAll("li")].map((row) => [
        row.querySelector("span")!.textContent,
        ...[...row.querySelectorAll("strong")].map((value) => value.textContent),
      ]);
    // A dictionary's values share its box. Every box shows, in returned order.
    const boxes = [
      ["Samplev2㋕", "312", "19896㋕"],
      ...frequencies.slice(2).map(({ title, value }) => [title, value]),
    ];
    expect(rows()).toEqual(boxes);
    expect(within(list).queryByRole("button")).toBeNull();
    expect(list.querySelectorAll("li")[4]).toHaveAttribute(
      "title",
      "A very long imported frequency title",
    );
    expect(
      within(card).getByRole("button", { name: "Play pronunciation for 読む" }),
    ).toBeInTheDocument();
  });

  it("keeps a short frequency list without a More control", async () => {
    lookupMock.mockImplementation(exact([result]));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const list = within(await screen.findByRole("article")).getByRole("list", {
      name: "Frequency",
    });
    expect(list).toHaveTextContent("Sample frequency7");
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  it("searches a glossary term as an exact standalone query and resets result state", async () => {
    const linkedResult: GroupFixture = {
      ...result,
      terms: [
        {
          ...result.terms[0],
          dictionaryId: 3,
          dictionaryTitle: "見本国語辞典",
          glossary: [
            {
              type: "structured-content",
              content: {
                tag: "p",
                content: ["See ", { tag: "a", href: "file:///private/entry", content: " 言葉 " }],
              },
            },
          ],
        },
      ],
    };
    const targetResult: GroupFixture = {
      ...result,
      expression: "言葉",
      reading: "ことば",
      terms: [{ ...result.terms[0], glossary: ["word"] }],
    };
    lookupMock
      .mockImplementationOnce(exact([linkedResult]))
      .mockImplementationOnce(exact([targetResult]));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    await user.type(input, result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const rail = screen.getByRole("complementary", { name: "Dictionary sources" });
    await user.click(await within(rail).findByRole("button", { name: /見本国語辞典/ }));
    expect(within(rail).getByRole("button", { name: /見本国語辞典/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const link = screen.getByRole("button", { name: "言葉" });
    link.focus();
    await user.keyboard("{Enter}");
    expect(lookupMock).toHaveBeenLastCalledWith("言葉");
    expect(input).toHaveValue("言葉");
    expect(await screen.findByText("word")).toBeInTheDocument();
    expect(screen.getByText("Results for").parentElement).toHaveTextContent("言葉");
    expect(screen.getByRole("button", { name: /All sources/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("article", { name: "言葉 (ことば)" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("file:///private/entry");
  });

  it("links each headword's kanji to their own searches", async () => {
    const mixed: GroupFixture = {
      ...result,
      expression: "読み込む𠀋々",
      reading: "よみこむ",
      terms: [{ ...result.terms[0], dictionaryId: 3, dictionaryTitle: "見本国語辞典" }],
    };
    const second: GroupFixture = { ...mixed, expression: "本読み", reading: "ほんよみ" };
    const readKanji: KanjiLookup = {
      entries: [
        {
          dictionaryId: 4,
          dictionaryTitle: "KANJIDIC",
          character: "読",
          onyomi: "ドク",
          kunyomi: "よ.む",
          tags: "",
          meanings: ["read"],
          stats: {},
          resolvedTags: [],
          statTags: [],
        },
      ],
      frequencies: [],
    };
    lookupMock
      .mockImplementationOnce(exact([mixed, second]))
      .mockImplementationOnce(exact([result]));
    kanjiMock.mockResolvedValueOnce(readKanji);
    const user = userEvent.setup();
    render(<DictionaryPage />);
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    await user.type(input, "読み込む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await screen.findAllByRole("article");
    expect(kanjiMock).not.toHaveBeenCalled();

    // Only kanji become buttons, in order; kana and 々 stay text, and the headword reads as before.
    const [first, other] = screen.getAllByRole("article");
    const headword = first.querySelector(".lookup-entry__expression")!;
    expect(headword).toHaveTextContent(/^読み込む𠀋々$/);
    expect(
      within(first)
        .getAllByRole("button", { name: /^Search kanji/ })
        .map((button) => button.textContent),
    ).toEqual(["読", "込", "𠀋"]);
    expect(headword.querySelectorAll("button")).toHaveLength(3);
    // Every entry's headword links its kanji, as in the lookup popup.
    expect(
      within(other)
        .getAllByRole("button", { name: /^Search kanji/ })
        .map((button) => button.textContent),
    ).toEqual(["本", "読"]);

    const read = within(first).getByRole("button", { name: "Search kanji 読" });
    expect(read).toHaveAttribute("title", "Search kanji 読");
    read.focus();
    await user.keyboard("{Enter}");
    expect(lookupMock).toHaveBeenLastCalledWith("読");
    expect(kanjiMock).toHaveBeenCalledWith("読");
    expect(input).toHaveValue("読");
    const kanjiCard = await screen.findByRole("article", { name: "Kanji 読" });
    expect(kanjiCard).toHaveTextContent("read");
    expect(screen.getByText("Results for").parentElement).toHaveTextContent("読");
    expect(screen.getByRole("button", { name: /All sources/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("article", { name: "読む (よむ)" })).toBeInTheDocument();
  });

  it("shows pitch patterns with their sources in returned order", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Pitch source A",
              data: { reading: result.reading, pitches: [{ position: 0 }, { position: 2 }] },
            },
            {
              dictionaryId: 5,
              dictionaryTitle: "Pitch source B",
              data: { reading: result.reading, pitches: [{ position: 1 }, { position: -1 }, {}] },
            },
            {
              dictionaryId: 6,
              dictionaryTitle: "Wrong reading",
              data: { reading: "other", pitches: [{ position: 3 }] },
            },
            { dictionaryId: 7, dictionaryTitle: "Unsupported", data: { pitches: "4" } },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const pitch = pitchNote(card)!;
    // The first pattern is drawn on the reading: よむ flat, high from its second mora.
    expect(highKana(card)).toEqual(["む"]);
    expect(firstPitch(card)!.querySelector(".pitch-kana--drop")).toBeNull();
    expect(pitch).toHaveAttribute(
      "title",
      "[0] Pitch source A\n[2] Pitch source A\n[1] Pitch source B",
    );
    // Each pattern is drawn on the reading with its position, in returned order.
    const row = within(card).getByRole("list", { name: "Pitch" });
    expect(
      [...row.querySelectorAll("li")].map((item) => [
        [...item.querySelectorAll(".pitch-kana--high")].map((kana) => kana.textContent).join(""),
        item.querySelector(".lookup-entry__pitch-position")!.textContent,
      ]),
    ).toEqual([
      ["む", "[0]"],
      ["む", "[2]"],
      ["よ", "[1]"],
    ]);
    expect(row.querySelector("li:nth-child(2) .pitch-kana--drop")).toHaveTextContent("む");
    expect(pitch).not.toHaveTextContent("Wrong reading");
    expect(pitch).not.toHaveTextContent("Unsupported");
  });

  it("shows each distinct pitch pattern once with every source that returned it", async () => {
    const sources = [
      "NHK",
      "見本国語辞典",
      "Kanjium",
      "Long pitch accent source title for comparison",
      "NHK",
    ];
    const positions = [[0], [1, 1], [0, 4], [2], [0]];
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          pitches: sources.map((dictionaryTitle, index) => ({
            dictionaryId: 10 + index,
            dictionaryTitle,
            data: {
              reading: result.reading,
              pitches: positions[index].map((position) => ({ position })),
            },
          })),
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    const pitch = pitchNote(card)!;
    expect(pitch).toHaveAttribute(
      "title",
      [
        "[0] NHK, Kanjium, NHK",
        "[1] 見本国語辞典",
        "[4] Kanjium",
        "[2] Long pitch accent source title for comparison",
      ].join("\n"),
    );
    expect(pitch).toHaveTextContent(
      "Pitch: Position 0; NHK, Kanjium, NHK. Position 1; 見本国語辞典. Position 4; Kanjium. Position 2; Long pitch accent source title for comparison",
    );
    expect(highKana(card)).toEqual(["む"]);
  });

  it("counts joined kana as one mora and keeps text when a contour is unsafe", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          reading: "きょう",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Pitch source",
              data: { reading: "きょう", pitches: [{ position: 2 }, { position: 3 }] },
            },
          ],
        },
        {
          ...result,
          expression: "今日",
          reading: "今日",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 5,
              dictionaryTitle: "Unsafe reading",
              data: { reading: "今日", pitches: [{ position: 1 }] },
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const cards = await screen.findAllByRole("article");
    // きょう has two morae: position 2 is high on う and falls after it.
    expect(highKana(cards[0])).toEqual(["う"]);
    expect(firstPitch(cards[0])!.querySelector(".pitch-kana--drop")).toHaveTextContent("う");
    expect(pitchNote(cards[0])).toHaveAttribute("title", "[2] Pitch source\n[3] Pitch source");

    // A reading that is not kana keeps its text without marks.
    expect(cards[1].querySelector("[class^='pitch-kana']")).toBeNull();
    expect(cards[1].querySelector(".lookup-entry__expression")).toHaveTextContent(/^今日$/);
    expect(pitchNote(cards[1])).toHaveAttribute("title", "[1] Unsafe reading");
  });

  it("marks nasal and devoiced morae and keeps differently marked positions distinct", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          reading: "きがく",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Marked A",
              data: {
                reading: "きがく",
                transcriptions: [],
                pitches: [{ position: 1, devoice: [1, 1, 0, 4, 1.5, "2"], nasal: 2 }],
              },
            },
            {
              dictionaryId: 5,
              dictionaryTitle: "Unmarked",
              data: { reading: "きがく", pitches: [{ position: 1, nasal: "2", devoice: {} }] },
            },
            {
              dictionaryId: 6,
              dictionaryTitle: "Marked B",
              data: { reading: "きがく", pitches: [{ position: 1, nasal: [2], devoice: 1 }] },
            },
            {
              dictionaryId: 7,
              dictionaryTitle: "Nasal only",
              data: { reading: "きがく", pitches: [{ position: 1, nasal: [2, 9] }] },
            },
          ],
        },
        {
          ...result,
          expression: "今日",
          reading: "今日",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 8,
              dictionaryTitle: "Unsafe reading",
              data: { reading: "今日", pitches: [{ position: 1, nasal: 1, devoice: 2 }] },
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const cards = await screen.findAllByRole("article");
    expect(pitchNote(cards[0])).toHaveTextContent(
      "Pitch: Position 1; Nasal が (mora 2); Devoiced き (mora 1); Marked A, Marked B. Position 1; Unmarked. Position 1; Nasal が (mora 2); Nasal only",
    );
    expect(pitchNote(cards[0])).toHaveAttribute(
      "title",
      "[1] Marked A, Marked B\n[1] Unmarked\n[1] Nasal only",
    );
    // きがく falls after its first mora; き is devoiced and が nasal.
    const reading = [...firstPitch(cards[0])!.querySelectorAll(":scope > span")];
    expect(reading.map((kana) => [kana.textContent, kana.getAttribute("class")])).toEqual([
      ["き", "pitch-kana--high pitch-kana--drop pitch-kana--devoiced"],
      ["が", "pitch-kana--nasal"],
      ["く", null],
    ]);

    // Without kana to mark, a pattern keeps its position and source only.
    expect(pitchNote(cards[1])).toHaveTextContent("Pitch: Position 1; Unsafe reading");
    expect(cards[1].querySelector("[class^='pitch-kana']")).toBeNull();
  });

  it("shows pitch entry tags and keeps positions that differ only in tags distinct", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          reading: "きがく",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 4,
              dictionaryTitle: "Tagged A",
              data: {
                reading: "きがく",
                transcriptions: [],
                pitches: [
                  { position: 1, tags: [" n ", "vs", "n", "", "  ", 3, null, {}] },
                  { position: 2, tags: "n" },
                ],
              },
            },
            {
              dictionaryId: 5,
              dictionaryTitle: "Tagged B",
              data: { reading: "きがく", pitches: [{ position: 1, tags: ["vs", "n"], nasal: 2 }] },
            },
            {
              dictionaryId: 6,
              dictionaryTitle: "Tagged C",
              data: { reading: "きがく", pitches: [{ position: 1, tags: ["vs", "n"] }] },
            },
            {
              dictionaryId: 7,
              dictionaryTitle: "Untagged",
              data: { reading: "きがく", pitches: [{ position: 1, tags: [] }, { position: 2 }] },
            },
          ],
        },
        {
          ...result,
          expression: "今日",
          reading: "今日",
          transcriptions: [],
          pitches: [
            {
              dictionaryId: 8,
              dictionaryTitle: "Unsafe reading",
              data: { reading: "今日", pitches: [{ position: 1, tags: ["adv"] }] },
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const cards = await screen.findAllByRole("article");
    expect(pitchNote(cards[0])).toHaveAttribute(
      "title",
      [
        "[1] n, vs Tagged A, Tagged C",
        "[2] Tagged A, Untagged",
        "[1] vs, n Tagged B",
        "[1] Untagged",
      ].join("\n"),
    );
    expect(pitchNote(cards[0])).toHaveTextContent("Position 1; n, vs; Tagged A, Tagged C.");
    expect(pitchNote(cards[1])).toHaveAttribute("title", "[1] adv Unsafe reading");
  });

  it("omits pitch labels when no supported positions are returned", async () => {
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          transcriptions: [],
          pitches: [
            { dictionaryId: 4, dictionaryTitle: "Unsupported", data: null },
            {
              dictionaryId: 5,
              dictionaryTitle: "Invalid position",
              data: { reading: result.reading, pitches: [{ position: "1" }] },
            },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), result.expression);
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const card = await screen.findByRole("article");
    expect(pitchNote(card)).toBeNull();
    expect(card.querySelector("[class^='pitch-kana']")).toBeNull();
  });

  it("shows no-match and failure states without exposing native error details", async () => {
    const user = userEvent.setup();
    lookupMock
      .mockImplementationOnce(exact([]))
      .mockRejectedValueOnce("C:\\private\\dictionaries.sqlite3");
    render(<DictionaryPage />);
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    await user.type(input, "ない");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search could not be completed. Try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("private");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Search your dictionaries")).toBeInTheDocument();
  });

  describe("longest matching start", () => {
    const reading: GroupFixture = {
      ...result,
      expression: "読書",
      reading: "どくしょ",
      terms: [{ ...result.terms[0], glossary: ["reading books"] }],
    };

    it("says which start of a longer query matched and keeps the query in the field", async () => {
      lookupMock.mockResolvedValue(matched("読書", [reading]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, " 読書する ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(lookupMock).toHaveBeenCalledWith("読書する");
      expect(kanjiMock).not.toHaveBeenCalled();

      const card = await screen.findByRole("article");
      expect(card).toHaveTextContent("reading books");
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent("Showing results for 読書 No exact match for 読書する");
      expect(within(header).getByText("読書", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText("Results for")).not.toBeInTheDocument();
      expect(screen.getByText("1 entry")).toBeInTheDocument();
      expect(input).toHaveValue(" 読書する ");
    });

    it("keeps exact results unchanged", async () => {
      lookupMock.mockImplementation(exact([result]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      expect(screen.getByText("Results for").parentElement).toHaveTextContent("Results for 読む");
      expect(screen.queryByText("Showing results for")).not.toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
    });

    it("shows the no-match state when no start matches", async () => {
      lookupMock.mockResolvedValue(matched("xyz", []));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "xyz");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("No matches")).toBeInTheDocument();
      expect(screen.getByText("Results for").parentElement).toHaveTextContent("Results for xyz");
      expect(screen.queryByText("Showing results for")).not.toBeInTheDocument();
    });

    it("shows no Kanji card for a longer query whose one-kanji start matched", async () => {
      const bookWord: GroupFixture = {
        ...result,
        expression: "本",
        reading: "ほん",
        terms: [{ ...result.terms[0], glossary: ["book"] }],
      };
      lookupMock.mockResolvedValue(matched("本", [bookWord]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本だ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("book")).toBeInTheDocument();
      expect(kanjiMock).not.toHaveBeenCalled();
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.queryByRole("article", { name: /^Kanji/ })).not.toBeInTheDocument();
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        "Showing results for 本 No exact match for 本だ",
      );
    });

    it("names the dictionary form and inflections of a deinflected match", async () => {
      lookupMock.mockResolvedValue(
        matched("読みました", [
          { ...result, deinflection: { form: "読む", inflections: ["polite", "past"] } },
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読みました");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(/^Showing results for 読みました → 読む \(polite, past\)$/);
      expect(within(header).getByText("読みました", { selector: "strong" })).toBeInTheDocument();
      expect(within(header).getByText("読む", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
      expect(screen.queryByText("Results for")).not.toBeInTheDocument();
      expect(screen.getByText("1 entry")).toBeInTheDocument();
      expect(input).toHaveValue("読みました");
      // The card names the inflections beside its headword too.
      const card = screen.getByRole("article");
      const label = within(card).getByTitle("Inflected: polite, past");
      expect(label).toHaveTextContent(/^Inflected: polite · past$/);
      expect(label).toHaveClass("lookup-entry__note");
    });

    it("looks up in English with English inflection names and no reading, furigana or pitch", async () => {
      const lookUp: GroupFixture = {
        ...result,
        expression: "look up",
        reading: "look up",
        deinflection: { form: "look up", inflections: ["past", "interposed object"] },
        terms: [{ ...result.terms[0], rules: "v_phr", glossary: ["to search for"] }],
        transcriptions: [],
        pitches: [
          {
            dictionaryId: 4,
            dictionaryTitle: "Pitch source A",
            data: { reading: "look up", pitches: [{ position: 0 }] },
          },
        ],
      };
      lookupMock.mockImplementation(async (query) =>
        query === "I" ? matched("I", []) : matched("looked it up", [lookUp]),
      );
      const user = userEvent.setup();
      renderComponent(
        <MemoryRouter>
          <AppearanceProvider
            store={{
              load: async () => ({ lookupLanguage: "en", readerPopupReadingPosition: "above" }),
              save: async () => {},
            }}
          >
            <DictionaryPage />
          </AppearanceProvider>
        </MemoryRouter>,
      );
      const input = await screen.findByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "I");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("No matches")).toBeInTheDocument();
      expect(
        screen.getByText("Check the spelling, or add another dictionary in Settings."),
      ).toBeInTheDocument();
      expect(screen.getByText("Search your imported dictionaries.")).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/kanji/i);
      expect(lookupMock).toHaveBeenLastCalledWith("I", undefined, undefined, "en");
      // A one-letter query is not a kanji outside Japanese.
      expect(kanjiMock).not.toHaveBeenCalled();
      await user.clear(input);
      await user.type(input, "looked it up");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const header = (await screen.findByText("Showing results for")).parentElement!;
      expect(header).toHaveTextContent(
        /^Showing results for looked it up → look up \(past, interposed object\)$/,
      );
      const card = await screen.findByRole("article", { name: "look up" });
      expect(within(card).getByTitle("Inflected: past, interposed object")).toBeInTheDocument();
      expect(card.querySelector("ruby, rt, .lookup-entry__reading")).toBeNull();
      expect(card.querySelector(".lookup-entry__expression")).toHaveAttribute("lang", "en");
      expect(pitchNote(card)).toBeNull();
    });

    it("names a deinflected start of a longer query and the query", async () => {
      lookupMock.mockResolvedValue(
        matched("読んで", [{ ...result, deinflection: { form: "読む", inflections: ["-te"] } }]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読んでみる");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        "Showing results for 読んで → 読む (-te) No exact match for 読んでみる",
      );
      expect(input).toHaveValue("読んでみる");
    });

    it("names a progressive form's inflections in the header and card label", async () => {
      lookupMock.mockResolvedValue(
        matched("読んでいる", [
          { ...result, deinflection: { form: "読む", inflections: ["-te", "progressive"] } },
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読んでいる");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(
        /^Showing results for 読んでいる → 読む \(-te, progressive\)$/,
      );
      expect(within(header).getByText("読む", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
      const label = screen.getByRole("article").querySelector(".lookup-entry__note")!;
      expect(label).toHaveTextContent(/^Inflected: -te · progressive$/);
      expect(label).toHaveAttribute("title", "Inflected: -te, progressive");
      // A chained progressive of a longer query names every step and keeps the query line.
      lookupMock.mockResolvedValue(
        matched("読んでいました", [
          {
            ...result,
            deinflection: { form: "読む", inflections: ["-te", "progressive", "polite", "past"] },
          },
        ]),
      );
      await user.clear(input);
      await user.type(input, "読んでいましたよ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(
        await screen.findByTitle("Inflected: -te, progressive, polite, past"),
      ).toHaveTextContent(/^Inflected: -te · progressive · polite · past$/);
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        "Showing results for 読んでいました → 読む (-te, progressive, polite, past) No exact match for 読んでいましたよ",
      );
    });

    it("names a completive form's inflections in the header and card label", async () => {
      lookupMock.mockResolvedValue(
        matched("読んでしまった", [
          {
            ...result,
            deinflection: { form: "読む", inflections: ["-te", "completive", "past"] },
          },
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読んでしまった");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(
        /^Showing results for 読んでしまった → 読む \(-te, completive, past\)$/,
      );
      expect(within(header).getByText("読む", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
      const label = screen.getByRole("article").querySelector(".lookup-entry__note")!;
      expect(label).toHaveTextContent(/^Inflected: -te · completive · past$/);
      expect(label).toHaveAttribute("title", "Inflected: -te, completive, past");
      // A contracted completive of a longer query names its steps and keeps the query line.
      lookupMock.mockResolvedValue(
        matched("食べちゃった", [
          {
            ...result,
            expression: "食べる",
            reading: "たべる",
            deinflection: { form: "食べる", inflections: ["completive", "past"] },
            terms: [{ ...result.terms[0], glossary: ["to eat"] }],
          },
        ]),
      );
      await user.clear(input);
      await user.type(input, "食べちゃったよ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to eat")).toBeInTheDocument();
      expect(screen.getByRole("article").querySelector(".lookup-entry__note")).toHaveTextContent(
        /^Inflected: completive · past$/,
      );
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        "Showing results for 食べちゃった → 食べる (completive, past) No exact match for 食べちゃったよ",
      );
    });

    it("names a preparatory form's inflections in the header and card label", async () => {
      lookupMock.mockResolvedValue(
        matched("読んでおく", [
          {
            ...result,
            deinflection: { form: "読む", inflections: ["-te", "preparatory"] },
          },
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読んでおく");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(
        /^Showing results for 読んでおく → 読む \(-te, preparatory\)$/,
      );
      expect(within(header).getByText("読む", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
      const label = screen.getByRole("article").querySelector(".lookup-entry__note")!;
      expect(label).toHaveTextContent(/^Inflected: -te · preparatory$/);
      expect(label).toHaveAttribute("title", "Inflected: -te, preparatory");
      // A contracted, chained one of a longer query names its steps and keeps the query line.
      lookupMock.mockResolvedValue(
        matched("書いといた", [
          {
            ...result,
            expression: "書く",
            reading: "かく",
            deinflection: { form: "書く", inflections: ["-te", "preparatory", "past"] },
            terms: [{ ...result.terms[0], glossary: ["to write"] }],
          },
        ]),
      );
      await user.clear(input);
      await user.type(input, "書いといたよ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to write")).toBeInTheDocument();
      expect(screen.getByRole("article").querySelector(".lookup-entry__note")).toHaveTextContent(
        /^Inflected: -te · preparatory · past$/,
      );
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        "Showing results for 書いといた → 書く (-te, preparatory, past) No exact match for 書いといたよ",
      );
    });

    const say: GroupFixture = {
      ...result,
      expression: "言う",
      reading: "いう",
      deinflection: { form: "いう", inflections: ["past"] },
      terms: [{ ...result.terms[0], glossary: ["to say"] }],
    };
    const go: GroupFixture = {
      ...result,
      expression: "行く",
      reading: "いく",
      deinflection: { form: "いく", inflections: ["past"] },
      terms: [{ ...result.terms[0], glossary: ["to go"] }],
    };

    it("lists every dictionary form a query matched, each card naming its inflections", async () => {
      lookupMock.mockResolvedValue(matched("いった", [go, say]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "いった");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to go")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(/^Showing results for いった$/);
      expect(header).not.toHaveTextContent("→");
      expect(screen.getByText("2 entries")).toBeInTheDocument();
      const cards = screen.getAllByRole("article");
      expect(
        cards.map((card) => card.querySelector(".lookup-entry__expression")!.textContent),
      ).toEqual(["行く", "言う"]);
      for (const card of cards) {
        expect(within(card).getByTitle("Inflected: past")).toHaveTextContent(/^Inflected: past$/);
      }
    });

    it("keeps exact cards unlabelled beside deinflected ones", async () => {
      const below: GroupFixture = {
        ...result,
        expression: "下",
        reading: "した",
        terms: [{ ...result.terms[0], glossary: ["below"] }],
      };
      const doVerb: GroupFixture = {
        ...result,
        expression: "する",
        reading: "する",
        deinflection: { form: "する", inflections: ["past"] },
        terms: [{ ...result.terms[0], glossary: ["to do"] }],
      };
      lookupMock.mockResolvedValue(matched("した", [below, doVerb]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "した");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("below")).toBeInTheDocument();
      expect(screen.getByText("Results for").parentElement).toHaveTextContent(/^Results for した$/);
      expect(screen.queryByText("Showing results for")).not.toBeInTheDocument();
      const [exactCard, deinflectedCard] = screen.getAllByRole("article");
      expect(exactCard.querySelector(".lookup-entry__note")).toBeNull();
      expect(exactCard).not.toHaveTextContent("Inflected");
      expect(deinflectedCard.querySelector(".lookup-entry__note")).toHaveTextContent(
        /^Inflected: past$/,
      );
    });

    it("names one form in the header only when every result shares it", async () => {
      const recite: GroupFixture = {
        ...result,
        expression: "詠む",
        deinflection: { form: "よむ", inflections: ["past"] },
        terms: [{ ...result.terms[0], glossary: ["to recite"] }],
      };
      lookupMock.mockResolvedValue(
        matched("よんだ", [
          { ...result, deinflection: { form: "よむ", inflections: ["past"] } },
          recite,
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "よんだ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        /^Showing results for よんだ → よむ \(past\)$/,
      );
      // Two forms, even with the same inflections, leave the header to the matched text.
      lookupMock.mockResolvedValue(matched("いった", [go, say]));
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.clear(input);
      await user.type(input, "いった");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to go")).toBeInTheDocument();
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        /^Showing results for いった$/,
      );
    });

    it("names a する-noun reached through its する verb as the form", async () => {
      const study: GroupFixture = {
        ...result,
        expression: "勉強",
        reading: "べんきょう",
        deinflection: { form: "勉強", inflections: ["-te"] },
        terms: [{ ...result.terms[0], rules: "vs", glossary: ["study"] }],
      };
      lookupMock.mockResolvedValue(matched("勉強して", [study]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "勉強して");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("study")).toBeInTheDocument();
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(/^Showing results for 勉強して → 勉強 \(-te\)$/);
      expect(within(header).getByText("勉強", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText(/No exact match for/)).not.toBeInTheDocument();
      const card = screen.getByRole("article");
      expect(card.querySelector(".lookup-entry__expression")).toHaveTextContent(/^勉強$/);
      const label = card.querySelector(".lookup-entry__note")!;
      expect(label).toHaveTextContent(/^Inflected: -te$/);
      expect(label).toHaveAttribute("title", "Inflected: -te");
      // A stored する verb and the bare noun are two forms: each card keeps its label, and the
      // header names the matched text alone.
      const research: GroupFixture = {
        ...study,
        expression: "研究",
        reading: "けんきゅう",
        deinflection: { form: "研究", inflections: ["-te"] },
        terms: [{ ...study.terms[0], glossary: ["research"] }],
      };
      const researchVerb: GroupFixture = {
        ...research,
        expression: "研究する",
        reading: "けんきゅうする",
        deinflection: { form: "研究する", inflections: ["-te"] },
        terms: [{ ...study.terms[0], glossary: ["to research"] }],
      };
      lookupMock.mockResolvedValue(matched("研究して", [researchVerb, research]));
      await user.clear(input);
      await user.type(input, "研究して");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to research")).toBeInTheDocument();
      expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
        /^Showing results for 研究して$/,
      );
      const cards = screen.getAllByRole("article");
      expect(
        cards.map((card) => card.querySelector(".lookup-entry__expression")!.textContent),
      ).toEqual(["研究する", "研究"]);
      for (const card of cards) {
        expect(card.querySelector(".lookup-entry__note")).toHaveTextContent(/^Inflected: -te$/);
      }
    });

    it("names a six-step chain in the header and on the card", async () => {
      const chain = ["short causative", "passive", "-te", "progressive", "polite", "past"];
      lookupMock.mockResolvedValue(
        matched("読まされていました", [
          { ...result, deinflection: { form: "読む", inflections: chain } },
        ]),
      );
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読まされていましたよ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      // The header names the whole chain and wraps within itself.
      const header = screen.getByText("Showing results for").parentElement!;
      expect(header).toHaveTextContent(
        "Showing results for 読まされていました → 読む (short causative, passive, -te, progressive, polite, past) No exact match for 読まされていましたよ",
      );
      const css = dictionaryCss.replace(/\r\n/g, "\n");
      expect(css).toMatch(
        /\.dictionary-results__header div \{[^}]*min-width: 0;[^}]*flex-wrap: wrap;[^}]*overflow-wrap: anywhere;/,
      );
      // The card's label names every step; its tooltip keeps them comma-separated.
      const card = screen.getByRole("article");
      const label = card.querySelector(".lookup-entry__note")!;
      expect(label).toHaveTextContent(`Inflected: ${chain.join(" · ")}`);
      expect(label).toHaveAttribute("title", `Inflected: ${chain.join(", ")}`);
    });

    describe("shorter starts", () => {
      const readShort: GroupFixture = {
        ...result,
        expression: "読",
        reading: "よみ",
        terms: [
          {
            ...result.terms[0],
            dictionaryId: 3,
            dictionaryTitle: "見本国語辞典",
            glossary: ["a reading"],
          },
        ],
      };
      const readOn: GroupFixture = {
        ...readShort,
        reading: "とく",
        terms: [{ ...result.terms[0], glossary: ["reading (on)"] }],
      };

      it("lists each shorter start's cards after the longest start's, naming their start", async () => {
        lookupMock.mockResolvedValue(matched("読書", [reading], ["読", [readShort, readOn]]));
        const user = userEvent.setup();
        render(<DictionaryPage />);
        await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読書する");
        await user.click(screen.getByRole("button", { name: /^Search$/ }));
        expect(await screen.findByText("reading books")).toBeInTheDocument();
        // The header still names the longest start alone.
        expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
          /^Showing results for 読書 No exact match for 読書する$/,
        );
        expect(screen.getByText("3 entries")).toBeInTheDocument();
        const cards = screen.getAllByRole("article");
        expect(
          cards.map((card) => card.querySelector(".lookup-entry__expression")!.textContent),
        ).toEqual(["読書", "読", "読"]);
        // The longest start's card has no start label.
        expect(cards[0].querySelector(".lookup-entry__note")).toBeNull();
        // Each shorter start's card names its start under its headword, as the inflection
        // label does.
        for (const card of cards.slice(1)) {
          const label = card.querySelector(".lookup-entry__note")!;
          expect(label).toHaveTextContent(/^Matched: ← 読$/);
          expect(label).toHaveAttribute("title", "Matched: 読");
          expect(label).toHaveAttribute("lang", "ja");
          expect(label).toHaveClass("lookup-entry__note");
        }
        expect(within(cards[1]).getByText("a reading")).toBeInTheDocument();
      });

      it("describes only the longest start in the header", async () => {
        const polite = { form: "読む", inflections: ["polite"] };
        const recite: GroupFixture = {
          ...result,
          expression: "詠む",
          deinflection: { form: "詠む", inflections: ["-te"] },
          terms: [{ ...result.terms[0], glossary: ["to recite"] }],
        };
        lookupMock.mockResolvedValue(
          matched(
            "読みます",
            [{ ...result, deinflection: polite }],
            ["読んで", [recite]],
            ["読", [readShort]],
          ),
        );
        const user = userEvent.setup();
        render(<DictionaryPage />);
        await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読みます");
        await user.click(screen.getByRole("button", { name: /^Search$/ }));
        expect(await screen.findByText("to read")).toBeInTheDocument();
        // An exact shorter start and another form leave the longest start's one form named.
        expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
          /^Showing results for 読みます → 読む \(polite\)$/,
        );
        const cards = screen.getAllByRole("article");
        const labels = (card: HTMLElement) =>
          [...card.querySelectorAll(".lookup-entry__note")].map((label) => label.textContent);
        expect(labels(cards[0])).toEqual(["Inflected: polite"]);
        // A deinflected shorter start names its start, then its inflections.
        expect(labels(cards[1])).toEqual(["Matched: ← 読んで", "Inflected: -te"]);
        expect(labels(cards[2])).toEqual(["Matched: ← 読"]);
      });

      it("reads as an exact match when the whole query's exact groups come first", async () => {
        lookupMock.mockResolvedValue(
          matched(
            "読書",
            [reading, { ...result, deinflection: { form: "読む", inflections: ["past"] } }],
            ["読", [readShort]],
          ),
        );
        const user = userEvent.setup();
        render(<DictionaryPage />);
        await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読書");
        await user.click(screen.getByRole("button", { name: /^Search$/ }));
        expect(await screen.findByText("reading books")).toBeInTheDocument();
        expect(screen.getByText("Results for").parentElement).toHaveTextContent(
          /^Results for 読書$/,
        );
        expect(screen.queryByText("Showing results for")).not.toBeInTheDocument();
        expect(
          screen.getAllByRole("article")[2].querySelector(".lookup-entry__note"),
        ).toHaveTextContent("Matched: ← 読");
      });

      it("counts and filters every start's groups in the source rail", async () => {
        lookupMock.mockResolvedValue(matched("読書", [reading], ["読", [readShort, readOn]]));
        const user = userEvent.setup();
        render(<DictionaryPage />);
        await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読書する");
        await user.click(screen.getByRole("button", { name: /^Search$/ }));
        const rail = await screen.findByRole("complementary", { name: "Dictionary sources" });
        expect(await screen.findByText("reading books")).toBeInTheDocument();
        expect(within(rail).getByRole("button", { name: /All sources/ })).toHaveTextContent("3");
        expect(within(rail).getByRole("button", { name: /Jitendex/ })).toHaveTextContent("2");
        expect(within(rail).getByRole("button", { name: /見本国語辞典/ })).toHaveTextContent("1");
        await user.click(within(rail).getByRole("button", { name: /見本国語辞典/ }));
        const cards = screen.getAllByRole("article");
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveTextContent("a reading");
        expect(cards[0].querySelector(".lookup-entry__note")).toHaveTextContent("Matched: ← 読");
        expect(screen.getByText("Showing results for").parentElement).toHaveTextContent(
          /^Showing results for 読書 No exact match for 読書する$/,
        );
        await user.click(within(rail).getByRole("button", { name: /All sources/ }));
        expect(screen.getAllByRole("article")).toHaveLength(3);
        expect(lookupMock).toHaveBeenCalledTimes(1);
      });
    });

    it("styles a card's inflections as small muted text after its reading", () => {
      expect(readerCss).toMatch(
        /\.lookup-entry__note \{[^}]*color: var\(--text-muted\);[^}]*font-size: 12\.5px;/,
      );
    });

    it("keeps the query line within the results header", () => {
      expect(dictionaryCss).toMatch(
        /\.dictionary-results__header div \{[^}]*min-width: 0;[^}]*flex-wrap: wrap;[^}]*overflow-wrap: anywhere;/,
      );
      expect(dictionaryCss).toMatch(/\.dictionary-results__query \{[^}]*flex-basis: 100%;/);
    });
  });

  it("keeps the latest search when an earlier lookup finishes afterward", async () => {
    let finishFirst!: (lookup: TermLookup) => void;
    lookupMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockImplementationOnce(exact([result]));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    const input = screen.getByRole("textbox", { name: "Dictionary search" });
    await user.type(input, "本");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await user.clear(input);
    await user.type(input, "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("to read")).toBeInTheDocument();
    await act(async () => finishFirst({ text: "本", groups: [] }));
    expect(screen.getByText("to read")).toBeInTheDocument();
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
  });

  it("lets entries out of view skip layout, standing in at the shared placeholder size", () => {
    expect(tokensCss).toMatch(/--lookup-entry-placeholder-height:\s*15rem;/);
    expect(dictionaryCss).toMatch(
      /\.dictionary-sheet > \.lookup-entry \{\s*content-visibility: auto;\s*contain-intrinsic-block-size: auto var\(--lookup-entry-placeholder-height\);\s*\}/,
    );
  });

  it("shows the first entries of a long result at once and the rest when idle, in order", async () => {
    const idle: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const groups = Array.from({ length: 10 }, (_, index) => ({
      ...result,
      expression: `語${index}`,
      reading: `ご${index}`,
    }));
    const labels = groups.map(({ expression, reading }) => `${expression} (${reading})`);
    lookupMock.mockImplementation(exact(groups));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "ご");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await screen.findByRole("article", { name: labels[0] });
    const shown = () =>
      screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"));
    expect(shown()).toEqual(labels.slice(0, 2));
    act(() => idle.splice(0).forEach((run) => run()));
    expect(shown()).toEqual(labels);
    // Narrowing to one source starts over from its first entries.
    const rail = screen.getByRole("complementary", { name: "Dictionary sources" });
    await user.click(within(rail).getByRole("button", { name: /Jitendex/ }));
    expect(shown()).toEqual(labels.slice(0, 2));
    act(() => idle.splice(0).forEach((run) => run()));
    expect(shown()).toEqual(labels);
  });

  it("counts term rows, filters groups in order, and keeps frequency metadata", async () => {
    const another = {
      ...result.terms[0],
      dictionaryId: 3,
      dictionaryTitle: "見本国語辞典",
      glossary: ["to recite"],
    };
    lookupMock.mockImplementation(
      exact([
        { ...result, terms: [result.terms[0], another, another] },
        {
          expression: "詠む",
          reading: "よむ",
          deinflection: null,
          terms: [another],
          frequencies: [],
          transcriptions: [],
          pitches: [],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "よむ");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const rail = await screen.findByRole("complementary", { name: "Dictionary sources" });
    expect(within(rail).getByRole("button", { name: /All sources/ })).toHaveTextContent("4");
    expect(within(rail).getByRole("button", { name: /Jitendex/ })).toHaveTextContent("1");
    expect(within(rail).getByRole("button", { name: /見本国語辞典/ })).toHaveTextContent("3");
    await user.click(within(rail).getByRole("button", { name: /見本国語辞典/ }));
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("読む");
    expect(cards[0]).toHaveTextContent("to recite");
    expect(cards[0]).toHaveTextContent("7");
    expect(cards[0]).not.toHaveTextContent("to read");
    expect(cards[1]).toHaveTextContent("詠む");
    await user.click(within(rail).getByRole("button", { name: /Jitendex/ }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article")).toHaveTextContent("to read");
    await user.click(within(rail).getByRole("button", { name: /All sources/ }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("searches from the phone's keyboard and filters by a row of source chips", async () => {
    const another = { ...result.terms[0], dictionaryId: 3, glossary: ["to recite"] };
    lookupMock.mockImplementation(exact([{ ...result, terms: [result.terms[0], another] }]));
    const user = userEvent.setup();
    render(
      <MobileHeaderContext.Provider value={({ title }) => <h1>{title}</h1>}>
        <DictionaryPage />
      </MobileHeaderContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: /^Search$/ })).toBeNull();
    const input = screen.getByRole("searchbox", { name: "Dictionary search" });
    expect(input).toHaveAttribute("enterkeyhint", "search");
    await user.type(input, "よむ{Enter}");
    // The search key puts the keyboard away so the results show.
    expect(input).not.toHaveFocus();
    const chips = await screen.findByRole("group", { name: "Dictionary sources" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      within(chips)
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["All sources · 2", "Jitendex · 1", "見本国語辞典 · 1"]);
    expect(within(chips).getByRole("button", { name: /All sources/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(chips).getByRole("button", { name: /見本国語辞典/ }));
    expect(screen.getByRole("article")).toHaveTextContent("to recite");
    expect(screen.getByRole("article")).not.toHaveTextContent("to read");
    // Entries add to AnkiDroid from their headword row, as on the PC.
    expect(document.querySelector(".lookup-entry__actions .anki-action")).not.toBeNull();
  });

  it("lists only sources with matches and keeps results if source loading fails", async () => {
    listMock.mockResolvedValueOnce(dictionaries).mockRejectedValueOnce(new Error("private path"));
    lookupMock.mockImplementation(exact([result]));
    const user = userEvent.setup();
    const { unmount } = render(<DictionaryPage />);
    const rail = screen.getByRole("complementary", { name: "Dictionary sources" });
    // Before a search no dictionary has matches, so none is listed yet.
    expect(
      await within(rail).findByText("Dictionaries with matches appear here."),
    ).toBeInTheDocument();
    expect(within(rail).getAllByRole("button")).toHaveLength(1);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await within(rail).findByRole("button", { name: /Jitendex/ });
    // 見本国語辞典 has no matching rows, and the frequency source is never a source of its own.
    expect(within(rail).queryByRole("button", { name: /見本国語辞典/ })).not.toBeInTheDocument();
    expect(
      within(rail).queryByRole("button", { name: /Sample frequency/ }),
    ).not.toBeInTheDocument();
    expect(within(rail).queryByText("Dictionaries with matches appear here.")).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("to read");
    unmount();
    render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dictionary sources could not be loaded",
    );
    expect(screen.getByRole("article")).toHaveTextContent("to read");
    expect(screen.queryByText("private path")).not.toBeInTheDocument();
  });

  it("offers Get dictionaries while installed sources supply only frequency", async () => {
    const frequencyOnly = {
      ...dictionaries[0],
      id: 2,
      title: "Jiten frequency",
      termCount: 0,
      termMetaCount: 10,
      hasDefinitions: false,
    };
    listMock.mockResolvedValue([frequencyOnly]);
    const { unmount } = render(<DictionaryPage />);
    expect(await screen.findByRole("link", { name: "Get dictionaries" })).toHaveAttribute(
      "href",
      "/settings?section=dictionary",
    );
    expect(screen.getByText("No dictionaries yet")).toBeInTheDocument();
    expect(screen.queryByText("No dictionaries imported yet.")).toBeNull();
    unmount();
    listMock.mockResolvedValue([frequencyOnly, dictionaries[0]]);
    render(<DictionaryPage />);
    await screen.findByText("Dictionaries with matches appear here.");
    expect(screen.queryByRole("link", { name: "Get dictionaries" })).toBeNull();
  });

  it("shows an empty source list with All sources available", async () => {
    listMock.mockResolvedValue([]);
    lookupMock.mockImplementation(exact([result]));
    const user = userEvent.setup();
    render(<DictionaryPage />);
    // The offer above the search says it once; the source list adds no second empty message.
    expect(await screen.findByText("No dictionaries yet")).toBeInTheDocument();
    expect(screen.queryByText("No dictionaries imported yet.")).toBeNull();
    expect(screen.getByRole("link", { name: "Get dictionaries" })).toHaveAttribute(
      "href",
      "/settings?section=dictionary",
    );
    expect(screen.getByRole("button", { name: /All sources/ })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(screen.getByRole("article")).toHaveTextContent("to read");
  });

  it("lists sources in the order Settings returns, not by dictionary ID", async () => {
    listMock.mockResolvedValue([dictionaries[1], dictionaries[0]]);
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            result.terms[0],
            { ...result.terms[0], dictionaryId: 3, dictionaryTitle: "見本国語辞典" },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    const rail = await screen.findByRole("complementary", { name: "Dictionary sources" });
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    await within(rail).findByRole("button", { name: /Jitendex/ });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringMatching(/^All sources/),
      expect.stringMatching(/^見本国語辞典/),
      expect.stringMatching(/^Jitendex/),
    ]);
  });

  it("lists all matching imported dictionaries without consulting the retired global flag", async () => {
    listMock.mockResolvedValue([dictionaries[0], { ...dictionaries[1], enabled: false }]);
    lookupMock.mockImplementation(
      exact([
        {
          ...result,
          terms: [
            result.terms[0],
            { ...result.terms[0], dictionaryId: 3, dictionaryTitle: "見本国語辞典" },
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    render(<DictionaryPage />);
    const rail = await screen.findByRole("complementary", { name: "Dictionary sources" });
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await within(rail).findByRole("button", { name: /Jitendex/ })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /見本国語辞典/ })).toBeInTheDocument();
    expect(within(rail).getAllByRole("button")).toHaveLength(3);
    cleanup();

    listMock.mockResolvedValue(
      dictionaries.map((dictionary) => ({ ...dictionary, enabled: false })),
    );
    render(<DictionaryPage />);
    await screen.findByText("Dictionaries with matches appear here.");
    expect(
      screen.queryByText("Every dictionary is turned off in Settings."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No dictionaries imported yet.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All sources/ })).toBeInTheDocument();
  });

  it("plays a headword's recording without expanding, stops the earlier one, and stops on removal", async () => {
    stubWordAudio();
    lookupMock.mockImplementation(
      exact([result, { ...result, expression: "詠む", reading: "よむ" }]),
    );
    const user = userEvent.setup();
    render(
      <AppearanceProvider
        store={{ load: async () => ({ readerPopupVoiceAction: false }), save: async () => {} }}
      >
        <DictionaryPage />
      </AppearanceProvider>,
    );
    await user.type(await screen.findByRole("textbox", { name: "Dictionary search" }), "よむ");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    const cards = await screen.findAllByRole("article");
    const first = within(cards[0]).getByRole("button", { name: "Play pronunciation for 読む" });
    const second = within(cards[1]).getByRole("button", { name: "Play pronunciation for 詠む" });
    expect(first).toHaveAttribute("aria-pressed", "false");
    await user.click(first);
    expect(within(cards[0]).getByRole("button", { expanded: true })).toBeInTheDocument();
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
    expect(getWordAudio).toHaveBeenCalledWith("読む", "よむ");
    await user.click(second);
    await waitFor(() => expect(second).toHaveAttribute("aria-pressed", "true"));
    expect(MockAudio.played[0].pause).toHaveBeenCalled();
    expect(first).toHaveAttribute("aria-pressed", "false");
    act(() => MockAudio.played[1].onended?.());
    expect(second).toHaveAttribute("aria-pressed", "false");
    await user.click(second);
    await waitFor(() => expect(second).toHaveAttribute("aria-pressed", "true"));
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(MockAudio.played[2].pause).toHaveBeenCalled();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("disables pronunciation without word audio sources", async () => {
    lookupMock.mockImplementation(exact([result]));
    const user = userEvent.setup();
    const { unmount } = render(<DictionaryPage />);
    await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    // Recordings come only from the desktop app.
    const button = await screen.findByRole("button", { name: "Play pronunciation for 読む" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No word audio sources");
    unmount();

    stubWordAudio();
    render(
      <AppearanceProvider
        store={{ load: async () => ({ wordAudioSources: [] }), save: async () => {} }}
      >
        <DictionaryPage />
      </AppearanceProvider>,
    );
    await user.type(await screen.findByRole("textbox", { name: "Dictionary search" }), "読む");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(
      await screen.findByRole("button", { name: "Play pronunciation for 読む" }),
    ).toBeDisabled();
    expect(getWordAudio).not.toHaveBeenCalled();
  });
  describe("single kanji", () => {
    const kanjiSources = [
      dictionaries[0],
      { ...dictionaries[0], id: 4, title: "KANJIDIC", termCount: 0, kanjiCount: 13108 },
      { ...dictionaries[0], id: 5, title: "Sample Kanji", termCount: 0, kanjiMetaCount: 6000 },
    ];
    const bookKanji: KanjiLookup = {
      entries: [
        {
          dictionaryId: 4,
          dictionaryTitle: "KANJIDIC",
          character: "本",
          onyomi: "ホン",
          kunyomi: "もと もと.づく",
          tags: "jouyou grade1 jouyou",
          meanings: ["book", "origin", "counter for long cylindrical things"],
          stats: { strokes: "5", freq: 10, nested: { value: 1 }, missing: null },
          resolvedTags: [
            {
              name: "jouyou",
              category: "frequent",
              order: 0,
              notes: "included in list of regular-use characters",
              score: 0,
            },
            { name: "grade1" },
          ],
          statTags: [
            { name: "freq", category: "misc", order: 0, notes: "Frequency", score: 0 },
            { name: "missing", category: "misc", order: 0, notes: "Missing", score: 0 },
            { name: "nested" },
            { name: "strokes", category: "misc", order: 0, notes: "Stroke count", score: 0 },
          ],
        },
      ],
      frequencies: [
        { dictionaryId: 4, dictionaryTitle: "KANJIDIC", data: 10 },
        {
          dictionaryId: 5,
          dictionaryTitle: "Sample Kanji",
          data: { value: 7, displayValue: "7㋕" },
        },
      ],
    };
    const bookWord: GroupFixture = {
      ...result,
      expression: "本",
      reading: "ほん",
      terms: [{ ...result.terms[0], glossary: ["book"] }],
      frequencies: [],
    };

    it("shows the kanji's rows and frequencies beside its word results", async () => {
      listMock.mockResolvedValue(kanjiSources);
      lookupMock.mockImplementation(exact([bookWord]));
      kanjiMock.mockResolvedValue(bookKanji);
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), " 本 ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(kanjiMock).toHaveBeenCalledWith("本");
      expect(lookupMock).toHaveBeenCalledWith("本");

      const cards = await screen.findAllByRole("article");
      expect(cards).toHaveLength(2);
      const kanji = screen.getByRole("article", { name: "Kanji 本" });
      expect(cards[0]).toBe(kanji);
      expect(screen.getByText("2 entries")).toBeInTheDocument();
      expect(cards[1]).toHaveAccessibleName("本 (ほん)");
      expect(cards[1]).toHaveTextContent("book");

      expect(kanji).toHaveTextContent("KANJIDIC");
      const meanings = within(kanji).getByRole("list", { name: "Meanings" });
      expect(
        within(meanings)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["book", "origin", "counter for long cylindrical things"]);
      const readings = kanji.querySelector("dl[aria-label='Readings']")!;
      expect(readings).toHaveTextContent("Onホン");
      expect(readings).toHaveTextContent("Kunもと、もと.づく");
      // Under its dictionary's name, Kanji leads the tags its dictionary defines, as a word's do.
      const source = within(kanji).getByRole("region", { name: "KANJIDIC" });
      const tags = [...source.querySelectorAll(".lookup-source__tags > span")];
      expect(tags.map((tag) => [tag.textContent, tag.getAttribute("title")])).toEqual([
        ["Kanji", null],
        ["jouyou", "included in list of regular-use characters"],
        ["grade1", null],
      ]);
      expect(tags[1]).toHaveAccessibleDescription("included in list of regular-use characters");
      expect(within(source).getByRole("button", { name: "Collapse KANJIDIC definitions" }));

      const frequencies = within(kanji).getByRole("list", { name: "Frequency" });
      expect(
        [...frequencies.children].map((row) => [
          row.querySelector("span")!.textContent,
          row.querySelector("strong")!.textContent,
        ]),
      ).toEqual([
        ["KANJIDIC", "10"],
        ["Sample Kanji", "7㋕"],
      ]);

      // Stats are collapsed; strings and numbers show, labelled by their notes, and other
      // values are left out.
      const stats = within(kanji).getByText("Stats (2)");
      expect(stats.closest("details")).not.toHaveAttribute("open");
      // Komori's chevron marks it, as on every other disclosure.
      expect(stats.querySelector(":scope > svg")).toHaveAttribute("aria-hidden", "true");
      await user.click(stats);
      expect(stats.closest("details")).toHaveAttribute("open");
      const statRows = [...stats.closest("details")!.querySelectorAll("dl > div")];
      expect(statRows.map((row) => row.textContent)).toEqual(["Frequency10", "Stroke count5"]);
      expect(statRows[1].querySelector("dt")).toHaveAttribute("title", "strokes");
      expect(stats.closest("details")!.querySelector("dl")).toHaveAccessibleName("Statistics");
    });

    it("groups a kanji's stats by category in definition order", async () => {
      const defined = (name: string, category: string, order: number, notes: string) => ({
        name,
        category,
        order,
        notes,
        score: 0,
      });
      kanjiMock.mockResolvedValue({
        entries: [
          {
            ...bookKanji.entries[0],
            tags: "",
            resolvedTags: [],
            stats: {
              busy_people: "3.2",
              deroo: 1,
              four_corner: "5023.0",
              grade: "1",
              jlpt: 4,
              mystery: "x",
              nelson_c: "96",
              radical: "木",
              skip: "4-5-1",
              strokes: "5",
              "trailing note": "y",
              ucs: "672c",
              unnoted: "z",
            },
            statTags: [
              defined("busy_people", "index", 0, "Japanese for Busy People"),
              defined("deroo", "class", 0, "De Roo code"),
              defined("four_corner", "class", 0, "Four-corner code"),
              defined("grade", "misc", 0, "School grade"),
              defined("jlpt", "misc", -1, "JLPT level"),
              { name: "mystery" },
              defined("nelson_c", "index", 0, "Classic Nelson"),
              defined("radical", "shape", 0, "Radical"),
              defined("skip", "class", -2, "SKIP code"),
              defined("strokes", "misc", 0, "Stroke count"),
              defined("trailing note", "", 0, "Trailing"),
              defined("ucs", "code", 0, "Unicode"),
              defined("unnoted", "misc", 0, "  "),
            ],
          },
        ],
        frequencies: [],
      });
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const kanji = await screen.findByRole("article", { name: "Kanji 本" });
      expect(
        [...kanji.querySelectorAll(".lookup-source__tags > span")].map((tag) => tag.textContent),
      ).toEqual(["Kanji"]);
      await user.click(within(kanji).getByText("Stats (13)"));
      const lists = [...kanji.querySelectorAll(".dictionary-kanji__stat-group dl")];
      expect(
        lists.map((list) => [
          document.getElementById(list.getAttribute("aria-labelledby")!)?.textContent,
          [...list.children].map((row) => row.textContent),
        ]),
      ).toEqual([
        // The format's categories in their usual order, each in definition order with ties as returned.
        ["Statistics", ["JLPT level4", "School grade1", "Stroke count5", "unnotedz"]],
        ["Classifications", ["SKIP code4-5-1", "De Roo code1", "Four-corner code5023.0"]],
        ["Codepoints", ["Unicode672c"]],
        ["Dictionary indices", ["Japanese for Busy People3.2", "Classic Nelson96"]],
        // Another category keeps its name; uncategorized, then undefined, stats follow.
        ["shape", ["Radical木"]],
        ["Other", ["Trailingy", "mysteryx"]],
      ]);
      expect(lists[0]).toHaveAccessibleName("Statistics");
      // A stat labelled by its notes keeps its name as a tooltip.
      expect(within(kanji).getByText("Unicode")).toHaveAttribute("title", "ucs");
      expect(within(kanji).getByText("mystery")).not.toHaveAttribute("title");
    });

    it("leaves a kanji's stats unheaded when none is categorized", async () => {
      kanjiMock.mockResolvedValue({
        entries: [
          {
            ...bookKanji.entries[0],
            stats: { strokes: "5", freq: 10 },
            statTags: [{ name: "freq" }, { name: "strokes" }],
          },
        ],
        frequencies: [],
      });
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const kanji = await screen.findByRole("article", { name: "Kanji 本" });
      await user.click(within(kanji).getByText("Stats (2)"));
      expect(kanji.querySelector(".dictionary-kanji__stat-heading")).toBeNull();
      expect(
        [...kanji.querySelectorAll(".dictionary-kanji__stats dl > div")].map(
          (row) => row.textContent,
        ),
      ).toEqual(["freq10", "strokes5"]);
    });

    it("counts kanji rows per source and filters them with the word results", async () => {
      listMock.mockResolvedValue(kanjiSources);
      lookupMock.mockImplementation(exact([bookWord]));
      kanjiMock.mockResolvedValue(bookKanji);
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const rail = await screen.findByRole("complementary", { name: "Dictionary sources" });
      await screen.findByRole("article", { name: "Kanji 本" });
      const source = (name: RegExp) => within(rail).getByRole("button", { name });
      expect(source(/All sources/)).toHaveTextContent("2");
      expect(source(/All sources/)).toContainElement(
        within(rail).getByLabelText("2 matching rows"),
      );
      expect(source(/Jitendex/)).toHaveTextContent("1");
      expect(source(/KANJIDIC/)).toHaveTextContent("1");
      // A kanji frequency dictionary only describes the results.
      expect(within(rail).queryByRole("button", { name: /Sample Kanji/ })).not.toBeInTheDocument();

      await user.click(source(/KANJIDIC/));
      expect(screen.getAllByRole("article")).toEqual([
        screen.getByRole("article", { name: "Kanji 本" }),
      ]);
      expect(screen.getByText("1 entry")).toBeInTheDocument();
      // The kanji keeps every frequency row, as a word keeps its frequencies.
      expect(screen.getByRole("article")).toHaveTextContent("Sample Kanji");

      await user.click(source(/Jitendex/));
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.queryByRole("article", { name: "Kanji 本" })).not.toBeInTheDocument();

      await user.click(source(/All sources/));
      expect(screen.getAllByRole("article")).toHaveLength(2);
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(kanjiMock).toHaveBeenCalledTimes(1);
    });

    it("lists each kanji dictionary's part in returned order and omits empty parts", async () => {
      kanjiMock.mockResolvedValue({
        entries: [
          bookKanji.entries[0],
          {
            dictionaryId: 6,
            dictionaryTitle: "Kanjium",
            character: "本",
            onyomi: "",
            kunyomi: "",
            tags: "",
            meanings: [],
            stats: [],
            resolvedTags: [],
            statTags: [],
          },
        ],
        frequencies: [],
      });
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const kanji = await screen.findByRole("article", { name: "Kanji 本" });
      const rows = kanji.querySelectorAll<HTMLElement>(".lookup-source");
      expect(
        [...rows].map((row) => row.querySelector(".lookup-source__name")!.textContent),
      ).toEqual(["KANJIDIC", "Kanjium"]);
      expect(within(rows[1]).queryByRole("list")).not.toBeInTheDocument();
      expect(rows[1].querySelector("dl, details, .lookup-source__tags")).toBeNull();
      expect(within(kanji).queryByRole("list", { name: "Frequency" })).not.toBeInTheDocument();
      // A kanji without word results is still a result.
      expect(screen.getByText("1 entry")).toBeInTheDocument();
      expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    });

    it("shows a kanji with only frequency rows under All sources", async () => {
      kanjiMock.mockResolvedValue({ entries: [], frequencies: bookKanji.frequencies });
      listMock.mockResolvedValue(kanjiSources);
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      const kanji = await screen.findByRole("article", { name: "Kanji 本" });
      expect(kanji).toHaveTextContent("Sample Kanji");
      expect(kanji.querySelector(".lookup-source")).toBeNull();
      expect(screen.queryByRole("button", { name: /Sample Kanji/ })).not.toBeInTheDocument();
    });

    it("asks only about one-character queries and shows nothing for an empty kanji result", async () => {
      lookupMock.mockImplementation(exact([result]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "読む");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      await screen.findByRole("article");
      expect(kanjiMock).not.toHaveBeenCalled();

      await user.clear(input);
      await user.type(input, "よ");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      await screen.findByText("1 entry");
      expect(kanjiMock).toHaveBeenCalledWith("よ");
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.queryByRole("article", { name: /^Kanji/ })).not.toBeInTheDocument();
    });

    it("fails the search without native details when the kanji lookup fails", async () => {
      lookupMock.mockImplementation(exact([bookWord]));
      kanjiMock.mockRejectedValue("C:\\private\\dictionaries.sqlite3");
      const user = userEvent.setup();
      render(<DictionaryPage />);
      await user.type(screen.getByRole("textbox", { name: "Dictionary search" }), "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Search could not be completed. Try again.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("private");
    });

    it("ignores a kanji result that arrives after a newer search", async () => {
      let finishKanji!: (lookup: KanjiLookup) => void;
      kanjiMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishKanji = resolve;
        }),
      );
      lookupMock.mockImplementationOnce(exact([bookWord])).mockImplementationOnce(exact([result]));
      const user = userEvent.setup();
      render(<DictionaryPage />);
      const input = screen.getByRole("textbox", { name: "Dictionary search" });
      await user.type(input, "本");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      await user.clear(input);
      await user.type(input, "読む");
      await user.click(screen.getByRole("button", { name: /^Search$/ }));
      expect(await screen.findByText("to read")).toBeInTheDocument();
      await act(async () => finishKanji(bookKanji));
      expect(screen.queryByRole("article", { name: "Kanji 本" })).not.toBeInTheDocument();
      expect(screen.getByText("Results for").parentElement).toHaveTextContent("Results for 読む");
    });
  });
});
