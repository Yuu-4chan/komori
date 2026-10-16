import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { PronunciationButton } from "./DictionaryResults";
import { WordAudioSettings } from "./WordAudioSettings";
import { getWordAudio, normalizeWordAudioSources, validWordAudioUrl } from "./wordAudio";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));

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

const recording = { mime: "audio/mpeg", data: btoa("ID3 word") };
const listSource = { kind: "list", url: "http://localhost:5050/?term={term}" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  MockAudio.played = [];
  vi.stubGlobal("Audio", MockAudio);
  URL.createObjectURL = vi.fn(() => "blob:word");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("word audio sources", () => {
  it("accepts only http(s) URLs with a host, filled placeholders and no repeats", () => {
    expect(validWordAudioUrl("http://localhost:5050/?term={term}&reading={reading}")).toBe(true);
    expect(validWordAudioUrl("https://example.com/{language}/{term}.mp3")).toBe(true);
    for (const url of ["", "file:///C:/{term}.mp3", "ftp://example.com/{term}", "{term}"])
      expect(validWordAudioUrl(url), url).toBe(false);
    expect(validWordAudioUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
    expect(validWordAudioUrl("https://example.com/\n{term}")).toBe(false);

    expect(normalizeWordAudioSources([listSource, { kind: "jpod101" }])).toEqual([
      listSource,
      { kind: "jpod101" },
    ]);
    expect(normalizeWordAudioSources([])).toEqual([]);
    for (const invalid of [
      [{ kind: "jpod101" }, { kind: "jpod101" }],
      [{ kind: "url", url: "file:///C:/a.mp3" }],
      [{ kind: "jpod101", url: "https://example.com" }],
      [{ kind: "other" }],
      Array.from({ length: 9 }, (_, n) => ({ kind: "url", url: `https://e.com/${n}` })),
      "jpod101",
    ])
      expect(normalizeWordAudioSources(invalid)).toBeUndefined();
    // A saved record keeps its valid choices and leaves out the rest.
    expect(normalizeAppearancePreferences({ wordAudioSources: [listSource] })).toMatchObject({
      wordAudioSources: [listSource],
    });
    expect(normalizeAppearancePreferences({ wordAudioSources: [{ kind: "x" }] })).toEqual({});
  });

  it("asks native code for the word and decodes its recording", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(recording).mockResolvedValueOnce(null);
    const blob = await getWordAudio("読む", "よむ");
    expect(invoke).toHaveBeenCalledWith("get_word_audio", { term: "読む", reading: "よむ" });
    expect(blob?.type).toBe("audio/mpeg");
    expect(blob?.size).toBe("ID3 word".length);
    expect(await getWordAudio("無音", "むおん")).toBeNull();
  });
});

describe("Voice with word audio", () => {
  it("plays the first recording, one at a time, and releases it when it ends", async () => {
    vi.mocked(invoke).mockResolvedValue(recording);
    const user = userEvent.setup();
    render(
      <>
        <PronunciationButton canPlay expression="読む" reading="よむ" />
        <PronunciationButton canPlay expression="詠む" reading="よむ" />
      </>,
    );
    const [first, second] = screen.getAllByRole("button");
    await user.click(first);
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
    expect(invoke).toHaveBeenCalledWith("get_word_audio", { term: "読む", reading: "よむ" });
    expect(MockAudio.played[0].src).toBe("blob:word");

    await user.click(second);
    await waitFor(() => expect(second).toHaveAttribute("aria-pressed", "true"));
    expect(MockAudio.played[0].pause).toHaveBeenCalled();
    expect(first).toHaveAttribute("aria-pressed", "false");
    act(() => MockAudio.played[1].onended?.());
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("says when no source has the word, and plays nothing without sources", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const user = userEvent.setup();
    const { rerender } = render(<PronunciationButton canPlay expression="読む" reading="よむ" />);
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveAttribute("title", "No audio for 読む"),
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    expect(MockAudio.played).toEqual([]);

    rerender(<PronunciationButton canPlay={false} expression="読む" reading="よむ" />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute("title", "No word audio sources");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("Settings > Dictionary > Word audio", () => {
  function renderSettings(load: Partial<AppearancePreferences> = {}) {
    const saved: AppearancePreferences[] = [];
    render(
      <AppearanceProvider
        store={{
          load: async () => load,
          save: async (preferences) => {
            saved.push(preferences);
          },
        }}
      >
        <WordAudioSettings />
      </AppearanceProvider>,
    );
    return saved;
  }
  const rows = () =>
    within(screen.getByRole("list", { name: "Word audio sources" }))
      .getAllByRole("listitem")
      .map((row) => row.querySelector("strong")?.textContent);

  it("adds, orders and removes sources, refusing invalid and repeated ones, and saves each change", async () => {
    const user = userEvent.setup();
    const saved = renderSettings();
    await screen.findByRole("list", { name: "Word audio sources" });
    expect(rows()).toEqual(["JapanesePod101"]);
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();

    const url = screen.getByRole("textbox", { name: "URL" });
    await user.type(url, "file:///C:/audio.mp3");
    expect(screen.getByRole("status")).toHaveTextContent("Enter an http or https URL.");
    expect(add).toBeDisabled();
    await user.clear(url);
    await user.type(url, "http://localhost:5050/?term={{term}");
    await user.selectOptions(screen.getByRole("combobox", { name: "New source" }), "list");
    await user.click(add);
    expect(rows()).toEqual(["JapanesePod101", "http://localhost:5050/?term={term}"]);
    await waitFor(() =>
      expect(saved.at(-1)?.wordAudioSources).toEqual([{ kind: "jpod101" }, listSource]),
    );
    expect(url).toHaveValue("");
    await user.type(url, "http://localhost:5050/?term={{term}");
    await user.selectOptions(screen.getByRole("combobox", { name: "New source" }), "list");
    expect(screen.getByRole("status")).toHaveTextContent("This source is already listed.");

    await user.click(screen.getByRole("button", { name: "Move JapanesePod101 down" }));
    expect(rows()).toEqual(["http://localhost:5050/?term={term}", "JapanesePod101"]);
    const jpod101 = screen.getAllByRole("listitem")[1];
    jpod101.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(rows()).toEqual(["JapanesePod101", "http://localhost:5050/?term={term}"]);
    await user.click(screen.getByRole("button", { name: "Remove JapanesePod101" }));
    expect(rows()).toEqual(["http://localhost:5050/?term={term}"]);
    await waitFor(() => expect(saved.at(-1)?.wordAudioSources).toEqual([listSource]));
    // A removed JapanesePod101 can be added again.
    await user.selectOptions(screen.getByRole("combobox", { name: "New source" }), "jpod101");
    expect(screen.queryByRole("textbox", { name: "URL" })).toBeNull();
    await user.click(add);
    expect(rows()).toEqual(["http://localhost:5050/?term={term}", "JapanesePod101"]);
  });

  it("shows an empty list", async () => {
    renderSettings({ wordAudioSources: [] });
    expect(await screen.findByText("No sources.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Windows Japanese voice" })).toBeNull();
  });
});
