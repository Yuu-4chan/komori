import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { SettingsPage } from "./SettingsPage";

function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current settings URL">{location.search}</output>
      <button onClick={() => navigate(-1)}>Previous section</button>
      <button onClick={() => navigate("?section=unknown")}>Unknown section</button>
    </>
  );
}

it("reveals a chosen compact section while keeping category keyboard focus", async () => {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
  const scroll = HTMLElement.prototype.scrollIntoView;
  const reveal = vi.fn();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 944 });
  HTMLElement.prototype.scrollIntoView = reveal;
  try {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppearanceProvider store={null}>
          <SettingsPage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(reveal).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    const storage = within(nav).getByRole("button", { name: "Storage" });
    storage.focus();
    await user.keyboard("{Enter}");
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(storage).toHaveFocus();
    expect(reveal.mock.instances[0]).toBe(document.querySelector(".settings-content__heading"));
    await user.keyboard("{Enter}");
    expect(reveal).toHaveBeenCalledTimes(2);
  } finally {
    Object.defineProperty(window, "innerWidth", width);
    HTMLElement.prototype.scrollIntoView = scroll;
  }
});

it("returns to a roomy section's heading and keeps the chosen category in view", async () => {
  const scroll = HTMLElement.prototype.scrollIntoView;
  const reveal = vi.fn();
  HTMLElement.prototype.scrollIntoView = reveal;
  const sidebarTop = new Map<Element, number>();
  const spies = [
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900),
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return sidebarTop.get(this) ?? 0;
    }),
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (
      this: HTMLElement,
      value: number,
    ) {
      sidebarTop.set(this, value);
    }),
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("settings-sidebar")) return new DOMRect(0, 100, 240, 400);
      if (this.getAttribute("aria-current") === "page") {
        return new DOMRect(
          0,
          620 - (sidebarTop.get(this.closest(".settings-sidebar")!) ?? 0),
          240,
          60,
        );
      }
      return new DOMRect(0, 0, 0, 0);
    }),
  ];
  try {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/settings?section=storage"]}>
        <AppearanceProvider store={null}>
          <SettingsPage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    const sidebar = document.querySelector(".settings-sidebar")!;
    // Storage sits below the sidebar's visible 100-500 range, so it scrolls just into view.
    expect(sidebarTop.get(sidebar)).toBe(180);
    expect(reveal).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    await user.click(within(nav).getByRole("button", { name: "Anki" }));
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(reveal.mock.instances[0]).toBe(document.querySelector(".settings-content__heading"));
  } finally {
    for (const spy of spies) spy.mockRestore();
    HTMLElement.prototype.scrollIntoView = scroll;
  }
});

it("keeps category navigation, handoffs and history in sync without losing preferences", async () => {
  // A link to a category since folded into another opens where its settings now are.
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(
    <MemoryRouter initialEntries={["/settings?section=library&keep=yes"]}>
      <AppearanceProvider store={{ load: async () => ({ libraryCardSize: 200 }), save }}>
        <NavigationProbe />
        <SettingsPage />
      </AppearanceProvider>
    </MemoryRouter>,
  );
  const nav = await screen.findByRole("navigation", { name: "Settings categories" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toHaveLength(7);
  expect(screen.getByRole("heading", { name: "General settings" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Increase Card size" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ libraryCardSize: 210 })),
  );
  for (const label of [
    "General",
    "Storage",
    "Shortcuts",
    "Reader popup",
    "Dictionary",
    "Anki",
    "Statistics",
  ]) {
    const button = within(nav).getByRole("button", { name: label });
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: `${label} settings` })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Current settings URL" })).toHaveTextContent(
      "keep=yes",
    );
  }
  await user.click(screen.getByRole("button", { name: "Previous section" }));
  expect(within(nav).getByRole("button", { name: "Anki" })).toHaveAttribute("aria-current", "page");
  await user.click(within(nav).getByRole("button", { name: "Dictionary" }));
  await user.click(document.querySelector<HTMLButtonElement>(".settings-inline-link")!);
  expect(within(nav).getByRole("button", { name: "Reader popup" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The popup's appearance is part of its own category now.
  expect(screen.getByRole("group", { name: "Popup theme" })).toBeInTheDocument();
  await user.click(within(nav).getByRole("button", { name: "General" }));
  expect(screen.getByRole("textbox", { name: "Card size" })).toHaveValue("210");
  await user.click(screen.getByRole("button", { name: "Unknown section" }));
  expect(within(nav).getByRole("button", { name: "General" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
