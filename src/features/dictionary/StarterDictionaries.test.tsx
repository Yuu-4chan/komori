import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictionarySources } from "./DictionarySources";
import { StarterDictionaries } from "./StarterDictionaries";
import { useStarterDictionaryNotifications, type StarterSnapshot } from "./useStarterDictionaries";
import { dictionariesChanged } from "./sourcePolicy";
import type { DictionarySummary } from "./dictionaryApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const platform = vi.hoisted(() => ({ isAndroid: false }));
vi.mock("../../app/platform", () => platform);
let callback: EventCallback<StarterSnapshot>;
let snapshot: StarterSnapshot;
let dictionaries: DictionarySummary[];
const stop = vi.fn();
const imported: DictionarySummary = {
  id: 1,
  title: "Jitendex",
  revision: "1",
  enabled: true,
  termCount: 2,
  termMetaCount: 0,
  kanjiCount: 0,
  kanjiMetaCount: 0,
  hasDefinitions: true,
  hasFrequency: false,
  hasPitch: false,
  language: "ja",
};
const emit = () =>
  act(() =>
    callback({ event: "starter-dictionaries-changed", id: 1, payload: structuredClone(snapshot) }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  dictionaries = [];
  snapshot = {
    revision: 0,
    started: false,
    dismissed: false,
    entries: ["Jitendex", "JMdict", "Jiten frequency"].map((name, i) => ({
      id: ["jitendex", "jmdict", "jiten"][i],
      name,
      description: `${name} description`,
      language: "ja",
      definitions: "en",
      attribution: `${name} attribution`,
      license: "CC BY-SA 4.0",
      phase: "ready",
      received: 0,
      total: null,
    })),
  };
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "starter-dictionaries-changed")
      callback = handler as EventCallback<StarterSnapshot>;
    return stop;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_dictionaries") return dictionaries;
    if (command === "get_starter_dictionaries") return structuredClone(snapshot);
    if (command === "open_starter_information") return undefined;
    if (command === "download_starter_dictionary") {
      snapshot.started = true;
      snapshot.revision++;
      snapshot.entries.find(({ id }) => id === (args as { id: string }).id)!.phase = "downloading";
      return structuredClone(snapshot);
    }
    if (command === "dismiss_starter_dictionaries") {
      snapshot.dismissed = true;
      snapshot.revision++;
      return structuredClone(snapshot);
    }
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => {
  cleanup();
  platform.isAndroid = false;
});

it("notifies Dictionary and Reader consumers when Settings is absent, rejects old events and disposes the app listener", async () => {
  function ApplicationNotifications() {
    useStarterDictionaryNotifications();
    return null;
  }
  const changed = vi.fn();
  window.addEventListener(dictionariesChanged, changed);
  const view = render(<ApplicationNotifications />);
  await waitFor(() => expect(listen).toHaveBeenCalled());
  snapshot.revision = 1;
  snapshot.entries[0].phase = "downloading";
  emit();
  expect(changed).not.toHaveBeenCalled();
  snapshot.revision = 2;
  snapshot.entries[0].phase = "imported";
  emit();
  expect(changed).toHaveBeenCalledOnce();
  snapshot.revision = 1;
  emit();
  expect(changed).toHaveBeenCalledOnce();
  view.unmount();
  snapshot.revision = 3;
  emit();
  expect(changed).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalled();
  window.removeEventListener(dictionariesChanged, changed);
});

it("offers independent sources and native attribution while keeping manual import; hides the offer for existing dictionaries", async () => {
  const user = userEvent.setup();
  const first = render(<DictionarySources />);
  await screen.findByRole("button", { name: "Download Jitendex" });
  expect(screen.getByRole("button", { name: "Download JMdict" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Download Jiten frequency" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add dictionaries" })).toBeEnabled();
  await user.click(screen.getAllByRole("button", { name: "Source & attribution" })[1]);
  expect(invoke).toHaveBeenCalledWith("open_starter_information", { id: "jmdict", license: false });
  await user.click(screen.getAllByRole("button", { name: "CC BY-SA 4.0" })[2]);
  expect(invoke).toHaveBeenCalledWith("open_starter_information", { id: "jiten", license: true });
  first.unmount();
  dictionaries = [imported];
  render(<DictionarySources />);
  await screen.findByText("Jitendex");
  expect(screen.queryByText("Start with Japanese dictionaries")).not.toBeInTheDocument();
});

