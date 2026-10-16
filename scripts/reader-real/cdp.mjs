// Chrome DevTools Protocol client for the isolated Komori build: evaluation, Tauri commands,
// protocol events and synthetic key and wheel input sent to the page only.
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const keyCodes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27 };

export async function connect(port, { timeoutMs = 60000 } = {}) {
  const until = Date.now() + timeoutMs;
  let page;
  while (!page) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      page = pages.find((p) => p.type === "page" && p.title === "Komori");
    } catch {
      // The webview has not opened its debugging port yet.
    }
    if (!page) {
      if (Date.now() > until) throw new Error("The Komori page never appeared over CDP.");
      await delay(250);
    }
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const reply = JSON.parse(event.data);
    if (reply.id && pending.has(reply.id)) {
      pending.get(reply.id)(reply);
      pending.delete(reply.id);
    } else if (reply.method) {
      for (const listener of listeners) listener(reply.method, reply.params);
    }
  };
  /** Calls `listener(method, params)` for every protocol event; returns its removal. */
  const on = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve({ error: { message: "socket closed" } });
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.error || reply.result?.exceptionDetails)
      throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 1500));
    return reply.result.result.value;
  };
  const invoke = (command, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
  async function key(name) {
    const windowsVirtualKeyCode = keyCodes[name];
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode });
  }
  async function wheel(x, y, deltaY) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  }
  return { send, on, evaluate, invoke, key, wheel, close: () => socket.close() };
}
