import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnkiAction, frequencyRanks, termCardSources } from "./AnkiAction";
import { AnkiSettings } from "./AnkiSettings";
import * as api from "./ankiApi";
import {
  configurationProblem,
  emptyContext,
  expandTemplate,
  lapisDefaults,
  mappedFields,
  validFields,
  validTemplate,
  cardFields,
  expressionFurigana,
  fieldProblem,
} from "./templates";
import { sentenceAt } from "../reader/textSelection";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import { normalizeAppearancePreferences } from "../appearance/appearancePreferences";
import { listDictionaries } from "../dictionary/dictionaryApi";
vi.mock("../dictionary/dictionaryApi", () => ({ listDictionaries: vi.fn() }));

vi.mock("./ankiApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  loadAnki: vi.fn(),
  cachedAnki: vi.fn(),
  discoverAnki: vi.fn(),
  saveAnki: vi.fn(),
  createLapis: vi.fn(),
  createNote: vi.fn(),
  checkNote: vi.fn(),
  pendingRequests: vi.fn(),
  browseNote: vi.fn(),
  noteStatus: vi.fn(),
}));
const prefs: api.AnkiPreferences = {
  port: 8765,
  key: "",
  deck: "Study",
  deckId: 1,
  model: "Basic",
  mappings: {
    Basic: {
      modelId: 2,
      fields: ["Front", "Back"],
      templates: {
        Front: "{{expression}}",
        Back: "{{definition}}\n{{source}}\n{{sentence}}\n{{bookTitle}}",
      },
    },
  },
};
const discovery: api.AnkiDiscovery = {
  deckIds: { Study: 1, Other: 3 },
  modelIds: { Basic: 2, Other: 5, Lapis: 4 },
  decks: ["Study", "Other"],
  models: ["Basic", "Other"],
  fields: ["Front", "Back"],
  lapis: "missing",
};
const sources = [
  {
    label: "1. Dictionary",
    context: {
      ...emptyContext,
      expression: "読む",
      reading: "よむ",
      definition: "read <script>",
      source: "Dictionary",
      sentence: "昨日読んだ。",
      bookTitle: "Book",
    },
  },
  {
    label: "2. Another",
    context: {
      ...emptyContext,
      expression: "読む",
      definition: "second definition",
      source: "Another",
    },
  },
];
function view(component: React.ReactNode) {
  return render(<MemoryRouter>{component}</MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.loadAnki).mockResolvedValue(structuredClone(prefs));
  vi.mocked(api.cachedAnki).mockImplementation(() => api.loadAnki());
  vi.mocked(api.discoverAnki).mockResolvedValue(structuredClone(discovery));
  vi.mocked(api.pendingRequests).mockResolvedValue([]);
  vi.mocked(api.saveAnki).mockResolvedValue();
  vi.mocked(api.noteStatus).mockResolvedValue({ status: "missing" });
  vi.mocked(listDictionaries).mockResolvedValue([]);
});

