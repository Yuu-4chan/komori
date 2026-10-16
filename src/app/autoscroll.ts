/** Shared middle-button input for app surfaces and isolated EPUB documents. */
const CONTROLS =
  'a, button, input, textarea, select, option, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-autoscroll-exclude]';

export function acceptsAutoscroll(target: EventTarget | null): target is Element {
  return !!target && (target as Node).nodeType === 1 && !(target as Element).closest(CONTROLS);
}

export interface AutoscrollTarget {
  axes: "both" | "horizontal" | "vertical";
  move: (x: number, y: number) => void;
}

/** Pixels/second; a dead zone prevents drift, then the speed keeps growing with the distance. */
export function autoscrollSpeed(offset: number): number {
  const distance = Math.max(0, Math.abs(offset) - 12);
  return Math.sign(offset) * distance * distance * 0.12;
}

export function scrollableAncestor(element: Element, boundary: HTMLElement): HTMLElement {
  for (let node: Element | null = element; node && node !== boundary; node = node.parentElement) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    if (
      (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) ||
      (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth)
    )
      return node as HTMLElement;
  }
  return boundary;
}

export class AutoscrollController {
  private releases = new Map<Document, () => void>();
  private session?: {
    target: AutoscrollTarget;
    x: number;
    y: number;
    pointerX: number;
    pointerY: number;
    dragged: boolean;
    /** Sub-pixel distance carried between frames, so slow speeds move evenly. */
    restX: number;
    restY: number;
  };
  private marker?: HTMLElement;
  private frame = 0;
  private lastFrame = 0;
  private cancelledAt = -Infinity;
  private view: Window;

  constructor(
    private root: Document,
    private resolve: (event: PointerEvent, document: Document) => AutoscrollTarget | null,
    private onStop?: () => void,
  ) {
    this.view = root.defaultView!;
    this.view.addEventListener("blur", this.stop);
    this.view.addEventListener("pagehide", this.stop);
    this.view.addEventListener("resize", this.stop);
  }

  addDocument(document: Document): void {
    if (this.releases.has(document) || !document.defaultView || !document.documentElement) return;
    const point = (event: MouseEvent) => {
      const rect = document.defaultView?.frameElement?.getBoundingClientRect();
      return { x: event.clientX + (rect?.left ?? 0), y: event.clientY + (rect?.top ?? 0) };
    };
    const down = (event: PointerEvent) => {
      if (this.session) {
        this.stop();
        this.cancelledAt = performance.now();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        event.button !== 1 ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey ||
        !acceptsAutoscroll(event.target)
      )
        return;
      const target = this.resolve(event, document);
      if (!target) return;
      event.preventDefault();
      const { x, y } = point(event);
      this.session = {
        target,
        x,
        y,
        pointerX: x,
        pointerY: y,
        dragged: false,
        restX: 0,
        restY: 0,
      };
      this.marker = this.root.createElement("div");
      this.marker.className = "autoscroll-marker";
      this.marker.setAttribute("aria-hidden", "true");
      this.marker.textContent =
        target.axes === "both" ? "✥" : target.axes === "horizontal" ? "↔" : "↕";
      this.marker.style.left = `${x}px`;
      this.marker.style.top = `${y}px`;
      this.root.body.append(this.marker);
      for (const doc of this.releases.keys())
        doc.documentElement?.classList.add("autoscroll-active");
      this.lastFrame = 0;
      this.frame = this.view.requestAnimationFrame(this.tick);
    };
    const move = (event: PointerEvent) => {
      if (!this.session) return;
      const { x, y } = point(event);
      this.session.pointerX = x;
      this.session.pointerY = y;
      this.session.dragged ||= Math.hypot(x - this.session.x, y - this.session.y) > 12;
    };
    const up = (event: PointerEvent) => {
      if (event.button === 1 && this.session?.dragged) this.stop();
    };
    const click = (event: MouseEvent) => {
      if (performance.now() - this.cancelledAt < 500) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!this.session) return;
      this.stop();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const visibility = () => {
      if (document.hidden) this.stop();
    };
    const style = document.createElement("style");
    style.textContent =
      ".autoscroll-active, .autoscroll-active * { cursor: all-scroll !important; }";
    document.documentElement?.append(style);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", this.stop, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("wheel", this.stop, { capture: true, passive: true });
    document.addEventListener("contextmenu", this.stop, true);
    document.addEventListener("click", click, true);
    document.addEventListener("auxclick", click, true);
    document.addEventListener("visibilitychange", visibility);
    this.releases.set(document, () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", this.stop, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("wheel", this.stop, true);
      document.removeEventListener("contextmenu", this.stop, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("auxclick", click, true);
      document.removeEventListener("visibilitychange", visibility);
      document.documentElement?.classList.remove("autoscroll-active");
      style.remove();
    });
    if (this.session) document.documentElement?.classList.add("autoscroll-active");
  }

  removeDocument(document: Document) {
    this.releases.get(document)?.();
    this.releases.delete(document);
  }

  stop = () => {
    const active = !!this.session;
    this.view.cancelAnimationFrame(this.frame);
    this.session = undefined;
    this.marker?.remove();
    this.marker = undefined;
    for (const doc of this.releases.keys())
      doc.documentElement?.classList.remove("autoscroll-active");
    if (active) this.onStop?.();
  };

  private tick = (time: number) => {
    const session = this.session;
    if (!session) return;
    // Skip suspended frames instead of jumping after the window becomes active again.
    const elapsed = this.lastFrame ? Math.min(50, time - this.lastFrame) / 1000 : 0;
    this.lastFrame = time;
    const fullX =
      session.target.axes === "vertical"
        ? 0
        : session.restX + autoscrollSpeed(session.pointerX - session.x) * elapsed;
    const fullY =
      session.target.axes === "horizontal"
        ? 0
        : session.restY + autoscrollSpeed(session.pointerY - session.y) * elapsed;
    const x = Math.trunc(fullX);
    const y = Math.trunc(fullY);
    session.restX = fullX - x;
    session.restY = fullY - y;
    if (x || y) session.target.move(x, y);
    if (this.session) this.frame = this.view.requestAnimationFrame(this.tick);
  };

  dispose() {
    this.stop();
    for (const doc of this.releases.keys()) this.removeDocument(doc);
    this.view.removeEventListener("blur", this.stop);
    this.view.removeEventListener("pagehide", this.stop);
    this.view.removeEventListener("resize", this.stop);
  }
}
