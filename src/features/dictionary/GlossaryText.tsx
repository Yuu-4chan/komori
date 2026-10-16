import { i18n } from "../../i18n/i18n";
import { Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import { openExternalLink } from "./dictionaryApi";
import {
  externalUrl,
  glossaryData,
  glossaryStyle,
  internalQuery,
  type GlossaryStyle,
} from "./glossaryStyle";

type PresentationRole =
  | "example-group"
  | "example-sentence"
  | "example-translation"
  | "note-group"
  | "note-label"
  | "note-content"
  | "xref-group"
  | "xref-label"
  | "xref-glossary"
  | "attribution"
  | "attribution-footnote"
  | "part-of-speech";

type ElementTag =
  | "div"
  | "p"
  | "span"
  | "ul"
  | "ol"
  | "li"
  | "ruby"
  | "rt"
  | "rp"
  | "table"
  | "thead"
  | "tbody"
  | "tfoot"
  | "tr"
  | "td"
  | "th"
  | "details"
  | "summary";

/** What an imported element keeps besides its content: all checked, all inert. */
interface ElementAttributes {
  reading?: boolean;
  presentation?: PresentationRole;
  style?: GlossaryStyle;
  data?: Record<string, string>;
  title?: string;
  lang?: string;
  colSpan?: number;
  rowSpan?: number;
  open?: boolean;
}

type GlossaryNode =
  | { kind: "text"; value: string }
  | { kind: "break" }
  // A dictionary link searches the term its `?query=` names (or, without one, its label), or
  // opens a web page; anything else stays a plain label.
  | { kind: "link"; children: GlossaryNode[]; query: string | null; url: string | null }
  | ({ kind: "element"; tag: ElementTag; children: GlossaryNode[] } & ElementAttributes);

/** Inert popup presentation; native Anki export supplies all markup and checks it again. */
export type GlossaryCardNode =
  | { kind: "text"; value: string }
  | { kind: "break" }
  | { kind: "link"; children: GlossaryCardNode[]; url?: string }
  | ({ kind: "element"; tag: ElementTag; children: GlossaryCardNode[] } & ElementAttributes);

type RenderContext = {
  onSearchTerm?: (term: string) => void;
  parent: string;
  // Inside a link or ruby, parts join without a separating space.
  joined: boolean;
  inLink: boolean;
};

const mediaTypes = new Set(["image", "audio", "video", "svg"]);
const mediaTags = new Set(["img", "audio", "video", "svg", "source", "picture", "iframe"]);
const discardedTags = new Set(["script", "style", "link", "meta"]);
const blockTags = new Set([
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "details",
  "summary",
]);
const tableParts = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

// Readings (ruby rt/rp and inline `wari` spans) are shown with the label but are not
// part of the searched term.
function linkQuery(nodes: GlossaryNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.value;
      if (node.kind === "break") return " ";
      if (node.kind === "link") return node.query;
      if (node.reading) return "";
      return linkQuery(node.children);
    })
    .join("");
}

// A searched term must be within the native query limits.
function searchable(query: string | null): string | null {
  const term = query?.trim();
  return term && [...term].length <= 256 && new TextEncoder().encode(term).length <= 1024
    ? term
    : null;
}

// Without a `?query=` target, only a label with Japanese text is searched.
function labelQuery(nodes: GlossaryNode[]): string | null {
  const label = linkQuery(nodes).trim();
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(label) ? label : null;
}

// Some monolingual dictionaries mark an inline reading with a `wari` data attribute; no other data is read.
function isReadingSpan(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, "wari");
}

// Only these exact Jitendex tag/marker pairs affect presentation; other metadata stays inert.
function presentationRole(tag: string, data: unknown): PresentationRole | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  switch ((data as Record<string, unknown>).content) {
    case "example-sentence":
      return tag === "div" ? "example-group" : undefined;
    case "example-sentence-a":
      return tag === "div" ? "example-sentence" : undefined;
    case "example-sentence-b":
      return tag === "div" ? "example-translation" : undefined;
    case "sense-note":
      return tag === "div" ? "note-group" : undefined;
    case "sense-note-label":
      return tag === "div" ? "note-label" : undefined;
    case "sense-note-content":
      return tag === "div" ? "note-content" : undefined;
    case "xref":
      return tag === "div" ? "xref-group" : undefined;
    case "reference-label":
      return tag === "span" ? "xref-label" : undefined;
    case "xref-glossary":
      return tag === "div" ? "xref-glossary" : undefined;
    case "attribution":
      return tag === "div" ? "attribution" : undefined;
    case "attribution-footnote":
      return tag === "span" ? "attribution-footnote" : undefined;
    case "part-of-speech-info":
      return tag === "span" ? "part-of-speech" : undefined;
    default:
      return undefined;
  }
}

