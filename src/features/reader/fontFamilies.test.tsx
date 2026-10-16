import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
} from "../appearance/appearancePreferences";
import {
  readerFontAvailability,
  readerFontStack,
  readerSerifFonts,
  readerSansFonts,
} from "./fontFamilies";

afterEach(() => vi.unstubAllGlobals());

it("accepts only each group's stable IDs, retaining the other fields independently", () => {
  for (const font of readerSerifFonts)
    expect(normalizeAppearancePreferences({ readerFontFamilyGroup1: font.value })).toEqual({
      readerFontFamilyGroup1: font.value,
      readerAsianFont: { source: "preset", id: font.value },
    });
  for (const font of readerSansFonts)
    expect(normalizeAppearancePreferences({ readerFontFamilyGroup2: font.value })).toEqual({
      readerFontFamilyGroup2: font.value,
      readerWesternFont: { source: "preset", id: font.value },
    });
  for (const bad of [null, false, 1, [], {}, "", "Arial", "serif; color:red", "inter"]) {
    expect(
      normalizeAppearancePreferences({
        readerFontFamilyGroup1: bad,
        readerFontFamilyGroup2: "inter",
        readerFontSize: 20,
      }),
    ).toEqual({
      readerFontFamilyGroup2: "inter",
      readerWesternFont: { source: "preset", id: "inter" },
      readerFontSize: 20,
    });
  }
  expect(normalizeAppearancePreferences({ readerFontFamilyGroup2: "georgia" })).toEqual({});
  expect(defaultAppearance.readerFontFamilyGroup1).toBe("yu-mincho");
  expect(defaultAppearance.readerFontFamilyGroup2).toBe("segoe-ui");
  expect(readerFontStack("georgia", "noto-sans-jp")).toBe('"Georgia", "Noto Sans JP", serif');
  expect(readerFontStack("serif", "inter")).toBe('serif, "Komori Reader Inter"');
});

it("reports failed local font probes honestly without treating missing families as installed", async () => {
  const load = vi.fn(async () => {
    throw new Error("Missing local font");
  });
  const face = vi.fn(
    class {
      load = load;
    },
  );
  vi.stubGlobal("FontFace", face);
  expect(await readerFontAvailability("noto-serif-jp")).toBe("unavailable");
  expect(face).toHaveBeenCalledWith("KomoriFontProbe", 'local("Noto Serif JP")');
  expect(await readerFontAvailability("inter")).toBe("available");
  expect(await readerFontAvailability("serif")).toBe("available");
  expect(await readerFontAvailability("unknown")).toBe("unknown");
  load.mockResolvedValueOnce(undefined as never);
  expect(await readerFontAvailability("georgia")).toBe("available");
  vi.stubGlobal("FontFace", undefined);
  expect(await readerFontAvailability("georgia")).toBe("unknown");
});

function FontProbe() {
  const prefs = useAppearance();
  return (
    <>
      <p>
        {prefs.readerFontFamilyGroup1} / {prefs.readerFontFamilyGroup2}
      </p>
      <button onClick={() => prefs.setReaderFontFamilyGroup1("noto-serif-jp")}>Serif</button>
      <button onClick={() => prefs.setReaderFontFamilyGroup2("inter")}>Sans</button>
      <button onClick={() => prefs.setReaderFontFamilyGroup1("inter" as never)}>Invalid</button>
    </>
  );
}

it("loads, saves and reopens choices, ignoring invalid setters without a write", async () => {
  const user = userEvent.setup();
  let saved = { ...defaultAppearance };
  const save = vi.fn(async (next: typeof saved) => {
    saved = next;
  });
  const store = { load: async () => saved, save };
  const first = render(
    <AppearanceProvider store={store}>
      <FontProbe />
    </AppearanceProvider>,
  );
  await screen.findByText("yu-mincho / segoe-ui");
  await user.click(screen.getByText("Serif"));
  await user.click(screen.getByText("Sans"));
  await waitFor(() => expect(saved.readerFontFamilyGroup2).toBe("inter"));
  const writes = save.mock.calls.length;
  await user.click(screen.getByText("Invalid"));
  expect(save).toHaveBeenCalledTimes(writes);
  first.unmount();
  render(
    <AppearanceProvider store={store}>
      <FontProbe />
    </AppearanceProvider>,
  );
  await screen.findByText("noto-serif-jp / inter");
});