describe("bounded field mappings and lookup context", () => {
  it("reads each term's glossary once per group for its card sources", () => {
    const reads: number[] = [0, 0, 0, 0];
    const terms = reads.map((_, index) => ({
      dictionaryId: index + 1,
      dictionaryTitle: `Dictionary ${index + 1}`,
      definitionTags: "",
      rules: "",
      score: 0,
      sequence: 1,
      termTags: "",
      tags: [],
      glossary: new Proxy([`meaning ${index + 1}`], {
        get(target, property, receiver) {
          if (property === "flatMap") reads[index] += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    }));
    const cards = termCardSources({
      expression: "本",
      reading: "ほん",
      text: "本",
      deinflection: null,
      terms,
      frequencies: [],
      pitches: [],
    });
    expect(reads).toEqual([1, 1, 1, 1]);
    expect(cards.map((card) => card.context.definition)).toEqual([
      "meaning 1",
      "meaning 2",
      "meaning 3",
      "meaning 4",
    ]);
    expect(cards.every((card) => card.context.glossary === cards[0].context.glossary)).toBe(true);
    expect(cards[0].context.glossary).toBe("meaning 1\n\nmeaning 2\n\nmeaning 3\n\nmeaning 4");
  });
  it("expands literal placeholders once, keeps text inert and validates UTF-8 bounds", () => {
    expect(
      expandTemplate("{{expression}}\n{{definition}}", {
        ...emptyContext,
        expression: "{{reading}}",
        definition: "<script>${bad}`",
      }),
    ).toBe("{{reading}}\n<script>${bad}`");
    for (const template of ["{{unknown}}", "{{{expression}}}", "{", "a".repeat(4097)])
      expect(validTemplate(template)).toBe(false);
    expect(validTemplate("<b>{{expression}}</b>")).toBe(true);
    expect(validFields({ Front: "字".repeat(6000), Back: "" }, ["Front", "Back"])).toBe(true);
    expect(validFields({ Front: "字".repeat(44000), Back: "" }, ["Front", "Back"])).toBe(false);
    expect(validFields({ Front: " ", Back: "definition" }, ["Front", "Back"])).toBe(false);
    expect(
      mappedFields(lapisDefaults(["Expression", "MainDefinition", "Picture"]), sources[0].context),
    ).toEqual({ Expression: "読む", MainDefinition: "read <script>", Picture: "" });
  });
  it("requires repair without dropping a missing deck/model or changed mapping", () => {
    expect(configurationProblem({ ...prefs, deck: "Missing" }, discovery)).toContain(
      "missing saved deck",
    );
    expect(configurationProblem({ ...prefs, model: "Missing" }, discovery)).toContain(
      "mappings are kept",
    );
    expect(configurationProblem(prefs, { ...discovery, fields: ["Front", "Changed"] })).toContain(
      "fields need review",
    );
    expect(configurationProblem(prefs, discovery)).toBeNull();
  });
  it("uses dictionary forms and chosen sources, omits media/paths", () => {
    const cards = termCardSources(
      {
        expression: "読む",
        reading: "よむ",
        text: "読んだ",
        deinflection: { form: "読む", inflections: ["past"] },
        terms: [
          {
            dictionaryId: 1,
            dictionaryTitle: "Real",
            definitionTags: "",
            rules: "v5m",
            score: 0,
            sequence: 1,
            termTags: "",
            tags: [],
            glossary: [
              {
                type: "structured-content",
                content: [
                  { tag: "ruby", content: ["読", { tag: "rt", content: "よ" }] },
                  "む",
                  { tag: "img", path: "private/path" },
                  { tag: "script", content: "evil" },
                  "read",
                ],
              },
            ],
          },
        ],
        frequencies: [{ dictionaryId: 2, dictionaryTitle: "Rank", data: 5 }],
        pitches: [
          {
            dictionaryId: 3,
            dictionaryTitle: "Pitch",
            data: { reading: "よむ", pitches: [{ position: 1 }] },
          },
        ],
      },
      { sentence: "昨日読んだ。", bookTitle: "Real book" },
    );
    expect(cards[0].context).toEqual({
      ...emptyContext,
      expression: "読む",
      reading: "よむ",
      expressionFurigana: "読[よ]む",
      glossary: "読む read",
      definition: "読む read",
      source: "Real",
      frequency: "Rank: 5",
      frequencyHarmonic: "5",
      frequencyAverage: "5",
      pitch: "Pitch: 1",
      sentence: "昨日読んだ。",
      bookTitle: "Real book",
    });
    expect(cards[0].matchedText).toBe("読んだ");
    const sentence = cardFields(
      { fields: ["Sentence"], templates: { Sentence: "{{sentence}}" } },
      cards,
    );
    expect(sentence.fieldParts.Sentence).toEqual([
      { type: "sentence", text: "昨日読んだ。", expression: "読んだ" },
    ]);
    expect(sentence.dictionarySources).toEqual([
      { id: 1, title: "Real" },
      { id: 2, title: "Rank", values: ["5"] },
    ]);
    const tiers = cardFields(
      { fields: ["Front"], templates: { Front: "{{expression}}" } },
      cards.map((card) => ({
        ...card,
        tagSources: [{ id: 42, title: "TMW", values: ["Divine"] }],
      })),
    );
    expect(tiers.dictionarySources).toEqual([
      { id: 1, title: "Real" },
      { id: 42, title: "TMW", values: ["Divine"] },
    ]);
    // Word audio crosses IPC as the headword alone; native code finds and stores the recording.
    const audio = cardFields(
      { fields: ["Front", "Audio"], templates: { Front: "{{expression}}", Audio: "{{audio}}" } },
      cards,
    );
    expect(audio.fieldParts.Audio).toEqual([{ type: "audio", term: "読む", reading: "よむ" }]);
    expect(audio.fields.Audio).toBe("");
    expect(validTemplate("[{{audio}}]")).toBe(true);
    expect(lapisDefaults(["Expression", "ExpressionAudio"]).templates.ExpressionAudio).toBe(
      "{{audio}}",
    );
    const original = cardFields(
      { fields: ["Front"], templates: { Front: "{{definition}}" } },
      cards,
    );
    expect(original.fieldParts.Front[0]).toMatchObject({
      type: "definitions",
      entries: [{ presentation: expect.any(Array) }],
    });
  });
  it("extracts a bounded ruby-free sentence through detached adapter ranges without changing selection", () => {
    const block = document.createElement("p");
    block.innerHTML = "前文。昨日<ruby>読<rt>よ</rt></ruby>んだ。次文。";
    document.body.append(block);
    const node = block.querySelector("ruby")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(sentenceAt(range)).toBe("昨日読んだ。");
    expect(document.getSelection()!.toString()).toBe("読");
    block.textContent = "字".repeat(3000);
    range.setStart(block.firstChild!, 1500);
    range.setEnd(block.firstChild!, 1501);
    expect([...sentenceAt(range)].length).toBe(1024);
    block.remove();
  });
});

it("gives FreqSort Yomitan's harmonic and average ranks", () => {
  const frequencies = [
    { dictionaryId: 1, dictionaryTitle: "TMW", data: { value: 14943, displayValue: "Major" } },
    { dictionaryId: 2, dictionaryTitle: "Jiten", data: { reading: "よむ", frequency: 15993 } },
    // A source's later rows, occurrence counts and empty ranks are left out.
    { dictionaryId: 2, dictionaryTitle: "Jiten", data: 111462 },
    { dictionaryId: 3, dictionaryTitle: "Counts", data: 4, frequencyMode: "occurrence-based" },
    { dictionaryId: 4, dictionaryTitle: "Zero", data: 0 },
  ];
  expect(frequencyRanks(frequencies)).toEqual([14943, 15993]);
  expect(
    frequencyRanks([
      {
        dictionaryId: 5,
        dictionaryTitle: "JPDB",
        data: { frequency: { value: 1, displayValue: "11㋕" } },
        frequencyMode: "rank-based",
      },
      { dictionaryId: 6, dictionaryTitle: "Text", data: "22" },
    ]),
  ).toEqual([11, 22]);
  const group = {
    expression: "読む",
    reading: "よむ",
    text: "読む",
    deinflection: null,
    terms: [
      {
        dictionaryId: 9,
        dictionaryTitle: "Real",
        definitionTags: "",
        rules: "",
        score: 0,
        sequence: 1,
        termTags: "",
        tags: [],
        glossary: ["read"],
      },
    ],
    pitches: [],
  };
  const [card] = termCardSources({ ...group, frequencies });
  expect(card.context.frequencyHarmonic).toBe("15450");
  expect(card.context.frequencyAverage).toBe("15468");
  const mapping = lapisDefaults(["Expression", "Frequency", "FreqSort"]);
  expect(mapping.templates.FreqSort).toBe("{{frequencyHarmonic}}");
  expect(cardFields(mapping, [card]).fields.FreqSort).toBe("15450");
  // Without a rank the card sorts last.
  expect(termCardSources({ ...group, frequencies: [] })[0].context.frequencyHarmonic).toBe(
    "9999999",
  );
});

it("keeps frequencies as native list parts in both Frequency and FreqSort mappings", () => {
  const result = cardFields(
    {
      fields: ["Frequency", "FreqSort"],
      templates: { Frequency: "{{frequency}}", FreqSort: "{{frequency}}" },
    },
    [{ context: { ...emptyContext, frequency: "BCCWJ: 637\nCC100: 5279\nTMW: Trainee" } }],
  );
  expect(result.fields.Frequency).toBe("BCCWJ: 637\nCC100: 5279\nTMW: Trainee");
  expect(result.fieldParts.Frequency).toEqual([
    { type: "frequencies", text: result.fields.Frequency },
  ]);
  expect(result.fieldParts.FreqSort).toEqual(result.fieldParts.Frequency);
});

it("reports the affected field and accepts large multi-dictionary glossary checks", async () => {
  expect(fieldProblem({ Front: "", Back: "text" }, ["Front", "Back"])).toContain(
    "first Anki field (Front)",
  );
  expect(fieldProblem({ Front: "字", Back: "字".repeat(44000) }, ["Front", "Back"])).toContain(
    "Back exceeds 128 KiB",
  );
  const large = [
    { ...sources[0], context: { ...sources[0].context, definition: "字".repeat(10000) } },
  ];
  view(<AnkiAction sources={large} />);
  expect(await screen.findByRole("button", { name: "Add 読む to Anki" })).toBeEnabled();
  // A check sends the first field alone, never the large glossary.
  expect(vi.mocked(api.noteStatus).mock.calls[0][1]).toEqual([{ type: "text", text: "読む" }]);
});

describe("One-click Anki actions", () => {
  it("disables the action with its reason instead of a message, and rechecks on focus", async () => {
    vi.mocked(api.noteStatus).mockRejectedValueOnce("timeout");
    view(<AnkiAction sources={sources} />);
    const button = await screen.findByRole("button", { name: "Add 読む to Anki" });
    await waitFor(() =>
      expect(button).toHaveAttribute("aria-description", expect.stringMatching(/did not answer/)),
    );
    expect(button).toBeDisabled();
    expect(button.title).toMatch(/did not answer/);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "missing" });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add 読む to Anki" })).toBeEnabled(),
    );
    expect(api.createNote).not.toHaveBeenCalled();
  });
  it("keeps the action usable while a focus recheck runs, so the first click adds", async () => {
    vi.mocked(api.createNote).mockResolvedValue({ status: "created", id: 9 });
    view(<AnkiAction sources={sources} />);
    const button = await screen.findByRole("button", { name: "Add 読む to Anki" });
    // Coming back from the book focuses the window just before the click lands.
    vi.mocked(api.noteStatus).mockReturnValue(new Promise(() => {}));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.createNote).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "読む saved in Anki" })).toBeDisabled();
  });
  it("creates by keyboard from saved settings, guards double clicks and opens Anki Browser", async () => {
    let resolve!: (value: api.NoteOutcome) => void;
    vi.mocked(api.createNote).mockReturnValue(new Promise((r) => (resolve = r)));
    vi.mocked(api.browseNote).mockResolvedValue();
    const user = userEvent.setup();
    view(<AnkiAction sources={sources} />);
    await screen.findByRole("button", { name: "Add 読む to Anki" });
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.createNote).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Saving 読む/ }));
    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect(api.createNote).toHaveBeenCalledWith(
      expect.any(String),
      prefs,
      {
        Front: "読む",
        Back: "read <script>\nDictionary\n昨日読んだ。\nBook",
      },
      expect.objectContaining({ fieldParts: expect.any(Object) }),
    );
    expect(api.discoverAnki).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(() => resolve({ status: "created", id: 42 }));
    await screen.findByText("Card added.");
    await user.click(screen.getByRole("button", { name: "Edit 読む in Anki Browser" }));
    expect(api.browseNote).toHaveBeenCalledWith(42);
    expect(api.createNote).toHaveBeenCalledTimes(1);
  });
  it("leaves {{selectionText}} empty for a selection outside the action's popup", async () => {
    vi.mocked(api.createNote).mockResolvedValue({ status: "created", id: 9 });
    vi.mocked(api.loadAnki).mockResolvedValue({
      ...structuredClone(prefs),
      mappings: {
        Basic: {
          modelId: 2,
          fields: ["Front", "Back"],
          templates: { Front: "{{expression}}", Back: "{{selectionText}}" },
        },
      },
    });
    view(
      <>
        <p>outside text</p>
        <section className="reader-lookup">
          <p>to read a book</p>
          <AnkiAction sources={sources} />
        </section>
      </>,
    );
    const button = await screen.findByRole("button", { name: "Add 読む to Anki" });
    const select = (text: string) => {
      const range = document.createRange();
      range.selectNodeContents(screen.getByText(text));
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    select("to read a book");
    // A selection outside the popup is not the popup's selection.
    select("outside text");
    fireEvent.click(button);
    await waitFor(() => expect(api.createNote).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createNote).mock.calls[0][2]).toEqual({ Front: "読む", Back: "" });
    expect(lapisDefaults(["Expression", "SelectionText"]).templates.SelectionText).toBe(
      "{{selectionText}}",
    );
  });
  it("reads the popup selection at the press, before the click can clear it", async () => {
    vi.mocked(api.createNote).mockResolvedValue({ status: "created", id: 9 });
    vi.mocked(api.loadAnki).mockResolvedValue({
      ...structuredClone(prefs),
      mappings: {
        Basic: {
          modelId: 2,
          fields: ["Front", "Back"],
          templates: { Front: "{{expression}}", Back: "<b>{{selectionText}}</b>" },
        },
      },
    });
    view(
      <section className="reader-lookup">
        <p>to read a book</p>
        <AnkiAction sources={sources} />
      </section>,
    );
    const button = await screen.findByRole("button", { name: "Add 読む to Anki" });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("to read a book"));
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent.pointerDown(button);
    document.getSelection()!.removeAllRanges();
    fireEvent.click(button, { detail: 1 });
    await waitFor(() => expect(api.createNote).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createNote).mock.calls[0][2]).toEqual({
      Front: "読む",
      Back: "<b>to read a book</b>",
    });
  });
  it("locks uncertain requests and checks the original ID without resending", async () => {
    vi.mocked(api.createNote).mockResolvedValue({ status: "uncertain" });
    vi.mocked(api.checkNote).mockResolvedValue({ status: "created", id: 43 });
    view(<AnkiAction sources={sources} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add 読む to Anki" }));
    // The action itself becomes the check; it never sends the card again.
    const check = await screen.findByRole("button", {
      name: "Check whether 読む was added to Anki",
    });
    expect(check).toBeEnabled();
    fireEvent.click(check);
    await screen.findByText("Card added.");
    expect(api.checkNote).toHaveBeenCalledWith(vi.mocked(api.createNote).mock.calls[0][0]);
    expect(api.createNote).toHaveBeenCalledTimes(1);
  });
  it("discards disposed/configuration-changed setup and handles missing mappings", async () => {
    let resolve!: (p: api.AnkiPreferences) => void;
    vi.mocked(api.loadAnki).mockReturnValue(new Promise((r) => (resolve = r)));
    const result = view(<AnkiAction sources={sources} />);
    expect(screen.getByRole("button", { name: /Checking 読む/ })).toBeDisabled();
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    await act(() => resolve(prefs));
    expect(api.createNote).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: "Add 読む to Anki" });
    vi.mocked(api.loadAnki).mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("button", { name: "Add 読む to Anki" }));
    result.unmount();
    await act(() => resolve(prefs));
    expect(api.createNote).not.toHaveBeenCalled();
    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, mappings: {} });
    view(<AnkiAction sources={sources} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add 読む to Anki" })).toHaveAttribute(
        "aria-description",
        expect.stringMatching(/Settings → Anki/),
      ),
    );
    expect(screen.getByRole("button", { name: "Add 読む to Anki" })).toBeDisabled();
    expect(api.createNote).not.toHaveBeenCalled();
  });
  it("blocks an existing note, offers Browser editing, and resets on a new lookup", async () => {
    vi.mocked(api.createNote).mockResolvedValue({ status: "duplicate", id: 44 });
    const result = view(<AnkiAction sources={sources} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add 読む to Anki" }));
    await screen.findByText(/No card added/);
    expect(screen.getByRole("button", { name: "読む already in Anki" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit 読む in Anki Browser" })).toBeEnabled();
    const browse = screen.getByRole("button", { name: "Edit 読む in Anki Browser" });
    const add = screen.getByRole("button", { name: "読む already in Anki" });
    expect(browse.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    result.rerender(
      <MemoryRouter>
        <AnkiAction sources={[{ label: "Next", context: { ...emptyContext, expression: "字" } }]} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Add 字 to Anki" })).toBeEnabled();
  });
  it("marks existing cards before clicking and rechecks new instances, scopes and external edits", async () => {
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "existing", id: 44, count: 1 });
    const first = view(<AnkiAction sources={sources} />);
    expect(await screen.findByRole("button", { name: "読む already in Anki" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit 読む in Anki Browser" })).toBeEnabled();
    first.unmount();
    view(
      <AnkiAction
        sources={[{ ...sources[0], context: { ...sources[0].context, sentence: "読む。" } }]}
      />,
    );
    expect(await screen.findByRole("button", { name: "読む already in Anki" })).toBeDisabled();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.noteStatus).toHaveBeenCalledTimes(2);
    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, deck: "Other", deckId: 3 });
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "missing" });
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    expect(await screen.findByRole("button", { name: "Add 読む to Anki" })).toBeEnabled();
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "existing", id: 45, count: 1 });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByRole("button", { name: "読む already in Anki" })).toBeDisabled();
  });
  it("honors overwrite and allow while refusing multiple overwrite matches", async () => {
    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, duplicatePolicy: "overwrite" });
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "existing", id: 44, count: 1 });
    const result = view(<AnkiAction sources={sources} />);
    expect(await screen.findByRole("button", { name: "Update 読む in Anki" })).toBeEnabled();
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "existing", id: 44, count: 2 });
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    expect(await screen.findByRole("button", { name: "読む already in Anki" })).toBeDisabled();
    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, duplicatePolicy: "allow" });
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    expect(await screen.findByRole("button", { name: "Add another 読む to Anki" })).toBeEnabled();
    result.unmount();
  });
  it("rejects stale existence responses and restores pending recovery on remount", async () => {
    let resolve!: (status: api.NoteStatus) => void;
    vi.mocked(api.noteStatus).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const result = view(<AnkiAction sources={sources} />);
    await waitFor(() => expect(api.noteStatus).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    await screen.findByRole("button", { name: "Add 読む to Anki" });
    await act(() => resolve({ status: "existing", id: 1, count: 1 }));
    expect(screen.getByRole("button", { name: "Add 読む to Anki" })).toBeEnabled();
    result.unmount();
    vi.mocked(api.noteStatus).mockResolvedValue({ status: "pending", requestId: "original" });
    view(<AnkiAction sources={sources} />);
    const check = await screen.findByRole("button", {
      name: "Check whether 読む was added to Anki",
    });
    expect(check).toBeEnabled();
    const count = vi.mocked(api.noteStatus).mock.calls.length;
    act(() => window.dispatchEvent(new Event(api.ankiChanged)));
    expect(api.noteStatus).toHaveBeenCalledTimes(count);
    vi.mocked(api.checkNote).mockResolvedValue({ status: "created", id: 5 });
    fireEvent.click(check);
    await screen.findByText("Card added.");
    expect(api.checkNote).toHaveBeenCalledWith("original");
    expect(api.createNote).not.toHaveBeenCalled();
  });
});