function readNodes(value: unknown, depth = 0, structured = false): GlossaryNode[] {
  if (depth > 32) return [];
  if (typeof value === "string") return value ? [{ kind: "text", value }] : [];
  if (Array.isArray(value))
    return value.flatMap((child) => readNodes(child, depth + 1, structured));
  if (!value || typeof value !== "object") return [];

  const item = value as Record<string, unknown>;
  if ("type" in item && item.type !== "structured-content" && item.type !== "text") {
    // Unknown types can carry media metadata or private paths.
    return [];
  }
  const tag = typeof item.tag === "string" ? item.tag.toLowerCase() : "";
  if (mediaTypes.has(tag) || mediaTags.has(tag) || discardedTags.has(tag)) return [];
  if (tag === "br") return [{ kind: "break" }];

  // Only content and text are glossary text. A link's href is read only as a search or an
  // http(s) address; styles, data, and titles only through their allowlists; never paths or src.
  const children = readNodes(
    item.content ?? item.text,
    depth + 1,
    structured || item.type === "structured-content",
  );
  if (!children.length) return [];
  if (tag === "a" && (structured || item.type === "structured-content")) {
    const href = typeof item.href === "string" ? item.href : "";
    const url = externalUrl(href);
    const query = url ? null : (internalQuery(href) ?? labelQuery(children));
    return [{ kind: "link", children, query, url }];
  }
  if (!tag) return children;
  const attributes = elementAttributes(tag, item);
  if (blockTags.has(tag) || tag === "ruby")
    return [
      {
        kind: "element",
        tag: tag as ElementTag,
        children,
        ...attributes,
        ...withRole(tag, item.data),
      },
    ];
  if (tag === "rt" || tag === "rp")
    return [{ kind: "element", tag, children, ...attributes, reading: true }];
  if (isReadingSpan(item.data)) {
    return [{ kind: "element", tag: "span", children, ...attributes, reading: true }];
  }
  return [{ kind: "element", tag: "span", children, ...attributes, ...withRole(tag, item.data) }];
}

function withRole(tag: string, data: unknown): { presentation?: PresentationRole } {
  const presentation = presentationRole(tag, data);
  return presentation ? { presentation } : {};
}

function elementAttributes(tag: string, item: Record<string, unknown>): ElementAttributes {
  const attributes: ElementAttributes = {};
  const style = glossaryStyle(item.style);
  if (style) attributes.style = style;
  const data = glossaryData(item.data);
  if (data) attributes.data = data;
  if (typeof item.title === "string" && item.title.trim() && [...item.title].length <= 256)
    attributes.title = item.title;
  if (typeof item.lang === "string" && /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/u.test(item.lang))
    attributes.lang = item.lang;
  if (tag === "td" || tag === "th") {
    for (const key of ["colSpan", "rowSpan"] as const) {
      const span = item[key];
      if (Number.isInteger(span) && (span as number) > 1 && (span as number) <= 32)
        attributes[key] = span as number;
    }
  }
  if (tag === "details" && item.open === true) attributes.open = true;
  return attributes;
}

// Ruby and readings attach to the text around them.
function attached(node: GlossaryNode): boolean {
  return node.kind === "element" && (node.tag === "ruby" || node.reading === true);
}

const japaneseText =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\u30fb\\u30fc\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";
const japaneseStart = new RegExp(`^[${japaneseText}]`, "u");
const japaneseEnd = new RegExp(`[${japaneseText}]$`, "u");
const openingBracket = /[「『（［｛【〈《〔〖〘〚｟]$/u;
const closingBracket = /^[」』）］｝】〉》〕〗〙〛｠]/u;

// The text piece at a rendered edge; Japanese-script joins ignore readings.
function edgeText(nodes: GlossaryNode[], end: boolean, skipReadings = false): string {
  for (const node of end ? [...nodes].reverse() : nodes) {
    if (node.kind === "text") return node.value;
    if (node.kind === "break") return "\n";
    if (skipReadings && node.kind === "element" && node.reading) continue;
    const text = edgeText(
      node.children,
      end,
      skipReadings || (node.kind === "element" && node.tag === "ruby"),
    );
    if (text) return text;
  }
  return "";
}

