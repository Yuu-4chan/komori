import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import * as api from "../features/anki/ankiApi";

vi.mock("../app/platform", () => ({ isAndroid: true }));
vi.mock("../features/dictionary/dictionaryApi", () => ({
  listDictionaries: vi.fn(async () => []),
}));
vi.mock("../features/anki/ankiApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  loadAnki: vi.fn(),
  cachedAnki: vi.fn(),
  discoverAnki: vi.fn(),
  pendingRequests: vi.fn(async () => []),
  allowAnkiDroid: vi.fn(),
  openAnkiDroidStore: vi.fn(async () => {}),
}));

const { MobileSettingsPage } = await import("./MobileSettingsPage");

const prefs: api.AnkiPreferences = { ...api.emptyAnki, deck: "Mining", model: "Lapis" };
const discovery: api.AnkiDiscovery = {
  deckIds: { Mining: 1 },
  modelIds: { Lapis: 2 },
  decks: ["Mining"],
  models: ["Lapis"],
  fields: ["Expression"],
  lapis: "compatible",
};

function settings(section?: string) {
  render(
    <MemoryRouter initialEntries={[section ? `/settings?section=${section}` : "/settings"]}>
      <AppearanceProvider store={null}>
        <MobileSettingsPage />
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.loadAnki).mockResolvedValue(prefs);
  vi.mocked(api.cachedAnki).mockResolvedValue(prefs);
  vi.mocked(api.discoverAnki).mockResolvedValue(discovery);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Anki on the phone", () => {
  it("names AnkiDroid and the deck in the Settings row", async () => {
    settings();
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(await within(nav).findByText("AnkiDroid · Mining")).toBeTruthy();
  });

  it("shows AnkiDroid's connection without a port or key, then the card settings", async () => {
    settings("anki");
    expect(screen.getByRole("heading", { level: 1, name: "Anki" })).toBeTruthy();
    expect(await screen.findByText("Connected to AnkiDroid")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AnkiDroid" })).toBeTruthy();
    expect(screen.queryByLabelText("Port")).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.getByLabelText("Deck")).toHaveValue("Mining");
  });

  it("asks for access when AnkiDroid is not allowed, and looks again", async () => {
    vi.mocked(api.discoverAnki).mockRejectedValueOnce("notAllowed");
    vi.mocked(api.allowAnkiDroid).mockResolvedValue(true);
    settings("anki");
    expect(await screen.findByText("Not allowed")).toBeTruthy();
    expect(document.querySelector(".anki-status")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Allow access" }));
    expect(api.allowAnkiDroid).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Connected to AnkiDroid")).toBeTruthy();
  });

  it("opens AnkiDroid's store page when it is not installed, and looks again on return", async () => {
    vi.mocked(api.discoverAnki).mockRejectedValueOnce("notInstalled");
    settings("anki");
    expect(await screen.findByText("Not installed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Get AnkiDroid" }));
    expect(api.openAnkiDroidStore).toHaveBeenCalledTimes(1);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByText("Connected to AnkiDroid")).toBeTruthy();
  });

  it("says AnkiDroid needs its setup, with Check again", async () => {
    vi.mocked(api.discoverAnki).mockRejectedValueOnce("notReady");
    settings("anki");
    expect(await screen.findByText("Not ready")).toBeTruthy();
    expect(screen.getByText("Open AnkiDroid once to finish setting it up.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Connected to AnkiDroid")).toBeTruthy();
  });
});
