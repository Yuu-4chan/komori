/**
 * How far a heading image's drawn content moves, as fractions of the image's width and
 * height, so it sits centered in the image's own box. Many chapter-name images leave
 * blank space on one side, such as a title drawn at the top of a page-tall strip.
 */
export interface InkShift {
  x: number;
  y: number;
}

/** A shift smaller than this share of an axis is left alone. */
const MINIMUM_SHIFT = 0.01;
/** How far a channel may differ from the background and still count as background. */
const TOLERANCE = 32;
/** The longest side an image is measured at; a larger one is scaled down first. */
const MEASURED_SIDE = 1024;

/**
 * The shift centering an image's content, from its RGBA pixels. The background is the
 * color all four corners share; an image whose corners differ has no clear background
 * and is left alone, as is one with no content or already centered content.
 */
export function inkShift(
  data: ArrayLike<number>,
  width: number,
  height: number,
): InkShift | undefined {
  if (width < 1 || height < 1 || data.length < width * height * 4) return undefined;
  const pixel = (x: number, y: number) => (y * width + x) * 4;
  const background = pixel(0, 0);
  const differs = (index: number) => {
    // Fully transparent pixels are background whatever their color.
    if (data[index + 3] < TOLERANCE && data[background + 3] < TOLERANCE) return false;
    for (let channel = 0; channel < 4; channel++)
      if (Math.abs(data[index + channel] - data[background + channel]) > TOLERANCE) return true;
    return false;
  };
  const corners = [pixel(width - 1, 0), pixel(0, height - 1), pixel(width - 1, height - 1)];
  if (corners.some(differs)) return undefined;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!differs(pixel(x, y))) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return undefined;
  const shift = (start: number, end: number, size: number) => {
    const share = (size - 1 - end - start) / 2 / size;
    return Math.abs(share) < MINIMUM_SHIFT ? 0 : share;
  };
  const x = shift(left, right, width);
  const y = shift(top, bottom, height);
  return x || y ? { x, y } : undefined;
}

/** The shift centering an image file's content, or none when it cannot be measured. */
export async function imageInkShift(blob: Blob): Promise<InkShift | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MEASURED_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    return inkShift(context.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bitmap.close();
  }
}
