import { describe, expect, it } from "vitest";

import {
  acceptsReaderInput,
  arrowScrollDistance,
  revealsVnText,
  arrowTurn,
  pageKey,
  isWheelStep,
  normalizeWheelStep,
  WheelStepCounter,
  wheelSteps,
  wholeWheelSteps,
  WheelNavigationQueue,
  isChapterWheelThreshold,
} from "./navigationInput";

describe("Reader input", () => {
  it("only authorizes one crossing from fresh settled-edge input in either direction", () => {
    const queue = new WheelNavigationQueue(3);
    queue.add(8, false, false, 10);
    expect(queue.take(false)).toBe(1);
    // All remaining input came before the edge, including input during arrival.
    expect(queue.take(true)).toBe(0);
    queue.add(8, true, true, 20);
    expect(queue.take(true)).toBe(0);
    queue.add(1, true, false, 30);
    queue.add(1, true, false, 40);
    expect(queue.take(true)).toBe(0);
    queue.add(8, true, false, 50);
    expect(queue.take(true)).toBe(1);
    expect(queue.take(true)).toBe(0);
    queue.add(-1, true, false, 60);
    queue.add(-1, true, false, 70);
    expect(queue.take(true)).toBe(0);
    queue.add(-1, true, false, 80);
    expect(queue.take(true)).toBe(-1);
  });

  it("accumulates fine edge movement and resets on reversal, idle gaps and lifecycle reset", () => {
    const queue = new WheelNavigationQueue(2);
    for (let i = 0; i < 6; i++) queue.add(0.3, true, false, i * 10);
    expect(queue.take(true)).toBe(0);
    queue.add(-0.1, true, false, 70);
    queue.add(0.3, true, false, 80);
    expect(queue.take(true)).toBe(0);
    queue.add(1, true, false, 900);
    expect(queue.take(true)).toBe(0);
    queue.reset();
    queue.add(1, true, false, 910);
    expect(queue.take(true)).toBe(0);
    queue.add(1, true, false, 920);
    expect(queue.take(true)).toBe(1);
    queue.add(3, false, false, 930);
    queue.add(-0.1, false, true, 940);
    expect(queue.take(false)).toBe(0);
    for (const value of [1, 3, 20]) expect(isChapterWheelThreshold(value)).toBe(true);
    for (const value of [0, 21, 1.5, NaN, "3", null])
      expect(isChapterWheelThreshold(value)).toBe(false);
  });
  it("maps physical arrows using adapter-normalized progression", () => {
    expect(arrowTurn("ArrowRight", "ArrowRight")).toBe("advance");
    expect(arrowTurn("ArrowLeft", "ArrowRight")).toBe("retreat");
    expect(arrowTurn("ArrowLeft", "ArrowLeft")).toBe("advance");
    expect(arrowTurn("ArrowRight", "ArrowLeft")).toBe("retreat");
    // Down reads on and Up goes back in either page direction.
    expect(arrowTurn("ArrowDown", "ArrowLeft")).toBe("advance");
    expect(arrowTurn("ArrowUp", "ArrowLeft")).toBe("retreat");
    expect(arrowTurn("ArrowDown", "ArrowRight")).toBe("advance");
    expect(arrowTurn("PageDown", "ArrowRight")).toBeNull();
  });

  it("turns a whole page with Page Down, Page Up, Space and Shift+Space", () => {
    expect(pageKey("PageDown", false)).toBe("advance");
    expect(pageKey(" ", false)).toBe("advance");
    expect(pageKey("PageUp", false)).toBe("retreat");
    expect(pageKey(" ", true)).toBe("retreat");
    expect(pageKey("PageDown", true)).toBeNull();
    expect(pageKey("ArrowDown", false)).toBeNull();
    expect(pageKey("Home", false)).toBeNull();
  });

  it("moves one tenth of the reading area for each continuous arrow", () => {
    expect(arrowScrollDistance(900)).toBe(90);
    expect(arrowScrollDistance(200)).toBe(40);
  });

  it("measures wheel movement in wheel steps", () => {
    expect(wheelSteps(100, 0)).toBe(1);
    expect(wheelSteps(-250, 0)).toBe(-2.5);
    expect(wheelSteps(3, 1)).toBe(1);
    expect(wheelSteps(1, 2)).toBe(1);
    expect(wheelSteps(Number.NaN, 0)).toBe(0);
    // A mouse wheel step is whole, even when a display scale makes it a little more.
    expect(wholeWheelSteps(1)).toBe(1);
    expect(wholeWheelSteps(1.25)).toBe(1);
    expect(wholeWheelSteps(-1.5)).toBe(-1);
    expect(wholeWheelSteps(2)).toBe(2);
    expect(wholeWheelSteps(0.6)).toBe(1);
    expect(wholeWheelSteps(0.2)).toBeNull();
  });

  it("turns one page per wheel step, and per whole step of finer movement", () => {
    const counter = new WheelStepCounter();
    // Three quick mouse wheel steps are three pages, at any display scale.
    expect([1, 1, 1].map((steps) => counter.consume(steps))).toEqual([1, 1, 1]);
    expect([1.25, 1.25, 1.25, 1.25].map((steps) => counter.consume(steps))).toEqual([1, 1, 1, 1]);
    expect(counter.consume(-1)).toBe(-1);
    expect(counter.consume(2)).toBe(2);
    // A touchpad's small movements turn once a whole step has built up.
    counter.reset();
    expect([0.3, 0.3, 0.3].map((steps) => counter.consume(steps))).toEqual([0, 0, 0]);
    expect(counter.consume(0.3)).toBe(1);
    expect(counter.consume(0.3)).toBe(0);
    // Turning back starts the count again.
    expect(counter.consume(-0.4)).toBe(0);
    expect(counter.consume(-0.4)).toBe(0);
    expect(counter.consume(-0.4)).toBe(-1);
    expect(counter.consume(0)).toBe(0);
  });

  it("keeps a wheel step within range on its step", () => {
    expect(normalizeWheelStep(125)).toBe(130);
    expect(normalizeWheelStep(1)).toBe(10);
    expect(normalizeWheelStep(9000)).toBe(2000);
    expect(normalizeWheelStep("x")).toBe(100);
    for (const step of [10, 100, 2000]) expect(isWheelStep(step)).toBe(true);
    for (const step of [0, 5, 105, 2010, "100", null]) expect(isWheelStep(step)).toBe(false);
  });

  it("excludes controls, sidebar, dialogs and scrollable panels", () => {
    const viewport = document.createElement("main");
    viewport.className = "reader-viewport";
    const page = document.createElement("div");
    viewport.append(page);
    const button = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    Object.defineProperties(panel, { scrollHeight: { value: 300 }, clientHeight: { value: 100 } });
    page.append(button, dialog, input, editor, panel);
    expect(acceptsReaderInput(page)).toBe(true);
    for (const target of [button, dialog, input, editor, panel]) {
      expect(acceptsReaderInput(target)).toBe(false);
    }
    expect(acceptsReaderInput(document.createElement("aside"))).toBe(false);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignBody = iframe.contentDocument!.body;
    expect(acceptsReaderInput(foreignBody, true)).toBe(true);
    iframe.remove();
  });
});

describe("VN reveal by Space", () => {
  it("works from the book and the Reader but never from controls or dialogs", () => {
    document.body.innerHTML = `
      <main class="reader-viewport"><p id="text">text</p></main>
      <aside class="reader-sidebar reader-sidebar--shown"><input id="field" /><button id="button"></button></aside>
      <div role="dialog"><p id="popup">popup</p></div>`;
    const at = (id: string) => document.getElementById(id);
    expect(revealsVnText(document.body)).toBe(true);
    expect(revealsVnText(at("text"))).toBe(true);
    expect(revealsVnText(at("field"))).toBe(false);
    expect(revealsVnText(at("button"))).toBe(false);
    expect(revealsVnText(at("popup"))).toBe(false);
    document.body.innerHTML = "";
  });
});
