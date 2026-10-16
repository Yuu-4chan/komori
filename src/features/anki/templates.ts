import type {
  AnkiDiscovery,
  AnkiMapping,
  AnkiPreferences,
  DictionaryTagSource,
  FieldPart,
} from "./ankiApi";
import { glossaryCardContent } from "../dictionary/GlossaryText";
import { i18n } from "../../i18n/i18n";

export const placeholders = [
  "expression",
  "reading",
  "definition",
  "source",
  "frequency",
  "frequencyHarmonic",
  "frequencyAverage",
  "pitch",
  "sentence",
  "bookTitle",
  "expressionFurigana",
  "glossary",
  "picture",
  "selectionText",
  "audio",
] as const;
export type CardContext = Record<(typeof placeholders)[number], string>;
export const emptyContext: CardContext = {
  expression: "",
  reading: "",
  definition: "",
  source: "",
  frequency: "",
  frequencyHarmonic: "",
  frequencyAverage: "",
  pitch: "",
  sentence: "",
  bookTitle: "",
  expressionFurigana: "",
  glossary: "",
  picture: "",
  selectionText: "",
  audio: "",
};
const bytes = (text: string) => new TextEncoder().encode(text).length;
export function validText(text: string, limit = 16 * 1024): boolean {
  return (
    // eslint-disable-next-line no-control-regex -- Match native text validation.
    bytes(text) <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
  );
}
export function validTemplate(template: string): boolean {
  return (
    validText(template, 4096) &&
    [...template.matchAll(/\{\{dictionary:(\d+)\}\}/g)].every(
      (match) => Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0,
    ) &&
    !template
      .replace(
        /\{\{(expression|reading|definition|source|frequency|frequencyHarmonic|frequencyAverage|pitch|sentence|bookTitle|expressionFurigana|glossary|picture|selectionText|audio|dictionary:[1-9]\d{0,15})\}\}/g,
        "",
      )
      .match(/[{}]/)
  );
}
export function expandTemplate(template: string, context: CardContext): string {
  return template.replace(
    /\{\{(expression|reading|definition|source|frequency|frequencyHarmonic|frequencyAverage|pitch|sentence|bookTitle|expressionFurigana|glossary|picture|selectionText|audio)\}\}/g,
    (_, key: keyof CardContext) => context[key],
  );
}
export function mappedFields(mapping: AnkiMapping, context: CardContext): Record<string, string> {
  return Object.fromEntries(
    mapping.fields.map((field) => [field, expandTemplate(mapping.templates[field] ?? "", context)]),
  );
}
export function validFields(fields: Record<string, string>, order: string[]): boolean {
  return fieldProblem(fields, order) === null;
}
export function fieldProblem(fields: Record<string, string>, order: string[]): string | null {
  if (
    !order.length ||
    Object.keys(fields).length !== order.length ||
    order.some((name) => typeof fields[name] !== "string")
  )
    return i18n().t("ankiProblem.fieldsChanged");
  if (!fields[order[0]].trim()) return i18n().t("ankiProblem.firstEmpty", { field: order[0] });
  for (const name of order) {
    if (bytes(fields[name]) > 128 * 1024)
      return i18n().t("ankiProblem.fieldTooLarge", { field: name });
    if (!validText(fields[name], 128 * 1024))
      return i18n().t("ankiProblem.fieldControl", { field: name });
  }
  return Object.values(fields).reduce((sum, s) => sum + bytes(s), 0) > 512 * 1024
    ? i18n().t("ankiProblem.cardTooLarge")
    : null;
}
export function configurationProblem(
  prefs: AnkiPreferences,
  discovery: AnkiDiscovery,
): string | null {
  if (!discovery.decks.includes(prefs.deck)) return i18n().t("ankiProblem.deck");
  if (!discovery.models.includes(prefs.model)) return i18n().t("ankiProblem.model");
  if (prefs.deckId !== discovery.deckIds[prefs.deck]) return i18n().t("ankiProblem.deckReplaced");
  const mapping = prefs.mappings[prefs.model];
  if (
    !mapping ||
    mapping.modelId !== discovery.modelIds[prefs.model] ||
    JSON.stringify(mapping.fields) !== JSON.stringify(discovery.fields)
  )
    return i18n().t("ankiProblem.fieldsReview");
  if (!mapping.fields.every((field) => validTemplate(mapping.templates[field] ?? "")))
    return i18n().t("ankiProblem.templates");
  const tagsError = tagProblem(mapping.tags ?? ["komori"]);
  if (tagsError) return tagsError;
  const tagDictionaries = mapping.tagDictionaries ?? [];
  if (
    tagDictionaries.length > 32 ||
    new Set(tagDictionaries).size !== tagDictionaries.length ||
    tagDictionaries.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    return i18n().t("ankiProblem.dictionaryTags");
  return null;
}
export function tagProblem(tags: string[]): string | null {
  if (
    tags.length > 32 ||
    new Set(tags).size !== tags.length ||
    tags.some(
      (tag) => !tag || !validText(tag, 128) || /\s/u.test(tag) || tag.startsWith("komori_request_"),
    )
  )
    return i18n().t("ankiProblem.tags");
  return null;
}
export function currentMapping(
  fields: string[],
  previous?: AnkiMapping,
  modelId?: number,
): AnkiMapping {
  return {
    modelId,
    fields,
    templates: Object.fromEntries(fields.map((field) => [field, previous?.templates[field] ?? ""])),
    ...(previous?.tags ? { tags: previous.tags } : {}),
    ...(previous?.tagDictionaries ? { tagDictionaries: previous.tagDictionaries } : {}),
  };
}
export function lapisDefaults(fields: string[], modelId?: number): AnkiMapping {
  const templates: Record<string, string> = {
    Expression: "{{expression}}",
    ExpressionFurigana: "{{expressionFurigana}}",
    MainDefinition: "{{definition}}",
    Glossary: "{{glossary}}",
    Picture: "{{picture}}",
    Sentence: "{{sentence}}",
    SelectionText: "{{selectionText}}",
    ExpressionAudio: "{{audio}}",
    Frequency: "{{frequency}}",
    FreqSort: "{{frequencyHarmonic}}",
    PitchPosition: "{{pitch}}",
    MiscInfo: "{{bookTitle}}",
  };
  return {
    modelId,
    fields,
    templates: Object.fromEntries(fields.map((field) => [field, templates[field] ?? ""])),
  };
}

/** Anki's plain furigana syntax, keeping shared kana outside the annotation. */
export function expressionFurigana(expression: string, reading: string): string {
  if (!reading || expression === reading || !/[\p{Script=Han}]/u.test(expression))
    return expression;
  let start = 0;
  while (start < expression.length && expression[start] === reading[start]) start++;
  let end = 0;
  while (
    end < expression.length - start &&
    end < reading.length - start &&
    expression[expression.length - end - 1] === reading[reading.length - end - 1]
  )
    end++;
  return `${expression.slice(0, start)}${expression.slice(start, expression.length - end)}[${reading.slice(start, reading.length - end)}]${end ? expression.slice(-end) : ""}`;
}

export interface MappingSource {
  dictionaryId?: number;
  matchedText?: string;
  context: CardContext;
  glossary?: unknown;
  tagSources?: DictionaryTagSource[];
}
/** Only structured, inert parts cross IPC; native code owns the final HTML and cover. */
export function cardFields(mapping: AnkiMapping, sources: MappingSource[]) {
  const context = sources[0]?.context ?? emptyContext;
  const fieldParts: Record<string, FieldPart[]> = {};
  const fields: Record<string, string> = {};
  for (const field of mapping.fields) {
    const parts: FieldPart[] = [];
    const template = mapping.templates[field] ?? "";
    let offset = 0;
    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (match.index > offset)
        parts.push({ type: "text", text: template.slice(offset, match.index) });
      const key = match[1];
      if (key === "definition" || key === "glossary" || key.startsWith("dictionary:")) {
        const selected =
          key === "definition"
            ? sources.slice(0, 1)
            : key === "glossary"
              ? sources
              : sources.filter((s) => String(s.dictionaryId) === key.slice(11));
        parts.push({
          type: "definitions",
          entries: selected.map((s) => ({
            source: s.context.source,
            text: s.context.definition,
            ...(s.glossary === undefined ? {} : { presentation: glossaryCardContent(s.glossary) }),
          })),
        });
      } else if (key === "sentence")
        parts.push({
          type: "sentence",
          text: context.sentence,
          expression: sources[0]?.matchedText || context.expression,
        });
      else if (key === "picture") parts.push({ type: "cover" });
      else if (key === "audio")
        parts.push({ type: "audio", term: context.expression, reading: context.reading });
      else if (key === "frequency") parts.push({ type: "frequencies", text: context.frequency });
      else parts.push({ type: "text", text: context[key as keyof CardContext] ?? "" });
      offset = match.index + match[0].length;
    }
    if (offset < template.length) parts.push({ type: "text", text: template.slice(offset) });
    fieldParts[field] = parts;
    fields[field] = parts
      .map((p) =>
        p.type === "text" || p.type === "sentence" || p.type === "frequencies"
          ? p.text
          : p.type === "definitions"
            ? p.entries.map((entry) => entry.text).join("\n\n")
            : "",
      )
      .join("");
  }
  const dictionarySources: DictionaryTagSource[] = sources.flatMap((s, index) =>
    s.dictionaryId && sources.findIndex((other) => other.dictionaryId === s.dictionaryId) === index
      ? [{ id: s.dictionaryId, title: s.context.source }]
      : [],
  );
  for (const source of sources.flatMap((s) => s.tagSources ?? [])) {
    const existing = dictionarySources.find((s) => s.id === source.id);
    if (existing)
      existing.values = [...new Set([...(existing.values ?? []), ...(source.values ?? [])])];
    else dictionarySources.push({ ...source, values: [...new Set(source.values ?? [])] });
  }
  return { fields, fieldParts, dictionarySources };
}

/**
 * The first field alone, for existence checks: its parts, or the reason it cannot be checked.
 * Other fields (and their glossaries) are never built for a check.
 */
export function firstFieldParts(
  mapping: AnkiMapping,
  sources: MappingSource[],
): { parts: FieldPart[] } | { problem: string } {
  const first = mapping.fields[0];
  if (!first) return { problem: i18n().t("ankiProblem.fieldsChanged") };
  const { fields, fieldParts } = cardFields({ ...mapping, fields: [first] }, sources);
  if (!fields[first].trim())
    return { problem: i18n().t("ankiProblem.firstEmpty", { field: first }) };
  if (!validText(fields[first], 128 * 1024))
    return { problem: i18n().t("ankiProblem.firstInvalid", { field: first }) };
  return { parts: fieldParts[first] };
}
