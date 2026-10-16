import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { runBulkOperation, useBulkOperation, type BulkProgress } from "./bulkOperation";
import { OperationNotice } from "./OperationNotice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
let callback: EventCallback<BulkProgress>;
const stop = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Observer() {
  const operation = useBulkOperation("library");
  return (
    <>
      <button disabled={operation?.active}>Add books</button>
      <OperationNotice operation={operation} />
    </>
  );
}
function progress(
  operationId: string,
  completed: number,
  total: number | null,
  phase: BulkProgress["phase"] = "processing",
) {
  act(() =>
    callback({ event: "bulk-progress", id: 1, payload: { operationId, completed, total, phase } }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    callback = handler as EventCallback<BulkProgress>;
    return stop;
  });
});

it("subscribes before invoking, retains ownership across routes, and ignores stale/regressive events", async () => {
  const subscribed = deferred<() => void>();
  vi.mocked(listen).mockImplementationOnce((_event, handler) => {
    callback = handler as EventCallback<BulkProgress>;
    return subscribed.promise;
  });
  const reply = deferred<unknown>();
  vi.mocked(invoke).mockReturnValueOnce(reply.promise);
  const first = render(<Observer />);
  let running!: Promise<unknown>;
  act(() => {
    running = runBulkOperation("library", "remove_books", { ids: ["one", "two", "three"] });
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toBeDisabled();
  subscribed.resolve(stop);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const operationId = (vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>)
    .operationId as string;
  progress(operationId, 0, 3);
  progress("another-operation", 3, 3);
  progress(operationId, 1, 3);
  progress(operationId, 0, 3);
  progress(operationId, 2, 99);
  expect(screen.getByRole("progressbar")).toHaveValue(1);
  expect(screen.getByRole("status")).toHaveTextContent("Removing… 1 / 3");
  first.unmount();
  progress(operationId, 2, 3);
  render(<Observer />);
  expect(screen.getByRole("status")).toHaveTextContent("Removing… 2 / 3");
  await expect(runBulkOperation("library", "import_books")).rejects.toThrow("Another operation");
  progress(operationId, 3, 3, "reclaiming");
  progress(operationId, 2, 3);
  expect(screen.getByRole("status")).toHaveTextContent("Reclaiming space… 3 / 3");
  expect(screen.getByRole("button")).toBeDisabled();
  await act(async () => {
    reply.resolve({
      results: [
        { id: "one", status: "removed" },
        { id: "two", status: "failed" },
        { id: "three", status: "removed" },
      ],
      maintenance: { status: "failed" },
    });
    await running;
  });
  expect(screen.getByRole("button")).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Removals were kept");
  expect(stop).toHaveBeenCalledTimes(1);
  progress(operationId, 0, null, "picking");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("reconciles the final count from per-item results, preserves outcomes through cancellation and empty scans", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    results: [{ status: "removed" }, { status: "failed" }],
    maintenance: { status: "compacted", sizeBefore: 20, sizeAfter: 10 },
  });
  await runBulkOperation("library", "remove_books");
  render(<Observer />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 / 2 processed. 1 could not be removed. Successful removals were kept. Freed space reclaimed.",
  );
  vi.mocked(invoke).mockResolvedValueOnce({ canceled: true, results: [] });
  await act(async () => {
    await runBulkOperation("library", "import_books");
  });
  expect(screen.getByRole("status")).toHaveTextContent("2 / 2 processed");
  vi.mocked(invoke).mockResolvedValueOnce([]);
  await act(async () => {
    await runBulkOperation("library", "scan_library_folders");
  });
  expect(screen.getByRole("status")).toHaveTextContent("2 / 2 processed");
});

it("does not mutate without a listener and hides command diagnostics while releasing pending controls", async () => {
  render(<Observer />);
  vi.mocked(listen).mockRejectedValueOnce(new Error("private path"));
  await act(async () => {
    await expect(runBulkOperation("library", "import_books")).rejects.toThrow(
      "Komori could not finish",
    );
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toBeEnabled();
  expect(screen.getByRole("alert")).not.toHaveTextContent("private path");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("private database"));
  await act(async () => {
    await expect(runBulkOperation("library", "remove_books")).rejects.toThrow(
      "Komori could not finish",
    );
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).not.toHaveTextContent("private database");
});

it("clears a finished outcome once the page showing it is left, but keeps one finished elsewhere", async () => {
  const reply = deferred<unknown>();
  vi.mocked(invoke).mockReturnValueOnce(reply.promise);
  const page = render(<Observer />);
  let running!: Promise<unknown>;
  act(() => {
    running = runBulkOperation("dictionaries", "remove_dictionaries");
  });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  page.unmount();
  await act(async () => {
    reply.resolve({ results: [{ status: "removed" }], maintenance: { status: "compacted" } });
    await running;
  });
  function Dictionaries() {
    return <OperationNotice operation={useBulkOperation("dictionaries")} />;
  }
  const revisit = render(<Dictionaries />);
  expect(screen.getByRole("status")).toHaveTextContent("1 / 1 processed. Freed space reclaimed.");
  revisit.unmount();
  await act(() => new Promise((done) => setTimeout(done, 0)));
  render(<Dictionaries />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
