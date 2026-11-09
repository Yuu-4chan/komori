import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import * as api from "./pcLinkApi";

vi.mock("../app/platform", () => ({ isAndroid: true }));
vi.mock("./pcLinkApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getPcLink: vi.fn(),
  usePcLink: vi.fn(() => null),
  pairPc: vi.fn(),
  setPcAddress: vi.fn(),
  setPcSync: vi.fn(),
  unpairPc: vi.fn(),
  checkPc: vi.fn(),
  listPcDictionaries: vi.fn(),
  copyPcDictionary: vi.fn(),
  syncPc: vi.fn(),
  onPcTransfer: vi.fn(async () => () => {}),
  pcStorage: vi.fn(async () => ({ kept: 0, cached: 0, covers: 0 })),
  clearPcCovers: vi.fn(),
}));

const { MobileSettingsPage } = await import("./MobileSettingsPage");

const unpaired: api.PcLink = {
  address: "",
  port: 39_217,
  paired: false,
  pcName: null,
  syncOn: true,
  lastSynced: null,
};
const paired: api.PcLink = {
  address: "192.168.0.10",
  port: 39_217,
  paired: true,
  pcName: "KOMORI-PC",
  syncOn: true,
  lastSynced: null,
};
const dictionary: api.PcDictionary = {
  id: 4,
  title: "JMdict",
  revision: "2026-10",
  termCount: 1200,
  termMetaCount: 0,
  kanjiCount: 0,
  kanjiMetaCount: 0,
  hasDefinitions: true,
  hasFrequency: false,
  hasPitch: false,
  size: 3 * 1024 * 1024,
  onPhone: false,
};

function sync() {
  render(
    <MemoryRouter initialEntries={["/settings?section=sync"]}>
      <AppearanceProvider store={null}>
        <MobileSettingsPage />
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sync on the phone", () => {
  it("pairs with the code the PC shows, then lists the PC's dictionaries to copy", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue(unpaired);
    vi.mocked(api.pairPc).mockResolvedValue(paired);
    vi.mocked(api.checkPc).mockResolvedValue({ status: "connected", name: "KOMORI-PC" });
    vi.mocked(api.listPcDictionaries).mockResolvedValue([
      dictionary,
      { ...dictionary, id: 5, title: "Pitch", onPhone: true },
    ]);
    vi.mocked(api.copyPcDictionary).mockResolvedValue("imported");
    sync();

    expect(screen.getByRole("heading", { level: 1, name: "Sync" })).toBeTruthy();
    const pair = await screen.findByRole("button", { name: "Pair" });
    expect((pair as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Address"), "192.168.0.10");
    await userEvent.type(screen.getByLabelText("Pairing code"), "482 913");
    await userEvent.click(pair);
    expect(api.pairPc).toHaveBeenCalledWith("192.168.0.10", 39_217, "482 913");

    expect(await screen.findByText("Connected to KOMORI-PC")).toBeTruthy();
    expect(screen.getByText("Paired")).toBeTruthy();
    const list = screen.getByRole("region", { name: "Dictionaries on KOMORI-PC" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("1,200 terms · 3 MB");
    expect(rows[1]!.textContent).toContain("On this phone");
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Copy" }));
    expect(api.copyPcDictionary).toHaveBeenCalledWith(4);
    await waitFor(() => expect(rows[0]!.textContent).toContain("On this phone"));
  });

  it("shows when it last synced, and syncs now", async () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    vi.mocked(api.getPcLink).mockResolvedValue({ ...paired, lastSynced: minutesAgo });
    vi.mocked(api.checkPc).mockResolvedValue({ status: "connected", name: "KOMORI-PC" });
    vi.mocked(api.listPcDictionaries).mockResolvedValue([]);
    vi.mocked(api.syncPc).mockResolvedValue({
      ...paired,
      lastSynced: new Date().toISOString(),
      changed: false,
      moved: [],
    });
    sync();

    expect(await screen.findByText("Last synced 5 minutes ago")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(api.syncPc).toHaveBeenCalled();
    expect(await screen.findByText("Last synced just now")).toBeTruthy();
  });

  it("shows what the PC's books and covers take here, and clears the covers", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue(paired);
    vi.mocked(api.checkPc).mockResolvedValue({ status: "connected", name: "KOMORI-PC" });
    vi.mocked(api.listPcDictionaries).mockResolvedValue([]);
    vi.mocked(api.pcStorage).mockResolvedValue({
      kept: 30 * 1024 * 1024,
      cached: 2 * 1024 * 1024,
      covers: 5 * 1024 * 1024,
    });
    vi.mocked(api.clearPcCovers).mockResolvedValue({
      kept: 30 * 1024 * 1024,
      cached: 2 * 1024 * 1024,
      covers: 0,
    });
    sync();
    const storage = await screen.findByRole("region", { name: "Storage" });
    expect(within(storage).getByText("Books from KOMORI-PC")).toBeTruthy();
    expect(within(storage).getByText("32 MB")).toBeTruthy();
    expect(within(storage).getByText("5 MB")).toBeTruthy();

    await userEvent.click(within(storage).getByRole("button", { name: "Clear" }));
    expect(api.clearPcCovers).toHaveBeenCalled();
    expect(await within(storage).findByText("0 bytes")).toBeTruthy();
    expect(within(storage).getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("says why pairing failed in words, without pairing", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue({ ...unpaired, address: "192.168.0.10" });
    vi.mocked(api.pairPc).mockRejectedValue("wrongCode");
    sync();

    await userEvent.type(await screen.findByLabelText("Pairing code"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong pairing code.");
    expect(screen.queryByText("Paired")).toBeNull();

    // After too many wrong codes the PC stops pairing until it shows a new code.
    vi.mocked(api.pairPc).mockRejectedValue("pairingLocked");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "The PC stopped pairing after too many wrong codes. Press New code on the PC.",
      ),
    );
  });

  it("follows the PC to a new address, and unpairs after asking", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue(paired);
    vi.mocked(api.checkPc).mockResolvedValue({ status: "unreachable", name: "KOMORI-PC" });
    vi.mocked(api.setPcAddress).mockResolvedValue({ ...paired, address: "192.168.0.22" });
    vi.mocked(api.unpairPc).mockResolvedValue({ ...unpaired, address: "192.168.0.22" });
    sync();

    expect(await screen.findByText(/The PC isn't answering/)).toBeTruthy();
    const address = screen.getByLabelText("Address");
    await userEvent.clear(address);
    await userEvent.type(address, "192.168.0.22");
    await userEvent.tab();
    expect(api.setPcAddress).toHaveBeenCalledWith("192.168.0.22", 39_217);
    await waitFor(() => expect(api.checkPc).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Unpair this phone" }));
    const dialog = screen.getByRole("alertdialog", { name: "Unpair from KOMORI-PC?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Unpair" }));
    expect(api.unpairPc).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Pair" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpair this phone" })).toBeNull();
  });
});
