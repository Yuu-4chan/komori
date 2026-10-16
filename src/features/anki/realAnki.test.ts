import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { TermLookup } from "../dictionary/dictionaryApi";
import { termCardSources } from "./AnkiAction";
import { cardFields, lapisDefaults, validFields } from "./templates";

it.skipIf(!process.env.KOMORI_POPUP_LOOKUP_SAMPLE)(
  "validates reported terms from read-only real dictionary lookups",
  () => {
    const lookups: Record<string, TermLookup> = JSON.parse(
      readFileSync(process.env.KOMORI_POPUP_LOOKUP_SAMPLE!, "utf8"),
    );
    const mapping = lapisDefaults([
      "Expression",
      "ExpressionFurigana",
      "ExpressionReading",
      "ExpressionAudio",
      "SelectionText",
      "MainDefinition",
      "DefinitionPicture",
      "Sentence",
      "SentenceFurigana",
      "SentenceAudio",
      "Picture",
      "Glossary",
      "Hint",
      "IsWordAndSentenceCard",
      "IsClickCard",
      "IsSentenceCard",
      "IsAudioCard",
      "PitchPosition",
      "PitchCategories",
      "Frequency",
      "FreqSort",
      "MiscInfo",
    ]);
    const samples = Object.entries(lookups).flatMap(([term, lookup]) =>
      lookup.groups.map((group) => {
        const content = cardFields(mapping, termCardSources(group));
        expect(validFields(content.fields, mapping.fields)).toBe(true);
        console.log(
          `${term} → ${group.expression}: ${new TextEncoder().encode(content.fields.Glossary).length} glossary bytes; ${JSON.stringify(content).length} content characters`,
        );
        return { term, ...content };
      }),
    );
    expect(samples.length).toBeGreaterThan(3);
    expect(
      samples.some((s) => new TextEncoder().encode(s.fields.Glossary).length > 16 * 1024),
    ).toBe(true);
    writeFileSync("artifacts/validation/0132-real-card-parts.json", JSON.stringify(samples));
  },
);