it("retains native byte/verification/import progress across navigation, rejects old events, refreshes sources and distinguishes duplicate outcomes", async () => {
  const user = userEvent.setup();
  const first = render(<DictionarySources />);
  await user.click(await screen.findByRole("button", { name: "Download Jitendex" }));
  expect(invoke).toHaveBeenCalledWith("download_starter_dictionary", { id: "jitendex" });
  expect(screen.getByRole("button", { name: "Add dictionaries" })).toBeDisabled();
  const active = structuredClone(snapshot);
  snapshot.revision = 0;
  snapshot.entries[0].phase = "ready";
  emit();
  expect(screen.getByRole("button", { name: "Add dictionaries" })).toBeDisabled();
  snapshot = active;
  snapshot.revision++;
  snapshot.entries[0].received = 1024 * 1024;
  snapshot.entries[0].total = 2 * 1024 * 1024;
  emit();
  expect(screen.getByRole("progressbar")).toHaveValue(1024 * 1024);
  first.unmount();
  const second = render(<DictionarySources />);
  expect(stop).toHaveBeenCalled();
  await screen.findByText("Downloading… 1.0 MB / 2.0 MB");
  snapshot.revision++;
  snapshot.entries[0].phase = "verifying";
  emit();
  expect(screen.getByText("Verifying download…")).toBeInTheDocument();
  const latest = structuredClone(snapshot);
  snapshot.revision = 0;
  snapshot.entries[0].phase = "failed";
  emit();
  expect(screen.queryByRole("button", { name: "Retry Jitendex" })).not.toBeInTheDocument();
  snapshot = latest;
  snapshot.revision++;
  snapshot.entries[0].phase = "importing";
  emit();
  expect(screen.getByText(/Importing… Large/)).toBeInTheDocument();
  // The phone's settings carry no explanations, so its status is the progress alone.
  platform.isAndroid = true;
  snapshot.revision++;
  emit();
  expect(screen.getByText("Importing…")).toBeInTheDocument();
  platform.isAndroid = false;
  dictionaries = [imported];
  snapshot.revision++;
  snapshot.entries[0].phase = "imported";
  snapshot.entries[0].title = "Jitendex";
  emit();
  await screen.findByRole("button", { name: "Remove Jitendex" });
  expect(screen.getByRole("button", { name: "Download JMdict" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Download Jitendex" }));
  snapshot.revision++;
  snapshot.entries[0].phase = "alreadyImported";
  emit();
  expect(screen.getByText(/No duplicate was added/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("Start with Japanese dictionaries")).not.toBeInTheDocument();
  second.unmount();
});

it("says a download is added only while its dictionary is installed", async () => {
  snapshot.started = true;
  snapshot.entries[1].phase = "imported";
  snapshot.entries[1].title = "JMdict [2026-10-04]";
  snapshot.entries[2].phase = "alreadyImported";
  render(<DictionarySources />);
  await screen.findByRole("button", { name: "Download JMdict" });
  expect(screen.queryByText(/Added to your dictionaries/)).not.toBeInTheDocument();
  expect(screen.queryByText(/No duplicate was added/)).not.toBeInTheDocument();
  cleanup();
  dictionaries = [{ ...imported, id: 2, title: "JMdict [2026-10-04]" }];
  render(<DictionarySources />);
  expect(await screen.findByText(/Added to your dictionaries/)).toBeInTheDocument();
});

it("loads interrupted work after restart, retains failure/retry and refuses simultaneous clicks", async () => {
  snapshot.started = true;
  snapshot.entries[2].phase = "interrupted";
  const user = userEvent.setup();
  render(<DictionarySources />);
  const retry = await screen.findByRole("button", { name: "Retry Jiten frequency" });
  expect(screen.getByText(/was interrupted/)).toBeInTheDocument();
  await user.dblClick(retry);
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_starter_dictionary"),
  ).toHaveLength(1);
  snapshot.revision++;
  snapshot.entries[2].phase = "failed";
  emit();
  expect(screen.getByText(/Download or import failed/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry Jiten frequency" }));
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_starter_dictionary"),
  ).toHaveLength(2);
});

it("retries a failed status load", async () => {
  const user = userEvent.setup();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
  // A failed list still retains its normal error state; reload the component for the status failure.
  const first = render(<DictionarySources />);
  await screen.findByText(/Your dictionaries could not be loaded/);
  first.unmount();
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_starter_dictionaries") throw new Error("unavailable");
    return normal(command, args);
  });
  render(<DictionarySources />);
  await screen.findByText(/Starter dictionaries could not be loaded/);
  vi.mocked(invoke).mockImplementation(normal);
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: "Download JMdict" });
  await waitFor(() => expect(stop).toHaveBeenCalled());
});

