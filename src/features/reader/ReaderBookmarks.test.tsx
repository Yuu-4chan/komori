import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import type { BookmarkStore, ReaderBookmark } from "./bookmarks";
import { ReaderShell } from "./ReaderShell";
import type { ReaderRenderer, ReaderRendererFactory } from "./renderer";

const locator = {
  spineIndex: 1,
  sectionKey: "1234abcd",
  progress: 0.5,
  contentKey: "a".repeat(64),
};
const first: ReaderBookmark = {
  id: "11111111-1111-4111-8111-111111111111",
  locator,
  label: "Study",
  excerpt: "Useful passage",
};
function store(items: ReaderBookmark[] = []): BookmarkStore {
  return {
    load: vi.fn(async () => items),
    create: vi.fn(async (place, label) => ({
      duplicate: items.length > 0,
      bookmark: items[0] ?? { ...first, ...place, label },
    })),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}
function renderer(): ReaderRenderer {
  return {
    mount: vi.fn(async (_host, _signal, turns) => {
      turns({ canAdvance: true, canRetreat: true });
      return "ready" as const;
    }),
    advancePage: vi.fn(async () => undefined),
    retreatPage: vi.fn(async () => undefined),
    dispose: vi.fn(),
    captureBookmark: vi.fn(async () => ({ locator, excerpt: "Useful passage" })),
    goToBookmark: vi.fn(async () => true),
  };
}
function shell(factory: ReaderRendererFactory | undefined, bookmarks?: BookmarkStore) {
  return (
    <MemoryRouter>
      <AppearanceProvider>
        <ReaderShell rendererFactory={factory} bookmarkStore={bookmarks} />
      </AppearanceProvider>
    </MemoryRouter>
  );
}
async function open() {
  await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /^Bookmarks/ }));
}

