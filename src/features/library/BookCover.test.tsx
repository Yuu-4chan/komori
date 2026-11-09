import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BookCover } from "./BookCover";
import type { LibraryBook } from "./libraryApi";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Arrived = { id: string; revision: number };
let arrive: EventCallback<Arrived> | null = null;
vi.mocked(listen).mockImplementation(async (event, handler) => {
  if (event === "pc-cover") arrive = handler as EventCallback<Arrived>;
  return () => {};
});

const announce = (id: string, revision: number) =>
  act(() => arrive?.({ event: "pc-cover", id: 1, payload: { id, revision } }));

const book = (id: string, coverUrl: string): LibraryBook => ({
  id,
  title: "Kokoro",
  author: null,
  fileName: "kokoro.epub",
  importedAt: "",
  availability: "available",
  hasCover: true,
  coverUrl,
  progress: null,
  lastReadAt: null,
});

const pcId = (n: number) => `0de3d2ad-4c1b-4d2e-9f00-12345678900${n}`;
const pcUrl = (n: number) => `http://komori-cover.localhost/pc/${pcId(n)}/3`;

afterEach(cleanup);

describe("BookCover", () => {
  it("shows a PC cover the phone did not have yet once it arrives", async () => {
    const { container } = render(<BookCover book={book(pcId(1), pcUrl(1))} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Kokoro");

    // Another cover, or another revision of this one, changes nothing.
    await announce(pcId(2), 3);
    await announce(pcId(1), 2);
    expect(container.querySelector("img")).toBeNull();

    await announce(pcId(1), 3);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(pcUrl(1));
  });

  it("loads a PC cover again, once, when it arrived while its miss was on the way", async () => {
    await announce(pcId(3), 3);
    const { container } = render(<BookCover book={book(pcId(3), pcUrl(3))} />);
    const first = container.querySelector("img")!;
    fireEvent.error(first);
    const second = container.querySelector("img")!;
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe(pcUrl(3));
    // An image that still fails shows the title rather than trying forever.
    fireEvent.error(second);
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not wait for arrivals for the phone's own covers", () => {
    vi.mocked(listen).mockClear();
    const own = `http://komori-cover.localhost/${pcId(4)}/1`;
    const { container } = render(<BookCover book={book(pcId(4), own)} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });
});
