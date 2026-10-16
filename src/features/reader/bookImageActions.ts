import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ReaderImageResource } from "./renderer";

/** Draws an image once onto a canvas of its size and returns it as a PNG. */
function drawnPng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Image conversion unavailable");
  context.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(Error("Image conversion failed"))),
      "image/png",
    ),
  );
}

/** The clipboard takes images as PNG; other rasters are drawn once to convert them. */
async function pngImage(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    return await drawnPng(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Copies a shown book image to the clipboard. */
export async function copyBookImage(blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw Error("Image clipboard unavailable");
  const png = await pngImage(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/**
 * Saves a shown book image where the reader chooses; Komori checks the bytes natively and
 * suggests `name` for the file.
 */
export async function saveBookImage(
  blob: Blob,
  name: string,
): Promise<"saved" | "canceled" | "failed"> {
  if (!isTauri()) return "failed";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const status = await invoke<string>("save_book_image", bytes, {
    headers: { "x-komori-file-name": encodeURIComponent(name) },
  });
  return status === "saved" || status === "canceled" ? status : "failed";
}

/** The longest side a drawing is copied or saved at, in pixels, unless it is larger. */
const DRAWING_SIDE = 2048;

/**
 * The image a loaded resource shows, as a raster blob. A drawing is drawn as a PNG, since
 * neither the clipboard nor a saved image file takes SVG.
 */
export async function imageBlob(resource: ReaderImageResource): Promise<Blob> {
  const { blob } = resource;
  if (!blob) throw Error("Image unavailable");
  if (blob.type !== "image/svg+xml") return blob;
  const image = new Image();
  image.src = resource.url;
  await image.decode();
  const shown = [resource.width || image.naturalWidth, resource.height || image.naturalHeight];
  if (!shown.every((side) => side > 0)) throw Error("Image unavailable");
  // A drawing has no resolution of its own: draw it as large as a sharp picture.
  const scale = Math.max(1, DRAWING_SIDE / Math.max(...shown));
  return drawnPng(image, Math.round(shown[0] * scale), Math.round(shown[1] * scale));
}
