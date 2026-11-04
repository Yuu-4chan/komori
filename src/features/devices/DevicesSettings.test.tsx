import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "./devicesApi";
import { DevicesSettings } from "./DevicesSettings";

vi.mock("./devicesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getDevices: vi.fn(),
  setDevicesAllowed: vi.fn(),
  setDevicesPort: vi.fn(),
  newPairingCode: vi.fn(),
  removeDevice: vi.fn(),
  onDevicesChanged: vi.fn(async () => () => {}),
}));

const listening: api.DevicesView = {
  allowed: true,
  port: 39_217,
  address: "192.168.0.10",
  code: "482913",
  status: "listening",
  devices: [
    {
      id: "phone-1",
      name: "Galaxy S24",
      pairedAt: "2026-11-01T00:00:00Z",
      lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings > Devices", () => {
  it("shows where phones find this PC, the code they pair with, and the phones paired", async () => {
    vi.mocked(api.getDevices).mockResolvedValue(listening);
    vi.mocked(api.newPairingCode).mockResolvedValue({ ...listening, code: "105377" });
    vi.mocked(api.removeDevice).mockResolvedValue({ ...listening, devices: [] });
    render(<DevicesSettings />);

    expect(await screen.findByText("482 913")).toBeTruthy();
    expect(screen.getByText("192.168.0.10")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("39217"),
    );
    await userEvent.click(screen.getByRole("button", { name: "New code" }));
    expect(await screen.findByText("105 377")).toBeTruthy();

    const phone = screen.getByText("Galaxy S24").closest(".settings-row") as HTMLElement;
    expect(phone.textContent).toContain("Last connected 2 minutes ago");
    await userEvent.click(within(phone).getByRole("button", { name: "Remove" }));
    expect(api.removeDevice).toHaveBeenCalledWith("phone-1");
    expect(await screen.findByText("No phones paired")).toBeTruthy();
  });

  it("hides the code while phones may not connect, and says when the port is taken", async () => {
    vi.mocked(api.getDevices).mockResolvedValue({
      ...listening,
      allowed: false,
      code: null,
      status: "off",
    });
    vi.mocked(api.setDevicesAllowed).mockResolvedValue({
      ...listening,
      code: null,
      status: "portInUse",
    });
    vi.mocked(api.setDevicesPort).mockResolvedValue(listening);
    render(<DevicesSettings />);

    const allow = await screen.findByRole("button", { name: "Allow phones to connect" });
    expect(screen.getByText("––– –––")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New code" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(allow);
    expect(api.setDevicesAllowed).toHaveBeenCalledWith(true);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Port 39217 is in use by another app.",
    );

    const port = screen.getByLabelText("Port");
    await userEvent.clear(port);
    await userEvent.type(port, "40000{Enter}");
    expect(api.setDevicesPort).toHaveBeenCalledWith(40_000);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
