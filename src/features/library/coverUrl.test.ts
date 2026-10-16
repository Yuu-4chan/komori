import { describe, expect, it } from "vitest";

import { safeCoverUrl } from "./coverUrl";

const id = "0de3d2ad-4c1b-4d2e-9f00-1234567890ab";

describe("safeCoverUrl", () => {
  it.each([`http://komori-cover.localhost/${id}/0`, `komori-cover://localhost/${id}/12`])(
    "accepts the cover protocol URL %s",
    (value) => {
      expect(safeCoverUrl(value)).toBe(value);
    },
  );

  it.each([
    null,
    undefined,
    "",
    "file:///C:/private/cover.png",
    "http://example.com/cover.png",
    "data:image/png;base64,Y292ZXI=",
    `http://komori-cover.localhost/${id}`,
    `http://komori-cover.localhost/${id}/1?path=C:/books`,
    `http://komori-cover.localhost/${id}/1/../../library.sqlite3`,
    `http://komori-book.localhost/${id}/1`,
    `http://komori-cover.localhost/not-a-catalog-id/1`,
  ])("rejects %s", (value) => {
    expect(safeCoverUrl(value)).toBeNull();
  });
});
