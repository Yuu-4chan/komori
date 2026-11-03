import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider } from "../../i18n/i18n";
import { inflectionKeys, inflectionNames } from "./DictionaryResults";

const rules = join(process.cwd(), "src-tauri/src/dictionary/deinflect");

describe("inflection names", () => {
  afterEach(() => {
    render(<I18nProvider language="en">{null}</I18nProvider>).unmount();
  });

  it("are translated for every name the native rules give, except endings and affixes", () => {
    const names = readdirSync(rules).flatMap((file) =>
      [...readFileSync(join(rules, file), "utf8").matchAll(/const \w+: &str = "([^"]+)";/g)].map(
        ([, name]) => name,
      ),
    );
    expect(names).toContain("past participle");
    const untranslated = names.filter(
      (name) => !name.startsWith("-") && !name.endsWith("-") && !inflectionKeys[name],
    );
    expect(untranslated).toEqual([]);
  });

  it("show in the interface language, and endings keep their spelling", () => {
    render(<I18nProvider language="pt-BR">{null}</I18nProvider>).unmount();
    expect(inflectionNames(["past participle"])).toBe("particípio passado");
    render(<I18nProvider language="ru">{null}</I18nProvider>).unmount();
    expect(inflectionNames(["gerund"])).toBe("деепричастие");
    expect(inflectionNames(["-ing"])).toBe("-ing");
  });
});
