import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { listDictionaries, lookupTerms } from "../dictionary/dictionaryApi";

vi.mock("../../app/platform", () => ({ isAndroid: true }));
vi.mock("../dictionary/dictionaryApi", () => ({
  lookupTerms: vi.fn(),
  lookupKanji: vi.fn(),
  listDictionaries: vi.fn(),
}));

const { ReaderLookupPopup } = await import("./ReaderLookupPopup");

vi.mocked(listDictionaries).mockResolvedValue([]);
vi.mocked(lookupTerms).mockResolvedValue({
  text: "読書",
  groups: [
    {
      expression: "読書",
      reading: "どくしょ",
      text: "読書",
      deinflection: null,
      terms: [
        {
          dictionaryId: 1,
          dictionaryTitle: "国語",
          definitionTags: "n",
          rules: "",
          score: 0,
          sequence: 1,
          termTags: "",
          tags: [],
          glossary: ["本を読むこと"],
        },
      ],
      frequencies: [],
      transcriptions: [],
      pitches: [],
    },
  ],
});

afterEach(() => {
  cleanup();
});

it("looks up a word tapped in a lookup on the phone, but not a drag or a control", async () => {
  const onChildLookup = vi.fn();
  render(
    <AppearanceProvider store={null}>
      <ReaderLookupPopup onChildLookup={onChildLookup} onSearchTerm={vi.fn()} query="読書" />
    </AppearanceProvider>,
  );
  const gloss = await screen.findByText("本を読むこと");
  const text = [...gloss.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
  // The character under the finger: 読 in the definition.
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: () => ({ offsetNode: text, offset: 2 }),
  });
  const box = { left: 30, right: 50, top: 10, bottom: 30, width: 20, height: 20, x: 30, y: 10 };
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [box],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => box,
  });
  const touch = (target: Element, from: number, to: number) => {
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: from,
      clientY: 20,
    });
    fireEvent.pointerUp(target, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: to,
      clientY: 20,
    });
  };

  touch(gloss, 40, 40);
  expect(onChildLookup).toHaveBeenCalledTimes(1);
  expect(onChildLookup.mock.calls[0]![0].query).toMatch(/^読むこと/);

  // A touch that moves scrolls the lookup, and its buttons press as buttons.
  touch(gloss, 40, 80);
  touch(screen.getAllByRole("button")[0]!, 40, 40);
  expect(onChildLookup).toHaveBeenCalledTimes(1);
  delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});
