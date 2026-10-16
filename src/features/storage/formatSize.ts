import { i18n } from "../../i18n/i18n";

const sizeUnits = ["KB", "MB", "GB", "TB"];

/** Bytes in binary units, as Windows shows file sizes: 1.5 KB, 736 MB. */
export function formatSize(bytes: number): string {
  const { number, tp } = i18n();
  if (bytes < 1024) return tp("size.bytes", bytes);
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 ? 1 : 0;
  return `${number(value, { maximumFractionDigits: digits })} ${sizeUnits[unit]}`;
}
