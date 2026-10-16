import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { ReaderShell } from "./ReaderShell";
import type { ReaderRenderer, ReaderRendererFactory, ReaderSearchResults } from "./renderer";

const results: ReaderSearchResults = {
  truncated: false,
  matches: [
    {
      id: "session-match",
      label: "Real chapter",
      section: 2,
      before: "before ",
      match: "読む",
      after: " after",
    },
  ],
};
function adapter(): ReaderRenderer {
  return {
    mount: vi.fn(async (_host, _signal, turns) => {
      turns({ canAdvance: true, canRetreat: true });
      return "ready" as const;
    }),
    advancePage: vi.fn(async () => undefined),
    retreatPage: vi.fn(async () => undefined),
    dispose: vi.fn(),
    searchBook: vi.fn(async () => results),
    goToSearchResult: vi.fn(async () => true),
    setPresentation: vi.fn(async () => undefined),
  };
}
function shell(factory?: ReaderRendererFactory) {
  return (
    <MemoryRouter>
      <AppearanceProvider>
        <ReaderShell rendererFactory={factory} />
      </AppearanceProvider>
    </MemoryRouter>
  );
}
async function open() {
  await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
}
async function search(query = "読む") {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search this book" }), {
    target: { value: query },
  });
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
}

describe("Reader find in book", () => {
  it.each([false, true])(
    "Escape releases search focus and keeps its results (pinned %s)",
    async (pinned) => {
      render(shell(() => adapter()));
      await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
      if (pinned) await userEvent.click(screen.getByRole("button", { name: "Pin reader sidebar" }));
      await open();
      await search();
      const input = screen.getByRole("searchbox", { name: "Search this book" });
      expect(input).toHaveAttribute("spellcheck", "false");
      input.focus();
      for (const exclusion of [
        { shiftKey: true },
        { ctrlKey: true },
        { altKey: true },
        { metaKey: true },
        { repeat: true },
        { isComposing: true },
      ]) {
        fireEvent.keyDown(input, { key: "Escape", ...exclusion });
        expect(input).toHaveFocus();
      }
      await userEvent.keyboard("{Escape}");
      expect(document.getElementById("reader-main")).toHaveFocus();
      expect(input).toHaveValue("読む");
      expect(
        screen.getByRole("button", { name: "Jump to match 1: Real chapter" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Press Escape again/)).not.toBeInTheDocument();
      fireEvent.keyDown(document.getElementById("reader-main")!, { key: "f", ctrlKey: true });
      await waitFor(() => expect(input).toHaveFocus());
    },
  );

  it("searches and jumps by pointer and keyboard, hands focus to the book and preserves its mount", async () => {
    const renderer = adapter();
    const factory = vi.fn(() => renderer);
    render(shell(factory));
    await open();
    await search();
    const match = await screen.findByRole("button", { name: "Jump to match 1: Real chapter" });
    expect(match).toHaveAccessibleDescription("before 読む after");
    expect(screen.getByText("1 match · Whole book")).toBeInTheDocument();
    expect(screen.getByText("読む", { selector: "mark" })).toBeInTheDocument();
    await userEvent.click(match);
    await waitFor(() => expect(document.getElementById("reader-main")).toHaveFocus());
    expect(match).toHaveAttribute("aria-current", "location");
    match.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(renderer.goToSearchResult).toHaveBeenCalledTimes(2));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(renderer.setPresentation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to reader controls" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toHaveFocus());
  });

  it("cancels stale queries, scopes, pending jumps and unmounted work", async () => {
    const renderer = adapter();
    let resolve!: (result: ReaderSearchResults) => void;
    vi.mocked(renderer.searchBook!).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(shell(() => renderer));
    await open();
    await search("old");
    expect(screen.getByText("Searching the book…")).toBeInTheDocument();
    const signal = vi.mocked(renderer.searchBook!).mock.calls[0][2];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(results));
    expect(screen.queryByText("Real chapter")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "This chapter" }));
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(renderer.searchBook).toHaveBeenLastCalledWith("new", "chapter", expect.any(AbortSignal));
    const match = await screen.findByRole("button", { name: /Jump to match/ });
    let jumped!: (success: boolean) => void;
    vi.mocked(renderer.goToSearchResult!).mockImplementationOnce(
      () =>
        new Promise((done) => {
          jumped = done;
        }),
    );
    await userEvent.click(match);
    const jumpingSignal = vi.mocked(renderer.goToSearchResult!).mock.calls[0][1];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "changed" } });
    expect(jumpingSignal.aborted).toBe(true);
    await act(async () => jumped(true));
    expect(document.getElementById("reader-main")).not.toHaveFocus();
    await search();
    const lastSignal = vi.mocked(renderer.searchBook!).mock.calls.at(-1)![2];
    view.unmount();
    expect(lastSignal.aborted).toBe(true);
    expect(renderer.dispose).toHaveBeenCalled();
  });

  it("rejects previous-book results and clears the query on a book switch", async () => {
    const previous = adapter();
    const next = adapter();
    let resolve!: (result: ReaderSearchResults) => void;
    vi.mocked(previous.searchBook!).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const firstFactory = () => previous;
    const nextFactory = () => next;
    const view = render(shell(firstFactory));
    await open();
    await search();
    view.rerender(shell(nextFactory));
    await act(async () => resolve(results));
    expect(screen.queryByText("Real chapter")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(previous.dispose).toHaveBeenCalled();
  });

  it("shows safe retry, missing and capped-match states and retains focus on failed jumps", async () => {
    const renderer = adapter();
    vi.mocked(renderer.searchBook!).mockRejectedValueOnce(Error("private/source.epub"));
    render(shell(() => renderer));
    await open();
    await search();
    expect(await screen.findByText("Could not search this book.")).toBeInTheDocument();
    expect(screen.queryByText("private/source.epub")).not.toBeInTheDocument();
    vi.mocked(renderer.searchBook!).mockResolvedValueOnce({ matches: [], truncated: false });
    await search("missing");
    expect(await screen.findByText("No matches found.")).toBeInTheDocument();
    vi.mocked(renderer.searchBook!).mockResolvedValueOnce({
      ...results,
      truncated: true,
      matches: Array.from({ length: 100 }, (_, i) => ({ ...results.matches[0], id: `match-${i}` })),
    });
    await search();
    expect(
      await screen.findByText("100+ matches · Showing the first 100 · Whole book"),
    ).toBeInTheDocument();
    vi.mocked(renderer.goToSearchResult!).mockResolvedValueOnce(false);
    const match = screen.getByRole("button", { name: "Jump to match 1: Real chapter" });
    await userEvent.click(match);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this match");
    expect(match).toHaveFocus();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a".repeat(257) } });
    expect(screen.getByRole("button", { name: "Find" })).toBeDisabled();
  });

  it("opens from Ctrl+F in the book and excludes editing, repeats and composition", async () => {
    const renderer = adapter();
    render(shell(() => renderer));
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    const area = document.getElementById("reader-main")!;
    fireEvent.keyDown(area, { key: "f", ctrlKey: true, repeat: true });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.keyDown(area, { key: "f", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    await userEvent.keyboard("latin{Enter}");
    expect(renderer.searchBook).toHaveBeenCalledWith("latin", "book", expect.any(AbortSignal));
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowRight" });
    expect(renderer.advancePage).not.toHaveBeenCalled();
  });
});
