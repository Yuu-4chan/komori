import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GlossaryText, glossaryCardContent } from "./GlossaryText";

describe("GlossaryText", () => {
  it("exports the popup's joins, separate glossaries and semantic roles with only checked styles and web links", () => {
    const presentation = glossaryCardContent([
      {
        type: "structured-content",
        content: {
          tag: "div",
          style: { fontSize: "50em" },
          content: [
            "本を",
            { tag: "ruby", content: ["読", { tag: "rt", content: "よ" }] },
            "む。",
            "Read",
            { tag: "span", content: "books" },
            {
              tag: "div",
              data: { content: "example-sentence" },
              content: [
                { tag: "div", data: { content: "example-sentence-a" }, content: "本を読む。" },
                { tag: "div", data: { content: "example-sentence-b" }, content: "Read a book." },
              ],
            },
            { tag: "a", href: "file:///private/path", content: "読書" },
            { tag: "img", path: "private/media" },
          ],
        },
      },
      "Second sense",
    ]);
    const first = presentation[0][0];
    expect(first.kind).toBe("element");
    if (first.kind !== "element") throw new Error("Missing glossary root");
    expect(
      first.children
        .slice(0, 7)
        .map((n) => (n.kind === "text" ? n.value : n.kind === "element" ? n.tag : n.kind)),
    ).toEqual(["本を", "ruby", "む。", " ", "Read", " ", "span"]);
    expect(first.children[7]).toMatchObject({
      presentation: "example-group",
      children: [{ presentation: "example-sentence" }, { presentation: "example-translation" }],
    });
    expect(first.children[8]).toEqual({
      kind: "link",
      children: [{ kind: "text", value: "読書" }],
    });
    expect(presentation[1]).toEqual([{ kind: "text", value: "Second sense" }]);
    const serialized = JSON.stringify(presentation);
    // An oversized font size, file links and media paths never reach a card.
    for (const forbidden of ["style", "href", "private", "50em"])
      expect(serialized).not.toContain(forbidden);
    expect(
      glossaryCardContent({
        type: "structured-content",
        content: { tag: "a", href: "https://source.invalid", content: "JMdict" },
      }),
    ).toEqual([
      [
        {
          kind: "link",
          url: "https://source.invalid/",
          children: [{ kind: "text", value: "JMdict" }],
        },
      ],
    ]);
    expect(
      glossaryCardContent({
        type: "structured-content",
        content: {
          tag: "span",
          style: { fontWeight: "bold", position: "fixed", color: "url(x)" },
          data: { code: "n", 'x"': "1" },
          title: "noun",
          content: "n",
        },
      }),
    ).toEqual([
      [
        {
          kind: "element",
          tag: "span",
          style: { fontWeight: "bold" },
          data: { code: "n" },
          title: "noun",
          children: [{ kind: "text", value: "n" }],
        },
      ],
    ]);
  });
  it("keeps paragraphs and nested lists in source order", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: {
            tag: "div",
            content: [
              { tag: "p", content: ["First ", { tag: "strong", content: "sense" }] },
              {
                tag: "ol",
                content: [
                  {
                    tag: "li",
                    content: ["One", { tag: "ul", content: [{ tag: "li", content: "Nested" }] }],
                  },
                  { tag: "li", content: "Two" },
                ],
              },
              { tag: "p", content: "Last sense" },
            ],
          },
        }}
      />,
    );

    expect(container.querySelector("p")).toHaveTextContent("First sense");
    const ordered = screen.getAllByRole("list")[0];
    expect(ordered.tagName).toBe("OL");
    expect(
      within(ordered)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["OneNested", "Nested", "Two"]);
    expect(container.textContent).toMatch(/First.*sense.*One.*Nested.*Two.*Last sense/);
  });

  it("parses a glossary once while its value is unchanged", () => {
    let reads = 0;
    const value = new Proxy(["book"], {
      get(target, property, receiver) {
        if (property === "flatMap") reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const { rerender } = render(<GlossaryText onSearchTerm={() => {}} value={value} />);
    rerender(<GlossaryText onSearchTerm={() => {}} value={value} />);
    expect(screen.getByText("book")).toBeInTheDocument();
    expect(reads).toBe(1);
    rerender(<GlossaryText value={["volume"]} />);
    expect(screen.getByText("volume")).toBeInTheDocument();
  });

  it("renders a plain glossary string as text", () => {
    const { container } = render(<GlossaryText value="read <script> & learn" />);
    expect(container).toHaveTextContent("read <script> & learn");
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps link labels inert and ignores media, private fields, and malformed nodes", () => {
    const { container } = render(
      <GlossaryText
        value={[
          {
            tag: "p",
            content: ["See", { tag: "a", href: "file:///private/entry", content: "entry" }],
          },
          { tag: "img", src: "C:\\private\\image.png", content: "hidden media" },
          { type: "audio", path: "C:\\private\\sound.mp3", text: "hidden audio" },
          { tag: "script", content: "hidden script" },
          { type: "unexpected", content: "hidden unknown" },
          { type: 42, content: "C:\\private\\malformed" },
          { path: "C:\\private\\other", styles: { color: "red" } },
          null,
          42,
          { tag: "p", content: "Done" },
        ]}
      />,
    );

    expect(container).toHaveTextContent("See entry");
    expect(container).toHaveTextContent("Done");
    expect(container.querySelector("a, img, audio, script")).toBeNull();
    expect(container).not.toHaveTextContent(/private|hidden|file:|\.png|\.mp3/);
  });

  it("searches structured link labels in text order and opens only web links in the browser", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: {
            tag: "p",
            content: [
              "See ",
              {
                tag: "a",
                href: "file:///private/entry",
                content: [" 日本", { tag: "strong", content: "語 " }],
              },
              " first, then ",
              { tag: "a", href: "https://example.com/other", content: "かな" },
              ".",
            ],
          },
        }}
      />,
    );

    expect(container).toHaveTextContent("See 日本語 first, then かな.");
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/file:|private/);
    expect(screen.getByRole("link", { name: "かな" })).toHaveAttribute(
      "href",
      "https://example.com/other",
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([" 日本語 "]);
    await userEvent.setup().click(buttons[0]);
    expect(onSearchTerm.mock.calls).toEqual([["日本語"]]);
  });

  it("searches a ruby-annotated label without its reading", async () => {
    const onSearchTerm = vi.fn();
    render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          tag: "a",
          content: [
            "サバを",
            {
              tag: "ruby",
              content: ["読", { tag: "rp", content: "(" }, { tag: "rt", content: "よ" }],
            },
            "む",
          ],
        }}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("サバを読(よむ");
    expect(button.innerHTML).toBe("サバを<ruby>読<rp>(</rp><rt>よ</rt></ruby>む");
    expect(button).toHaveAttribute("title", "Search サバを読む");
    // Its name is what it shows inline, without the reading.
    expect(button).toHaveAccessibleName("サバを読む");
    await userEvent.setup().click(button);
    expect(onSearchTerm).toHaveBeenCalledWith("サバを読む");
  });

  it("renders ruby in glossary text without separating it from its text", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            "鯖を",
            {
              tag: "ruby",
              content: [
                "読",
                { tag: "rp", content: "（" },
                { tag: "rt", content: "よ" },
                { tag: "rp", content: "）" },
              ],
            },
            "む",
            { tag: "rt", content: "stray", href: "file:///private" },
          ],
        }}
      />,
    );
    const glossary = container.querySelector(".dictionary-glossary");
    expect(glossary?.innerHTML).toBe(
      '鯖を<ruby>読<rp>（</rp><rt>よ</rt><rp>）</rp></ruby>む<span class="dictionary-glossary__reading">stray</span>',
    );
  });

  it("shows inline wari spans as readings and searches linked labels without them", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: [
            "⇒",
            {
              tag: "a",
              href: "?query=鯖を読む",
              content: ["鯖", { tag: "span", data: { wari: "" }, content: "さば" }, "を読む"],
            },
            "。本文",
            { tag: "span", data: { wari: "" }, content: "ほんもん" },
            { tag: "span", data: { other: "" }, content: "注" },
          ],
        }}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.innerHTML).toBe('鯖<span class="dictionary-glossary__reading">さば</span>を読む');
    expect(button).toHaveAttribute("title", "Search 鯖を読む");
    expect(container.querySelectorAll(".dictionary-glossary__reading")).toHaveLength(2);
    expect(container).toHaveTextContent("⇒ 鯖さばを読む。本文ほんもん注");
    expect(container.innerHTML).not.toMatch(/wari|query=|data-/);
    await userEvent.setup().click(button);
    expect(onSearchTerm).toHaveBeenCalledWith("鯖を読む");
  });

  it("joins a Japanese example keyword to its sentence without spaces", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: {
            tag: "span",
            data: { content: "example-sentence-a" },
            content: [
              { tag: "ruby", content: ["楽譜", { tag: "rt", content: "がくふ" }] },
              "を",
              {
                tag: "span",
                data: { content: "example-keyword" },
                content: [
                  {
                    tag: "ruby",
                    content: [
                      "読",
                      { tag: "rp", content: "(" },
                      { tag: "rt", content: "よ" },
                      { tag: "rp", content: ")" },
                    ],
                  },
                  "む",
                ],
              },
              "ように",
              { tag: "span", content: "「速く」" },
              { tag: "span", content: "ｶﾀｶﾅ" },
              "。",
            ],
          },
        }}
      />,
    );
    const glossary = container.querySelector(".dictionary-glossary");
    expect(glossary?.innerHTML).not.toMatch(/data-|example-/);
    expect(glossary?.textContent).toBe("楽譜がくふを読(よ)むように「速く」ｶﾀｶﾅ。");
  });

  it("distinguishes Jitendex example sentences and translations in source order", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: [
            { tag: "li", content: "to read" },
            {
              tag: "div",
              data: { class: "extra-box", content: "example-sentence", source: "195029" },
              content: [
                {
                  tag: "div",
                  data: { content: "example-sentence-a" },
                  content: [
                    "本を",
                    { tag: "span", data: { content: "example-keyword" }, content: "読んだ" },
                    "。",
                  ],
                },
                {
                  tag: "div",
                  data: { content: "example-sentence-b" },
                  content: [
                    "I read a book.",
                    { tag: "a", href: "https://example.com", content: "読む" },
                  ],
                },
              ],
            },
            { tag: "li", content: "to recite" },
          ],
        }}
      />,
    );

    const group = container.querySelector(".dictionary-glossary__example-group");
    expect(group?.children).toHaveLength(2);
    expect(group?.children[0]).toHaveClass("dictionary-glossary__example-sentence");
    expect(group?.children[1]).toHaveClass("dictionary-glossary__example-translation");
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "to read本を読んだ。I read a book. 読むto recite",
    );
    expect(container.innerHTML).not.toMatch(/data-|195029|extra-box/);
    // A web link opens in the browser instead of searching its label.
    expect(screen.getByRole("link", { name: "読む" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    expect(screen.queryByRole("button", { name: "読む" })).not.toBeInTheDocument();
    expect(onSearchTerm).not.toHaveBeenCalled();
  });

  it("distinguishes real Jitendex sense-note markers after their glosses", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: {
            tag: "li",
            data: { content: "sense" },
            content: [
              {
                tag: "ul",
                data: { content: "glossary" },
                content: { tag: "li", content: "to count" },
              },
              {
                tag: "div",
                data: { content: "extra-info" },
                content: {
                  tag: "div",
                  data: { class: "extra-box", content: "sense-note" },
                  content: [
                    { tag: "div", data: { content: "sense-note-label" }, content: "Note" },
                    {
                      tag: "div",
                      data: { content: "sense-note-content" },
                      content: [
                        "now mostly used in ",
                        { tag: "a", href: "?query=慣用句", content: "慣用句" },
                      ],
                    },
                  ],
                },
              },
              { tag: "div", content: "See also" },
            ],
          },
        }}
      />,
    );

    const note = container.querySelector(".dictionary-glossary__note-group");
    expect(note?.children[0]).toHaveClass("dictionary-glossary__note-label");
    expect(note?.children[1]).toHaveClass("dictionary-glossary__note-content");
    expect(note).toHaveTextContent("Notenow mostly used in 慣用句");
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "to countNotenow mostly used in 慣用句See also",
    );
    expect(container.innerHTML).not.toMatch(/data-|extra-box|query=/);
    await userEvent.setup().click(screen.getByRole("button", { name: "慣用句" }));
    expect(onSearchTerm).toHaveBeenCalledWith("慣用句");
  });

  it("distinguishes a real Jitendex cross-reference without changing its text or search reading", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: {
            tag: "li",
            data: { content: "sense" },
            content: [
              {
                tag: "ul",
                data: { content: "glossary" },
                content: { tag: "li", content: "to read" },
              },
              {
                tag: "div",
                data: { content: "extra-info" },
                content: {
                  tag: "div",
                  data: { class: "extra-box", content: "xref" },
                  content: [
                    {
                      tag: "div",
                      data: { content: "xref-content" },
                      content: [
                        {
                          tag: "span",
                          data: { content: "reference-label" },
                          content: "See also",
                        },
                        {
                          tag: "a",
                          href: "?query=サバを読む&wildcards=off&primary_reading=さばをよむ",
                          content: [
                            "サバを",
                            { tag: "ruby", content: ["読", { tag: "rt", content: "よ" }] },
                            "む",
                          ],
                        },
                      ],
                    },
                    {
                      tag: "div",
                      data: { content: "xref-glossary" },
                      content: "to manipulate figures to one's advantage",
                    },
                  ],
                },
              },
              { tag: "div", content: "following sense" },
            ],
          },
        }}
      />,
    );

    const group = container.querySelector(".dictionary-glossary__xref-group");
    expect(group?.querySelector(".dictionary-glossary__xref-label")).toHaveTextContent("See also");
    expect(group?.querySelector(".dictionary-glossary__xref-glossary")).toHaveTextContent(
      "to manipulate figures to one's advantage",
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "to readSee also サバを読よむto manipulate figures to one's advantagefollowing sense",
    );
    const button = screen.getByTitle("Search サバを読む");
    expect(button).toHaveAttribute("title", "Search サバを読む");
    expect(button.querySelector("ruby rt")).toHaveTextContent("よ");
    expect(container.innerHTML).not.toMatch(/query=|primary_reading|extra-box|data-/);
    await userEvent.setup().click(button);
    expect(onSearchTerm).toHaveBeenCalledWith("サバを読む");
  });

  it("distinguishes Jitendex attribution footnotes and opens their source links in the browser", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: [
            {
              tag: "div",
              data: { content: "example-sentence" },
              content: {
                tag: "div",
                data: { content: "example-sentence-b" },
                content: [
                  "I read a book.",
                  { tag: "span", data: { content: "attribution-footnote" }, content: "[1]" },
                ],
              },
            },
            {
              tag: "div",
              data: { content: "attribution", class: "source-css" },
              content: [
                { tag: "a", href: "https://example.com/private", content: "JMdict" },
                " | Tatoeba ",
                { tag: "a", href: "https://example.com/1", content: "[1]" },
              ],
            },
            { tag: "a", href: "?query=読む", content: "読む" },
          ],
        }}
      />,
    );

    const glossary = container.querySelector(".dictionary-glossary");
    expect(glossary?.querySelector(".dictionary-glossary__attribution-footnote")).toHaveTextContent(
      "[1]",
    );
    expect(glossary?.querySelector(".dictionary-glossary__attribution")).toHaveTextContent(
      "JMdict | Tatoeba [1]",
    );
    expect(glossary?.textContent).toBe("I read a book. [1]JMdict | Tatoeba [1]読む");
    expect(container.innerHTML).not.toMatch(/source-css|data-|query=/);
    expect(
      screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["JMdict", "https://example.com/private"],
      ["[1]", "https://example.com/1"],
    ]);
    await userEvent.setup().click(screen.getByRole("button", { name: "読む" }));
    expect(onSearchTerm).toHaveBeenCalledWith("読む");
  });

  it("distinguishes real Jitendex part-of-speech hints before the senses", async () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: {
            tag: "li",
            data: { content: "sense-group" },
            content: [
              {
                tag: "span",
                title: "Godan verb with 'mu' ending",
                data: { class: "tag", code: "v5m", content: "part-of-speech-info" },
                content: "5-dan",
              },
              {
                tag: "span",
                title: "transitive verb",
                data: { class: "tag", code: "vt", content: "part-of-speech-info" },
                content: "transitive",
              },
              {
                tag: "ol",
                content: { tag: "li", content: ["to read", { tag: "a", content: "読む" }] },
              },
            ],
          },
        }}
      />,
    );

    const hints = container.querySelectorAll(".dictionary-glossary__part-of-speech");
    expect([...hints].map((hint) => hint.textContent)).toEqual(["5-dan", "transitive"]);
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "5-dan transitiveto read 読む",
    );
    expect(container.innerHTML).not.toMatch(/v5m|\bvt\b|data-/);
    // Their titles explain them on hover.
    expect([...hints].map((hint) => hint.getAttribute("title"))).toEqual([
      "Godan verb with 'mu' ending",
      "transitive verb",
    ]);
    await userEvent.setup().click(screen.getByRole("button", { name: "読む" }));
    expect(onSearchTerm).toHaveBeenCalledWith("読む");
  });

  it("leaves unrelated and misplaced metadata inert", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            { tag: "div", data: { content: "example-keyword" }, content: "keyword" },
            { tag: "div", data: { content: "example-sentence-unknown" }, content: "unknown" },
            { tag: "span", data: { content: "example-sentence-b" }, content: "wrong tag" },
            { tag: "div", data: { content: ["example-sentence-a"] }, content: "wrong value" },
            { tag: "span", data: { content: "sense-note" }, content: "wrong note tag" },
            { tag: "div", data: { content: "sense-note-other" }, content: "other note" },
            { tag: "div", data: { content: ["sense-note-label"] }, content: "wrong note value" },
            { tag: "span", data: { content: "xref" }, content: "wrong cross-reference tag" },
            { tag: "div", data: { content: "reference-label" }, content: "wrong label tag" },
            { tag: "span", data: { content: "xref-glossary" }, content: "wrong glossary tag" },
            { tag: "div", data: { content: "xref-other" }, content: "other cross-reference" },
            { tag: "span", data: { content: "attribution" }, content: "wrong attribution tag" },
            {
              tag: "div",
              data: { content: "attribution-footnote" },
              content: "wrong footnote tag",
            },
            { tag: "div", data: { content: "attribution-other" }, content: "other attribution" },
            { tag: "div", data: { content: "part-of-speech-info" }, content: "wrong speech tag" },
            { tag: "span", data: { content: "part-of-speech" }, content: "other speech marker" },
            {
              tag: "span",
              data: { content: ["part-of-speech-info"] },
              content: "wrong speech value",
            },
          ],
        }}
      />,
    );
    expect(container).toHaveTextContent(
      "keywordunknownwrong tagwrong valuewrong note tagother notewrong note valuewrong cross-reference tagwrong label tagwrong glossary tagother cross-referencewrong attribution tagwrong footnote tagother attributionwrong speech tagother speech marker wrong speech value",
    );
    expect(
      container.querySelector(
        '[class*="dictionary-glossary__example-"], [class*="dictionary-glossary__note-"], [class*="dictionary-glossary__xref-"], [class*="dictionary-glossary__attribution"], .dictionary-glossary__part-of-speech',
      ),
    ).toBeNull();
    expect(container.innerHTML).not.toMatch(/data-|example-/);
  });

  it("keeps spaces where Japanese meets other text, and between English parts", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            { tag: "span", content: "noun" },
            { tag: "span", content: "to read" },
            { tag: "span", content: "読む" },
            { tag: "span", content: "(yomu)" },
            "本",
            { tag: "strong", content: "book" },
            {
              tag: "span",
              content: ["鯖", { tag: "span", data: { wari: "" }, content: "(さば)" }],
            },
            { tag: "em", content: "𠀋" },
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "noun to read 読む (yomu) 本 book 鯖(さば)𠀋",
    );
  });

  it("does not add a space beside source whitespace nested in inline elements", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            "alpha",
            { tag: "span", content: [{ tag: "strong", content: " beta " }] },
            "gamma ",
            { tag: "em", content: "delta" },
            { tag: "span", content: [" ", { tag: "strong", content: "epsilon" }] },
            " zeta",
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "alpha beta gamma delta epsilon zeta",
    );
  });

  it("checks the rendered edge when a nested reading contains whitespace", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            { tag: "span", content: ["word", { tag: "span", data: { wari: "" }, content: " " }] },
            "next",
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe("word next");
  });

  it("keeps the Japanese/English space when ruby annotations contain whitespace", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            { tag: "span", content: { tag: "ruby", content: ["漢", { tag: "rt", content: " " }] } },
            "word",
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe("漢  word");
    expect(container.querySelector(".dictionary-glossary")?.innerHTML).toContain("</span> word");
  });

  it("joins inside Japanese brackets even when their content is not Japanese", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            "類語",
            { tag: "span", content: "（" },
            { tag: "span", content: "3" },
            { tag: "span", content: "）" },
            { tag: "span", content: "English" },
            { tag: "span", content: "「" },
            { tag: "span", content: "word" },
            { tag: "span", content: "」" },
            { tag: "span", content: "note" },
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "類語（3） English 「word」 note",
    );
  });

  it("keeps source spacing around synthetic bracketed phrases", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            { tag: "span", content: "「" },
            { tag: "span", content: "テスト星を―・る" },
            { tag: "span", content: "」" },
            { tag: "span", content: " " },
            { tag: "span", content: "「テスト雲が―・す」" },
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary")?.textContent).toBe(
      "「テスト星を―・る」 「テスト雲が―・す」",
    );
  });

  it("keeps a nested link inside its label's single search button", async () => {
    const onSearchTerm = vi.fn();
    render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          tag: "a",
          content: [
            "行間",
            { tag: "a", content: ["を", { tag: "span", data: { wari: "" }, content: "（を）" }] },
            "読む",
          ],
        }}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.querySelector("button")).toBeNull();
    await userEvent.setup().click(button);
    expect(onSearchTerm).toHaveBeenCalledWith("行間を読む");
  });

  it("does not search a label that is only a reading", () => {
    render(
      <GlossaryText
        onSearchTerm={vi.fn()}
        value={{
          type: "structured-content",
          tag: "a",
          content: { tag: "span", data: { wari: "" }, content: "よむ" },
        }}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("よむ")).toHaveClass("dictionary-glossary__reading");
  });

  it("leaves unsupported labels as inert text", () => {
    const onSearchTerm = vi.fn();
    const { container } = render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: [
            { tag: "a", content: "   " },
            { tag: "a", content: "English" },
            { tag: "a", content: "あ".repeat(257) },
            { tag: "a", content: "𠀋".repeat(257) },
            { tag: "a", content: "あ".repeat(256) },
          ],
        }}
      />,
    );
    expect(container).toHaveTextContent("English");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button")).toHaveTextContent("あ".repeat(256));
    expect(onSearchTerm).not.toHaveBeenCalled();
  });

  it("keeps a structured label as text when no search action is supplied", () => {
    const { container } = render(
      <GlossaryText value={{ type: "structured-content", tag: "a", content: "日本語" }} />,
    );
    expect(container).toHaveTextContent("日本語");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("GlossaryText dictionary layouts", () => {
  it("searches a link's own target, not an arrow in its label", async () => {
    const onSearchTerm = vi.fn();
    render(
      <GlossaryText
        onSearchTerm={onSearchTerm}
        value={{
          type: "structured-content",
          content: [
            { tag: "a", href: "?query=記号", content: "←記号" },
            { tag: "a", href: "?query=%E6%96%87%E5%AD%97&wildcards=off", content: "⇒" },
          ],
        }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "←記号" }));
    await user.click(screen.getByRole("button", { name: "⇒" }));
    expect(onSearchTerm.mock.calls).toEqual([["記号"], ["文字"]]);
  });

  it("renders tables, collapsible sections and checked styles", () => {
    const { container } = render(
      <GlossaryText
        value={{
          type: "structured-content",
          content: [
            {
              tag: "table",
              content: [
                {
                  tag: "tr",
                  content: [
                    { tag: "th", content: "音" },
                    { tag: "td", rowSpan: 2, content: "コン" },
                  ],
                },
              ],
            },
            {
              tag: "details",
              content: [
                { tag: "summary", content: "用例" },
                { tag: "span", style: { fontWeight: "bold", position: "fixed" }, content: "例" },
              ],
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".dictionary-glossary__table table th")).toHaveTextContent("音");
    expect(container.querySelector("td")).toHaveAttribute("rowspan", "2");
    expect(container.querySelector("details summary")).toHaveTextContent("用例");
    const bold = container.querySelector("details span") as HTMLElement;
    expect(bold.style.fontWeight).toBe("bold");
    expect(bold.style.position).toBe("");
  });
});
