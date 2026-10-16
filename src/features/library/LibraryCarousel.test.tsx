import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryBook } from "./libraryApi";
import { LibraryBookCard } from "./LibraryBookCard";
import { LibraryCarousel } from "./LibraryCarousel";

const books: LibraryBook[] = Array.from({ length: 12 }, (_, index) => ({
  id: String(index),
  title: `Book ${index}`,
  author: null,
  fileName: `${index}.epub`,
  importedAt: "2026-10-01T00:00:00Z",
  availability: "available",
  hasCover: false,
}));

// jsdom has no layout: the row is 500 px wide and scrolls by 100 px cards with 10 px gaps.
const width = 500;
const content = books.length * 110 - 10;

describe("Library carousel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(content);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows each arrow over the row only while the row can move that way", async () => {
    render(
      <MemoryRouter>
        <LibraryCarousel
          books={books}
          gap={10}
          heading={<h3>Series</h3>}
          itemWidth={100}
          renderBook={(book) => <article key={book.id}>{book.title}</article>}
          seeAll="/library?group=series%3ASeries"
          title="Series"
          view="grid"
        />
      </MemoryRouter>,
    );
    const previous = () => screen.queryByRole("button", { name: "Previous books in Series" });
    const next = () => screen.queryByRole("button", { name: "Next books in Series" });
    // At the start only Next shows, and See all stands alone beside the heading.
    expect(previous()).toBeNull();
    expect(next()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all of Series" }).parentElement).toHaveClass(
      "library-carousel__head",
    );

    const track = document.querySelector(".library-carousel__track") as HTMLElement;
    const scrollTo = async (left: number) => {
      track.scrollLeft = left;
      fireEvent.scroll(track);
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    };
    await scrollTo(300);
    expect(previous()).toBeInTheDocument();
    expect(next()).toBeInTheDocument();
    await scrollTo(content - width);
    expect(previous()).toBeInTheDocument();
    expect(next()).toBeNull();
  });

  it("is one Tab stop whose cards Left and Right move through, leaving Up and Down to the page", async () => {
    const user = userEvent.setup();
    const noop = () => undefined;
    render(
      <MemoryRouter>
        <LibraryCarousel
          books={books.slice(0, 3)}
          gap={10}
          heading={<h3>Series</h3>}
          itemWidth={100}
          renderBook={(book) => (
            <LibraryBookCard
              book={book}
              details={{ series: false, language: false, kanji: false, lastRead: false }}
              key={book.id}
              onRelink={noop}
              onRemove={noop}
              onSelect={noop}
              relinkDisabled={false}
              relinking={false}
              selected={false}
              selectionMode={false}
              view="grid"
            />
          )}
          seeAll="/library?group=series%3ASeries"
          title="Series"
          view="grid"
        />
      </MemoryRouter>,
    );
    const track = document.querySelector<HTMLElement>(".library-carousel__track")!;
    const links = screen.getAllByRole("link", { name: /^Open Book \d in reader$/ });
    const stops = () =>
      Array.from(track.querySelectorAll<HTMLElement>("a, button, input")).filter(
        (control) => control.tabIndex >= 0,
      );
    expect(stops()).toEqual([links[0]]);
    links[0].focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(links[2]).toHaveFocus();
    expect(stops()).toEqual([links[2]]);
    const down = fireEvent.keyDown(links[2], { key: "ArrowDown" });
    expect(down).toBe(true);
    expect(links[2]).toHaveFocus();
  });
});