it("maps all definitions and selected dictionaries into safe structured parts and defaults to furigana", () => {
  const input = sources.map((s, index) => ({ ...s, dictionaryId: index + 1 }));
  const mapping = {
    fields: ["Main", "Glossary", "Selected", "Reading", "Picture"],
    templates: {
      Main: "{{definition}}",
      Glossary: "{{glossary}}",
      Selected: "{{dictionary:2}}",
      Reading: "{{expressionFurigana}}",
      Picture: "{{picture}}",
    },
  };
  const result = cardFields(mapping, input);
  expect(result.fields.Main).toBe("read <script>");
  expect(result.fields.Glossary).toBe("read <script>\n\nsecond definition");
  expect(result.fields.Selected).toBe("second definition");
  expect(result.fieldParts.Picture).toEqual([{ type: "cover" }]);
  expect(result.fieldParts.Glossary).toEqual([
    {
      type: "definitions",
      entries: [
        { source: "Dictionary", text: "read <script>" },
        { source: "Another", text: "second definition" },
      ],
    },
  ]);
  expect(cardFields(mapping, input.slice(0, 1)).fields.Selected).toBe("");
  expect(expressionFurigana("食べる", "たべる")).toBe("食[た]べる");
  expect(expressionFurigana("かな", "かな")).toBe("かな");
  const defaults = lapisDefaults([
    "ExpressionFurigana",
    "ExpressionReading",
    "MainDefinition",
    "Glossary",
    "Picture",
  ]);
  expect(defaults.templates).toEqual({
    ExpressionFurigana: "{{expressionFurigana}}",
    ExpressionReading: "",
    MainDefinition: "{{definition}}",
    Glossary: "{{glossary}}",
    Picture: "{{picture}}",
  });
});

