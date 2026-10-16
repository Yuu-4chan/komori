import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ankiNoteChanged,
  emptyAnki,
  forgetNoteStatuses,
  noteStatus,
  loadAnki,
  saveAnki,
  type FieldPart,
} from "./ankiApi";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  forgetNoteStatuses();
});

const first = (text: string): FieldPart[] => [{ type: "text", text }];
it("normalizes legacy and saved tags without changing caller drafts or note-type choices", async () => {
  const original = {
    ...emptyAnki,
    mappings: {
      Basic: {
        fields: ["Front"],
        templates: { Front: "{{expression}}" },
        tags: ["MiXeD", "mixed", "OtherTAG"],
        tagDictionaries: [42],
      },
    },
  };
  vi.mocked(invoke).mockResolvedValue(original);
  const loaded = await loadAnki();
  expect(loaded.mappings.Basic.tags).toEqual(["mixed", "othertag"]);
  await saveAnki(original);
  expect(vi.mocked(invoke).mock.calls[1]).toEqual([
    "save_anki_preferences",
    { preferences: loaded },
  ]);
  expect(original.mappings.Basic.tags).toEqual(["MiXeD", "mixed", "OtherTAG"]);
  expect(loaded.mappings.Basic.tagDictionaries).toEqual([42]);
});

it("sends a moment's checks as one batch of first fields and readings, and keeps answers", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([
    { status: "missing" },
    { status: "existing", id: 7, count: 1 },
  ]);
  const read = noteStatus(emptyAnki, first("読む"), "よむ");
  const again = noteStatus(emptyAnki, first("読む"), "よむ");
  const who = noteStatus(emptyAnki, first("誰が"), "たが");
  expect(again).toBe(read);
  expect(await read).toEqual({ status: "missing" });
  expect(await who).toEqual({ status: "existing", id: 7, count: 1 });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("get_anki_note_statuses", {
    batch: {
      preferences: emptyAnki,
      notes: [
        { first: first("読む"), reading: "よむ" },
        { first: first("誰が"), reading: "たが" },
      ],
    },
  });
  // Answers are kept until a card changes; another scope is its own check.
  await noteStatus(emptyAnki, first("読む"), "よむ");
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockResolvedValue([{ status: "missing" }]);
  await noteStatus({ ...emptyAnki, duplicateScope: "deck" }, first("読む"), "よむ");
  expect(invoke).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event(ankiNoteChanged));
  await noteStatus(emptyAnki, first("読む"), "よむ");
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("expires stalled IPC so a retry sends a new check", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}));
    const stalled = noteStatus(emptyAnki, first("字"));
    const rejected = expect(stalled).rejects.toBe("timeout");
    await vi.advanceTimersByTimeAsync(6001);
    await rejected;
    vi.mocked(invoke).mockResolvedValue([{ status: "missing" }]);
    const retried = noteStatus(emptyAnki, first("字"));
    await vi.advanceTimersByTimeAsync(1);
    await retried;
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
