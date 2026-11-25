import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { openExternalLink } from "../dictionary/dictionaryApi";
import { ReaderShell } from "./ReaderShell";
import type { ReaderIdentity } from "./readerIdentity";
import type { ReaderRenderer } from "./renderer";
import { getWikipediaSummary } from "./wikipedia";

vi.mock("./wikipedia", () => ({ getWikipediaSummary: vi.fn() }));
vi.mock("../dictionary/dictionaryApi", async (original) => ({
  ...(await original<typeof import("../dictionary/dictionaryApi")>()),
  openExternalLink: vi.fn(async () => {}),
}));

const identity = (language: string | null): ReaderIdentity => ({
  status: "book",
  book: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "猫",
    author: null,
    availability: "available",
    hasCover: false,
    language,
    series: null,
    seriesIndex: null,
  },
  cover: null,
});

describe("Wikipedia from selected book text", () => {
  let frame: HTMLIFrameElement;
  let book: Document;
  beforeEach(() => {
    vi.clearAllMocks();
    frame = document.createElement("iframe");
    document.body.append(frame);
    book = frame.contentDocument!;
    book.body.innerHTML = '<p id="text"> 「東京」 </p>';
  });
  afterEach(() => frame.remove());

  function open(language: string | null) {
    const reader: ReaderRenderer = {
      mount: vi.fn(async (...args: Parameters<ReaderRenderer["mount"]>) => {
        args[2]({ canAdvance: true, canRetreat: true });
        args[3]?.(book);
        return "ready" as const;
      }),
      advancePage: vi.fn(async () => {}),
      retreatPage: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    render(
      <MemoryRouter>
        <AppearanceProvider store={null}>
          <ReaderShell identity={identity(language)} rendererFactory={() => reader} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
  }
  async function chooseWikipedia() {
    await screen.findByText("Reader ready");
    book.getSelection()!.selectAllChildren(book.getElementById("text")!);
    act(
      () =>
        void book
          .getElementById("text")!
          .dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
          ),
    );
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Wikipedia" }));
  }

  it("shows the page's introduction in the book's language and opens the page", async () => {
    vi.mocked(getWikipediaSummary).mockResolvedValue({
      status: "found",
      title: "東京",
      description: "日本の首都",
      extract: "東京は日本の首都。\n人口が多い。",
      url: "https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC",
    });
    open("ja");
    await chooseWikipedia();
    const card = await screen.findByRole("dialog", { name: "Wikipedia" });
    expect(await within(card).findByRole("heading", { name: "東京" })).toBeInTheDocument();
    expect(within(card).getByText("日本の首都")).toBeInTheDocument();
    expect(within(card).getByText("東京は日本の首都。")).toBeInTheDocument();
    expect(within(card).getByText("人口が多い。")).toBeInTheDocument();
    expect(getWikipediaSummary).toHaveBeenCalledWith(" 「東京」 ", "ja");
    await userEvent.click(within(card).getByRole("button", { name: "Open in Wikipedia" }));
    expect(openExternalLink).toHaveBeenCalledWith(
      "https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says when there is no page or Wikipedia cannot be reached, and closes on Escape", async () => {
    vi.mocked(getWikipediaSummary).mockResolvedValueOnce({ status: "missing" });
    open(null);
    await chooseWikipedia();
    expect(await screen.findByText("No Wikipedia page")).toBeInTheDocument();
    // A book without a language uses the interface's.
    expect(getWikipediaSummary).toHaveBeenCalledWith(" 「東京」 ", "en");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    vi.mocked(getWikipediaSummary).mockRejectedValueOnce(Error("offline"));
    await chooseWikipedia();
    expect(await screen.findByText("Wikipedia could not be reached")).toBeInTheDocument();
  });
});
