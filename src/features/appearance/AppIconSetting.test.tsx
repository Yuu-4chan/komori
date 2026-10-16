import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { appIcons, appIconSvg } from "../../brand/appIcons";
import logo from "../../brand/komori.svg?raw";
import { AppearanceProvider } from "./AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "./appearancePreferences";
import { AppThemeSettings } from "./AppThemeSettings";

it("keeps a saved app icon only when it is one of the choices, beige by default", () => {
  expect(defaultAppearance.appIcon).toBe("beige");
  expect(normalizeAppearancePreferences({ appIcon: "teal" })).toEqual({ appIcon: "teal" });
  expect(normalizeAppearancePreferences({ appIcon: "pink", theme: "light" })).toEqual({
    theme: "light",
  });
});

it("draws every icon on its tile with the sakura cut out in the tile's colours", () => {
  for (const { id, tile } of appIcons) {
    const svg = appIconSvg(logo, id);
    expect(svg).toMatch(/^<svg[^>]*width="1024" height="1024" viewBox="-320 -465 1880 1880"/u);
    expect(svg).toContain('<rect id="tile"');
    const sakura = svg.match(/<linearGradient id="sakura-pink"[\s\S]*?<\/linearGradient>/u)![0];
    expect(sakura).toContain(`stop-color="${tile[0]}"`);
    expect(svg).not.toMatch(/#(FE7E88|EE657E|FA919E)/iu);
  }
});

it("saves the chosen icon from Settings and shows it chosen after a restart", async () => {
  let saved: Partial<AppearancePreferences> = {};
  const store = {
    load: async () => saved,
    save: vi.fn(async (value: AppearancePreferences) => {
      saved = value;
    }),
  };
  const user = userEvent.setup();
  const first = render(
    <AppearanceProvider store={store}>
      <AppThemeSettings />
    </AppearanceProvider>,
  );
  const icons = await screen.findByRole("radiogroup", { name: "App icon" });
  expect(icons.querySelectorAll('[role="radio"]')).toHaveLength(appIcons.length);
  expect(screen.getByRole("radio", { name: "Beige" })).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByRole("radio", { name: "Teal" }));
  await waitFor(() => expect(saved.appIcon).toBe("teal"));
  first.unmount();
  render(
    <AppearanceProvider store={store}>
      <AppThemeSettings />
    </AppearanceProvider>,
  );
  expect(await screen.findByRole("radio", { name: "Teal" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
