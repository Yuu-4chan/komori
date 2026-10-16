import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // The heaviest panel tests take about 3 s alone and exceed the 5 s default when the whole
    // suite runs in parallel on a busy machine.
    testTimeout: 15_000,
  },
});
