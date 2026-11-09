import { describe, expect, it } from "vitest";
import { lookupLanguageOf } from "./lookupLanguage";

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
  });

  it("names nothing for a language lookups do not read, or no tag", () => {
    for (const tag of [undefined, null, "", "nl", "und", "x-klingon", "italian"])
      expect(lookupLanguageOf(tag)).toBeUndefined();
  });
});
