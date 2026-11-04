import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

/** Settings > Devices on the PC, as native code reports it. */
export interface DevicesView {
  allowed: boolean;
  port: number;
  /** The PC's address on its network, when it has one. */
  address: string | null;
  /** The code a phone pairs with, while the PC listens. */
  code: string | null;
  status: "off" | "listening" | "portInUse" | "failed";
  devices: PairedDevice[];
}

export const getDevices = () => invoke<DevicesView>("get_devices");
export const setDevicesAllowed = (allowed: boolean) =>
  invoke<DevicesView>("set_devices_allowed", { allowed });
export const setDevicesPort = (port: number) => invoke<DevicesView>("set_devices_port", { port });
export const newPairingCode = () => invoke<DevicesView>("new_pairing_code");
export const removeDevice = (id: string) => invoke<DevicesView>("remove_device", { id });

/** Calls `changed` when a phone pairs, connects or unpairs itself. */
export const onDevicesChanged = (changed: () => void) => listen("devices-changed", changed);

/** "482 913": the code in two groups of three, as phones ask for it. */
export const groupedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
