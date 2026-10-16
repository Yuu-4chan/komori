import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { normalizeNote, noteStore, noteTextValid, visibleNotes } from "./notes";
import { notePassage } from "./noteCapture";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
const place = {
  passage: "本文",
  locator: { spineIndex: 0, sectionKey: "abcd1234", progress: 0.5, contentKey: "a".repeat(64) },
};
const note = { ...place, body: "Thought", id: "11111111-1111-4111-8111-111111111111" };
describe("note search and ordering", () => {
  it("searches bodies and passages literally without case, trimming only the query edges", () => {
    const items = [
      note,
      { ...note, id: "other", body: "A [Literal] detail\nSecond line", passage: "English PASSAGE" },
    ];
    for (const query of ["thought", "  ThOuGhT  ", "本文"])
      expect(visibleNotes(items, query, "creation")).toEqual([note]);
    for (const query of ["[literal]", "passage", "detail\nsecond"])
      expect(visibleNotes(items, query, "reading")).toEqual([items[1]]);
    expect(visibleNotes(items, "absent", "creation")).toEqual([]);
    expect(visibleNotes(items, "   ", "creation")).toEqual(items);
  });
  it("sorts by section then fraction with deterministic ID ties, without mutating stored data", () => {
    const items = [
      { ...note, id: "late", locator: { ...place.locator, spineIndex: 2, progress: 0 } },
      { ...note, id: "first-tie" },
      { ...note, id: "earlier", locator: { ...place.locator, progress: 0.1 } },
      { ...note, id: "second-tie" },
    ];
    const original = structuredClone(items);
    expect(visibleNotes(items, "", "reading").map((n) => n.id)).toEqual([
      "earlier",
      "first-tie",
      "second-tie",
      "late",
    ]);
    expect(visibleNotes(items, "", "creation")).toEqual(original);
    expect(items).toEqual(original);
    expect(visibleNotes([...items].reverse(), "", "reading")).toEqual(
      visibleNotes(items, "", "reading"),
    );
  });
});
describe("bounded native notes boundary", () => {
  it("validates Unicode, multiline text and safe locators", () => {
    expect(noteTextValid("本".repeat(4096))).toBe(true);
    expect(noteTextValid("本".repeat(4097))).toBe(false);
    expect(noteTextValid("Thought\n\tDetail")).toBe(true);
    for (const text of ["", " padded", "bad\0", "bad\r"]) expect(noteTextValid(text)).toBe(false);
    expect(normalizeNote(note)).toEqual(note);
    expect(normalizeNote({ ...note, locator: { ...place.locator, progress: 2 } })).toBeNull();
    expect(
      normalizeNote({ ...note, locator: { ...place.locator, contentKey: "path" } }),
    ).toBeNull();
  });
  it("reads detached passage text excluding ruby and inactive content and preserves paragraph breaks", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p><ruby>本<rt>ほん</rt></ruby>文<br>Line</p><p>Next <span hidden>Hidden</span><script>unsafe</script></p>";
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(notePassage(range)).toBe("本文\nLine\nNext");
    expect(root.querySelector("rt")).not.toBeNull();
  });
  it("binds CRUD to a catalog and suppresses native storage details", async () => {
    const store = noteStore("catalog");
    vi.mocked(invoke).mockResolvedValueOnce([note]);
    expect(await store.load()).toEqual([note]);
    vi.mocked(invoke).mockResolvedValueOnce({ status: "created", note });
    expect(await store.create(place, "Thought")).toEqual(note);
    expect(invoke).toHaveBeenLastCalledWith("create_reader_note", {
      id: "catalog",
      ...place,
      body: "Thought",
    });
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await store.edit(note.id, "Edited");
    expect(invoke).toHaveBeenLastCalledWith("edit_reader_note", {
      id: "catalog",
      noteId: note.id,
      body: "Edited",
    });
    vi.mocked(invoke).mockRejectedValueOnce(Error("C:/private/library.sqlite3"));
    await expect(store.remove(note.id)).rejects.toThrow("Could not save notes");
    vi.mocked(invoke).mockResolvedValueOnce({ status: "limit" });
    await expect(store.create(place, "Thought")).rejects.toThrow("1,000 notes");
  });
});
