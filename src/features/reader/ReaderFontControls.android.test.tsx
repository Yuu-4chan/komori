import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { defaultAppearance } from "../appearance/appearancePreferences";
import { ReaderFontControls } from "./ReaderFontControls";

vi.mock("../../app/platform", () => ({ isAndroid: true }));
vi.mock("./readerFonts", () => ({
  useReaderFonts: vi.fn(() => ({
    fonts: [{ id: "literata", family: "Literata", available: true, url: null }],
    pending: null,
    completed: 0,
    total: 0,
    error: null,
  })),
  checkSystemFont: vi.fn(async (family: string) => ({ family, available: true })),
  listSystemFonts: vi.fn(async () => ["Arial"]),
  changeDownloadedFont: vi.fn(async () => {}),
  refreshReaderFonts: vi.fn(async () => {}),
  importReaderFonts: vi.fn(async () => {}),
}));

it("opens the font list from a tap on the phone, with no keyboard to type in", async () => {
  const user = userEvent.setup();
  let saved = { ...defaultAppearance };
  const store = {
    load: async () => saved,
    save: vi.fn(async (next: typeof saved) => {
      saved = next;
    }),
  };
  render(
    <AppearanceProvider store={store}>
      <ReaderFontControls />
    </AppearanceProvider>,
  );
  const western = await screen.findByRole("combobox", { name: "Western font" });
  // A keyboard would cover the fonts below, and closing it would close the list.
  expect(western).toHaveAttribute("readonly");
  expect(western).toHaveAttribute("inputmode", "none");
  await user.click(western);
  expect(western).toHaveAttribute("aria-expanded", "true");
  await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Literata" }));
  expect(western).toHaveValue("Literata");
  expect(western).toHaveAttribute("aria-expanded", "false");
});
