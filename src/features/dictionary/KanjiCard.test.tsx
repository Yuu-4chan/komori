import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { KanjiCard } from "./DictionaryResults";

it("offers no Anki action for a kanji", () => {
  render(
    <KanjiCard
      character="有"
      entries={[
        {
          dictionaryId: 1,
          dictionaryTitle: "Kanji",
          character: "有",
          onyomi: "ユウ ウ",
          kunyomi: "あ.る",
          tags: "",
          meanings: ["have"],
          stats: {},
          resolvedTags: [],
          statTags: [],
        },
      ]}
      frequencies={[]}
    />,
  );
  expect(screen.getByText("have")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Anki/ })).toBeNull();
});
