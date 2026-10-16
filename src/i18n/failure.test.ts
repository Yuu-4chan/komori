import { expect, it } from "vitest";

import { failureText } from "./failure";
import { catalogs, translatorFor } from "./i18n";
import native from "../../src-tauri/src/failure.rs?raw";

const codes = [...native.matchAll(/"(failure\.\w+)"/g)].map((match) => match[1]);

it("translates every native failure code in every interface language", () => {
  expect(codes.length).toBeGreaterThan(15);
  for (const [language, catalog] of Object.entries(catalogs)) {
    const missing = codes.filter((code) => !(catalog as Record<string, string>)[code]);
    expect(missing, language).toEqual([]);
  }
  const { t } = translatorFor("ja");
  expect(failureText("failure.bookGone", t)).toBe("この本はもう本棚にありません。");
});

it("shows any other native text as it came", () => {
  const { t } = translatorFor("pt-BR");
  expect(failureText("Library storage error: disk I/O error", t)).toBe(
    "Library storage error: disk I/O error",
  );
  expect(failureText("failure.notAKnownCode", t)).toBe("failure.notAKnownCode");
  expect(failureText("failure.toString", t)).toBe("failure.toString");
});
