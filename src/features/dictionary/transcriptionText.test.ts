import { describe, expect, it } from "vitest";

import { transcriptionText } from "./lookupLanguage";

describe("transcriptionText", () => {
  it("marks only phonetic alphabets as transcriptions", () => {
    expect(transcriptionText("en", ["kæt", "/kat/", "[kʰæt]"])).toBe("/kæt/, /kat/, [kʰæt]");
    expect(transcriptionText("zh", ["nǐ hǎo"])).toBe("nǐ hǎo");
    expect(transcriptionText("ko", ["먹따", "mʌk̚t͈a̠"])).toBe("먹따, /mʌk̚t͈a̠/");
  });
});
