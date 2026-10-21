import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
} from "../appearance/appearancePreferences";
import {
  defaultPopupFont,
  fontPairFaces,
  fontPairStack,
  popupFontFaces,
  popupFontStack,
  sameFontPair,
  isReaderFontChoice,
  googleFontFiles,
  type ReaderFontPair,
} from "./fontChoices";
import { ReaderFontControls } from "./ReaderFontControls";
import { usePopupFont } from "./popupFont";
import { ReaderFontManager } from "./ReaderFontManager";
import {
  changeDownloadedFont,
  checkSystemFont,
  importReaderFonts,
  listSystemFonts,
  useReaderFonts,
} from "./readerFonts";

vi.mock("./readerFonts", () => ({
  useReaderFonts: vi.fn(() => ({
    fonts: [{ id: "literata", family: "Literata", available: true, url: null }],
    pending: null,
    completed: 0,
    total: 0,
    error: null,
  })),
  checkSystemFont: vi.fn(async (family: string) => ({ family, available: family === "Arial" })),
  listSystemFonts: vi.fn(async () => ["Arial", "Meiryo"]),
  changeDownloadedFont: vi.fn(async () => {}),
  refreshReaderFonts: vi.fn(async () => {}),
  importReaderFonts: vi.fn(async () => {}),
}));

it("migrates each legacy group independently, gives new choices precedence, and keeps missing-font names", () => {
  const prefs = normalizeAppearancePreferences({
    readerFontFamilyGroup1: "georgia",
    readerFontFamilyGroup2: "inter",
  });
  expect(prefs.readerAsianFont).toEqual({ source: "preset", id: "georgia" });
  expect(prefs.readerWesternFont).toEqual({ source: "preset", id: "inter" });
  expect(
    normalizeAppearancePreferences({
      readerAsianFont: { source: "system", family: "Missing font" },
      readerFontFamilyGroup1: "georgia",
    }).readerAsianFont,
  ).toEqual({ source: "system", family: "Missing font" });
  for (const bad of [
    null,
    false,
    "Arial",
    { source: "google", id: "arbitrary" },
    { source: "system", family: "Arial; color:red" },
    { source: "system", family: "Arial", css: "bad" },
  ]) {
    expect(isReaderFontChoice(bad)).toBe(false);
    const kept = normalizeAppearancePreferences({
      readerAsianFont: bad,
      readerWesternFont: { source: "google", id: "literata" },
      readerFontSize: 22,
    });
    expect(kept.readerAsianFont).toBeUndefined();
    expect(kept.readerWesternFont).toEqual({ source: "google", id: "literata" });
    expect(kept.readerFontSize).toBe(22);
  }
});
it("restricts Asian aliases to CJK while keeping ordered glyph fallback and fixed managed URLs", () => {
  const pair: ReaderFontPair = {
    asian: { source: "google", id: "zen-old-mincho" },
    western: { source: "system", family: "Arial" },
    downloaded: ["zen-old-mincho"],
  };
  expect(fontPairStack(pair)).toBe(
    '"Komori Asian", "Arial", "Komori Google zen-old-mincho", serif',
  );
  const faces = fontPairFaces(pair);
  expect(faces).toContain("unicode-range: U+1100-11FF,U+2E80-9FFF");
  expect(faces).toContain("http://komori-font.localhost/zen-old-mincho/");
  expect(fontPairFaces({ ...pair, downloaded: [] })).not.toContain("komori-font.localhost");
  expect(fontPairFaces({ ...pair, asian: { source: "preset", id: "inter" } })).toContain(
    'font-family: "Komori Reader Inter"',
  );
});
it("compares font pairs by values independently of object or resource order", () => {
  const a: ReaderFontPair = {
    asian: { source: "google", id: "zen-old-mincho" },
    western: { source: "system", family: "Arial" },
    downloaded: ["zen-old-mincho", "literata"],
  };
  const b: ReaderFontPair = {
    western: { family: "Arial", source: "system" },
    asian: { id: "zen-old-mincho", source: "google" },
    downloaded: ["literata", "zen-old-mincho"],
  };
  expect(sameFontPair(a, b)).toBe(true);
  expect(sameFontPair(a, { ...b, downloaded: [] })).toBe(false);
});
function Probe() {
  const prefs = useAppearance();
  return <p>{JSON.stringify(prefs.readerWesternFont)}</p>;
}
function memoryStore() {
  let saved = { ...defaultAppearance };
  return {
    get saved() {
      return saved;
    },
    load: async () => saved,
    save: vi.fn(async (next: typeof saved) => {
      saved = next;
    }),
  };
}

