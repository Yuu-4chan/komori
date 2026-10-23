// Evaluated into the isolated Komori page over CDP; defines window.__readerReal. It only reads the
// Reader adapter and the displayed section documents and never changes the reader's behavior.
(() => {
  if (window.__readerReal) return "already";
  const R = {};
  const BLOCKS = "p,div,li,h1,h2,h3,h4,h5,h6,td,blockquote";
  const MARKER =
    /^\s*(\[[0-9]{2}-[0-9]{3}\]|〈[0-9]{2}(-[0-9]{3})?〉|Part [0-9]+|\[FXL [0-9]+( end)?\])/;

  /** The live EPUB renderer, found through the React tree of the reader viewport. */
  R.adapter = () => {
    const cached = window.__readerRealAdapter;
    if (cached && !cached.disposed && cached.host?.isConnected) return cached;
    window.__readerRealAdapter = null;
    const host = document.querySelector(".reader-viewport");
    const key = host && Object.keys(host).find((k) => k.startsWith("__reactFiber"));
    if (!key) return null;
    const seen = new Set();
    const check = (v) => {
      if (!v || typeof v !== "object" || seen.has(v)) return null;
      seen.add(v);
      return v.rendition?.manager && "turnPending" in v && !v.disposed ? v : null;
    };
    let found = null;
    for (let f = host[key]; f && !found; f = f.return) {
      for (let s = f.memoizedState; s && !found; s = s.next) {
        const m = s.memoizedState;
        found = check(m) || check(m?.current);
        if (!found && m?.current && typeof m.current === "object")
          for (const k of Object.keys(m.current)) if ((found = check(m.current[k]))) break;
      }
      if (!found && f.memoizedProps)
        for (const k of Object.keys(f.memoizedProps))
          if ((found = check(f.memoizedProps[k]))) break;
    }
    window.__readerRealAdapter = found;
    return found;
  };

  const viewport = () => document.querySelector(".reader-viewport").getBoundingClientRect();
  const views = (a) =>
    (a?.rendition?.manager?.views?._views ?? []).filter(
      (v) => v.iframe && v.contents?.document && v.iframe.style.visibility !== "hidden",
    );
  const overlaps = (r, vp) =>
    r.width > 1 &&
    r.height > 1 &&
    r.right > vp.left + 1 &&
    r.left < vp.right - 1 &&
    r.bottom > vp.top + 1 &&
    r.top < vp.bottom - 1;

  const textIndex = new WeakMap();
  const indexOf = (doc) => {
    let index = textIndex.get(doc);
    if (index) return index;
    const nodes = [];
    const starts = [];
    let total = 0;
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest("rt,rp,script,style")) continue;
      nodes.push(n);
      starts.push(total);
      total += n.data.length;
    }
    index = { nodes, starts, total, position: new Map(nodes.map((n, i) => [n, i])) };
    textIndex.set(doc, index);
    return index;
  };
  const markerOf = (node) => {
    const block = node.parentElement?.closest(BLOCKS);
    return block?.textContent?.match(MARKER)?.[1] ?? null;
  };

  /** How the first shown document is laid out. */
  R.layout = () => {
    const doc = views(R.adapter())[0]?.contents?.document;
    if (!doc) return null;
    const body = getComputedStyle(doc.body ?? doc.documentElement);
    return {
      writingMode: body.writingMode,
      direction: body.direction,
      rootFontSize: getComputedStyle(doc.documentElement).fontSize,
      paragraphWeight: doc.querySelector("p")
        ? getComputedStyle(doc.querySelector("p")).fontWeight
        : null,
      headingWeight: doc.querySelector("h1")
        ? getComputedStyle(doc.querySelector("h1")).fontWeight
        : null,
    };
  };

  /** The part of one rect inside another, or the first rect without another. */
  const clip = (r, by) => {
    if (!by) return r;
    const left = Math.max(r.left, by.left);
    const top = Math.max(r.top, by.top);
    const right = Math.max(left, Math.min(r.right, by.right));
    const bottom = Math.max(top, Math.min(r.bottom, by.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  /**
   * The first character shown in document order, sampled on a grid over the reader viewport from
   * section geometry (never hit testing), or the first image when no text is shown. Clipped, the
   * grid covers only a continuous book's scroll container, and each section only where its view
   * shows it, leaving out a section scrolled past or collapsed outside the shown chapter.
   */
  R.firstVisible = ({ clipped = false } = {}) => {
    const a = R.adapter();
    if (!a) return null;
    const vp = clipped ? clip(viewport(), a.scrollContainer?.getBoundingClientRect()) : viewport();
    const layout = R.layout() ?? { writingMode: "horizontal-tb", direction: "ltr" };
    const vertical = layout.writingMode.startsWith("vertical");
    const cols = 30;
    const rows = 30;
    const inset = 6;
    const width = vp.width - 2 * inset;
    const height = vp.height - 2 * inset;
    const points = [];
    for (let major = 0; major < (vertical ? cols : rows); major++)
      for (let minor = 0; minor < (vertical ? rows : cols); minor++) {
        if (vertical) {
          const x =
            layout.writingMode === "vertical-lr"
              ? vp.left + inset + (width * major) / (cols - 1)
              : vp.right - inset - (width * major) / (cols - 1);
          points.push([x, vp.top + inset + (height * minor) / (rows - 1)]);
        } else {
          const x =
            layout.direction === "rtl"
              ? vp.right - inset - (width * minor) / (cols - 1)
              : vp.left + inset + (width * minor) / (cols - 1);
          points.push([x, vp.top + inset + (height * major) / (rows - 1)]);
        }
      }
    const frames = views(a).map((v) => {
      const r = v.iframe.getBoundingClientRect();
      return { v, r, shown: clipped ? clip(r, v.element.getBoundingClientRect()) : r };
    });
    let media = null;
    let best = null;
    const mediaSections = new Set();
    for (const [x, y] of points) {
      const hit = frames.find(
        ({ shown }) => x >= shown.left && x < shown.right && y >= shown.top && y < shown.bottom,
      );
      if (!hit) continue;
      const doc = hit.v.contents.document;
      const lx = x - hit.r.left;
      const ly = y - hit.r.top;
      const inner = doc.elementFromPoint(lx, ly);
      if (inner && /^(img|svg|image)$/i.test(inner.tagName)) {
        mediaSections.add(hit.v.section?.index);
        if (!media || hit.v.section?.index < media.section)
          media = { section: hit.v.section?.index, tag: inner.tagName.toLowerCase() };
      }
      const caret = doc.caretRangeFromPoint?.(lx, ly);
      if (!caret || caret.startContainer.nodeType !== 3) continue;
      const node = caret.startContainer;
      const at = Math.min(caret.startOffset, node.data.length - 1);
      if (!node.data.charAt(at).trim()) continue;
      // The caret must sit on a glyph near the point, not snap from far away.
      const range = doc.createRange();
      range.setStart(node, Math.max(0, at));
      range.setEnd(node, Math.min(node.data.length, at + 1));
      const box = range.getBoundingClientRect();
      const near =
        box.width + box.height > 0 &&
        Math.abs(box.left + box.width / 2 - lx) < 60 &&
        Math.abs(box.top + box.height / 2 - ly) < 60;
      if (!near) continue;
      const index = indexOf(doc);
      const i = index.position.get(node);
      const hitAt = {
        section: hit.v.section?.index,
        offset: i === undefined ? -1 : index.starts[i] + at,
        total: index.total,
        marker: markerOf(node),
      };
      if (
        !best ||
        hitAt.section < best.section ||
        (hitAt.section === best.section && hitAt.offset < best.offset)
      )
        best = hitAt;
    }
    if (best) return { ...best, media, mediaSections: [...mediaSections] };
    return media
      ? {
          section: media.section,
          offset: null,
          marker: null,
          media,
          mediaSections: [...mediaSections],
        }
      : null;
  };

  /** Whether the character at `offset` of section `section` is inside the reader viewport. */
  R.pointVisible = (section, offset) => {
    const view = views(R.adapter()).find((v) => v.section?.index === section);
    if (!view) return false;
    const doc = view.contents.document;
    const index = indexOf(doc);
    let lo = 0;
    let hi = index.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const node = index.nodes[lo];
    if (!node) return false;
    const at = Math.max(0, Math.min(node.data.length - 1, offset - index.starts[lo]));
    const range = doc.createRange();
    range.setStart(node, at);
    range.setEnd(node, Math.min(node.data.length, at + 1));
    const box = range.getBoundingClientRect();
    const frame = view.iframe.getBoundingClientRect();
    return overlaps(
      new DOMRect(
        box.left + frame.left,
        box.top + frame.top,
        Math.max(box.width, 2),
        Math.max(box.height, 2),
      ),
      viewport(),
    );
  };

  /**
   * Each displayed image labelled `label` (an img's alt or an svg's aria-label) in spine section
   * `index`: its box in the window, and the boxes that show it, the reading area's host and its
   * section's iframe.
   */
  R.imageBoxes = (label, index) => {
    const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const host = document.querySelector(".reader-viewport__host")?.getBoundingClientRect();
    const found = [];
    for (const view of views(R.adapter())) {
      if (view.section?.index !== index) continue;
      const frame = view.iframe.getBoundingClientRect();
      const doc = view.contents.document;
      for (const image of doc.querySelectorAll(`img[alt="${label}"], svg[aria-label="${label}"]`)) {
        const r = image.getBoundingClientRect();
        found.push({
          image: box(new DOMRect(r.left + frame.left, r.top + frame.top, r.width, r.height)),
          frame: box(frame),
          host: host ? box(host) : null,
          body: doc.body.getBoundingClientRect().width,
        });
      }
    }
    return found;
  };

  /**
   * Paints two characters of the first displayed paragraph as a pointer lookup's match, as the
   * Reader does once a lookup finds them, then selects the same characters, and returns each
   * paint's marks (box and color) and whether clearing the match removed its own.
   */
  R.lookupPaint = async () => {
    const a = R.adapter();
    const doc = views(a)[0]?.contents.document;
    const text = [...(doc?.querySelectorAll("p") ?? [])]
      .map((p) => p.firstChild)
      .find((node) => node?.nodeType === Node.TEXT_NODE && node.data.includes("〉"));
    if (!text) return null;
    const range = doc.createRange();
    const start = text.data.indexOf("〉") + 1;
    range.setStart(text, start);
    range.setEnd(text, start + 2);
    const marks = (attribute) =>
      [...(doc.documentElement.querySelector(`:scope > [${attribute}]`)?.children ?? [])].map(
        (mark) => {
          const r = mark.getBoundingClientRect();
          const color = doc.defaultView.getComputedStyle(mark).backgroundColor;
          return [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " " + color;
        },
      );
    a.pointerScan = { id: -1, ranges: [range] };
    a.highlightPointerMatch(-1, 2);
    const lookup = marks("data-komori-lookup-marks");
    a.highlightPointerMatch(null);
    const cleared = !doc.documentElement.querySelector(":scope > [data-komori-lookup-marks]");
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const selected = marks("data-komori-selection-marks");
    selection.removeAllRanges();
    return { text: range.toString(), lookup, selected, cleared };
  };

  /** The markers of the paragraphs whose first character is in the reader viewport. */
  R.visibleMarkers = () => {
    const vp = viewport();
    const markers = [];
    for (const view of views(R.adapter())) {
      const frame = view.iframe.getBoundingClientRect();
      for (const block of view.contents.document.querySelectorAll("p")) {
        const marker = block.textContent.match(MARKER)?.[1];
        const text = block.firstChild;
        if (!marker || text?.nodeType !== 3) continue;
        const range = view.contents.document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const box = range.getBoundingClientRect();
        const shown = new DOMRect(
          box.left + frame.left,
          box.top + frame.top,
          box.width,
          box.height,
        );
        if (overlaps(shown, vp)) markers.push(marker);
      }
    }
    return markers;
  };

  /** The character the published locator names: its section and text offset. */
  R.publishedPoint = () => {
    const a = R.adapter();
    const published = a?.published;
    const view = views(a).find((v) => v.section?.index === published?.spineIndex);
    if (!view) return null;
    const total = indexOf(view.contents.document).total;
    return {
      section: published.spineIndex,
      offset: Math.min(total - 1, Math.round(published.progress * total)),
    };
  };

  R.state = () => {
    const a = R.adapter();
    const vp = document.querySelector(".reader-viewport") ? viewport() : null;
    return {
      path: location.pathname,
      adapter: !!a,
      ready: !!a?.ready,
      busy: !!(a?.turnPending || a?.layoutPending),
      published: a?.published ? { ...a.published } : null,
      fixedLayout: a?.fixedLayout ?? null,
      continuous: a?.continuous ?? null,
      shown:
        a && vp ? views(a).filter((v) => overlaps(v.iframe.getBoundingClientRect(), vp)).length : 0,
      error:
        document.querySelector(".reader-status, [role=alert]")?.textContent?.slice(0, 120) ?? null,
    };
  };

  const signature = () => {
    const a = R.adapter();
    const c = a?.rendition?.manager?.container;
    const s = a?.scrollContainer;
    return JSON.stringify([
      a?.published,
      c && [Math.round(c.scrollLeft), Math.round(c.scrollTop)],
      s && [Math.round(s.scrollLeft), Math.round(s.scrollTop)],
      views(a).map((v) => {
        const r = v.iframe.getBoundingClientRect();
        return [
          v.section?.index,
          Math.round(r.x),
          Math.round(r.y),
          Math.round(r.width),
          Math.round(r.height),
        ];
      }),
    ]);
  };

  /** Resolves once the Reader is ready, not busy and unchanged for `quiet` ms. */
  R.settle = ({ quiet = 400, timeout = 20000 } = {}) =>
    new Promise((resolve) => {
      const started = performance.now();
      let last = signature();
      let since = started;
      const tick = () => {
        const now = performance.now();
        const a = R.adapter();
        const current = signature();
        if (current !== last || !a?.ready || a.turnPending || a.layoutPending) {
          if (current !== last) last = current;
          since = now;
        }
        if (a?.ready && now - since >= quiet)
          return resolve({ settled: true, ms: Math.round(now - started) });
        if (now - started > timeout)
          return resolve({ settled: false, ms: Math.round(now - started), state: R.state() });
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });

  /** Resolves once nothing has moved for `quiet` ms, busy or not. */
  R.still = (quiet = 80) =>
    new Promise((resolve) => {
      let last = signature();
      let since = performance.now();
      const tick = () => {
        const current = signature();
        if (current !== last) {
          last = current;
          since = performance.now();
        }
        if (performance.now() - since >= quiet) resolve(true);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** Opens a book the way the Library does, through the router. */
  R.open = (bookId) => {
    window.__readerRealAdapter = null;
    history.pushState({}, "", `/reader/${bookId}`);
    dispatchEvent(new PopStateEvent("popstate"));
    return true;
  };

  R.focus = () => {
    document.querySelector(".reader-viewport")?.focus({ preventScroll: true });
    return true;
  };

  window.__readerReal = R;
  return "installed";
})();
