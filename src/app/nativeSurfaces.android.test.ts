import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./platform", () => ({ isAndroid: true }));
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { copyText, guardDocument, setSurfaceHost } = await import("./nativeSurfaces");
type SurfaceHost = Parameters<typeof setSurfaceHost>[0];

describe("browser surfaces on the phone", () => {
  let host: { [K in keyof SurfaceHost]: Mock<SurfaceHost[K]> };
  let cleanups: (() => void)[];

  beforeEach(() => {
    host = {
      tooltip: vi.fn<SurfaceHost["tooltip"]>(),
      menu: vi.fn<SurfaceHost["menu"]>(),
      list: vi.fn<SurfaceHost["list"]>(),
    };
    cleanups = [setSurfaceHost(host), guardDocument(document)];
  });
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    document.body.innerHTML = "";
  });

  it("leaves a long press to Android, which selects with its handles and toolbar", () => {
    document.body.innerHTML = '<input aria-label="Search" value="cats" /><p>Some text</p>';
    for (const target of [document.querySelector("input")!, document.querySelector("p")!]) {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(host.menu).not.toHaveBeenCalled();
  });

  it("copies through Android, as the WebView may not write the clipboard", () => {
    copyText("羅生門");
    expect(invoke).toHaveBeenCalledWith("copy_text", { text: "羅生門" });
  });
});