it("keeps independent weight preferences while menus follow static face removal and re-addition", async () => {
  const user = userEvent.setup();
  const store = memoryStore();
  const previous = vi.mocked(useReaderFonts).getMockImplementation()!;
  store.saved.readerAsianFont = { source: "google", id: "zen-old-mincho" };
  store.saved.readerAsianFontWeight = 700;
  store.saved.readerWesternFontWeight = 300;
  let installed = ["zen-old-mincho-600"];
  vi.mocked(useReaderFonts).mockImplementation(() => ({
    fonts: googleFontFiles.map((f) => ({
      ...f,
      source: "google",
      style: "normal",
      available: installed.includes(f.id),
      url: null,
    })),
    pending: null,
    completed: 0,
    total: 0,
    error: null,
    loaded: true,
  }));
  const tree = (
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>
  );
  const view = render(tree);
  const asian = await screen.findByRole("combobox", { name: "Asian font weight" });
  await waitFor(() => expect(asian).toHaveValue("600"));
  const options = () =>
    within(asian)
      .getAllByRole("option")
      .map((o) => o.textContent);
  expect(options()).toEqual(["600"]);
  expect(screen.getByRole("combobox", { name: "Western font weight" })).toHaveValue("300");
  expect(store.saved.readerAsianFontWeight).toBe(700);
  installed = ["zen-old-mincho-600", "zen-old-mincho-700"];
  view.rerender(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  expect(options()).toEqual(["600", "700"]);
  expect(asian).toHaveValue("700");
  await user.selectOptions(asian, "600");
  await waitFor(() => expect(store.saved.readerAsianFontWeight).toBe(600));
  expect(store.saved.readerWesternFontWeight).toBe(300);
  installed = [];
  view.rerender(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  expect(asian).toBeDisabled();
  expect(options()).toEqual(["—"]);
  expect(store.saved.readerAsianFontWeight).toBe(600);
  view.unmount();
  installed = ["zen-old-mincho-600"];
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Asian font weight" })).toHaveValue("600"),
  );
  vi.mocked(useReaderFonts).mockImplementation(previous);
});

it("migrates the old weight independently and rejects a present invalid role instead of reviving it", () => {
  expect(normalizeAppearancePreferences({ readerFontWeight: 600 })).toMatchObject({
    readerWesternFontWeight: 600,
    readerAsianFontWeight: 600,
  });
  expect(
    normalizeAppearancePreferences({
      readerFontWeight: 600,
      readerWesternFontWeight: 450,
      readerAsianFontWeight: null,
    }),
  ).toEqual({ readerFontWeight: 600, readerWesternFontWeight: 450 });
  for (const weight of [0, 1001, 400.5, "600", null])
    expect(normalizeAppearancePreferences({ readerAsianFontWeight: weight })).toEqual({});
});

it("maps actual static, variable and installed faces independently and preserves nonstandard publisher weights", () => {
  const pair: ReaderFontPair = {
    western: { source: "google", id: "noto-sans-jp" },
    asian: { source: "google", id: "zen-old-mincho" },
    downloaded: ["noto-sans-jp", "zen-old-mincho-600", "zen-old-mincho-900"],
    weights: { western: 400, asian: 600 },
  };
  const faces = fontPairFaces(pair, [400, 575, 700]);
  const asian = faces.split("\n").filter((f) => f.includes('font-family: "Komori Asian"'));
  expect(asian.find((f) => f.includes("font-weight: 400;"))).toContain("/zen-old-mincho-600/");
  expect(asian.find((f) => f.includes("font-weight: 700;"))).toContain("/zen-old-mincho-900/");
  expect(
    faces
      .split("\n")
      .find((f) => f.includes('font-family: "Komori Western"') && f.includes("font-weight: 575;")),
  ).toContain('font-variation-settings: "wght" 575;');
  const local = fontPairFaces(
    {
      ...pair,
      asian: { source: "system", family: "Arial" },
      weights: { western: 400, asian: 700 },
      systemFaces: [
        { family: "Arial", name: "Arial", weight: 400, style: "normal" },
        { family: "Arial", name: "Arial Bold", weight: 700, style: "normal" },
      ],
    },
    [400],
  );
  expect(local.split("\n").find((f) => f.includes('font-family: "Komori Asian"'))).toContain(
    'src: local("Arial Bold"); font-weight: 400;',
  );
  expect(sameFontPair(pair, { ...pair, weights: { western: 400, asian: 700 } })).toBe(false);
  const extremes = fontPairFaces(
    {
      asian: { source: "preset", id: "inter" },
      western: { source: "preset", id: "inter" },
      downloaded: [],
      weights: { western: 900, asian: 400 },
    },
    [400, 700],
  );
  expect(
    extremes
      .split("\n")
      .find((f) => f.includes('font-family: "Komori Asian"') && f.includes("font-weight: 700;")),
  ).toContain('font-variation-settings: "wght" 700;');
  expect(
    extremes
      .split("\n")
      .find((f) => f.includes('font-family: "Komori Western"') && f.includes("font-weight: 400;")),
  ).toContain('font-variation-settings: "wght" 900;');
});
it("offers this computer's fonts by name, saves the chosen family and restores it after restart", async () => {
  const user = userEvent.setup();
  const store = memoryStore();
  const first = render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
      <Probe />
    </AppearanceProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Choose Western font" }));
  const search = screen.getByRole("combobox", { name: "Western font" });
  expect(search).toHaveFocus();
  // Installed families are listed natively; nothing has to be typed out in full.
  expect(await screen.findByRole("option", { name: "Meiryo" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Literata/ })).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "Arial");
  expect(screen.queryByRole("option", { name: "Meiryo" })).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(store.saved.readerWesternFont).toEqual({ source: "system", family: "Arial" }),
  );
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Western font" })).toHaveFocus();
  expect(listSystemFonts).toHaveBeenCalled();
  first.unmount();
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
      <Probe />
    </AppearanceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Western font" })).toHaveValue("Arial"),
  );
  // An installed font needs no word once the check is done; only a missing one is named.
  const status = screen
    .getByRole("combobox", { name: "Western font" })
    .closest(".reader-font-field")!
    .querySelector('[role="status"]');
  await waitFor(() => expect(checkSystemFont).toHaveBeenCalledWith("Arial"));
  await waitFor(() => expect(status).toBeEmptyDOMElement());
});
it("keeps downloads outside the pickers and offers separate static weights and variable ranges in the manager", async () => {
  const user = userEvent.setup();
  const store = memoryStore();
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Choose Asian font" }));
  expect(screen.queryByRole("option", { name: /Zen Old Mincho/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  const add = screen.getByRole("button", { name: "Manage fonts for Asian font" });
  await user.click(add);
  expect(screen.getByRole("dialog", { name: "Fonts" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Download Klee One 600" }));
  expect(changeDownloadedFont).toHaveBeenLastCalledWith("klee-one-600", "download");
  await user.click(screen.getByRole("button", { name: "Download Zen Old Mincho 700" }));
  expect(changeDownloadedFont).toHaveBeenLastCalledWith("zen-old-mincho-700", "download");
  // The dialog opens on the menu's own collection; the other is a tab away.
  expect(screen.getByRole("button", { name: "Asian fonts", pressed: true })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download Lora 400–700" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Western fonts" }));
  expect(screen.queryByRole("button", { name: "Download Klee One 600" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Download Lora 400–700" }));
  expect(changeDownloadedFont).toHaveBeenLastCalledWith("lora", "download");
  await user.click(screen.getByRole("button", { name: "Remove Literata 200–900" }));
  expect(changeDownloadedFont).toHaveBeenLastCalledWith("literata", "remove");
  await user.click(screen.getByRole("button", { name: "Import fonts" }));
  expect(importReaderFonts).toHaveBeenCalledOnce();
  await user.type(screen.getByRole("textbox", { name: "Search fonts" }), "Merri");
  expect(screen.queryByRole("button", { name: "Download Lora 400–700" })).toBeNull();
  expect(screen.getByRole("button", { name: /Download Merriweather/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(add).toHaveFocus();
  expect(store.saved.readerAsianFont).toEqual(defaultAppearance.readerAsianFont);
});
it("offers each menu only its own collection's usable fonts and keeps the chosen one", async () => {
  const user = userEvent.setup();
  const fonts = [
    { id: "literata", familyId: "literata", family: "Literata", available: true, url: null },
    {
      id: "noto-sans-jp",
      familyId: "noto-sans-jp",
      family: "Noto Sans JP",
      available: true,
      bundled: true,
      url: null,
    },
  ];
  vi.mocked(useReaderFonts).mockReturnValue({
    fonts,
    pending: null,
    completed: 0,
    total: 0,
    error: null,
    loaded: true,
  });
  vi.mocked(listSystemFonts).mockResolvedValue(["Georgia", "Yu Gothic", "Noto Sans KR"]);
  const store = memoryStore();
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  try {
    await user.click(await screen.findByRole("button", { name: "Choose Western font" }));
    const western = within(screen.getByRole("listbox", { name: "Western font" }));
    await waitFor(() => expect(western.queryByRole("option", { name: "Segoe UI" })).toBeNull());
    // Each font is listed once; this computer's fonts stay listed by name in both menus.
    for (const name of [
      "Georgia",
      "Inter (included, Latin)",
      "System serif",
      "Literata",
      "Yu Gothic",
    ])
      expect(western.getAllByRole("option", { name })).toHaveLength(1);
    for (const name of ["Yu Mincho", "Noto Sans JP", "Noto Serif JP"])
      expect(western.queryByRole("option", { name })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Choose Asian font" }));
    const asian = within(screen.getByRole("listbox", { name: "Asian font" }));
    // The included Noto Sans JP is offered as itself, and is the default.
    expect(asian.getByRole("option", { name: "Noto Sans JP", selected: true })).toBeInTheDocument();
    for (const name of ["Noto Sans JP", "Yu Gothic", "Noto Sans KR", "Georgia"])
      expect(asian.getAllByRole("option", { name })).toHaveLength(1);
    for (const name of ["Yu Mincho", "Noto Serif JP", "Literata", "Segoe UI"])
      expect(asian.queryByRole("option", { name })).toBeNull();
    await user.keyboard("{Escape}");
  } finally {
    vi.mocked(listSystemFonts).mockResolvedValue(["Arial", "Meiryo"]);
    vi.mocked(useReaderFonts).mockReturnValue({
      fonts: [{ id: "literata", family: "Literata", available: true, url: null }],
      pending: null,
      completed: 0,
      total: 0,
      error: null,
      loaded: true,
    });
  }
});
it("shows the included weights without an action to download or remove them", async () => {
  const user = userEvent.setup();
  vi.mocked(useReaderFonts).mockReturnValueOnce({
    fonts: [
      {
        id: "zen-old-mincho",
        familyId: "zen-old-mincho",
        family: "Zen Old Mincho",
        available: true,
        bundled: true,
        url: null,
      },
    ],
    pending: null,
    completed: 0,
    total: 0,
    error: null,
    loaded: true,
  });
  render(<ReaderFontManager category="asian" onClose={() => {}} />);
  const dialog = within(screen.getByRole("dialog", { name: "Fonts" }));
  expect(dialog.getByText("Zen Old Mincho 400 is included with Komori")).toBeInTheDocument();
  expect(
    dialog.queryByRole("button", { name: /(Download|Remove) Zen Old Mincho 400$/ }),
  ).toBeNull();
  await user.click(dialog.getByRole("button", { name: "Download Zen Old Mincho 700" }));
  expect(changeDownloadedFont).toHaveBeenLastCalledWith("zen-old-mincho-700", "download");
});
it("accepts a typed missing family on Enter or blur, cancels with Escape and refuses CSS names", async () => {
  const user = userEvent.setup();
  const store = memoryStore();
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  const input = await screen.findByRole("combobox", { name: "Western font" });
  await user.clear(input);
  await user.type(input, "My missing font{Enter}");
  await waitFor(() =>
    expect(store.saved.readerWesternFont).toEqual({ source: "system", family: "My missing font" }),
  );
  await screen.findAllByText("Not installed. Fallback fonts are in use.");
  await user.clear(input);
  await user.type(input, "Cancelled{Escape}");
  expect(input).toHaveValue("My missing font");
  await user.clear(input);
  await user.type(input, "Arial; color:red{Enter}");
  expect(input).toHaveValue("My missing font");
  expect(store.saved.readerWesternFont).toEqual({ source: "system", family: "My missing font" });
  await user.clear(input);
  await user.type(input, "Meiryo");
  await user.tab();
  await waitFor(() =>
    expect(store.saved.readerWesternFont).toEqual({ source: "system", family: "Meiryo" }),
  );
});
it("declares every downloaded weight and bounded imported face with safe owned URLs", () => {
  const id = "a".repeat(64);
  const pair: ReaderFontPair = {
    asian: { source: "google", id: "klee-one" },
    western: { source: "uploaded", id },
    downloaded: ["klee-one", "klee-one-600"],
    uploaded: [{ id, family: "Uploaded", weight: "400 700", style: "normal" }],
  };
  const faces = fontPairFaces(pair);
  expect(faces).toContain("font-weight: 400;");
  expect(faces).toContain("font-weight: 600;");
  expect(faces).toContain("font-weight: 400 700;");
  expect(faces).toContain("/uploaded/" + id + ".ttf");
  expect(fontPairFaces({ ...pair, downloaded: [], uploaded: [] })).not.toContain("@font-face");
  expect(isReaderFontChoice({ source: "uploaded", id })).toBe(true);
  expect(isReaderFontChoice({ source: "uploaded", id: "../Arial" })).toBe(false);
  expect(sameFontPair(pair, { ...pair, uploaded: [] })).toBe(false);
});

it("sets the popup in its chosen font over the included Zen Old Mincho, declaring only owned faces", () => {
  expect(defaultAppearance).toMatchObject({
    readerPopupStyle: "standard",
    readerPopupFont: { source: "google", id: "zen-old-mincho" },
  });
  expect(popupFontStack(defaultPopupFont)).toBe('"Komori Google zen-old-mincho", serif');
  expect(popupFontStack({ source: "system", family: "Yu Mincho" })).toBe(
    '"Yu Mincho", "Komori Google zen-old-mincho", serif',
  );
  expect(popupFontStack({ source: "preset", id: "sans-serif" })).toBe(
    'sans-serif, "Komori Google zen-old-mincho", serif',
  );
  const zen = googleFontFiles.find((f) => f.id === "zen-old-mincho")!;
  // The popup is in Komori's own window: no script aliases, only the fonts it names.
  expect(popupFontFaces(defaultPopupFont, [zen.id])).toBe(
    `@font-face { font-family: "Komori Google zen-old-mincho"; src: url("http://komori-font.localhost/zen-old-mincho/${zen.hash}.ttf"); font-weight: 400; font-style: normal; font-display: block; }`,
  );
  const shippori = googleFontFiles.find((f) => f.id === "shippori-mincho-600")!;
  const chosen = popupFontFaces({ source: "google", id: "shippori-mincho" }, [zen.id, shippori.id]);
  expect(chosen.match(/@font-face/g)).toHaveLength(2);
  expect(chosen).toContain(
    `font-family: "Komori Google shippori-mincho"; src: url("http://komori-font.localhost/shippori-mincho-600/${shippori.hash}.ttf"); font-weight: 600;`,
  );
  expect(chosen).not.toContain("Komori Asian");
  expect(popupFontFaces({ source: "system", family: "Yu Mincho" }, [])).toBe("");
  const uploaded = {
    id: "a".repeat(64),
    family: "My Mincho",
    weight: "400",
    style: "normal" as const,
  };
  expect(popupFontFaces({ source: "uploaded", id: uploaded.id }, [], [uploaded])).toContain(
    `font-family: "Komori Uploaded ${uploaded.id}"; src: url("http://komori-font.localhost/uploaded/${uploaded.id}.ttf");`,
  );
  // Each saved choice is kept or dropped on its own.
  const saved = {
    readerPopupStyle: "dictionary",
    readerPopupFont: { source: "system", family: "Yu Mincho" },
  };
  expect(normalizeAppearancePreferences(saved)).toEqual(saved);
  for (const [style, font] of [
    ["Dictionary", { source: "google", id: "missing" }],
    [null, "zen-old-mincho"],
    [1, { source: "system", family: "a; color:red" }],
    ["compact", { source: "google", id: "zen-old-mincho", weight: 600 }],
  ])
    expect(
      normalizeAppearancePreferences({
        readerPopupStyle: style,
        readerPopupFont: font,
        readerPopupRadius: 7,
      }),
    ).toEqual({ readerPopupRadius: 7 });
  expect(
    normalizeAppearancePreferences({
      readerPopupStyle: "compact",
      readerPopupFont: defaultPopupFont,
    }),
  ).toEqual({ readerPopupFont: defaultPopupFont });
});

it("declares the popup's faces once in Komori's document and keeps them after popups close", () => {
  const previous = vi.mocked(useReaderFonts).getMockImplementation()!;
  const zen = googleFontFiles.find((f) => f.id === "zen-old-mincho")!;
  vi.mocked(useReaderFonts).mockImplementation(
    () =>
      ({
        ...previous(),
        fonts: [
          {
            id: zen.id,
            familyId: zen.familyId,
            family: zen.family,
            source: "google",
            available: true,
            url: `http://komori-font.localhost/zen-old-mincho/${zen.hash}.ttf`,
          },
        ],
      }) as ReturnType<typeof useReaderFonts>,
  );
  function Popup() {
    return <p style={{ fontFamily: usePopupFont(defaultPopupFont) }}>読む</p>;
  }
  const first = render(<Popup />);
  const second = render(<Popup />);
  expect(document.head.querySelectorAll("style#komori-popup-fonts")).toHaveLength(1);
  first.unmount();
  second.unmount();
  expect(document.getElementById("komori-popup-fonts")?.textContent).toBe(
    popupFontFaces(defaultPopupFont, [zen.id]),
  );
  vi.mocked(useReaderFonts).mockImplementation(previous);
});
