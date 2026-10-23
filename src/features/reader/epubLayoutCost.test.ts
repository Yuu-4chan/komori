import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error EPUB.js declares no modules for its view sources.
import IframeView from "epubjs/src/managers/views/iframe";
// @ts-expect-error EPUB.js declares no modules for its view helpers.
import Views from "epubjs/src/managers/helpers/views";
// @ts-expect-error EPUB.js declares no modules for its rendition source.
import Rendition from "epubjs/src/rendition";

// Measuring a section or its view lays out every view of a continuous book, so Komori's
// EPUB.js patch measures only what is used, when it is used, and groups the views so that
// laying the book out does not lay out every view.
describe("EPUB.js layout cost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function createView() {
    const view = new IframeView(
      { index: 0, properties: [] },
      { axis: "vertical", width: 600, height: 400, layout: { name: "reflowable" } },
    );
    document.body.append(view.element);
    view.create();
    return view;
  }

  it("takes a view's borders out of its locked size only as the size is used", () => {
    const view = createView();
    const computed = vi.spyOn(window, "getComputedStyle");
    view.size(600, 400);
    expect(computed).not.toHaveBeenCalled();

    view.element.style.paddingLeft = "5px";
    view.iframe.style.marginRight = "3px";
    expect(view.lockedWidth).toBe(592);
    expect(computed).toHaveBeenCalledTimes(2);
    expect(view.lockedWidth).toBe(592);
    expect(computed).toHaveBeenCalledTimes(2);

    view.lock("width", 500, 400);
    view.lock("height", 500, 300);
    expect(view.lockedWidth).toBe(492);
    expect(view.lockedHeight).toBe(300);
    expect(computed).toHaveBeenCalledTimes(4);
  });

  it("keeps a locked size assigned after the lock asked for", () => {
    const view = createView();
    view.lock("both", 600, 400);
    view.lockedWidth = 320;
    expect(view.lockedWidth).toBe(320);
    expect(view.lockedHeight).toBe(400);
  });

  function adjustImages(settings: { limitImages?: boolean }) {
    const contents = {
      window: {
        getComputedStyle: vi.fn(() => ({
          paddingTop: "10px",
          paddingBottom: "10px",
          paddingLeft: "20px",
          paddingRight: "20px",
        })),
      },
      content: { offsetHeight: 1020 },
      addStylesheetRules: vi.fn(),
    };
    void Rendition.prototype.adjustImages.call(
      { _layout: { name: "reflowable", columnWidth: 640 }, settings },
      contents,
    );
    return contents;
  }

  it("limits a section's images to its measured size unless the rendition limits them", () => {
    const measured = adjustImages({});
    expect(measured.window.getComputedStyle).toHaveBeenCalledOnce();
    expect(measured.addStylesheetRules).toHaveBeenCalledWith({
      img: expect.objectContaining({
        "max-width": "600px!important",
        "max-height": "950px!important",
        "object-fit": "contain",
      }),
      svg: expect.objectContaining({
        "max-width": "600px!important",
        "max-height": "950px!important",
      }),
    });

    const limited = adjustImages({ limitImages: false });
    expect(limited.window.getComputedStyle).not.toHaveBeenCalled();
    expect(limited.addStylesheetRules).toHaveBeenCalledWith({
      img: {
        "object-fit": "contain",
        "page-break-inside": "avoid",
        "break-inside": "avoid",
        "box-sizing": "border-box",
      },
      svg: { "page-break-inside": "avoid", "break-inside": "avoid" },
    });
  });

  type FakeView = { name: string; element: HTMLElement; displayed: boolean };

  function fakeView(name: string): FakeView {
    const element = document.createElement("div");
    element.dataset.name = name;
    return { name, element, displayed: false };
  }

  /** The container's groups, each as the names of its views in order. */
  function groups(container: HTMLElement): string[][] {
    return [...container.children].map((group) =>
      [...group.children].map((element) => (element as HTMLElement).dataset.name ?? ""),
    );
  }

  it("groups views in reading order, splitting a full group a view lands inside", () => {
    const container = document.createElement("div");
    container.style.display = "flex";
    const views = new Views(container, 3);
    const named: Record<string, FakeView> = {};
    const view = (name: string) => (named[name] = fakeView(name));

    for (const name of ["c", "d", "e", "f"]) views.append(view(name));
    views.prepend(view("b"));
    views.prepend(view("a"));
    expect(groups(container)).toEqual([["a", "b"], ["c", "d", "e"], ["f"]]);
    const group = container.firstElementChild as HTMLElement;
    expect(group.className).toBe("epub-view-group");
    expect(getComputedStyle(group).display).toBe("flex");
    expect([group.style.flexGrow, group.style.flexShrink]).toEqual(["0", "0"]);

    // A view joins the group before it with room, else the one after it.
    views.insert(view("b2"), 2);
    expect(groups(container)).toEqual([["a", "b", "b2"], ["c", "d", "e"], ["f"]]);
    // Within a full group, the views after the new one move to a group of their own.
    views.insert(view("d0"), 4);
    expect(groups(container)).toEqual([["a", "b", "b2"], ["c", "d0"], ["d", "e"], ["f"]]);
    views.insert(view("c0"), 3);
    expect(groups(container)).toEqual([["a", "b", "b2"], ["c0", "c", "d0"], ["d", "e"], ["f"]]);
    // Between full groups, it takes a group of its own.
    views.insert(view("b3"), 3);
    expect(groups(container)).toEqual([
      ["a", "b", "b2"],
      ["b3"],
      ["c0", "c", "d0"],
      ["d", "e"],
      ["f"],
    ]);
    expect(views.all().map((item: FakeView) => item.name)).toEqual(groups(container).flat());

    // A group goes with its last view.
    views.remove(named.b3);
    views.remove(named.f);
    expect(groups(container)).toEqual([
      ["a", "b", "b2"],
      ["c0", "c", "d0"],
      ["d", "e"],
    ]);
    views.clear();
    expect(container.children).toHaveLength(0);
  });

  it("keeps views ungrouped unless asked to group them", () => {
    const container = document.createElement("div");
    const views = new Views(container);
    const [a, b, c] = ["a", "b", "c"].map(fakeView);
    views.append(b);
    views.prepend(a);
    views.insert(c, 2);
    expect([...container.children]).toEqual([a.element, b.element, c.element]);
    views.remove(b);
    expect([...container.children]).toEqual([a.element, c.element]);
  });
});
