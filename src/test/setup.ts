import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy and waitFor give up after a second by default, which a busy machine running the whole
// suite in parallel can exceed while a heavy screen renders; each still returns as soon as its
// check passes.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});
