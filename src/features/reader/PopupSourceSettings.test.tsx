import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import {
  listDictionaries,
  lookupTerms,
  lookupKanji,
  type DictionarySummary,
  type TermLookup,
} from "../dictionary/dictionaryApi";
import { dictionariesChanged, normalizeSourceSelection } from "../dictionary/sourcePolicy";
import { ReaderPopupSettings } from "./ReaderPopupSettings";
import { PopupSourceSettings } from "./PopupSourceSettings";

vi.mock("../dictionary/dictionaryApi", () => ({
  listDictionaries: vi.fn(),
  lookupTerms: vi.fn(),
  lookupKanji: vi.fn(),
}));
const dictionaries: DictionarySummary[] = [
  {
    id: 1,
    title: "Definitions",
    revision: "1",
    enabled: true,
    termCount: 1,
    termMetaCount: 0,
    kanjiCount: 1,
    kanjiMetaCount: 0,
    hasFrequency: false,
    hasPitch: false,
    hasDefinitions: true,
  },
  {
    id: 2,
    title: "Frequency",
    revision: "1",
    enabled: true,
    termCount: 0,
    termMetaCount: 1,
    kanjiCount: 0,
    kanjiMetaCount: 1,
    hasFrequency: true,
    hasPitch: false,
    hasDefinitions: false,
  },
  {
    id: 3,
    title: "Pitch",
    revision: "1",
    enabled: false,
    termCount: 0,
    termMetaCount: 1,
    kanjiCount: 0,
    kanjiMetaCount: 0,
    hasFrequency: false,
    hasPitch: true,
    hasDefinitions: false,
  },
];
const result: TermLookup = {
  text: "読む",
  groups: [
    {
      expression: "読む",
      reading: "よむ",
      text: "読む",
      deinflection: null,
      terms: [
        {
          dictionaryId: 1,
          dictionaryTitle: "Definitions",
          definitionTags: "",
          rules: "v5",
          score: 0,
          sequence: 1,
          termTags: "",
          tags: [],
          glossary: ["to read"],
        },
      ],
      frequencies: [{ dictionaryId: 2, dictionaryTitle: "Frequency", data: 10 }],
      pitches: [
        {
          dictionaryId: 3,
          dictionaryTitle: "Pitch",
          data: { reading: "よむ", pitches: [{ position: 0 }] },
        },
      ],
    },
  ],
};
beforeEach(() => {
  vi.mocked(listDictionaries).mockReset().mockResolvedValue(dictionaries);
  vi.mocked(lookupTerms).mockReset().mockResolvedValue(result);
  vi.mocked(lookupKanji).mockReset().mockResolvedValue({ entries: [], frequencies: [] });
});

function open(saved: Partial<AppearancePreferences> = {}) {
  const store = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (_preferences: AppearancePreferences) => {}),
  };
  const dictionarySettings = vi.fn();
  const view = render(
    <MemoryRouter>
      <AppearanceProvider store={store}>
        <ReaderPopupSettings onDictionarySettings={dictionarySettings} />
      </AppearanceProvider>
    </MemoryRouter>,
  );
  return { ...view, store, dictionarySettings };
}

