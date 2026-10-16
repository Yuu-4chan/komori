import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { getLibraryBook } from "../features/library/libraryApi";
import { ReaderPage } from "./ReaderPage";

vi.mock("../features/library/libraryApi", () => ({
  getLibraryBook: vi.fn(),
}));
vi.mock("../features/reader/epubRenderer", () => ({
  epubRendererFactory: vi.fn(() => () => ({
    mount: async (host: HTMLElement) => {
      host.textContent = "EPUB content";
      return "ready" as const;
    },
    dispose: vi.fn(),
  })),
}));

const lookupMock = vi.mocked(getLibraryBook);
const coverUrl = "http://komori-cover.localhost/0de3d2ad-4c1b-4d2e-9f00-1234567890ab/3";
const book = {
  id: "catalog-42",
  title: "Quiet Hours",
  author: "A Reader",
  fileName: "quiet.epub",
  importedAt: "2026-09-21T00:00:00Z",
  availability: "available" as const,
  hasCover: true,
  coverUrl,
};

function renderRoute(route = "/reader/catalog-42") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppearanceProvider>
        <Routes>
          <Route path="/reader/:catalogId" element={<ReaderPage />} />
          <Route path="/library" element={<h1>Library destination</h1>} />
        </Routes>
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

describe("catalog Reader route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupMock.mockImplementation(async (id) => (id === book.id ? book : null));
  });

  it("resolves a direct ID route and shows safe identity, cover and EPUB content", async () => {
    const user = userEvent.setup();
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Quiet Hours" })).toBeInTheDocument();
    expect(screen.getAllByText("A Reader").length).toBeGreaterThan(0);
    expect(await screen.findByText("Reader ready")).toBeInTheDocument();
    expect(document.querySelector(".reader-viewport__host")).toHaveTextContent("EPUB content");
    expect(document.querySelector(".reader-sidebar__cover")).toHaveAttribute("src", coverUrl);
    expect(lookupMock).toHaveBeenCalledWith("catalog-42");
    expect(document.body.innerHTML).not.toContain("quiet.epub");
    await user.click(screen.getByRole("link", { name: "Back to library" }));
    expect(screen.getByRole("heading", { name: "Library destination" })).toBeInTheDocument();
  });

  it.each(["missing", "unreadable"] as const)(
    "shows %s source recovery without path details",
    async (availability) => {
      lookupMock.mockResolvedValueOnce({ ...book, availability });
      renderRoute();
      expect(
        await screen.findByText(
          availability === "missing" ? /source file is missing/i : /source file cannot be read/i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to library" })).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain("quiet.epub");
    },
  );

  it("shows an unknown catalog ID without a cover", async () => {
    renderRoute("/reader/not-in-catalog");
    expect((await screen.findAllByRole("heading", { name: "Book not found" })).length).toBe(2);
    expect(lookupMock).toHaveBeenCalledWith("not-in-catalog");
    expect(document.querySelector(".reader-sidebar__cover")).not.toBeInTheDocument();
  });

  it("hides native resolution details on failure", async () => {
    lookupMock.mockRejectedValueOnce(new Error("C:\\private\\books\\quiet.epub"));
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Library unavailable" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("private");
  });

  it("rejects an unsafe cover value while keeping the book available", async () => {
    lookupMock.mockResolvedValueOnce({ ...book, coverUrl: "file:///C:/private/quiet.png" });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    expect(document.querySelector(".reader-sidebar__cover")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("file:///");
  });
});
