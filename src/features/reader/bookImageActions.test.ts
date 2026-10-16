import { afterEach, describe, expect, it, vi } from "vitest";
import { imageBlob } from "./bookImageActions";

describe("book image actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands over a raster as loaded and draws a drawing as a large PNG", async () => {
    const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
    expect(await imageBlob({ url: "blob:photo", width: 4, height: 3, blob: jpeg })).toBe(jpeg);
    await expect(imageBlob({ url: "blob:none", width: 4, height: 3 })).rejects.toThrow();

    // jsdom decodes no images.
    const decode = vi.fn(async () => undefined);
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      writable: true,
      value: decode,
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const png = new Blob(["png"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      done,
    ) {
      expect([this.width, this.height]).toEqual([1440, 2048]);
      done(png);
    });
    const svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
    expect(await imageBlob({ url: "blob:drawing", width: 720, height: 1024, blob: svg })).toBe(png);
    expect(decode).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 1440, 2048);
    expect((drawImage.mock.calls[0][0] as HTMLImageElement).src).toBe("blob:drawing");
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });
});