describe("popup source policies", () => {
  it("shows a frequency source with empty term placeholders only in its actual role", async () => {
    vi.mocked(listDictionaries).mockResolvedValue([
      ...dictionaries,
      { ...dictionaries[1], id: 4, title: "TMW", termCount: 243796, hasDefinitions: false },
    ]);
    open();
    await screen.findByText("to read");
    fireEvent.click(await screen.findByRole("button", { name: "Select term dictionaries" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source selection" }), {
      target: { value: "selected" },
    });
    expect(within(screen.getByRole("dialog")).queryByText("TMW")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Select frequency dictionaries" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source selection" }), {
      target: { value: "selected" },
    });
    expect(await within(screen.getByRole("dialog")).findByText("TMW")).toBeInTheDocument();
  });

  it("validates each role independently with bounded stable IDs and legacy defaults", () => {
    expect(defaultAppearance.readerPopupDefinitionSources).toEqual({ mode: "all" });
    expect(defaultAppearance.readerPopupFrequencySources).toEqual({ mode: "all" });
    expect(defaultAppearance.readerPopupPitchSources).toEqual({ mode: "all" });
    for (const invalid of [
      { mode: "selected", ids: [0] },
      { mode: "selected", ids: [1.5] },
      { mode: "selected", ids: [1, 1] },
      { mode: "selected", ids: [Number.MAX_SAFE_INTEGER + 1] },
      { mode: "selected", ids: Array.from({ length: 129 }, (_, i) => i + 1) },
      { mode: "all", ids: [] },
      { mode: "unknown" },
    ]) {
      expect(normalizeSourceSelection(invalid)).toBeUndefined();
      const kept = normalizeAppearancePreferences({
        readerPopupDefinitionSources: invalid,
        readerPopupFrequencySources: { mode: "none" },
        readerPopupPitchSources: { mode: "selected", ids: [1] },
      });
      expect(kept.readerPopupDefinitionSources).toBeUndefined();
      expect(kept.readerPopupFrequencySources).toEqual({ mode: "none" });
      expect(kept.readerPopupPitchSources).toEqual({ mode: "selected", ids: [1] });
    }
  });

  it("offers every role and all/explicit/none, saves/reopens, and cancels with keyboard focus restored", async () => {
    const user = userEvent.setup();
    const view = open();
    await screen.findByRole("button", { name: "Select term dictionaries" });
    await waitFor(() =>
      expect(screen.queryByText("Loading dictionary sources…")).not.toBeInTheDocument(),
    );
    for (const [label, field] of [
      ["term", "readerPopupDefinitionSources"],
      ["frequency", "readerPopupFrequencySources"],
      ["pitch", "readerPopupPitchSources"],
    ] as const) {
      for (const mode of ["selected", "none", "all"] as const) {
        const opener = screen.getByRole("button", { name: `Select ${label} dictionaries` });
        opener.focus();
        await user.keyboard("{Enter}");
        const dialog = screen.getByRole("dialog", { name: `Select ${label} dictionaries` });
        await user.selectOptions(within(dialog).getByRole("combobox"), mode);
        if (mode === "selected") {
          const checkboxes = within(dialog).getAllByRole("checkbox");
          expect(checkboxes).toHaveLength(1);
          (checkboxes[0] as HTMLElement).focus();
          await user.keyboard(" ");
        }
        within(dialog).getByRole("button", { name: "Apply" }).focus();
        await user.keyboard("{Enter}");
        await waitFor(() => expect(view.store.save.mock.lastCall?.[0][field].mode).toBe(mode));
        expect(opener).toHaveFocus();
      }
    }
    const before = view.store.save.mock.lastCall![0];
    const opener = screen.getByRole("button", { name: "Select term dictionaries" });
    opener.focus();
    await user.keyboard("{Enter}");
    await user.selectOptions(screen.getByRole("combobox", { name: "Source selection" }), "none");
    screen.getByRole("button", { name: "Cancel" }).focus();
    await user.keyboard("{Enter}");
    expect(opener).toHaveFocus();
    expect(view.store.save.mock.lastCall![0]).toEqual(before);
    opener.focus();
    await user.keyboard("{Enter}");
    await user.selectOptions(screen.getByRole("combobox", { name: "Source selection" }), "none");
    // Native dialogs translate Escape into cancel; jsdom lacks showModal's default behavior.
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(opener).toHaveFocus();
    expect(view.store.save.mock.lastCall![0]).toEqual(before);
    view.unmount();
    open(before);
    await screen.findByRole("button", { name: "Select term dictionaries" });
    expect(await screen.findAllByText(/^All imported sources · /)).toHaveLength(3);
  });

  it("retains explicit unavailable IDs and ignores the retired global flag after maintenance", async () => {
    const view = open({ readerPopupDefinitionSources: { mode: "selected", ids: [1, 99] } });
    await screen.findByText("Definitions · 1 unavailable");
    vi.mocked(listDictionaries).mockResolvedValue([
      { ...dictionaries[0], enabled: false },
      dictionaries[1],
    ]);
    act(() => window.dispatchEvent(new Event(dictionariesChanged)));
    await screen.findByText("Definitions · 1 unavailable");
    expect(view.store.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Select term dictionaries" }));
    expect(screen.getByRole("checkbox", { name: "Unavailable source #99" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Definitions" })).toBeChecked();
  });

  it("rejects stale source lists and disposal responses without rewriting explicit choices", async () => {
    const answers: ((sources: DictionarySummary[]) => void)[] = [];
    vi.mocked(listDictionaries).mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const save = vi.fn(async () => {});
    const mount = () =>
      render(
        <AppearanceProvider
          store={{
            load: async () => ({
              readerPopupDefinitionSources: { mode: "selected", ids: [1, 99] },
            }),
            save,
          }}
        >
          <PopupSourceSettings onDictionarySettings={() => {}} />
        </AppearanceProvider>,
      );
    const view = mount();
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => window.dispatchEvent(new Event(dictionariesChanged)));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1]([dictionaries[0]]));
    await screen.findByText("Definitions · 1 unavailable");
    await act(async () => answers[0]([]));
    expect(screen.getByText("Definitions · 1 unavailable")).toBeInTheDocument();
    view.unmount();
    const next = mount();
    await waitFor(() => expect(answers).toHaveLength(3));
    next.unmount();
    await act(async () => answers[2](dictionaries));
    expect(screen.queryByText("Dictionary cards")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows loading, safe failure/retry, empty collection and Dictionary settings handoff", async () => {
    // The preview reads the list too, so every read fails until Retry.
    vi.mocked(listDictionaries).mockRejectedValue(new Error("private database path"));
    const view = open();
    await screen.findByRole("alert");
    expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
    vi.mocked(listDictionaries).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findAllByText(/No suitable dictionaries imported/);
    fireEvent.click(screen.getAllByRole("button", { name: "Open dictionary settings" })[0]);
    expect(view.dictionarySettings).toHaveBeenCalledOnce();
  });

  it("offers to get dictionaries in the preview when none can define its word", async () => {
    vi.mocked(listDictionaries).mockResolvedValue([]);
    vi.mocked(lookupTerms).mockResolvedValue({ text: "", groups: [] });
    open();
    expect(await screen.findByRole("link", { name: "Get dictionaries" })).toHaveAttribute(
      "href",
      "/settings?section=dictionary",
    );
    expect(screen.queryByText("No matches")).toBeNull();
  });
});

describe("popup source rows", () => {
  it("shows one row per role with its sources and a single Choose control", async () => {
    open({ readerPopupFrequencySources: { mode: "none" } });
    const choose = await screen.findByRole("button", { name: "Select term dictionaries" });
    const role = choose.closest(".settings-row")!;
    expect(role).not.toBeNull();
    expect(role.parentElement).toHaveClass("settings-list");
    expect(role.parentElement!.children).toHaveLength(3);
    expect(within(role as HTMLElement).getAllByRole("button")).toEqual([choose]);
    expect(choose).toHaveTextContent("Choose…");
    expect(role).toHaveTextContent("Term dictionaries");
    await waitFor(() => expect(role).toHaveTextContent("All imported sources · Definitions"));
    const frequency = screen.getByRole("button", { name: "Select frequency dictionaries" });
    expect(frequency.closest(".settings-row")).toHaveTextContent("Frequency dictionariesNone");
    expect(screen.queryByText("Active sources")).toBeNull();
  });
});

describe("real lookup preview", () => {
  function openAppearance() {
    const store = {
      load: vi.fn(async () => ({ readerPopupEnabled: false })),
      save: vi.fn(async (_preferences: AppearancePreferences) => {}),
    };
    return render(
      <MemoryRouter>
        <AppearanceProvider store={store}>
          <ReaderPopupSettings />
        </AppearanceProvider>
      </MemoryRouter>,
    );
  }

  it("always looks up 読む, with the popup off, and keeps results through behavior changes", async () => {
    open({
      readerPopupEnabled: false,
      readerPopupMouseSelection: false,
      readerPopupShiftLookup: false,
    });
    await screen.findByText("to read");
    // There is nothing to type: the preview's word is fixed.
    expect(screen.queryByRole("textbox", { name: "Preview query" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Look up" })).toBeNull();
    expect(lookupTerms).toHaveBeenCalledExactlyOnceWith("読む", undefined, 5);
    fireEvent.click(screen.getByRole("button", { name: "Show pitch" }));
    fireEvent.click(screen.getByRole("button", { name: "Show frequency" }));
    fireEvent.click(screen.getByRole("button", { name: "Voice action" }));
    expect(lookupTerms).toHaveBeenCalledOnce();
    expect(screen.getByText("to read")).toBeInTheDocument();
    // The popup's design choices sit with its behavior, above the preview.
    expect(screen.getByRole("button", { name: "Night" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Popup width" })).toBeInTheDocument();
    expect(screen.getByLabelText("Reading position")).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "Reader lookup popup",
      "Lookup appearance",
      "Popup preview",
      "Dictionary cards",
      "Lookup triggers",
      "Scanning and results",
    ]);
  });

  it("previews every design choice on the same 読む results", async () => {
    openAppearance();
    await screen.findByText("to read");
    expect(screen.queryByRole("textbox", { name: "Preview query" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    expect(preview).toHaveAttribute("data-popup-theme", "night");
    fireEvent.click(screen.getByRole("button", { name: "Increase Rounded corners" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Popup width" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Popup height" }));
    expect(preview).toHaveStyle({ width: "500px", height: "460px", borderRadius: "19px" });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const background = screen.getByRole("textbox", { name: "Popup background HEX" });
    fireEvent.change(background, { target: { value: "#eeeecc" } });
    fireEvent.blur(background);
    expect(preview).toHaveAttribute("data-popup-theme", "custom");
    expect(preview.style.getPropertyValue("--surface-card")).toBe("#eeeecc");
    fireEvent.change(screen.getByLabelText("Reading position"), { target: { value: "above" } });
    await waitFor(() => expect(preview.querySelector("ruby")).not.toBeNull());
    expect(
      preview.querySelector(
        ".lookup-entry--furigana .lookup-entry__headline > .lookup-entry__actions",
      ),
    ).toBeInTheDocument();
    expect(lookupTerms).toHaveBeenCalledOnce();
  });

  it("previews the Dictionary style, disables what it leaves out, and saves the popup font", async () => {
    const { store } = open();
    await screen.findByText("to read");
    const preview = screen.getByRole("region", { name: "Lookup: 読む" });
    const style = screen.getByRole("combobox", { name: "Popup style" });
    expect(style).toHaveValue("standard");
    expect(
      within(style)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Standard", "Dictionary"]);
    // The hint describes the chosen style.
    expect(screen.getByText(/^Standard shows each entry in full/)).toBeInTheDocument();
    const hidden = ["Add to Anki action", "Voice action", "Show pitch", "Show frequency"];
    for (const name of hidden) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(screen.getByLabelText("Reading position")).toBeEnabled();
    expect(preview.querySelector(".lookup-entry")).not.toBeNull();

    fireEvent.change(style, { target: { value: "dictionary" } });
    expect(screen.getByText(/^Dictionary shows only each headword/)).toBeInTheDocument();
    expect(screen.queryByText(/^Standard shows each entry in full/)).not.toBeInTheDocument();
    expect(preview).toHaveClass("reader-lookup--dictionary");
    expect(preview.querySelector(".dictionary-entry")).not.toBeNull();
    expect(preview.querySelector(".lookup-entry")).toBeNull();
    for (const name of hidden) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show dictionary names" })).toBeEnabled();
    expect(screen.getByLabelText("Reading position")).toBeDisabled();
    expect(
      screen.getByText("The Dictionary style always shows readings above their kanji as furigana."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(store.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ readerPopupStyle: "dictionary" }),
      ),
    );

    // The font is Zen Old Mincho until another is chosen, in either style.
    const font = screen.getByRole("combobox", { name: "Font" });
    expect(font).toHaveValue("Zen Old Mincho");
    expect(preview.style.getPropertyValue("--popup-font")).toBe(
      '"Komori Google zen-old-mincho", serif',
    );
    fireEvent.change(font, { target: { value: "Yu Mincho" } });
    fireEvent.keyDown(font, { key: "Enter" });
    expect(preview.style.getPropertyValue("--popup-font")).toBe(
      '"Yu Mincho", "Komori Google zen-old-mincho", serif',
    );
    await waitFor(() =>
      expect(store.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readerPopupStyle: "dictionary",
          readerPopupFont: { source: "preset", id: "yu-mincho" },
        }),
      ),
    );
    expect(lookupTerms).toHaveBeenCalledOnce();
  });

  it("refreshes on source changes, rejects old source/disposal responses, and keeps failures safe", async () => {
    const answers: ((value: TermLookup) => void)[] = [];
    vi.mocked(lookupTerms).mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const view = open();
    await waitFor(() => expect(lookupTerms).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Select frequency dictionaries" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source selection" }), {
      target: { value: "none" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lookupTerms).toHaveBeenCalledTimes(2));
    expect(vi.mocked(lookupTerms).mock.lastCall?.[1]?.frequency).toEqual({ mode: "none" });
    await act(async () => answers[0](result));
    expect(screen.queryByText("to read")).not.toBeInTheDocument();
    await act(async () => answers[1]({ text: "読む", groups: [] }));
    await screen.findByText("No matches");
    view.unmount();
    vi.mocked(lookupTerms).mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const late = open();
    await waitFor(() => expect(answers).toHaveLength(3));
    late.unmount();
    await act(async () => answers[2](result));
    expect(screen.queryByText("to read")).not.toBeInTheDocument();
    vi.mocked(lookupTerms).mockRejectedValue(new Error("private path"));
    open();
    await screen.findByText(/Lookup could not be completed/);
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
  });
});
