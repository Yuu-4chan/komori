import { describe, expect, it } from "vitest";
import { pathsIn, peSubsystem, peVersions } from "./check-release.mjs";

/** A minimal PE image: DOS header, PE signature, subsystem and a fixed version resource. */
function pe(subsystem, [major, minor, patch]) {
  const bytes = Buffer.alloc(0x200);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  bytes.writeUInt16LE(subsystem, 0x80 + 24 + 68);
  const info = 0x180;
  bytes.writeUInt32LE(0xfeef04bd, info);
  for (const offset of [8, 16]) {
    bytes.writeUInt32LE((major << 16) | minor, info + offset);
    bytes.writeUInt32LE(patch << 16, info + offset + 4);
  }
  return bytes;
}

describe("release checks", () => {
  it("read the PE subsystem and version", () => {
    expect(peSubsystem(pe(2, [1, 0, 0]))).toBe(2);
    expect(peSubsystem(pe(3, [1, 0, 0]))).toBe(3);
    expect(peVersions(pe(2, [1, 2, 3]))).toEqual({ file: "1.2.3.0", product: "1.2.3.0" });
    expect(() => peSubsystem(Buffer.alloc(0x100))).toThrow();
  });

  it("find absolute and source paths, not license text", () => {
    expect(pathsIn("see C:\\Users\\someone\\.cargo\\registry\\x.rs here")).toEqual([
      "C:\\Users\\someone\\.cargo\\registry\\x.rs",
    ]);
    expect(pathsIn("built in D:\\a\\komori\\komori\\src-tauri")).toEqual([
      "D:\\a\\komori\\komori\\src-tauri",
    ]);
    expect(pathsIn("from src-tauri/src/library.rs:42")).toEqual(["src-tauri/src/library.rs"]);
    expect(pathsIn("failed in src/features/reader/Reader.tsx")).toEqual([
      "src/features/reader/Reader.tsx",
    ]);
    expect(pathsIn("a) Disclaiming warranty s:\r\n\r\n (C) <year>")).toEqual([]);
    expect(
      pathsIn("modified in src-tauri/src/dictionary/deinflect.rs", [
        "src-tauri/src/dictionary/deinflect.rs",
      ]),
    ).toEqual([]);
  });
});
