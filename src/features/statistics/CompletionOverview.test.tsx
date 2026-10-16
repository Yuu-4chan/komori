import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import type { LibraryBook } from "../library/libraryApi";
import { COMPLETION_PREVIEW, CompletionOverview } from "./StatisticsCards";

const books = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    book: { id: `book-${index}`, title: `Book ${index}`, fileName: `${index}.epub` } as LibraryBook,
    status: "not-started" as const,
  }));

it("keeps a large Library's completion overview short until Show all", () => {
  const { container } = render(<CompletionOverview books={books(COMPLETION_PREVIEW + 25)} />);
  const dots = () => container.querySelectorAll(".completion-dot").length;
  expect(dots()).toBe(COMPLETION_PREVIEW);
  fireEvent.click(
    screen.getByRole("button", { name: `Show all ${COMPLETION_PREVIEW + 25} books` }),
  );
  expect(dots()).toBe(COMPLETION_PREVIEW + 25);
  fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
  expect(dots()).toBe(COMPLETION_PREVIEW);
});

it("shows every dot and no Show all for a small Library", () => {
  const { container } = render(<CompletionOverview books={books(12)} />);
  expect(container.querySelectorAll(".completion-dot")).toHaveLength(12);
  expect(screen.queryByRole("button")).toBeNull();
});
