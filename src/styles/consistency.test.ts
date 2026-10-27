import { describe, expect, it } from "vitest";

import components from "./components.css?raw";
import dictionary from "./dictionary.css?raw";
import globals from "./globals.css?raw";
import library from "./library.css?raw";
import pages from "./pages.css?raw";
import reader from "./reader.css?raw";
import shell from "./shell.css?raw";
import statistics from "./statistics.css?raw";
import tokens from "./tokens.css?raw";

const sheets = { components, dictionary, globals, library, pages, reader, shell, statistics };

/** Each rule's selector and declarations, ignoring comments and at-rule wrappers. */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

describe("shared control finish", () => {
  it("draws every keyboard focus outline with the one focus ring token", () => {
    expect(tokens).toMatch(/--focus-ring:\s*2px solid var\(--accent-ink\);/);
    const outlines = Object.entries(sheets).flatMap(([name, css]) =>
      rules(css)
        .filter(({ selector }) => /:focus-visible|:focus-within/.test(selector))
        .flatMap(({ selector, body }) =>
          [...body.matchAll(/(?:^|;|\s)outline:\s*([^;]+);/g)].map((match) => ({
            where: `${name}: ${selector}`,
            value: match[1].trim(),
          })),
        ),
    );
    expect(outlines.length).toBeGreaterThan(20);
    expect(outlines.filter(({ value }) => !/^(var\(--focus-ring\)|0|none)$/.test(value))).toEqual(
      [],
    );
  });

  it("keeps every scrolling surface on the application's thumb instead of system scrollbars", () => {
    // Standard scrollbar-width/-color switch Chromium back to its arrowed system scrollbar and
    // disable the shared ::-webkit-scrollbar styles; only hidden carousels may opt out.
    const overrides = Object.entries(sheets).flatMap(([name, css]) =>
      [...css.matchAll(/scrollbar-(width|color):\s*([^;]+);/g)]
        .filter((match) => !(match[1] === "width" && match[2].trim() === "none"))
        .map((match) => `${name}: ${match[0]}`),
    );
    expect(overrides).toEqual([]);
    expect(globals).toMatch(/::-webkit-scrollbar-thumb\s*\{/);
  });
});

describe("native text selection", () => {
  it("selects nothing on the interface by dragging, and keeps copyable content selectable", () => {
    const declared = (value: string) =>
      Object.values(sheets).flatMap((css) =>
        rules(css)
          .filter(({ body }) => body.match(/(?:^|;|\s)user-select:\s*([a-z]+);/)?.[1] === value)
          .flatMap(({ selector }) => selector.split(",").map((part) => part.trim())),
      );
    expect(declared("none")).toContain("body");
    expect(declared("text")).toEqual(
      expect.arrayContaining([
        "input",
        "textarea",
        ".lookup-entry",
        ".dictionary-result-card",
        ".reader-note-passage",
        ".reader-sidebar__book--open",
        ".library-folders strong",
        '[role="alert"]',
      ]),
    );
  });
});

describe("programmatic focus", () => {
  it("frames no container focused only by code, and rings the image viewer's pan area", () => {
    const all = Object.values(sheets).flatMap(rules);
    const reset = all.find(
      ({ selector, body }) =>
        selector.includes('[tabindex="-1"]:focus') && /outline:\s*none;/.test(body),
    );
    expect(reset?.selector).toMatch(/main/);
    expect(
      all.find(({ selector }) => selector === ".reader-image-viewer__art:focus-visible")?.body,
    ).toMatch(/outline:\s*var\(--focus-ring\);/);
  });
});

describe("typed text", () => {
  it("draws what the reader types in a muted field in the primary text colour, not the placeholder's", () => {
    const all = Object.values(sheets).flatMap(rules);
    const muted = all
      .filter(
        ({ selector, body }) =>
          /^\.[\w-]+$/.test(selector) && /(?:^|[;\s])color:\s*var\(--text-muted\);/.test(body),
      )
      .map(({ selector }) => selector);
    const fields = all.filter(({ selector }) =>
      muted.some((container) => selector === `${container} input`),
    );
    expect(fields.map(({ selector }) => selector)).toEqual(
      expect.arrayContaining([".search-field input", ".dictionary-search input"]),
    );
    expect(
      fields
        .filter(({ body }) => !/(?:^|[;\s])color:\s*var\(--text-primary\);/.test(body))
        .map(({ selector }) => selector),
    ).toEqual([]);
  });
});

describe("grouped settings rows", () => {
  const all = Object.values(sheets).flatMap(rules);
  // A rule's declarations for one selector, alone or in a selector list.
  const body = (selector: string) =>
    all
      .filter((rule) => rule.selector.split(/,\s*/).includes(selector))
      .map((rule) => rule.body)
      .join("");

  it("draws a list of settings rows as one box divided by hairlines, not a card per row", () => {
    expect(body(".settings-rows")).toMatch(/border:\s*1px solid var\(--border-soft\);/);
    expect(body(".settings-rows > li + li")).toMatch(
      /border-top:\s*1px solid var\(--border-soft\);/,
    );
    expect(body(".settings-rows li")).not.toMatch(/border/);
    expect(body(".settings-source-row")).not.toMatch(/border:/);
    expect(body(".settings-source-row + .settings-source-row")).toMatch(/border-top:/);
  });

  it("leaves a row's buttons their standard label size", () => {
    expect(
      all
        .filter(({ selector }) => /\.settings-rows span(?![\w-])/.test(selector))
        .map((r) => r.selector),
    ).toEqual([]);
  });

  it("lowers a row's controls to the row height, and lays a font out like any other row", () => {
    expect(tokens).toMatch(/--control-height-row:\s*2\.25rem;/);
    expect(body(".settings-list > .settings-field")).toMatch(
      /--control-height:\s*var\(--control-height-row\);/,
    );
    const placed = all.find(({ selector }) =>
      /^\.settings-list\s*>\s*\.settings-field\s*:is\([^)]*\.font-picker__controls/.test(selector),
    );
    expect(placed?.body).toMatch(
      /position:\s*absolute;[^]*width:\s*var\(--settings-control-width\);/,
    );
    expect(body(".settings-list > .settings-field > .reader-font-field")).toMatch(
      /display:\s*contents;/,
    );
    expect(body(".settings-list > .settings-field .font-picker__controls > .icon-button")).toMatch(
      /height:\s*var\(--control-height\);/,
    );
  });

  it("puts Save on the right like every other action, and draws no box inside a kanji result", () => {
    expect(body(".anki-save-bar")).toMatch(/justify-items:\s*end;/);
    expect(body(".dictionary-sheet > .dictionary-kanji-card")).not.toMatch(/background:\s*var/);
  });
});

describe("application frame", () => {
  it("keeps the scrollbar's width on every page and scrolls content under a surface", () => {
    const body = (selector: string) =>
      rules(shell).find((rule) => rule.selector === selector)?.body;
    expect(body(".app-shell__content")).toMatch(/scrollbar-gutter:\s*stable;/);
    expect(body(".app-topbar--floating")).toMatch(
      /background:\s*color-mix\(in srgb, var\(--surface-main\)/,
    );
    expect(body(".app-shell__content::-webkit-scrollbar-track:vertical")).toMatch(
      /margin-top:\s*var\(--topbar-height\);/,
    );
  });

  it("centers an empty Library's top bar buttons without the search's reserved width", () => {
    const empty = rules(shell).find((rule) => rule.selector === ".app-topbar__search:empty");
    expect(empty?.body).toMatch(/display:\s*none;/);
  });
});

describe("Statistics tiles", () => {
  it("wraps a tile's hint to a second line rather than cutting it to one", () => {
    const hint = rules(statistics).find(({ selector }) => selector === ".statistics-metric small");
    expect(hint?.body).not.toMatch(/white-space:\s*nowrap/);
    expect(hint?.body).toMatch(/-webkit-line-clamp:\s*2;/);
  });
});
