import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DictionarySources } from "./DictionarySources";
import { useStarterDictionaryNotifications, type StarterSnapshot } from "./useStarterDictionaries";
import { dictionariesChanged } from "./sourcePolicy";
import type { DictionarySummary } from "./dictionaryApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
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
afterEach(cleanup);

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