describe("Anki setup", () => {
  it.each([undefined, "deck"] as const)(
    "defaults an unsaved scope to the collection and preserves a saved scope: %s",
    async (duplicateScope) => {
      vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, duplicateScope });
      view(<AnkiSettings />);
      await screen.findByText("Connected to Anki");
      expect(screen.getByLabelText("Check duplicates in")).toHaveValue(
        duplicateScope ?? "collection",
      );
      expect(api.emptyAnki.duplicateScope).toBe("collection");
    },
  );

  it("leaves the connection to its status pill, with no paragraph repeating it", async () => {
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    expect(screen.queryByText(/Choose a deck and note type/)).toBeNull();
    expect(document.querySelector(".anki-status")).toBeNull();
  });

  it("reports a missing saved deck or note type, but not one that was never chosen", async () => {
    const save = () => screen.getByRole("button", { name: "Save configuration" });
    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, deck: "", deckId: undefined, model: "" });
    const fresh = view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    expect(save()).toBeDisabled();
    expect(screen.queryByText(/Choose an available/)).toBeNull();
    expect(screen.queryByText(/note type's fields need review/)).toBeNull();
    fresh.unmount();

    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, deck: "Gone" });
    const missingDeck = view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    expect(save()).toBeDisabled();
    expect(screen.getByText(/Choose an available deck\./)).toBeInTheDocument();
    missingDeck.unmount();

    vi.mocked(api.loadAnki).mockResolvedValue({ ...prefs, model: "Gone" });
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    expect(save()).toBeDisabled();
    expect(screen.getByText(/Choose an available note type\./)).toBeInTheDocument();
  });

  it("shows connection state automatically and saves dictionary dropdowns, custom text, tags and duplicate policy", async () => {
    vi.mocked(listDictionaries).mockResolvedValue([
      {
        id: 7,
        title: "Imported dictionary",
        enabled: true,
        revision: "1",
        termCount: 10,
        kanjiCount: 0,
        termMetaCount: 0,
        kanjiMetaCount: 0,
        hasFrequency: false,
        hasPitch: false,
        hasDefinitions: true,
      },
    ]);
    const user = userEvent.setup();
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    expect(api.discoverAnki).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByLabelText("Content for Back"), "{{dictionary:7}}");
    expect(screen.getByLabelText("Back template")).toHaveValue("{{dictionary:7}}");
    await user.selectOptions(screen.getByLabelText("Content for Back"), "custom");
    expect(screen.getByLabelText("Back template")).toBeVisible();
    await user.clear(screen.getByLabelText("Back template"));
    await user.type(screen.getByLabelText("Back template"), "Custom definition");
    expect(screen.getByLabelText("Content for Back")).toHaveValue("custom");
    for (const field of ["Local port", "API key (optional)", "Card tags"])
      expect(screen.getByLabelText(field)).toHaveAttribute("spellcheck", "false");
    await user.clear(screen.getByLabelText("Card tags"));
    await user.type(screen.getByLabelText("Card tags"), "Japanese book");
    await user.selectOptions(screen.getByLabelText("Add dictionary tag"), "7");
    expect(screen.getByRole("button", { name: "Remove Imported dictionary tag" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("When the card already exists"), "overwrite");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() =>
      expect(api.saveAnki).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicatePolicy: "overwrite",
          mappings: {
            Basic: {
              ...prefs.mappings.Basic,
              tags: ["japanese", "book"],
              tagDictionaries: [7],
              templates: { Front: "{{expression}}", Back: "Custom definition" },
            },
          },
        }),
      ),
    );
    vi.mocked(api.discoverAnki).mockRejectedValue("unavailable");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Disconnected");
  });
  it("keeps text and frequency tags with the mapped fields, lowercasing and deduplicating before save/reload", async () => {
    vi.mocked(listDictionaries).mockResolvedValue([
      {
        id: 42,
        title: "TMW",
        enabled: true,
        revision: "1",
        termCount: 0,
        kanjiCount: 0,
        termMetaCount: 100,
        kanjiMetaCount: 0,
        hasFrequency: true,
        hasPitch: false,
        hasDefinitions: false,
      },
    ]);
    const user = userEvent.setup();
    const first = view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    const tags = screen.getByLabelText("Add dictionary tag");
    expect(tags.closest(".anki-mappings")).toBe(
      screen.getByLabelText("Content for Back").closest(".anki-mappings"),
    );
    expect(
      tags.compareDocumentPosition(screen.getByLabelText("Check duplicates in")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByLabelText("Content for Back")).not.toContainHTML(
      'value="{{dictionary:42}}"',
    );
    await user.clear(screen.getByLabelText("Card tags"));
    await user.type(screen.getByLabelText("Card tags"), "JaPanese BookTag JaPanese booktag");
    await user.selectOptions(tags, "42");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    const saved = vi.mocked(api.saveAnki).mock.calls[0][0];
    expect(saved.mappings.Basic.tagDictionaries).toEqual([42]);
    expect(saved.mappings.Basic.tags).toEqual(["japanese", "booktag"]);
    first.unmount();
    vi.mocked(api.loadAnki).mockResolvedValue(saved);
    view(<AnkiSettings />);
    expect(await screen.findByRole("button", { name: "Remove TMW tag" })).toBeVisible();
    expect(screen.getByLabelText("Card tags")).toHaveValue("japanese booktag");
    await user.click(screen.getByRole("button", { name: "Remove TMW tag" }));
    expect(screen.queryByRole("button", { name: "Remove TMW tag" })).not.toBeInTheDocument();
  });
  it("shows pending, success and failure beside Save, locks edits and permits repeated saves and retry", async () => {
    let finish!: () => void;
    vi.mocked(api.saveAnki).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    const save = screen.getByRole("button", { name: "Save configuration" });
    const bar = save.closest(".anki-save-bar")!;
    await user.click(save);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(bar).toHaveAttribute("aria-busy", "true");
    expect(bar).toHaveTextContent("Saving Anki configuration…");
    expect(screen.getByLabelText("Card tags")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    fireEvent.click(save);
    expect(api.saveAnki).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(bar).toHaveTextContent("Anki configuration saved on this computer.");
    expect(bar).toHaveAttribute("data-state", "saved");
    expect(save).toBeEnabled();
    vi.mocked(api.saveAnki).mockRejectedValueOnce("storage");
    save.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration could not be saved.");
    expect(screen.getByRole("alert").closest(".anki-save-bar")).toBe(bar);
    expect(save).toBeEnabled();
    await user.keyboard(" ");
    await waitFor(() => expect(bar).toHaveAttribute("data-state", "saved"));
    expect(api.saveAnki).toHaveBeenCalledTimes(3);
    await user.type(screen.getByLabelText("Card tags"), " NewTag");
    expect(bar.querySelector("p")).toHaveTextContent("");
    expect(bar).toHaveAttribute("data-state", "idle");
    await user.clear(screen.getByLabelText("Local port"));
    await user.type(screen.getByLabelText("Local port"), "8877");
    expect(screen.getByText("Connection not checked")).toBeVisible();
    expect(screen.getByText("Test the connection to continue with these choices.")).toBeVisible();
  });
  it("keeps invalid tag/template feedback beside Save and clears it after correction", async () => {
    const user = userEvent.setup();
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    const tags = screen.getByLabelText("Card tags");
    const save = screen.getByRole("button", { name: "Save configuration" });
    fireEvent.change(tags, { target: { value: "あ".repeat(43) } });
    expect(tags).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/128 UTF-8 bytes/);
    fireEvent.click(save);
    expect(api.saveAnki).not.toHaveBeenCalled();
    await user.clear(tags);
    await user.type(tags, "MixedCase");
    expect(tags).toHaveAttribute("aria-invalid", "false");
    await user.click(screen.getByRole("button", { name: "Edit Front template" }));
    fireEvent.change(screen.getByLabelText("Front template"), { target: { value: "{{bad}}" } });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/Fix invalid templates/);
    await user.selectOptions(screen.getByLabelText("Content for Front"), "{{expression}}");
    expect(save).toBeEnabled();
    await user.click(save);
    await screen.findByText("Anki configuration saved on this computer.");
  });
  it("normalizes independent text tags while keeping dictionary choices when switching note types", async () => {
    const saved = structuredClone(prefs);
    saved.mappings.Basic.tags = ["BasicTag"];
    saved.mappings.Basic.tagDictionaries = [42];
    saved.mappings.Other = {
      ...structuredClone(saved.mappings.Basic),
      modelId: 5,
      tags: ["OtherTAG"],
      tagDictionaries: [43],
    };
    vi.mocked(api.loadAnki).mockResolvedValue(saved);
    const user = userEvent.setup();
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    await user.type(screen.getByLabelText("Card tags"), " EditedTag");
    await user.selectOptions(screen.getByLabelText("Note type"), "Other");
    await screen.findByText("Connected to Anki");
    expect(screen.getByLabelText("Card tags")).toHaveValue("othertag");
    expect(
      screen.getByRole("button", { name: "Remove Unavailable dictionary #43 tag" }),
    ).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Note type"), "Basic");
    await screen.findByText("Connected to Anki");
    expect(screen.getByLabelText("Card tags")).toHaveValue("basictag editedtag");
    expect(
      screen.getByRole("button", { name: "Remove Unavailable dictionary #42 tag" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(vi.mocked(api.saveAnki).mock.calls[0][0].mappings.Other.tags).toEqual(["othertag"]);
  });
  it("discards save feedback from a disposed editor", async () => {
    let fail!: (error: string) => void;
    vi.mocked(api.saveAnki).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    first.unmount();
    view(<AnkiSettings />);
    await screen.findByText("Connected to Anki");
    await act(async () => fail("storage"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  });
  it("requires explicit repair for decks and note types recreated under the same names", async () => {
    vi.mocked(api.discoverAnki).mockResolvedValue({
      ...discovery,
      deckIds: { Study: 10, Other: 3 },
      modelIds: { Basic: 20 },
    });
    view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Accept current deck" });
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept current deck" }));
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept current fields" }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() =>
      expect(api.saveAnki).toHaveBeenCalledWith({
        ...prefs,
        deckId: 10,
        mappings: { Basic: { ...prefs.mappings.Basic, modelId: 20 } },
      }),
    );
  });
  it("creates Lapis only on acceptance, refreshes discovery and offers explicit defaults", async () => {
    vi.mocked(api.createLapis).mockResolvedValue("created");
    view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Create Lapis…" });
    fireEvent.click(screen.getByRole("button", { name: "Create Lapis…" }));
    expect(api.createLapis).not.toHaveBeenCalled();
    vi.mocked(api.discoverAnki).mockResolvedValue({
      ...discovery,
      models: ["Basic", "Lapis"],
      lapis: "compatible",
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Lapis" }));
    await screen.findByText(/Lapis is available/);
    expect(api.createLapis).toHaveBeenCalledTimes(1);
    vi.mocked(api.discoverAnki).mockResolvedValue({
      ...discovery,
      models: ["Basic", "Lapis"],
      fields: ["Expression", "MainDefinition", "Sentence", "Picture"],
      lapis: "compatible",
    });
    fireEvent.change(screen.getByLabelText("Note type"), { target: { value: "Lapis" } });
    await screen.findByRole("button", { name: "Apply Lapis defaults" });
    fireEvent.click(screen.getByRole("button", { name: "Apply Lapis defaults" }));
    expect(screen.getByLabelText("Expression template")).toHaveValue("{{expression}}");
    expect(screen.getByLabelText("Picture template")).toHaveValue("{{picture}}");
    expect(api.saveAnki).not.toHaveBeenCalled();
    expect(api.createNote).not.toHaveBeenCalled();
  });
  it("requires renewed discovery after failed Lapis creation", async () => {
    vi.mocked(api.createLapis).mockRejectedValue("unavailable");
    view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Create Lapis…" });
    fireEvent.click(screen.getByRole("button", { name: "Create Lapis…" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Lapis" }));
    await screen.findByText(/Test discovery again before retrying/);
    expect(screen.queryByRole("button", { name: "Create Lapis…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Create Lapis…" });
    expect(api.createLapis).toHaveBeenCalledTimes(1);
  });
  it("loads saved independent choices, repairs changed fields explicitly and saves", async () => {
    vi.mocked(api.discoverAnki).mockResolvedValue({ ...discovery, fields: ["Front", "New"] });
    view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Card configuration");
    expect(screen.getByLabelText("Deck")).toHaveValue("Study");
    expect(screen.getByLabelText("Note type")).toHaveValue("Basic");
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept current fields" }));
    expect(screen.getByLabelText("Front template")).toHaveValue("{{expression}}");
    expect(screen.queryByLabelText("Back")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New template"), {
      target: { value: "{{definition}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() =>
      expect(api.saveAnki).toHaveBeenCalledWith({
        ...prefs,
        mappings: {
          Basic: {
            modelId: 2,
            fields: ["Front", "New"],
            templates: { Front: "{{expression}}", New: "{{definition}}" },
          },
        },
      }),
    );
  });
  it("requires explicit acceptance for missing Lapis, preserves decline and refreshes after failure", async () => {
    view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Create Lapis…" });
    expect(api.createLapis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create Lapis…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.createLapis).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create Lapis…" })).not.toBeInTheDocument();
  });
  it("reports unavailable service and rejects late setup responses after disposal", async () => {
    vi.mocked(api.discoverAnki).mockRejectedValue("unavailable");
    const result = view(<AnkiSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Anki is not reachable/);
    expect(api.saveAnki).not.toHaveBeenCalled();
    result.unmount();
  });
});

it("persists the popup action independently with enabled legacy defaults", async () => {
  const saver = {
    load: vi.fn(async () => ({ readerPopupAnkiAction: false, readerPopupVoiceAction: true })),
    save: vi.fn(async () => {}),
  };
  function Control() {
    const value = useAppearance();
    return (
      <button onClick={() => value.setReaderPopupAnkiAction(!value.readerPopupAnkiAction)}>
        {value.readerPopupAnkiAction ? "Anki on" : "Anki off"}
      </button>
    );
  }
  render(
    <AppearanceProvider store={saver}>
      <Control />
    </AppearanceProvider>,
  );
  await screen.findByRole("button", { name: "Anki off" });
  fireEvent.click(screen.getByRole("button", { name: "Anki off" }));
  await waitFor(() =>
    expect(saver.save).toHaveBeenCalledWith(
      expect.objectContaining({ readerPopupAnkiAction: true, readerPopupVoiceAction: true }),
    ),
  );
  expect(normalizeAppearancePreferences({ readerPopupAnkiAction: "bad" })).not.toHaveProperty(
    "readerPopupAnkiAction",
  );
});
