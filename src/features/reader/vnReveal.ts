const name = "komori-vn-hidden";
const limit = 100_000;

/** Paint-only reveal: original nodes, CFIs, layout, images and text counts stay intact. */
export class VnReveal {
  private release?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private key?: string;
  private revealed = 0;
  private total = 0;
  private nodes: Array<{ node: Text; ends: number[]; before: number }> = [];
  revealing = false;
  supported = true;

  constructor(private readonly changed: () => void) {}

  start(key: string, elements: Element[], speed: number, visibility: Document): void {
    this.clear();
    if (this.key !== key) this.revealed = 0;
    this.key = key;
    this.nodes = [];
    this.total = 0;
    const document = elements[0]?.ownerDocument;
    const view = document?.defaultView as (Window & typeof globalThis) | null;
    const registry = view?.CSS?.highlights;
    this.supported = !!registry && !!view?.Highlight;
    if (!document || !speed) {
      this.supported = true;
      this.revealed = Infinity;
      return;
    }
    if (!registry || !view?.Highlight) return;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest("script, style, [hidden], [aria-hidden='true']")) continue;
        const text = node as Text;
        const ends: number[] = [];
        for (const part of segmenter.segment(text.data))
          ends.push(part.index + part.segment.length);
        this.nodes.push({ node: text, ends, before: this.total });
        this.total += ends.length;
        if (this.total > limit) {
          this.supported = false;
          this.nodes = [];
          return;
        }
      }
    }
    if (this.revealed >= this.total) return;
    const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.setAttribute("data-komori-vn-reveal", "");
    style.textContent = `::highlight(${name}) { color: transparent !important; background-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; }`;
    (document.head ?? document.documentElement).append(style);
    const paint = () => {
      const ranges = this.nodes.flatMap(({ node, ends, before }) => {
        const shown = Math.max(0, Math.floor(this.revealed) - before);
        if (shown >= ends.length) return [];
        const range = document.createRange();
        range.setStart(node, shown ? ends[shown - 1] : 0);
        range.setEnd(node, node.length);
        return [range];
      });
      const highlight = new view.Highlight(...ranges);
      highlight.priority = 100;
      registry.set(name, highlight);
    };
    this.release = () => {
      registry.delete(name);
      style.remove();
    };
    this.revealing = true;
    paint();
    let previous = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(100, now - previous);
      previous = now;
      if (visibility.hidden) return;
      this.revealed = Math.min(this.total, this.revealed + (elapsed * speed) / 1000);
      if (this.revealed >= this.total) this.finish();
      else paint();
    }, 32);
  }

  finish(): void {
    this.revealed = this.total;
    this.clear();
    this.changed();
  }

  /** Remove timers and masks; retain progress across a reflow of the same group. */
  clear(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.release?.();
    this.release = undefined;
    this.revealing = false;
  }

  dispose(): void {
    this.clear();
    this.nodes = [];
    this.key = undefined;
  }
}
