import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Release builds must use the Windows GUI subsystem, or Explorer opens a console beside Komori.
describe("Windows subsystem", () => {
  it("builds release executables as GUI programs and keeps the debug console", () => {
    const main = readFileSync("src-tauri/src/main.rs", "utf8");
    expect(main).toMatch(
      /^#!\[cfg_attr\(\s*not\(debug_assertions\),\s*windows_subsystem\s*=\s*"windows"\s*\)\]/mu,
    );
  });
});