describe("Reader bookmarks", () => {
  it("includes a native duplicate missing from an older list and hides capture errors", async () => {
    const adapter = renderer();
    const bookmarks = store();
    vi.mocked(bookmarks.create).mockResolvedValueOnce({ duplicate: true, bookmark: first });
    render(shell(() => adapter, bookmarks));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Save current place" }));
    expect(await screen.findByRole("button", { name: "Jump to Study" })).toBeInTheDocument();
    vi.mocked(adapter.captureBookmark!).mockRejectedValueOnce(Error("private/archive.xhtml"));
    await userEvent.click(screen.getByRole("button", { name: "Save current place" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not capture this place");
    expect(screen.queryByText("private/archive.xhtml")).not.toBeInTheDocument();
  });

  it("keeps bookmarks manageable without an open source", async () => {
    const bookmarks = store([first]);
    render(shell(undefined, bookmarks));
    await userEvent.click(screen.getByRole("button", { name: /^Bookmarks/ }));
    expect(await screen.findByRole("button", { name: "Jump to Study" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Save current place" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove Study" }));
    await waitFor(() => expect(bookmarks.remove).toHaveBeenCalledWith(first.id));
  });

  it("ignores a late list from another catalog and a pending write after unmount", async () => {
    const oldStore = store();
    const nextStore = store();
    let loaded!: (items: ReaderBookmark[]) => void;
    vi.mocked(oldStore.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    const firstAdapter = renderer();
    const nextAdapter = renderer();
    const firstFactory = () => firstAdapter;
    const nextFactory = () => nextAdapter;
    const view = render(shell(firstFactory, oldStore));
    await open();
    view.rerender(shell(nextFactory, nextStore));
    await act(async () => loaded([first]));
    expect(screen.queryByRole("button", { name: "Jump to Study" })).not.toBeInTheDocument();
    let written!: (value: { duplicate: boolean; bookmark: ReaderBookmark }) => void;
    vi.mocked(nextStore.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          written = resolve;
        }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save current place" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save current place" }));
    await waitFor(() => expect(nextStore.create).toHaveBeenCalled());
    view.unmount();
    await act(async () => written({ duplicate: false, bookmark: first }));
    expect(nextAdapter.dispose).toHaveBeenCalled();
  });

  it("creates with labels, reports duplicates, renames, jumps and removes by keyboard", async () => {
    const user = userEvent.setup();
    const adapter = renderer();
    const factory = vi.fn(() => adapter);
    const bookmarks = store();
    render(shell(factory, bookmarks));
    await open();
    expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Bookmark title" }), "Study");
    await user.keyboard("{Enter}");
    const jump = await screen.findByRole("button", { name: "Jump to Study" });
    expect(bookmarks.create).toHaveBeenCalledWith({ locator, excerpt: "Useful passage" }, "Study");
    await user.click(screen.getByRole("button", { name: "Rename Study" }));
    const field = screen.getByRole("textbox", { name: "Label for Study" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Renamed{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename Renamed" })).toHaveFocus(),
    );
    expect(bookmarks.rename).toHaveBeenCalledWith(first.id, "Renamed");
    jump.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    expect(adapter.goToBookmark).toHaveBeenCalledWith(locator);
    vi.mocked(bookmarks.create).mockResolvedValueOnce({
      duplicate: true,
      bookmark: { ...first, label: "Renamed" },
    });
    fireEvent.keyDown(screen.getByRole("main"), { key: "b" });
    await waitFor(() => expect(bookmarks.create).toHaveBeenCalledTimes(2));
    const remove = screen.getByRole("button", { name: "Remove Renamed" });
    remove.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to Renamed" })).not.toBeInTheDocument(),
    );
    expect(bookmarks.remove).toHaveBeenCalledWith(first.id);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the same place and keeps unresolved bookmarks manageable without moving focus", async () => {
    const adapter = renderer();
    vi.mocked(adapter.goToBookmark!).mockResolvedValue(false);
    const bookmarks = store([first]);
    render(shell(() => adapter, bookmarks));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Save current place" }));
    expect(await screen.findByText("This place is already bookmarked.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Jump to/ })).toHaveLength(1);
    const jump = screen.getByRole("button", { name: "Jump to Study" });
    await userEvent.click(jump);
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable in the current EPUB");
    expect(jump).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove Study" })).toBeEnabled();
  });

  it("shows loading/failure/retry and keeps failed writes in the list", async () => {
    const bookmarks = store([first]);
    let reject!: (error: Error) => void;
    vi.mocked(bookmarks.load).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(shell(() => renderer(), bookmarks));
    await open();
    expect(screen.getByText("Loading bookmarks…")).toBeInTheDocument();
    await act(async () => reject(Error("private path")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load bookmarks");
    await userEvent.click(screen.getByRole("button", { name: "Reload bookmarks" }));
    await screen.findByRole("button", { name: "Jump to Study" });
    vi.mocked(bookmarks.remove).mockRejectedValueOnce(
      Error("Could not save bookmarks. Try again."),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Study" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
    expect(screen.getByRole("button", { name: "Jump to Study" })).toBeInTheDocument();
    expect(screen.queryByText("private path")).not.toBeInTheDocument();
  });

  it("rejects stale captures, loads and jumps across book changes and disposal", async () => {
    const old = renderer();
    const next = renderer();
    let capture!: (value: { locator: typeof locator; excerpt: string }) => void;
    vi.mocked(old.captureBookmark!).mockImplementation(
      () =>
        new Promise((resolve) => {
          capture = resolve;
        }),
    );
    const oldStore = store([first]);
    const nextStore = store();
    const oldFactory = () => old;
    const nextFactory = () => next;
    const view = render(shell(oldFactory, oldStore));
    await open();
    fireEvent.keyDown(screen.getByRole("main"), { key: "b" });
    await waitFor(() => expect(old.captureBookmark).toHaveBeenCalled());
    view.rerender(shell(nextFactory, nextStore));
    await act(async () => capture({ locator, excerpt: "Old book" }));
    expect(oldStore.create).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to Study" })).not.toBeInTheDocument(),
    );
    let finish!: (value: boolean) => void;
    vi.mocked(next.goToBookmark!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(nextStore.create).mockResolvedValue({ duplicate: false, bookmark: first });
    await userEvent.click(screen.getByRole("button", { name: "Save current place" }));
    await userEvent.click(await screen.findByRole("button", { name: "Jump to Study" }));
    view.unmount();
    await act(async () => finish(false));
    expect(next.dispose).toHaveBeenCalled();
    expect(nextStore.remove).not.toHaveBeenCalled();
  });

  it("serializes capture with navigation and excludes the shortcut while editing", async () => {
    const adapter = renderer();
    const bookmarks = store();
    let finish!: (value: { locator: typeof locator; excerpt: string }) => void;
    vi.mocked(adapter.captureBookmark!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(shell(() => adapter, bookmarks));
    await open();
    const field = screen.getByRole("textbox", { name: "Bookmark title" });
    fireEvent.keyDown(field, { key: "b" });
    expect(adapter.captureBookmark).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "b" });
    fireEvent.keyDown(screen.getByRole("main"), { key: "b" });
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(adapter.captureBookmark).toHaveBeenCalledTimes(1);
    expect(adapter.advancePage).not.toHaveBeenCalled();
    await act(async () => finish({ locator, excerpt: "Useful passage" }));
    expect(bookmarks.create).toHaveBeenCalledTimes(1);
  });
});
