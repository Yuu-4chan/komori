import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { ReaderShell } from "./ReaderShell";
import type { BookmarkStore } from "./bookmarks";
import type { ReaderRenderer } from "./renderer";
import { escapeReturnWindow } from "./shortcuts";

afterEach(() => {
  vi.useRealTimers();
});
async function reader() {
  let content!: (document: Document) => void;
  const locator = {
    spineIndex: 0,
    sectionKey: "abcd1234",
    contentKey: "a".repeat(64),
    progress: 0.25,
  };
  const adapter: ReaderRenderer = {
    mount: vi.fn(async (_host, _signal, turns, published) => {
      content = published!;
      turns({ canAdvance: true, canRetreat: true });
      return "ready" as const;
    }),
    advancePage: vi.fn(async () => {}),
    retreatPage: vi.fn(async () => {}),
    dispose: vi.fn(),
    captureBookmark: vi.fn(async () => ({ locator, excerpt: "Excerpt" })),
    listImages: vi.fn(async () => ({ items: [], truncated: false, failedSections: 0 })),
  };
  const bookmarks: BookmarkStore = {
    load: vi.fn(async () => []),
    create: vi.fn(async (place, label) => ({
      duplicate: false,
      bookmark: { ...place, label, id: "11111111-1111-4111-8111-111111111111" },
    })),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const view = render(
    <MemoryRouter initialEntries={["/reader"]}>
      <AppearanceProvider store={null}>
        <Routes>
          <Route
            path="/reader"
            element={<ReaderShell rendererFactory={() => adapter} bookmarkStore={bookmarks} />}
          />
          <Route path="/library" element={<h1>Returned Library</h1>} />
        </Routes>
      </AppearanceProvider>
    </MemoryRouter>,
  );
  await screen.findByText("Reader ready");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Bookmarks (0)" })).toBeInTheDocument(),
  );
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const book = iframe.contentDocument!;
  book.body.innerHTML = "<p>Book text</p><input />";
  act(() => content(book));
  return {
    adapter,
    bookmarks,
    book,
    target: screen.getByRole("main"),
    unmount: view.unmount,
    iframe,
  };
}
describe("Reader command dispatch", () => {
  it("guards Ctrl+A in adapter-published EPUB documents, retaining text editing and selection", async () => {
    const { adapter, book, unmount, iframe } = await reader();
    const range = book.createRange();
    range.selectNodeContents(book.querySelector("p")!);
    book.getSelection()!.addRange(range);
    expect(fireEvent.keyDown(book.body, { key: "a", ctrlKey: true })).toBe(false);
    expect(book.getSelection()!.toString()).toBe("Book text");
    expect(fireEvent.keyDown(book.querySelector("input")!, { key: "a", ctrlKey: true })).toBe(true);
    const editable = book.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.innerHTML = "<b>Editable book text</b>";
    book.body.append(editable);
    expect(fireEvent.keyDown(editable.firstElementChild!, { key: "a", ctrlKey: true })).toBe(true);
    expect(adapter.advancePage).not.toHaveBeenCalled();
    expect(adapter.retreatPage).not.toHaveBeenCalled();
    unmount();
    expect(fireEvent.keyDown(book.body, { key: "a", ctrlKey: true })).toBe(true);
    iframe.remove();
  });
  it("opens gallery, appearance, find and bookmarks from EPUB focus; B gives confirmed feedback", async () => {
    const { adapter, bookmarks, book, target } = await reader();
    fireEvent.keyDown(book.body, { key: "g" });
    expect(await screen.findByRole("heading", { name: "Images" })).toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "a" });
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "f", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    fireEvent.keyDown(book.body, { key: "b", ctrlKey: true });
    expect(screen.getByRole("heading", { name: "Bookmarks" })).toBeInTheDocument();
    expect(bookmarks.create).not.toHaveBeenCalled();
    fireEvent.keyDown(book.body, { key: "b" });
    expect(
      await screen.findByText("Bookmark saved.", { selector: ".reader-floating-feedback" }),
    ).toBeInTheDocument();
    vi.mocked(bookmarks.create).mockResolvedValueOnce({
      duplicate: true,
      bookmark: {
        locator: {
          spineIndex: 0,
          sectionKey: "abcd1234",
          contentKey: "a".repeat(64),
          progress: 0.25,
        },
        excerpt: "Excerpt",
        label: "",
        id: "11111111-1111-4111-8111-111111111111",
      },
    });
    fireEvent.keyDown(target, { key: "b" });
    expect(
      await screen.findByText("This place is already bookmarked.", {
        selector: ".reader-floating-feedback",
      }),
    ).toBeInTheDocument();
    vi.mocked(bookmarks.create).mockRejectedValueOnce(
      Error("Could not save this bookmark. Try again."),
    );
    fireEvent.keyDown(target, { key: "b" });
    expect(
      await screen.findByText("Could not save this bookmark. Try again.", {
        selector: ".reader-floating-feedback",
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(book.querySelector("input")!, { key: "b" });
    fireEvent.keyDown(book.body, { key: "b", shiftKey: true });
    fireEvent.keyDown(book.body, { key: "b", repeat: true });
    expect(adapter.captureBookmark).toHaveBeenCalledTimes(3);
  });
  it("toggles sidebar and requires separate Escapes, cancelling confirmation on action, focus loss and timeout", async () => {
    const { book, target } = await reader();
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--hidden");
    fireEvent.keyDown(book.body, { key: "s" });
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--shown");
    fireEvent.keyDown(book.body, { key: "s" });
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--hidden");
    // A toggles Appearance; S hides it and reopens on the reader controls.
    fireEvent.keyDown(book.body, { key: "a" });
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--shown");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "a" });
    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--shown");
    fireEvent.keyDown(book.body, { key: "a" });
    fireEvent.keyDown(book.body, { key: "s" });
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--hidden");
    fireEvent.keyDown(book.body, { key: "s" });
    expect(screen.getByLabelText("Reader sidebar")).toHaveClass("reader-sidebar--shown");
    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "s" });
    vi.useFakeTimers();
    fireEvent.keyDown(target, { key: "Escape" });
    expect(screen.getByText(/Press Escape again/)).toBeInTheDocument();
    fireEvent.keyDown(target, { key: "Escape", repeat: true });
    expect(screen.queryByText("Returned Library")).not.toBeInTheDocument();
    fireEvent.keyDown(target, { key: "x" });
    expect(screen.queryByText(/Press Escape again/)).not.toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "Escape" });
    act(() => window.dispatchEvent(new Event("blur")));
    expect(screen.queryByText(/Press Escape again/)).not.toBeInTheDocument();
    fireEvent.keyDown(target, { key: "Escape" });
    act(() => vi.advanceTimersByTime(escapeReturnWindow + 1));
    expect(screen.queryByText(/Press Escape again/)).not.toBeInTheDocument();
    fireEvent.keyDown(book.body, { key: "Escape" });
    fireEvent.keyDown(book.body, { key: "Escape" });
    expect(screen.getByText("Returned Library")).toBeInTheDocument();
  });
  it("leaves the book with Escape from a Reader button, but not from a text field", async () => {
    await reader();
    const sidebar = screen.getByLabelText("Reader sidebar");
    fireEvent.click(screen.getByRole("button", { name: "Pin reader sidebar" }));
    expect(sidebar).toHaveClass("reader-sidebar--pinned");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const field = screen.getByRole("searchbox", { name: "Search this book" });
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByText(/Press Escape again/)).not.toBeInTheDocument();
    // Focus left on a sidebar button, as after closing the font manager.
    const button = screen.getByRole("button", { name: "Unpin reader sidebar" });
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByText(/Press Escape again/)).toBeInTheDocument();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByText("Returned Library")).toBeInTheDocument();
  });
});
