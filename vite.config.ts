import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The release date About shows: the date of the commit the build is made from, which for a
// release is its version's. A build outside a Git checkout shows none.
if (!process.env.VITE_RELEASE_DATE) {
  try {
    process.env.VITE_RELEASE_DATE = execFileSync("git", ["log", "-1", "--format=%cs"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* No Git: no release date. */
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // WebView2 on Windows and Android System WebView are both Chromium.
    target: ["windows", "android"].includes(process.env.TAURI_ENV_PLATFORM ?? "")
      ? "chrome105"
      : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
