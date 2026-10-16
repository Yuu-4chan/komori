import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Locked packages must stay at or above the first release that fixes every known advisory.
const patched = {
  "@xmldom/xmldom": [0, 8, 15],
  "source-map-js": [1, 2, 2],
};

function lockedVersions(lockfile, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@(\\d+)\\.(\\d+)\\.(\\d+)'?:`, "gmu");
  return [...lockfile.matchAll(pattern)].map((match) => match.slice(1).map(Number));
}

function atLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

describe("dependency advisories", () => {
  const lockfile = readFileSync("pnpm-lock.yaml", "utf8");

  it.each(Object.entries(patched))("locks %s at a patched version", (name, minimum) => {
    const versions = lockedVersions(lockfile, name);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(atLeast(version, minimum), `${name}@${version.join(".")}`).toBe(true);
    }
  });
});