// Japanese text reads continuously, so inline parts meeting inside it are not spaced apart.
function japaneseJoin(previous: GlossaryNode, node: GlossaryNode): boolean {
  return (
    japaneseEnd.test(edgeText([previous], true, true)) &&
    japaneseStart.test(edgeText([node], false, true))
  );
}

function separates(
  previous: GlossaryNode | undefined,
  node: GlossaryNode,
  parent: string,
  joined: boolean,
): boolean {
  const before = previous ? edgeText([previous], true) : "";
  const after = edgeText([node], false);
  return !!(
    previous &&
    !joined &&
    parent !== "ul" &&
    parent !== "ol" &&
    !tableParts.has(parent) &&
    previous.kind !== "break" &&
    node.kind !== "break" &&
    !attached(previous) &&
    !attached(node) &&
    !(previous.kind === "element" && blockTags.has(previous.tag)) &&
    !(node.kind === "element" && blockTags.has(node.tag)) &&
    !/\s$/.test(before) &&
    !/^\s/.test(after) &&
    !openingBracket.test(before) &&
    !closingBracket.test(after) &&
    !(node.kind === "text" && /^[.,;:!?。！？、，]/u.test(node.value)) &&
    !japaneseJoin(previous, node)
  );
}

/** A label's text without its ruby readings, so a control is named by what it shows inline. */
function labelText(nodes: GlossaryNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "text"
        ? node.value
        : node.kind === "break" ||
            (node.kind === "element" && (node.tag === "rt" || node.tag === "rp"))
          ? ""
          : labelText(node.children),
    )
    .join("");
}

function renderNodes(nodes: GlossaryNode[], context: RenderContext): ReactNode {
  const { onSearchTerm, parent, joined, inLink } = context;
  return nodes.flatMap((node, index) => {
    const prefix = separates(nodes[index - 1], node, parent, joined) ? [" "] : [];
    if (node.kind === "text") return [...prefix, node.value];
    if (node.kind === "break") return [<br key={index} />];
    if (node.kind === "link") {
      const label = renderNodes(node.children, {
        onSearchTerm,
        parent: "a",
        joined: true,
        inLink: true,
      });
      // A link nested in a label stays part of that label's button.
      const search = inLink ? undefined : onSearchTerm;
      const term = search && searchable(node.query);
      const url = inLink ? null : node.url;
      const name = labelText(node.children).trim() || undefined;
      if (url)
        return [
          ...prefix,
          <a
            aria-label={name}
            className="dictionary-glossary__link"
            href={url}
            key={index}
            onClick={(event) => {
              event.preventDefault();
              void openExternalLink(url).catch(() => {});
            }}
            rel="noreferrer"
            target="_blank"
            title={url}
          >
            {label}
          </a>,
        ];
      return [
        ...prefix,
        term ? (
          <button
            aria-label={name}
            className="dictionary-glossary__term"
            key={index}
            onClick={() => search(term)}
            title={i18n().t("glossary.search", { term })}
            type="button"
          >
            {label}
          </button>
        ) : (
          <Fragment key={index}>{label}</Fragment>
        ),
      ];
    }
    const children = renderNodes(node.children, {
      onSearchTerm,
      parent: node.tag,
      joined: joined || node.tag === "ruby",
      inLink,
    });
    const props = {
      style: node.style as CSSProperties | undefined,
      title: node.title,
      lang: node.lang,
    };
    const className = node.presentation ? `dictionary-glossary__${node.presentation}` : undefined;
    switch (node.tag) {
      case "div":
        return [
          <div {...props} className={className} key={index}>
            {children}
          </div>,
        ];
      case "p":
        return [
          <p {...props} key={index}>
            {children}
          </p>,
        ];
      case "ul":
        return [
          <ul {...props} key={index}>
            {children}
          </ul>,
        ];
      case "ol":
        return [
          <ol {...props} key={index}>
            {children}
          </ol>,
        ];
      case "li":
        return [
          <li {...props} key={index}>
            {children}
          </li>,
        ];
      case "table":
        // A wide table scrolls inside its definition instead of widening the popup.
        return [
          <div className="dictionary-glossary__table" key={index}>
            <table {...props}>{children}</table>
          </div>,
        ];
      case "thead":
        return [
          <thead {...props} key={index}>
            {children}
          </thead>,
        ];
      case "tbody":
        return [
          <tbody {...props} key={index}>
            {children}
          </tbody>,
        ];
      case "tfoot":
        return [
          <tfoot {...props} key={index}>
            {children}
          </tfoot>,
        ];
      case "tr":
        return [
          <tr {...props} key={index}>
            {children}
          </tr>,
        ];
      case "td":
        return [
          <td {...props} colSpan={node.colSpan} key={index} rowSpan={node.rowSpan}>
            {children}
          </td>,
        ];
      case "th":
        return [
          <th {...props} colSpan={node.colSpan} key={index} rowSpan={node.rowSpan}>
            {children}
          </th>,
        ];
      case "details":
        return [
          <details {...props} key={index} open={node.open}>
            {children}
          </details>,
        ];
      case "summary":
        return [
          <summary {...props} key={index}>
            {children}
          </summary>,
        ];
      case "ruby":
        return [
          ...prefix,
          <ruby {...props} key={index}>
            {children}
          </ruby>,
        ];
      case "rt":
        if (parent === "ruby")
          return [
            <rt {...props} key={index}>
              {children}
            </rt>,
          ];
        break;
      case "rp":
        if (parent === "ruby")
          return [
            <rp {...props} key={index}>
              {children}
            </rp>,
          ];
        break;
    }
    return [
      ...prefix,
      <span
        {...props}
        className={node.reading ? "dictionary-glossary__reading" : className}
        key={index}
      >
        {children}
      </span>,
    ];
  });
}