it("keeps a newer native event when an initial snapshot arrives late", async () => {
  let resolve!: (value: StarterSnapshot) => void;
  const loading = new Promise<StarterSnapshot>((done) => {
    resolve = done;
  });
  const initial = structuredClone(snapshot);
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "get_starter_dictionaries" ? loading : normal(command, args),
  );
  render(<DictionarySources />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_starter_dictionaries"));
  snapshot.started = true;
  snapshot.revision = 10;
  snapshot.entries[1].phase = "failed";
  emit();
  await screen.findByRole("button", { name: "Retry JMdict" });
  await act(async () => resolve(initial));
  expect(screen.getByRole("button", { name: "Retry JMdict" })).toBeInTheDocument();
});

describe("starter dictionaries for each language", () => {
  const entry = (id: string, language: string, definitions: string | null) => ({
    id,
    language,
    definitions,
    name: id,
    description: "",
    attribution: "",
    license: "CC BY-SA 4.0",
    phase: "ready" as const,
    received: 0,
    total: null,
  });
  const starter = {
    snapshot: {
      revision: 1,
      started: false,
      dismissed: false,
      entries: [
        entry("jitendex", "ja", "en"),
        entry("jiten", "ja", null),
        entry("wty-ko-en", "ko", "en"),
        entry("wty-ko-en-ipa", "ko", "en"),
        entry("wty-ko-zh", "ko", "zh"),
        entry("wty-fr-en", "fr", "en"),
        entry("wty-en-vi", "en", "vi"),
        entry("wty-en-de", "en", "de"),
      ],
    },
    error: false,
    retry: vi.fn(),
    download: vi.fn(),
    dismiss: vi.fn(),
  };
  const rows = () =>
    screen.getAllByRole("article").map((row) => row.getAttribute("aria-labelledby"));

  it("lists the language's dictionaries for the chosen definitions language", async () => {
    const choose = vi.fn();
    const props = { empty: true, installed: [], busy: false, starter };
    const view = render(
      <StarterDictionaries {...props} language="ko" onDefinitionsChange={choose} />,
    );
    expect(rows()).toEqual(["starter-wty-ko-en", "starter-wty-ko-en-ipa"]);
    expect(screen.getByText("Korean words with definitions in English.")).toBeInTheDocument();
    expect(screen.getByText("Korean pronunciations in IPA.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Definitions in"), { target: { value: "zh" } });
    expect(choose).toHaveBeenCalledWith("zh");

    view.rerender(<StarterDictionaries {...props} language="ko" savedDefinitions="zh" />);
    expect(rows()).toEqual(["starter-wty-ko-zh"]);
    // A saved choice this language lacks falls back, and one choice needs no select.
    view.rerender(<StarterDictionaries {...props} language="fr" savedDefinitions="zh" />);
    expect(rows()).toEqual(["starter-wty-fr-en"]);
    expect(screen.queryByLabelText("Definitions in")).toBeNull();
    // Definitions can be in a language lookups don't have, named by the system.
    view.rerender(<StarterDictionaries {...props} language="en" savedDefinitions="vi" />);
    expect(rows()).toEqual(["starter-wty-en-vi"]);
    expect(screen.getByText("English words with definitions in Vietnamese.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Vietnamese" })).toBeInTheDocument();
    // Sources without definitions stay listed.
    view.rerender(<StarterDictionaries {...props} language="ja" />);
    expect(rows()).toEqual(["starter-jitendex", "starter-jiten"]);
  });

  it("names Kurdish definitions where the system has no name for them", () => {
    const withKurdish = {
      ...starter,
      snapshot: {
        ...starter.snapshot,
        entries: [...starter.snapshot.entries, entry("wty-en-ku", "en", "ku")],
      },
    };
    // Android's WebView gives Kurdish's code as its name.
    const system = Intl.DisplayNames.prototype.of;
    vi.spyOn(Intl.DisplayNames.prototype, "of").mockImplementation(function (
      this: Intl.DisplayNames,
      code: string,
    ) {
      return code === "ku" ? code : system.call(this, code);
    });
    try {
      render(
        <StarterDictionaries
          empty
          installed={[]}
          busy={false}
          starter={withKurdish}
          language="en"
          savedDefinitions="ku"
        />,
      );
      expect(screen.getByRole("option", { name: "Kurdish" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Vietnamese" })).toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
