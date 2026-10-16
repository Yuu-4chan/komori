import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "./appearancePreferences";
import { AutoscrollSetting } from "./AutoscrollSetting";

function Probe() {
  const appearance = useAppearance();
  return (
    <>
      <AutoscrollSetting />
      <p>threshold {appearance.readerChapterWheelThreshold}</p>
      <button onClick={() => appearance.setReaderChapterWheelThreshold(7)}>Choose seven</button>
      <button
        onClick={() => {
          appearance.setReaderChapterWheelThreshold(2.5);
          appearance.setMiddleClickAutoscroll("no" as never);
        }}
      >
        Invalid
      </button>
    </>
  );
}

describe("saved scrolling choices", () => {
  it("uses independent defaults for absent/invalid fields", () => {
    expect(
      normalizeAppearancePreferences({
        middleClickAutoscroll: false,
        readerChapterWheelThreshold: 0,
      }),
    ).toMatchObject({ middleClickAutoscroll: false });
    expect(
      normalizeAppearancePreferences({ middleClickAutoscroll: 1, readerChapterWheelThreshold: 8 }),
    ).toEqual({ readerChapterWheelThreshold: 8 });
    expect(defaultAppearance).toMatchObject({
      middleClickAutoscroll: true,
      readerChapterWheelThreshold: 3,
    });
  });

  it("saves from the discoverable switch, rejects invalid setters and restores on restart", async () => {
    let saved: Partial<AppearancePreferences> = {
      middleClickAutoscroll: false,
      readerChapterWheelThreshold: 4,
    };
    const store = {
      load: async () => saved,
      save: vi.fn(async (value: AppearancePreferences) => {
        saved = value;
      }),
    };
    const first = render(
      <AppearanceProvider store={store}>
        <Probe />
      </AppearanceProvider>,
    );
    const toggle = await screen.findByRole("button", { name: "Middle-click autoscroll" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    const user = userEvent.setup();
    await user.click(toggle);
    await user.click(screen.getByText("Choose seven"));
    await waitFor(() =>
      expect(saved).toMatchObject({ middleClickAutoscroll: true, readerChapterWheelThreshold: 7 }),
    );
    const count = store.save.mock.calls.length;
    await user.click(screen.getByText("Invalid"));
    expect(store.save).toHaveBeenCalledTimes(count);
    first.unmount();
    await act(async () => {
      render(
        <AppearanceProvider store={store}>
          <Probe />
        </AppearanceProvider>,
      );
    });
    expect(screen.getByRole("button", { name: "Middle-click autoscroll" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("threshold 7")).toBeInTheDocument();
    expect(store.save).toHaveBeenCalledTimes(count);
  });
});
