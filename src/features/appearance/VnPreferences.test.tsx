import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "./appearancePreferences";

function Probe() {
  const a = useAppearance();
  return (
    <>
      <p>
        {a.readerViewMode}:{a.readerVnParagraphs}:{a.readerVnTextSpeed}
      </p>
      <button onClick={() => a.setReaderViewMode("vn")}>VN</button>
      <button onClick={() => a.setReaderVnParagraphs(3)}>Three</button>
      <button onClick={() => a.setReaderVnTextSpeed(0)}>Instant</button>
      <button
        onClick={() => {
          a.setReaderVnParagraphs(0);
          a.setReaderVnTextSpeed(201);
        }}
      >
        Invalid
      </button>
    </>
  );
}

it("validates VN fields independently and keeps legacy defaults", () => {
  expect(defaultAppearance.readerVnParagraphs).toBe(1);
  expect(defaultAppearance.readerVnTextSpeed).toBe(40);
  for (const value of [0, 21, 1.5, "3", null, NaN])
    expect(
      normalizeAppearancePreferences({ readerVnParagraphs: value, readerVnTextSpeed: 80 }),
    ).toEqual({ readerVnTextSpeed: 80 });
  for (const value of [-1, 201, 1.5, "80", null, NaN])
    expect(
      normalizeAppearancePreferences({
        readerViewMode: "vn",
        readerVnParagraphs: 20,
        readerVnTextSpeed: value,
      }),
    ).toEqual({ readerViewMode: "vn", readerVnParagraphs: 20 });
});

it("saves VN choices, refuses invalid setters, and restores them after remount", async () => {
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
      <Probe />
    </AppearanceProvider>,
  );
  await screen.findByText("paginated:1:40");
  await user.click(screen.getByText("VN"));
  await user.click(screen.getByText("Three"));
  await user.click(screen.getByText("Instant"));
  await waitFor(() =>
    expect(saved).toMatchObject({
      readerViewMode: "vn",
      readerVnParagraphs: 3,
      readerVnTextSpeed: 0,
    }),
  );
  const writes = store.save.mock.calls.length;
  await user.click(screen.getByText("Invalid"));
  expect(store.save).toHaveBeenCalledTimes(writes);
  first.unmount();
  render(
    <AppearanceProvider store={store}>
      <Probe />
    </AppearanceProvider>,
  );
  await screen.findByText("vn:3:0");
});
