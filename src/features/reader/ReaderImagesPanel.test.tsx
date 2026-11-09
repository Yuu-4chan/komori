import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderImagesPanel } from "./ReaderImagesPanel";

describe("ReaderImagesPanel thumbnails", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("watches the thumbnails against the phone sheet that scrolls them", async () => {
    const roots: (Element | Document | null | undefined)[] = [];
    let report: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          roots.push(options?.root);
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const loadImage = vi.fn(async () => ({ url: "blob:thumb", width: 10, height: 10 }));
    render(
      <section className="mobile-sheet">
        <ReaderImagesPanel
          ready
          listImages={async () => ({
            items: [{ id: "i1", label: "Chapter 1", alt: "Map", section: 0 }],
            truncated: false,
            failedSections: 0,
          })}
          loadImage={loadImage}
          releaseImage={() => {}}
          onOpen={() => {}}
        />
      </section>,
    );
    await screen.findByRole("button", { name: /Open image 1/ });
    expect(roots).toEqual([document.querySelector(".mobile-sheet")]);
    expect(loadImage).not.toHaveBeenCalled();
    report([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(await screen.findByRole("img", { name: "Map" })).toHaveAttribute("src", "blob:thumb");
  });
});
