import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { DictionarySources } from "./DictionarySources";
import type { DictionarySummary } from "./dictionaryApi";
import type { BulkProgress } from "../operations/bulkOperation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => undefined,
  }),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const source = (id: number): DictionarySummary => ({
  id,
  title: `Source ${id}`,
  revision: "1",
  enabled: true,
  termCount: 1,
  termMetaCount: 0,
  kanjiCount: 0,
  kanjiMetaCount: 0,
  hasDefinitions: true,
  hasFrequency: false,
  hasPitch: false,
});

it("presents native import/removal progress across remounts, keeps failed items, and separates maintenance failure", async () => {
  const user = userEvent.setup();
  const importing = deferred<unknown>();
  const removing = deferred<unknown>();
  let listed = [source(10), source(30)];
  let callback!: EventCallback<BulkProgress>;
  let operationId = "";
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    callback = handler as EventCallback<BulkProgress>;
    return () => {};
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_dictionaries") return listed;
    operationId = (args as Record<string, unknown>).operationId as string;
    if (command === "import_dictionaries") return importing.promise;
    if (command === "remove_dictionaries") return removing.promise;
    throw new Error(`Unexpected ${command}`);
  });
  const emit = (completed: number, phase: BulkProgress["phase"] = "processing") =>
    act(() =>
      callback({
        event: "bulk-progress",
        id: 1,
        payload: { operationId, completed, total: 3, phase },
      }),
    );
  const first = render(<DictionarySources />);
  await screen.findByText("Source 10");
  await user.click(screen.getByRole("button", { name: "Add dictionaries" }));
  await waitFor(() => expect(operationId).not.toBe(""));
  emit(1);
  expect(screen.getByRole("progressbar")).toHaveValue(1);
  first.unmount();
  const second = render(<DictionarySources />);
  expect(screen.getByRole("button", { name: "Adding… 1 / 3" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Adding… 1 / 3");
  listed = [...listed, source(90)];
  await act(async () => {
    importing.resolve({
      canceled: false,
      results: [
        { fileName: "new.zip", status: "imported", title: "Source 90" },
        { fileName: "duplicate.zip", status: "alreadyImported", title: "Source 10" },
        { fileName: "invalid.zip", status: "invalid", title: null },
      ],
    });
  });
  await screen.findByText("Source 90");
  expect(screen.getByText(/1 added · 1 already installed · 1 not added/)).toBeInTheDocument();
  await user.click(screen.getAllByRole("checkbox", { name: /^Select / })[0]);
  await user.click(screen.getByRole("button", { name: "Select all" }));
  await user.click(screen.getByRole("button", { name: "Remove selected" }));
  let dialog = screen.getByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "remove_dictionaries")).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Remove selected" }));
  dialog = screen.getByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Remove 3 dictionaries" }));
  await waitFor(() =>
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "remove_dictionaries"),
    ).toBe(true),
  );
  emit(2);
  expect(within(dialog).getByRole("button", { name: "Removing… 2 / 3" })).toBeDisabled();
  emit(3, "reclaiming");
  expect(within(dialog).getByRole("button", { name: "Reclaiming space… 3 / 3" })).toBeDisabled();
  listed = [source(30)];
  await act(async () => {
    removing.resolve({
      results: [
        { id: 10, status: "removed" },
        { id: 30, status: "failed" },
        { id: 90, status: "removed" },
      ],
      maintenance: { status: "failed" },
    });
  });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(screen.getByRole("checkbox", { name: "Select Source 30" })).toBeChecked();
  expect(screen.getByText(/Removals were kept, but Komori could not reclaim/)).toBeInTheDocument();
  second.unmount();
  render(<DictionarySources />);
  await screen.findByText("Source 30", { selector: ".settings-source-row strong" });
  expect(screen.getByText(/Removals were kept, but Komori could not reclaim/)).toBeInTheDocument();
  expect(
    screen.getByText("Could not be removed.", { exact: false, selector: "li" }),
  ).toBeInTheDocument();
});
