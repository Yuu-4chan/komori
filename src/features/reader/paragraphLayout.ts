const STYLE = "data-komori-paragraph-layout";
const EXCLUDED = "[data-komori-heading], [data-komori-image-block]";
const PARAGRAPHS =
  ":root body p:not([data-komori-heading]):not([data-komori-heading] *)" +
  ":not([data-komori-image-block]):not([data-komori-image-block] *)";

/** Override inline declarations only when needed, retaining their order and priorities. */
function inlineChoice(
  paragraph: HTMLElement,
  marker: string,
  properties: string[],
  enabled: boolean,
  declarations: [string, string][],
): void {
  const { style } = paragraph;
  const saved = paragraph.getAttribute(marker);
  let own: [string, string, string][] = [];
  if (saved !== null) {
    try {
      own = JSON.parse(saved);
    } catch {
      return;
    }
    for (const property of properties) style.removeProperty(property);
    for (const [property, value, priority] of own) style.setProperty(property, value, priority);
    paragraph.removeAttribute(marker);
  } else {
    for (let index = 0; index < style.length; index++) {
      const property = style.item(index);
      if (properties.includes(property))
        own.push([property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
    }
  }
  if (!enabled || !own.length) return;
  paragraph.setAttribute(marker, JSON.stringify(own));
  for (const property of properties) style.removeProperty(property);
  for (const [property, value] of declarations) style.setProperty(property, value, "important");
}

/** Off restores publisher composition. CSS support and line-breaking quality are browser-owned. */
export function applyParagraphLayout(document: Document, justify: boolean, pretty: boolean): void {
  // Unsupported declarations must not displace a publisher's inline nowrap/style.
  pretty =
    pretty && (typeof CSS === "undefined" || !CSS.supports || CSS.supports("text-wrap", "pretty"));
  const existing = document.querySelector(`style[${STYLE}]`);
  for (const paragraph of document.querySelectorAll<HTMLElement>("body p")) {
    const prose = !paragraph.closest(EXCLUDED);
    inlineChoice(
      paragraph,
      "data-komori-own-paragraph-align",
      ["text-align", "text-align-last"],
      justify && prose,
      [
        ["text-align", "justify"],
        ["text-align-last", "auto"],
      ],
    );
    inlineChoice(
      paragraph,
      "data-komori-own-paragraph-wrap",
      ["text-wrap", "text-wrap-mode", "text-wrap-style"],
      pretty && prose,
      [["text-wrap", "pretty"]],
    );
  }
  if (!justify && !pretty) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  if (!existing) {
    style.setAttribute(STYLE, "");
    // An early important layer wins over publisher styles, including their important layers.
    (document.head ?? document.documentElement).prepend(style);
  }
  style.textContent = `@layer komori-paragraphs { ${PARAGRAPHS} { ${
    justify ? "text-align: justify !important; text-align-last: auto !important; " : ""
  }${pretty ? "text-wrap: pretty !important;" : ""} } }`;
}
