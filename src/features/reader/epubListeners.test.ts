import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error EPUB.js declares no modules for its manager sources.
import ContinuousViewManager from "epubjs/src/managers/continuous";
// @ts-expect-error EPUB.js declares no modules for its manager sources.
import DefaultViewManager from "epubjs/src/managers/default";

type Registration = [type: string, listener: unknown];

// EPUB.js's view managers and stage add window listeners bound to themselves; a closed book
// must remove each one, or the window keeps the manager, its renderer and its documents.
describe("EPUB.js window listeners", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["paginated", DefaultViewManager],
    ["continuous", ContinuousViewManager],
  ])("removes every window listener its %s view manager added", (_name, Manager) => {
    const added: Registration[] = [];
    const removed: Registration[] = [];
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      added.push([type, listener]);
      add(type, listener, options);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
      removed.push([type, listener]);
      remove(type, listener, options);
    });
    const host = document.createElement("div");
    document.body.append(host);
    const manager = new Manager({ settings: { width: 600, height: 400 }, queue: {} });
    manager.render(host, { width: 600, height: 400 });
    expect(added.map(([type]) => type)).toEqual(
      expect.arrayContaining(["orientationchange", "unload"]),
    );
    manager.destroy();
    host.remove();
    for (const registration of added) expect(removed).toContainEqual(registration);
  });
});
