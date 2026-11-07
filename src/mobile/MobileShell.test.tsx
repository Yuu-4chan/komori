import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { MobileSheet } from "./MobileSheet";
import { MobileShell } from "./MobileShell";

vi.mock("../app/platform", () => ({ isAndroid: true }));

// jsdom lays nothing out, so each element keeps the scroll position it is given.
const scrolled = new WeakMap<Element, number>();
const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrolled.get(this) ?? 0;
    },
    set(this: Element, top: number) {
      scrolled.set(this, top);
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(Element.prototype, "scrollTop", original);
});

function Back() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(-1)} type="button">
      Back
    </button>
  );
}

function Filters() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Filters
      </button>
      <MobileSheet label="Filters" onClose={() => setOpen(false)} open={open}>
        <button onClick={() => setOpen(false)} type="button">
          Close
        </button>
      </MobileSheet>
    </>
  );
}

function shell() {
  const router = createMemoryRouter(
    [
      {
        element: <MobileShell />,
        children: [
          { path: "/library", element: <Filters /> },
          { path: "/statistics", element: <Back /> },
        ],
      },
    ],
    { initialEntries: ["/library"] },
  );
  render(
    <AppearanceProvider store={null}>
      <RouterProvider router={router} />
    </AppearanceProvider>,
  );
  return { router, page: document.getElementById("main-content")! };
}

function scroll(page: HTMLElement, top: number) {
  page.scrollTop = top;
  page.dispatchEvent(new Event("scroll"));
}

describe("The phone's frame", () => {
  it("opens pages at their top and returns to where a page was left", async () => {
    const { router, page } = shell();
    scroll(page, 640);
    await userEvent.click(screen.getByRole("link", { name: "Statistics" }));
    expect(router.state.location.pathname).toBe("/statistics");
    expect(page.scrollTop).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/library");
    expect(page.scrollTop).toBe(640);
  });

  it("takes the page already open back to its top when its dock item is tapped again", async () => {
    const { router, page } = shell();
    page.scrollTo = vi.fn();
    scroll(page, 900);
    await userEvent.click(screen.getByRole("link", { name: "Library" }));
    expect(page.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(router.state.location.pathname).toBe("/library");
    expect(router.state.historyAction).toBe("POP");
  });

  it("keeps the page still while a sheet is open", async () => {
    shell();
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(document.documentElement.dataset.sheetOpen).toBe("");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(document.documentElement.dataset.sheetOpen).toBeUndefined();
  });
});
