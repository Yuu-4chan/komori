import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addLibraryFolder,
  listLibraryFolders,
  removeLibraryFolder,
  scanLibraryFolders,
  type LibraryFolder,
} from "./libraryApi";
import { LibraryFolders } from "./LibraryFolders";

vi.mock("./libraryApi", () => ({
  addLibraryFolder: vi.fn(),
  listLibraryFolders: vi.fn(),
  removeLibraryFolder: vi.fn(),
  scanLibraryFolders: vi.fn(),
}));

const books: LibraryFolder = { id: 1, path: "D:\\Books", availability: "available", books: 12 };
const drive: LibraryFolder = { id: 2, path: "E:\\Novels", availability: "missing", books: 1 };

describe("Book folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLibraryFolders).mockResolvedValue([]);
  });

  it("adds a folder, reporting its first scan, and lists it", async () => {
    const user = userEvent.setup();
    render(<LibraryFolders />);
    expect(await screen.findByText("No book folders yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check for new books/ })).not.toBeInTheDocument();

    vi.mocked(addLibraryFolder).mockResolvedValueOnce({
      status: "added",
      message: null,
      results: [
        { fileName: "one.epub", status: "imported", message: null },
        { fileName: "two.epub", status: "alreadyImported", message: null },
        { fileName: "broken.epub", status: "failed", message: "Not an EPUB." },
      ],
    });
    vi.mocked(listLibraryFolders).mockResolvedValue([books, drive]);
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 book added · 1 could not be imported");
    expect(alert).toHaveTextContent("broken.epub: Not an EPUB.");
    const rows = screen.getAllByRole("listitem").filter((item) => item.closest(".library-folders"));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("D:\\Books12 books in your library"),
      expect.stringContaining("1 book in your library · Not found"),
    ]);
  });

  it("checks for new books, reports nothing new, and removes a folder", async () => {
    const user = userEvent.setup();
    vi.mocked(listLibraryFolders).mockResolvedValue([books]);
    render(<LibraryFolders />);
    await screen.findByText("D:\\Books");

    vi.mocked(scanLibraryFolders).mockResolvedValueOnce([]);
    await user.click(screen.getByRole("button", { name: "Check for new books" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No new books found.");

    vi.mocked(removeLibraryFolder).mockResolvedValueOnce(true);
    vi.mocked(listLibraryFolders).mockResolvedValue([]);
    const row = screen.getByText("D:\\Books").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Remove D:\\Books" }));
    expect(removeLibraryFolder).toHaveBeenCalledWith(1);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Komori no longer checks D:\\Books. Its books stay in your library.",
    );
    expect(await screen.findByText("No book folders yet.")).toBeInTheDocument();
  });

  it("explains a folder that is already added and stays quiet when the picker is canceled", async () => {
    const user = userEvent.setup();
    render(<LibraryFolders />);
    await screen.findByText("No book folders yet.");
    vi.mocked(addLibraryFolder).mockResolvedValueOnce({
      status: "canceled",
      message: null,
      results: [],
    });
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    vi.mocked(addLibraryFolder).mockResolvedValueOnce({
      status: "duplicate",
      message: "That folder is already one of your book folders.",
      results: [],
    });
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That folder is already one of your book folders.",
    );
  });

  it("keeps the Library's settings, the folders header and the folders in one grouped box", async () => {
    const view = render(
      <LibraryFolders>
        <div className="settings-field">Card size</div>
      </LibraryFolders>,
    );
    const empty = await screen.findByText("No book folders yet.");
    const box = empty.closest(".settings-list")!;
    expect(box).not.toBeNull();
    expect(box).toContainElement(screen.getByText("Card size"));
    expect(box).toContainElement(screen.getByText("Book folders"));
    const add = screen.getByRole("button", { name: "Add folder" });
    expect(box).toContainElement(add);
    expect(add).toHaveClass("button--secondary");
    view.unmount();

    vi.mocked(listLibraryFolders).mockResolvedValue([books]);
    render(<LibraryFolders />);
    const folder = (await screen.findByText(books.path)).closest("li")!;
    expect(folder.closest(".settings-list")).toContainElement(
      screen.getByRole("button", { name: "Check for new books" }),
    );
  });
});
