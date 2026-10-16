// Writes the synthetic books for the manual release checks into a folder: the real-engine smoke
// test's EPUBs, which open normally, and two damaged ones, which Komori must refuse without
// failing: a truncated archive and a ZIP that is not an EPUB.
// Usage: node scripts/release-books.mjs <folder>
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeBooks, writeDropFiles } from "./reader-real/books.mjs";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node scripts/release-books.mjs <folder>");
  process.exit(2);
}
const good = writeBooks(resolve(folder));
const { book } = writeDropFiles(join(resolve(folder), "drop"));
const whole = readFileSync(good[0].path);
writeFileSync(
  join(resolve(folder), "Damaged truncated.epub"),
  whole.subarray(0, whole.length >> 1),
);
// An empty ZIP archive: the end-of-central-directory record alone.
const emptyZip = Buffer.alloc(22);
emptyZip.writeUInt32LE(0x06054b50, 0);
writeFileSync(join(resolve(folder), "Damaged not an epub.epub"), emptyZip);
console.log(`${good.length} good books, 2 damaged ones and ${book} in ${resolve(folder)}`);
