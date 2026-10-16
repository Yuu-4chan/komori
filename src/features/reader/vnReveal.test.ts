import { afterEach, describe, expect, it, vi } from "vitest";
import { VnReveal } from "./vnReveal";

afterEach(() => vi.useRealTimers());
function fixture() {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = '<p>A😀é<ruby>本<rt>ほん</rt></ruby></p><img src="art.png"/>';
  const registry = new Map<string, { ranges: Range[] }>();
  Object.defineProperty(doc.defaultView!, "CSS", {
    value: { highlights: registry },
    configurable: true,
  });
  Object.defineProperty(doc.defaultView!, "Highlight", {
    value: class {
      constructor(...publicRanges: Range[]) {
        this.ranges = publicRanges;
      }
      ranges: Range[];
    },
    configurable: true,
  });
  return { doc, registry, iframe };
}
describe("VN text reveal", () => {
  it("reveals whole graphemes without changing DOM, ruby, media, selection or layout", () => {
    vi.useFakeTimers();
    const { doc, registry, iframe } = fixture();
    const original = doc.body.innerHTML;
    const changed = vi.fn();
    const reveal = new VnReveal(changed);
    reveal.start("one", [...doc.body.children], 10, document);
    expect(reveal.revealing).toBe(true);
    expect(registry.get("komori-vn-hidden")!.ranges[0].toString()).toBe("A😀é");
    vi.advanceTimersByTime(320);
    expect(
      registry.get("komori-vn-hidden")!.ranges.some((range) => range.toString().includes("😀")),
    ).toBe(false);
    expect(doc.body.innerHTML).toBe(original);
    reveal.finish();
    expect(registry.size).toBe(0);
    expect(reveal.revealing).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    reveal.dispose();
    iframe.remove();
  });

  it("retains reveal progress through speed/reflow updates and cancels masks/timers on disposal", () => {
    vi.useFakeTimers();
    const { doc, registry, iframe } = fixture();
    const reveal = new VnReveal(vi.fn());
    reveal.start("one", [...doc.body.children], 10, document);
    vi.advanceTimersByTime(128);
    reveal.start("one", [...doc.body.children], 20, document);
    expect(registry.get("komori-vn-hidden")!.ranges[0].toString()).toBe("😀é");
    reveal.start("two", [...doc.body.children], 20, document);
    expect(registry.get("komori-vn-hidden")!.ranges[0].toString()).toBe("A😀é");
    reveal.dispose();
    vi.advanceTimersByTime(2000);
    expect(registry.size).toBe(0);
    expect(doc.querySelector("[data-komori-vn-reveal]")).toBeNull();
    iframe.remove();
  });

  it("shows text instantly for zero speed or unavailable browser support", () => {
    const { doc, registry, iframe } = fixture();
    const reveal = new VnReveal(vi.fn());
    reveal.start("one", [...doc.body.children], 0, document);
    expect(reveal.revealing).toBe(false);
    expect(registry.size).toBe(0);
    Object.defineProperty(doc.defaultView!, "Highlight", { value: undefined });
    reveal.start("two", [...doc.body.children], 10, document);
    expect(reveal.supported).toBe(false);
    expect(doc.body.textContent).toContain("A😀é本ほん");
    reveal.dispose();
    iframe.remove();
  });
});
