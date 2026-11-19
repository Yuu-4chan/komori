import { describe, expect, it } from "vitest";
import { lookupLanguageOf, spacesWords } from "./lookupLanguage";

describe("lookupLanguageOf", () => {
  it("reads a tag's primary subtag as a two- or three-letter code, in either case", () => {
    expect(lookupLanguageOf("it")).toBe("it");
    expect(lookupLanguageOf(" IT-it ")).toBe("it");
    expect(lookupLanguageOf("ita")).toBe("it");
    expect(lookupLanguageOf("zh_Hant_TW")).toBe("zh");
    expect(lookupLanguageOf("cmn")).toBe("zh");
    expect(lookupLanguageOf("ger")).toBe("de");
    expect(lookupLanguageOf("fre")).toBe("fr");
    expect(lookupLanguageOf("jpn")).toBe("ja");
    expect(lookupLanguageOf("nl-BE")).toBe("nl");
    expect(lookupLanguageOf("dut")).toBe("nl");
    expect(lookupLanguageOf("nob")).toBe("nb");
    expect(lookupLanguageOf("no")).toBe("nb");
    expect(lookupLanguageOf("gre")).toBe("el");
    expect(lookupLanguageOf("ar-EG")).toBe("ar");
    expect(lookupLanguageOf("arb")).toBe("ar");
    expect(lookupLanguageOf("tha")).toBe("th");
    expect(lookupLanguageOf("ind")).toBe("id");
  });

  it("scans Japanese, Chinese and Thai without word spaces", () => {
    expect(spacesWords("th")).toBe(false);
    expect(spacesWords("ar")).toBe(true);
    expect(spacesWords("hi")).toBe(true);
  });

  it("names nothing for a language lookups do not read, or no tag", () => {
    for (const tag of [undefined, null, "", "nn", "jv", "und", "x-klingon", "italian"])
      expect(lookupLanguageOf(tag)).toBeUndefined();
  });
});