export function GlossaryText({
  value,
  onSearchTerm,
}: {
  value: unknown;
  onSearchTerm?: (term: string) => void;
}) {
  const nodes = useMemo(() => readNodes(value), [value]);
  if (!nodes.length) return null;
  return (
    <div className="dictionary-glossary">
      {renderNodes(nodes, { onSearchTerm, parent: "", joined: false, inLink: false })}
    </div>
  );
}

/** Use the popup's parser and exact inline joins, dropping imported styles, URLs and metadata. */
export function glossaryCardContent(value: unknown): GlossaryCardNode[][] {
  function content(nodes: GlossaryNode[], parent = "", joined = false): GlossaryCardNode[] {
    return nodes.flatMap((node, index): GlossaryCardNode[] => {
      const prefix: GlossaryCardNode[] = separates(nodes[index - 1], node, parent, joined)
        ? [{ kind: "text", value: " " }]
        : [];
      if (node.kind === "text" || node.kind === "break") return [...prefix, node];
      if (node.kind === "link") {
        const children = content(node.children, "a", true);
        if (node.url) return [...prefix, { kind: "link", children, url: node.url }];
        return searchable(node.query)
          ? [...prefix, { kind: "link", children }]
          : [...prefix, ...children];
      }
      // Stray ruby annotations become inline readings, as they do in the popup.
      const tag = (node.tag === "rt" || node.tag === "rp") && parent !== "ruby" ? "span" : node.tag;
      const { children: nested, reading, presentation, ...attributes } = node;
      return [
        ...prefix,
        {
          ...attributes,
          kind: "element",
          tag,
          children: content(nested, node.tag, joined || node.tag === "ruby"),
          ...(reading ? { reading: true } : {}),
          ...(presentation ? { presentation } : {}),
        },
      ];
    });
  }
  // LookupDefinition presents each top-level glossary separately, without an invented sense list.
  return (Array.isArray(value) ? value : [value])
    .map((entry) => content(readNodes(entry)))
    .filter((nodes) => nodes.length > 0);
}

/** Export only allowlisted glossary text, retaining the visible inline joins. */
export function glossaryPlainText(value: unknown): string {
  function plain(nodes: GlossaryNode[], joined = false): string {
    return nodes
      .map((node, index) => {
        if (node.kind === "break") return "\n";
        if (node.kind === "element" && node.reading) return "";
        const text =
          node.kind === "text"
            ? node.value
            : plain(
                node.children,
                joined || node.kind === "link" || (node.kind === "element" && node.tag === "ruby"),
              );
        if (node.kind === "element" && blockTags.has(node.tag)) return "\n" + text + "\n";
        const previous = nodes[index - 1];
        const before = previous ? edgeText([previous], true) : "";
        const after = edgeText([node], false);
        const space =
          previous &&
          !joined &&
          previous.kind !== "break" &&
          !attached(previous) &&
          !attached(node) &&
          !(previous.kind === "element" && blockTags.has(previous.tag)) &&
          !/\s$/.test(before) &&
          !/^\s/.test(after) &&
          !openingBracket.test(before) &&
          !closingBracket.test(after) &&
          !(node.kind === "text" && /^[.,;:!?。！？、，]/u.test(node.value)) &&
          !japaneseJoin(previous, node);
        return (space ? " " : "") + text;
      })
      .join("");
  }
  return plain(readNodes(value))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
