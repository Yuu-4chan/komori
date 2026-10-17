// Real-engine Reader smoke test: builds Komori under its own identifier (so its library, settings
// and WebView data live apart from the real ones), imports synthetic EPUBs and drives the Reader
// over CDP, asserting reading points (first visible character or section, the saved locator),
// never pixels. It also checks the built WebView's effective CSP and that the updater refuses
// installers not signed by the release key. Windows only.
// `pnpm test:reader-real [--no-build] [--only <name>]`.
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { connect, delay } from "./cdp.mjs";
import { writeBooks, writeDropFiles } from "./books.mjs";

const IDENTIFIER = "app.komori.readerreal.test";
const LIVE_IDENTIFIER = "app.komori.reader";
const WIDTH = 1456;
const HEIGHT = 909;
// WebView2's debugging port and arguments, given both through Tauri's own option (built into
// this build's window config) and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so neither is relied on.
const port = 47652;
const browserArgs = [
  `--remote-debugging-port=${port}`,
  // Tauri's defaults (replaced by any arguments given), plus occlusion that would pause the page.
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
].join(" ");
const root = process.cwd();
const here = join(root, "scripts", "reader-real");
const targetDir = join(root, "src-tauri", "target", "reader-real");
const exe = process.env.KOMORI_READER_REAL_EXE ?? join(targetDir, "release", "komori.exe");
const dataDir = join(process.env.APPDATA, IDENTIFIER);
// A fresh WebView data folder per run: a WebView2 process can hold the last one for a while.
const webviewRoot = join(tmpdir(), "komori-reader-real-webview");
const webviewDir = join(webviewRoot, String(Date.now()));
const liveStore = join(process.env.APPDATA, LIVE_IDENTIFIER, "library.sqlite3");
const booksDir = join(tmpdir(), "komori-reader-real-books");
const dropDir = join(tmpdir(), "komori-reader-real-drop");
const reportDir = join(root, "artifacts", "validation", "reader-real");
// Komori's own stdout and stderr (a panic, a WebView2 error) across this run's launches.
const appLog = join(reportDir, "app.log");
const probe = readFileSync(join(here, "probe.js"), "utf8");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

if (process.platform !== "win32") {
  console.error("The real-engine Reader smoke test runs on Windows only.");
  process.exit(1);
}

const stamp = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);
const liveBefore = [stamp(liveStore), stamp(`${liveStore}-wal`)];

// ---------- build ----------
if (!args.includes("--no-build") || !existsSync(exe)) {
  console.log(`Building Komori as ${IDENTIFIER} into ${targetDir} ...`);
  // The main window as configured, with the debugging port; arrays are replaced, not merged.
  const config = JSON.parse(readFileSync(join(here, "tauri.conf.json"), "utf8"));
  const { windows } = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ).app;
  config.app = { windows: windows.map((w) => ({ ...w, additionalBrowserArgs: browserArgs })) };
  mkdirSync(targetDir, { recursive: true });
  const configFile = join(targetDir, "reader-real.conf.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  execFileSync(
    process.execPath,
    ["scripts/tauri.mjs", "build", "--no-bundle", "--config", configFile],
    { stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: targetDir } },
  );
}

// ---------- isolated data ----------
if (!resolve(dataDir).endsWith(IDENTIFIER) || IDENTIFIER === LIVE_IDENTIFIER)
  throw new Error(`Refusing to clear ${dataDir}.`);
rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
rmSync(appLog, { force: true });
for (const old of existsSync(webviewRoot) ? readdirSync(webviewRoot) : [])
  try {
    rmSync(join(webviewRoot, old), { recursive: true, force: true });
  } catch {
    // Still held by an exiting WebView2 process; a later run removes it.
  }
rmSync(booksDir, { recursive: true, force: true });
const books = writeBooks(booksDir);
rmSync(dropDir, { recursive: true, force: true });
const dropFiles = writeDropFiles(dropDir);

// ---------- app lifecycle ----------
let windowControl;
function windows() {
  if (windowControl) return windowControl;
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "window.ps1")],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (data) => {
    buffer += data.toString();
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1))
      waiters.shift()?.(buffer.slice(0, i).trim());
  });
  const ready = new Promise((r) => waiters.push(r));
  windowControl = {
    command: async (line) => {
      await ready;
      const reply = new Promise((r) => waiters.push(r));
      child.stdin.write(`${line}\n`);
      return reply;
    },
    quit: () => child.stdin.end("quit\n"),
  };
  return windowControl;
}

let app;
let cdp;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const appEnv = () => ({
  ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: webviewDir,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
});

/** The installed WebView2 Runtime and its running processes, for a page that never appeared. */
function webviewDiagnostics(pid) {
  const script = [
    "$key = 'SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'",
    "$versions = @(foreach ($hive in 'HKLM:', 'HKCU:') { (Get-ItemProperty \"$hive\\$key\" -ErrorAction SilentlyContinue).pv }) | Where-Object { $_ }",
    "'WebView2 Runtime: ' + $(if ($versions) { $versions -join ', ' } else { 'not found' })",
    "$processes = @(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\")",
    "'WebView2 processes: ' + $processes.Count",
    `'Komori process: ${pid}'`,
    "$processes | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { '  browser ' + $_.ProcessId + ', parent ' + $_.ParentProcessId + ', debugging port flag: ' + ($_.CommandLine -match '--remote-debugging-port') + ', data: ' + $(if ($_.CommandLine -match '--user-data-dir=(\"[^\"]+\"|\\S+)') { $Matches[1] } else { '?' }) }",
  ].join("\n");
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 30000,
    }).trimEnd();
  } catch (error) {
    return `WebView2 diagnostics failed: ${error.message}`;
  }
}

let launchedAt = 0;
async function launch() {
  launchedAt = Date.now();
  mkdirSync(reportDir, { recursive: true });
  const log = openSync(appLog, "a");
  app = spawn(exe, [], { detached: true, stdio: ["ignore", log, log], env: appEnv() });
  closeSync(log);
  let exited = null;
  app.on("exit", (code, signal) => (exited = signal ?? `code ${code}`));
  app.unref();
  const placed = await windows().command(`place ${app.pid} ${WIDTH} ${HEIGHT}`);
  try {
    // A cold machine can take long to start WebView2 the first time; say when it does.
    cdp = await connect(port, { timeoutMs: 180000 });
    const seconds = Math.round((Date.now() - launchedAt) / 1000);
    if (seconds > 30) console.log(`  Komori's page took ${seconds} s to appear over CDP.`);
  } catch (error) {
    // Say why: no window, an exit (a panic is in the log), or a webview without its page.
    const targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((pages) => pages.map((p) => `${p.type} "${p.title}"`).join(", ") || "none")
      .catch(() => "port closed");
    const tail = existsSync(appLog)
      ? readFileSync(appLog, "utf8").trimEnd().split("\n").slice(-20).join("\n")
      : "";
    throw new Error(
      `${error.message} Window: ${placed}. Process: ${exited ? `exited, ${exited}` : "running"}. ` +
        `CDP targets: ${targets}.${tail ? `\nApp output:\n${tail}` : " No app output."}\n` +
        webviewDiagnostics(app.pid),
    );
  }
  for (let i = 0; i < 150; i++) {
    const loaded = await cdp
      .evaluate(`document.readyState === "complete" && !!window.__TAURI_INTERNALS__`)
      .catch(() => false);
    if (loaded) break;
    await delay(200);
  }
  await cdp.evaluate(probe);
}

async function closeApp() {
  const pid = app.pid;
  cdp?.close();
  await windows().command(`close ${pid}`);
  for (let i = 0; i < 150 && alive(pid); i++) await delay(100);
  if (alive(pid)) {
    process.kill(pid);
    throw new Error("Komori did not exit after its window was closed.");
  }
  // WebView2 releases its user data folder a moment after the app exits.
  await delay(1500);
}

// ---------- reader helpers ----------
const evaluate = (expression) => cdp.evaluate(expression);
const state = () => evaluate("__readerReal.state()");
const firstVisible = () => evaluate("__readerReal.firstVisible()");
const settle = (timeout = 20000) => evaluate(`__readerReal.settle({ timeout: ${timeout} })`);
const pointVisible = (point) =>
  evaluate(`__readerReal.pointVisible(${point.section}, ${point.offset})`);
const layout = () => evaluate("__readerReal.layout()");
const publishedPoint = () => evaluate("__readerReal.publishedPoint()");

async function setPreferences(patch) {
  const saved = await cdp.invoke("get_appearance_preferences");
  await cdp.invoke("save_appearance_preferences", { preferences: { ...saved, ...patch } });
  await evaluate("location.href = '/library'; true").catch(() => {});
  await delay(500);
  for (let i = 0; i < 100; i++) {
    const loaded = await evaluate(
      `document.readyState === "complete" && !!document.querySelector("main")`,
    ).catch(() => false);
    if (loaded) break;
    await delay(200);
  }
  await evaluate(probe);
}

const bookId = {};
// No writing mode is chosen, so each book keeps its own.
const DEFAULTS = {
  readerViewMode: "paginated",
  readerWritingMode: undefined,
  readerFontSize: 16,
};

/** Opens `book` with these preferences and waits until the Reader settles there. */
async function open(book, patch = {}) {
  // Every scenario starts at the beginning of the book, whatever an earlier one saved.
  await cdp.invoke("save_reading_position", {
    id: bookId[book],
    position: { spineIndex: 0, sectionKey: null, progress: 0 },
  });
  await setPreferences({ ...DEFAULTS, ...patch });
  await evaluate(`__readerReal.open(${JSON.stringify(bookId[book])})`);
  return reopened();
}

async function reopened() {
  for (let i = 0; i < 150 && !(await state()).adapter; i++) await delay(100);
  const settled = await settle(30000);
  await evaluate("__readerReal.focus()");
  return { settled, state: await state(), first: await firstVisible() };
}

/** Sends `key` and waits for the Reader to settle. */
async function press(key) {
  await cdp.key(key);
  await settle();
  return firstVisible();
}

async function scroll(deltaY, times = 1) {
  const center = await evaluate(
    `(() => { const r = document.querySelector(".reader-viewport").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  for (let i = 0; i < times; i++) {
    await cdp.wheel(center.x, center.y, deltaY);
    await delay(120);
  }
}

/** Waits for the saved reading position to equal the published one. */
async function savedMatchesPublished(book, timeout = 6000) {
  let saved;
  let published;
  for (const until = Date.now() + timeout; Date.now() < until; await delay(200)) {
    published = (await state()).published;
    saved = await cdp.invoke("get_reading_position", { id: bookId[book] });
    if (
      saved &&
      published &&
      saved.spineIndex === published.spineIndex &&
      Math.abs(saved.progress - published.progress) < 1e-9
    )
      return { ok: true, saved, published };
  }
  return { ok: false, saved, published };
}

const after = (a, b) =>
  !!a && !!b && (a.section > b.section || (a.section === b.section && a.offset > b.offset));
const at = (p) => (p ? `${p.section}:${p.offset}${p.marker ? ` ${p.marker}` : ""}` : "nothing");

// ---------- assertions ----------
const results = [];
function check(scenario, name, ok, detail = "") {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${scenario}: ${name}${detail ? ` (${detail})` : ""}`);
}

const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

async function turnsForward(label, book, key, patch) {
  const opened = await open(book, patch);
  check(
    label,
    "opens settled at the start of the book",
    opened.settled.settled && opened.first?.section === 0 && opened.first.offset < 40,
    at(opened.first),
  );
  let previous = opened.first;
  let advanced = true;
  for (let i = 0; i < 3; i++) {
    const next = await press(key);
    if (!after(next, previous)) advanced = false;
    previous = next;
  }
  check(
    label,
    `${key} moves the first visible character forward three times`,
    advanced,
    at(previous),
  );
  const saved = await savedMatchesPublished(book);
  check(label, "saves the published locator", saved.ok, JSON.stringify(saved.published));
  return previous;
}

async function scrollsForward(label, book, patch) {
  const opened = await open(book, patch);
  check(
    label,
    "opens settled at the start of the book",
    opened.settled.settled && opened.first?.section === 0 && opened.first.offset < 40,
    at(opened.first),
  );
  await scroll(500, 4);
  await settle();
  const next = await firstVisible();
  check(
    label,
    "the wheel moves the first visible character forward",
    after(next, opened.first),
    at(next),
  );
  const saved = await savedMatchesPublished(book);
  check(label, "saves the published locator", saved.ok, JSON.stringify(saved.published));
}

scenario("paginated-horizontal", () =>
  turnsForward("paginated horizontal", "S05-flow-paginated", "ArrowRight"),
);
scenario("continuous-horizontal", () =>
  scrollsForward("continuous horizontal", "S05-flow-paginated", { readerViewMode: "continuous" }),
);
scenario("paginated-vertical-rl", async () => {
  await turnsForward("paginated vertical-rl", "S11-vertical-rl-markers", "ArrowLeft", {
    readerWritingMode: "vertical",
  });
  check(
    "paginated vertical-rl",
    "lays the book out vertical-rl",
    (await layout())?.writingMode === "vertical-rl",
  );
});
// The Reader's writing mode always applies: a book declaring vertical-lr reads vertical-rl when
// Vertical is chosen and horizontally otherwise.
scenario("declared-vertical-lr", async () => {
  await turnsForward("declared vertical-lr, Vertical", "S11lr-vertical-lr-markers", "ArrowLeft", {
    readerWritingMode: "vertical",
  });
  check(
    "declared vertical-lr, Vertical",
    "lays the book out vertical-rl",
    (await layout())?.writingMode === "vertical-rl",
  );
  await turnsForward(
    "declared vertical-lr, Horizontal",
    "S11lr-vertical-lr-markers",
    "ArrowRight",
    {
      readerWritingMode: "horizontal",
    },
  );
  check(
    "declared vertical-lr, Horizontal",
    "lays the book out horizontally",
    (await layout())?.writingMode === "horizontal-tb",
  );
});
scenario("continuous-vertical", async () => {
  await scrollsForward("continuous vertical-rl", "S11-vertical-rl-markers", {
    readerViewMode: "continuous",
    readerWritingMode: "vertical",
  });
  check(
    "continuous vertical-rl",
    "lays the book out vertical-rl",
    (await layout())?.writingMode === "vertical-rl",
  );
});
scenario("paginated-chosen-vertical", async () => {
  await turnsForward("paginated chosen vertical", "S05-flow-paginated", "ArrowLeft", {
    readerWritingMode: "vertical",
  });
  check(
    "paginated chosen vertical",
    "lays the book out vertical-rl",
    (await layout())?.writingMode === "vertical-rl",
  );
});
// Paginated pages a reflowable book whatever rendition:flow it declares: each of the
// first two sections takes several pages and shows every marker paragraph.
scenario("authored-flow", async () => {
  for (const book of [
    "S03-flow-scrolled-doc",
    "S04-flow-scrolled-continuous",
    "S05-flow-paginated",
  ]) {
    const label = `authored flow ${book.slice(0, 3)}`;
    const opened = await open(book);
    check(
      label,
      "opens settled at the start under Paginated",
      opened.settled.settled && opened.first?.section === 0,
      at(opened.first),
    );
    const pages = [1, 0];
    const markers = new Set(await evaluate("__readerReal.visibleMarkers()"));
    let first = opened.first;
    for (let i = 0; i < 40 && first?.section < 2; i++) {
      first = await press("ArrowRight");
      if (first?.section < 2) pages[first.section]++;
      for (const marker of await evaluate("__readerReal.visibleMarkers()")) markers.add(marker);
    }
    const missing = [0, 1].flatMap((section) =>
      Array.from({ length: 30 }, (_, p) => `[0${section}-${String(p).padStart(3, "0")}]`).filter(
        (marker) => !markers.has(marker),
      ),
    );
    check(
      label,
      "pages each of the first two sections at least three times",
      pages.every((n) => n >= 3),
      `pages ${pages.join("/")}`,
    );
    check(
      label,
      "shows every marker paragraph of both sections",
      missing.length === 0,
      `${60 - missing.length}/60 shown`,
    );
  }
});
scenario("toc-fragments", async () => {
  for (const book of ["S08a-toc-missing-fragment", "S08b-toc-mixed-fragments"]) {
    const opened = await open(book);
    check(
      `toc fragments ${book.slice(0, 4)}`,
      "opens settled at the start",
      opened.settled.settled && opened.first?.section === 0,
      at(opened.first),
    );
  }
});

async function crossImages(label, patch, forward, { imageOnly = true } = {}) {
  const opened = await open("S07-adjacent-images", patch);
  check(label, "opens at the first section", opened.first?.section === 0, at(opened.first));
  const seen = new Set([0]);
  let media = false;
  let stuck = 0;
  let last = opened.state.published;
  for (let i = 0; i < 60 && !seen.has(3); i++) {
    await forward();
    const first = await firstVisible();
    const now = (await state()).published;
    for (const section of [first?.section, ...(first?.mediaSections ?? [])])
      if (section !== undefined && section !== null) seen.add(section);
    if (first?.mediaSections?.includes(2)) media = true;
    stuck = JSON.stringify(now) === JSON.stringify(last) ? stuck + 1 : 0;
    last = now;
    if (stuck >= 3) break;
  }
  if (!imageOnly) {
    check(
      label,
      "crosses the image-ending section into the text after it",
      seen.has(1) && seen.has(3) && stuck < 3,
      [...seen].join(","),
    );
    return;
  }
  check(
    label,
    "crosses the image-ending and image-only sections into the text after them",
    seen.has(1) && seen.has(2) && seen.has(3) && stuck < 3,
    [...seen].join(","),
  );
  check(label, "shows the image-only section's images", media);
}

scenario("image-crossings-paginated", async () => {
  await crossImages("image crossings paginated", {}, () => press("ArrowRight"));
  const back = await press("ArrowLeft");
  const { published } = await state();
  check(
    "image crossings paginated",
    "ArrowLeft from the text after them returns to the image-only section",
    published?.spineIndex === 2 && !!back?.media,
    `${published?.spineIndex} ${at(back)}`,
  );
});
scenario("image-crossings-continuous", () =>
  // The image-only section's images are sized in vh, which in Continuous resolves against a
  // view sized to its content, so that section lays out at zero height; only the crossing counts.
  crossImages(
    "image crossings continuous",
    { readerViewMode: "continuous" },
    async () => {
      await scroll(450, 2);
      await settle();
    },
    { imageOnly: false },
  ),
);

scenario("close-reopen", async () => {
  // Paginated: a settled page.
  const label = "close and reopen paginated";
  await open("S11-vertical-rl-markers", { readerWritingMode: "vertical" });
  for (let i = 0; i < 4; i++) await press("ArrowLeft");
  const before = await firstVisible();
  const saved = await savedMatchesPublished("S11-vertical-rl-markers");
  check(label, "saves the published locator before closing", saved.ok);
  await closeApp();
  await launch();
  await evaluate(`__readerReal.open(${JSON.stringify(bookId["S11-vertical-rl-markers"])})`);
  const restored = await reopened();
  check(
    label,
    "reopens with the same first visible character",
    restored.first?.section === before.section && restored.first.offset === before.offset,
    `${at(before)} -> ${at(restored.first)}`,
  );
  const kept = await cdp.invoke("get_reading_position", {
    id: bookId["S11-vertical-rl-markers"],
  });
  check(
    label,
    "keeps the saved locator after reopening",
    kept?.spineIndex === saved.saved?.spineIndex &&
      Math.abs(kept.progress - saved.saved.progress) < 1e-9,
    `${JSON.stringify(saved.saved)} -> ${JSON.stringify(kept)}`,
  );

  // Continuous: closed right after a scroll stops, before its settle debounce.
  const continuous = "close and reopen continuous";
  const opened = await open("S05-flow-paginated", { readerViewMode: "continuous" });
  await scroll(500, 6);
  // Closed as soon as the scroll stops, inside the 250 ms settle debounce.
  await evaluate("__readerReal.still()");
  const point = await firstVisible();
  check(continuous, "the scroll moved the reading point", after(point, opened.first), at(point));
  await closeApp();
  await launch();
  await evaluate(`__readerReal.open(${JSON.stringify(bookId["S05-flow-paginated"])})`);
  const back = await reopened();
  // Within a few lines: the Reader's own first visible point may be a partly shown line apart.
  check(
    continuous,
    "reopens where the scroll stopped",
    back.first?.section === point.section && Math.abs(back.first.offset - point.offset) <= 400,
    `${at(point)} -> ${at(back.first)}`,
  );
});

async function resizeKeepsPoint(label, patch, move) {
  await open("S05-flow-paginated", patch);
  await move();
  await settle();
  const published = (await state()).published;
  const point = await publishedPoint();
  let kept = true;
  let lost = "";
  let settledAll = true;
  for (const [width, height] of [
    [1100, 760],
    [1500, 980],
    [WIDTH, HEIGHT],
  ]) {
    await windows().command(`size ${app.pid} ${width} ${height}`);
    await delay(150);
    const settled = await settle();
    if (!settled.settled) settledAll = false;
    const now = (await state()).published;
    const shown = await pointVisible(point);
    // A rewrapped line may begin a little earlier; the point must never move forward.
    const forward =
      !now || now.spineIndex !== published.spineIndex || now.progress > published.progress + 1e-9;
    if (kept && (forward || !shown)) {
      kept = false;
      lost = ` at ${width}x${height}: ${JSON.stringify(now)}, shown ${shown}`;
    }
  }
  check(
    label,
    "each resize settles and the reader is not left busy",
    settledAll && !(await state()).busy,
  );
  check(
    label,
    "never moves the published locator forward and keeps its character shown",
    kept,
    `${JSON.stringify(published)} ${at(point)}${lost}`,
  );
  const saved = await savedMatchesPublished("S05-flow-paginated");
  check(label, "saves the published locator", saved.ok);
}

scenario("resize-continuous", () =>
  resizeKeepsPoint("resize continuous", { readerViewMode: "continuous" }, () => scroll(500, 6)),
);
scenario("resize-semi-continuous", () =>
  resizeKeepsPoint("resize semi-continuous", { readerViewMode: "semi-continuous" }, () =>
    scroll(500, 6),
  ),
);
scenario("resize-paginated", () =>
  resizeKeepsPoint("resize paginated", {}, async () => {
    for (let i = 0; i < 4; i++) await press("ArrowRight");
  }),
);

scenario("rtl-documents", async () => {
  await turnsForward("rtl paginated horizontal", "S09-rtl-arabic-script", "ArrowLeft");
  const vertical = await open("S09-rtl-arabic-script", { readerWritingMode: "vertical" });
  check(
    "rtl paginated vertical",
    "opens settled with text shown",
    vertical.settled.settled &&
      vertical.state.shown > 0 &&
      vertical.first?.section === 0 &&
      vertical.first.offset !== null,
    at(vertical.first),
  );
});

scenario("fixed-layout", async () => {
  for (const book of ["S01-fxl-prepaginated", "S02-fxl-legacy-ibooks"]) {
    const label = `fixed layout ${book.slice(0, 3)}`;
    const opened = await open(book, { readerViewMode: "continuous", readerFontSize: 24 });
    check(
      label,
      "is detected as fixed layout and turns pages",
      opened.state.fixedLayout === true && opened.state.continuous === false,
    );
    check(
      label,
      "keeps the page's own root font size",
      (await layout())?.rootFontSize !== "24px",
      (await layout())?.rootFontSize,
    );
    await press("ArrowRight");
    const { published } = await state();
    check(
      label,
      "ArrowRight turns to the next page",
      published?.spineIndex >= 1,
      JSON.stringify(published),
    );
  }
});

scenario("import-cycle", async () => {
  const label = "import cycle";
  const opened = await open("S06-css-two-root-cycle");
  check(
    label,
    "opens settled",
    opened.settled.settled && opened.first?.section === 0,
    at(opened.first),
  );
  const first = await layout();
  check(
    label,
    "applies both mutually importing stylesheets",
    first?.paragraphWeight === "700" && first?.headingWeight === "900",
    JSON.stringify(first),
  );
  for (let i = 0; i < 60 && ((await state()).published?.spineIndex ?? 0) < 2; i++)
    await press("ArrowRight");
  const reversed = await layout();
  check(
    label,
    "reaches the section linking them in the other order, styled the same",
    (await state()).published?.spineIndex === 2 &&
      reversed?.paragraphWeight === "700" &&
      reversed?.headingWeight === "900",
    JSON.stringify(reversed),
  );
});

scenario("reduced-motion", async () => {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    check(
      "reduced motion",
      "the page reports reduced motion",
      await evaluate(`matchMedia("(prefers-reduced-motion: reduce)").matches`),
    );
    await turnsForward("reduced motion paginated", "S05-flow-paginated", "ArrowRight");
    await scrollsForward("reduced motion continuous", "S05-flow-paginated", {
      readerViewMode: "continuous",
    });
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

// ---------- Library drop ----------
// The browser delivers a file drop from outside the page, as WebView2 does for Explorer, with
// File objects backed by the dropped files; Komori's page hands them to native code. Explorer's
// own drag source is left to the release check.
const fileStamp = (path) => {
  const { mtimeMs, size } = statSync(path);
  return `${size} ${mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
};

async function dropOnLibrary(files) {
  await evaluate("location.href = '/library'; true").catch(() => {});
  await delay(500);
  for (let i = 0; i < 100; i++) {
    const loaded = await evaluate(
      `document.readyState === "complete" && !!document.querySelector("main")`,
    ).catch(() => false);
    if (loaded) break;
    await delay(200);
  }
  await evaluate(probe);
  const data = { items: [], files, dragOperationsMask: 1 };
  const replies = [];
  for (const type of ["dragEnter", "dragOver", "drop"])
    replies.push(await cdp.send("Input.dispatchDragEvent", { type, x: 400, y: 300, data }));
  return replies.find((reply) => reply.error)?.error;
}

async function libraryCount(title, expected, timeout = 15000) {
  let count;
  for (const end = Date.now() + timeout; Date.now() < end; await delay(250)) {
    count = (await cdp.invoke("list_library")).filter((book) => book.title === title).length;
    if (count === expected) break;
  }
  return count;
}

scenario("library-drop", async () => {
  const label = "library drop";
  const before = [fileStamp(dropFiles.book), fileStamp(dropFiles.text)];
  const error = await dropOnLibrary([dropFiles.book, dropFiles.text]);
  check(label, "the browser accepts the file drop", !error, JSON.stringify(error));
  const imported = await libraryCount(dropFiles.title, 1);
  check(label, "imports the dropped EPUB once", imported === 1, `${imported} records`);
  const library = await cdp.invoke("list_library");
  check(
    label,
    "imports nothing else from the drop",
    library.length === books.length + 1,
    `${library.length} books`,
  );
  await dropOnLibrary([dropFiles.book]);
  await delay(3000);
  const again = await libraryCount(dropFiles.title, 1, 1000);
  check(label, "dropping it again adds no second record", again === 1, `${again} records`);
  check(
    label,
    "leaves the dropped files unchanged",
    fileStamp(dropFiles.book) === before[0] && fileStamp(dropFiles.text) === before[1],
  );
});

// ---------- monitor size ----------
// Only a display scaled away from 100% tells physical and logical pixels apart.
scenario("monitor-size", async () => {
  const label = "monitor size";
  const [status, width, height, dpi] = (await windows().command(`monitor ${app.pid}`)).split(" ");
  const scale = Number(dpi) / 96;
  const size = await cdp.invoke("get_reader_monitor_size");
  check(
    label,
    `the Reader's monitor size is the monitor's in logical pixels (scale ${scale})`,
    status === "ok" &&
      Math.abs(size?.width - Number(width) / scale) < 1 &&
      Math.abs(size?.height - Number(height) / scale) < 1,
    `${width}x${height} physical at ${dpi} dpi -> ${size?.width}x${size?.height}`,
  );
});

// ---------- display scale change ----------
// Needs two monitors with different scale factors; skipped otherwise.
async function monitors() {
  const [status, ...areas] = (await windows().command("monitors")).split(" ");
  if (status !== "ok") return [];
  return areas.map((area) => {
    const [x, y, width, height, dpi] = area.split(",").map(Number);
    return { x, y, width, height, scale: dpi / 96 };
  });
}

scenario("display-scale-move", async () => {
  const label = "display scale move";
  const all = await monitors();
  const pair = all.flatMap((a) => all.filter((b) => b.scale !== a.scale).map((b) => [a, b]))[0];
  if (!pair) {
    console.log("  skip display scale move: needs two monitors with different scale factors");
    return;
  }
  await windows().command(`move ${app.pid} ${pair[0].x + 40} ${pair[0].y + 40}`);
  const book = "S11-vertical-rl-markers";
  await open(book, { readerWritingMode: "vertical" });
  for (let i = 0; i < 4; i++) await press("ArrowLeft");
  const published = (await state()).published;
  const point = await publishedPoint();
  for (const monitor of [pair[1], pair[0]]) {
    const scale = `scale ${monitor.scale}`;
    await windows().command(`move ${app.pid} ${monitor.x + 40} ${monitor.y + 40}`);
    await delay(1000);
    const settled = await settle();
    const size = await cdp.invoke("get_reader_monitor_size");
    const logical = await windows().command(`monitor ${app.pid}`);
    const [, width, height] = logical.split(" ").map(Number);
    check(
      label,
      `the Reader's monitor size follows the monitor (${scale})`,
      Math.abs(size?.width - width / monitor.scale) < 1 &&
        Math.abs(size?.height - height / monitor.scale) < 1,
      `${logical} -> ${size?.width}x${size?.height}`,
    );
    const now = (await state()).published;
    check(
      label,
      `keeps the reading point (${scale})`,
      settled.settled &&
        now?.spineIndex === published.spineIndex &&
        now.progress <= published.progress + 1e-9 &&
        (await pointVisible(point)),
      `${JSON.stringify(published)} -> ${JSON.stringify(now)}`,
    );
  }
  const saved = await savedMatchesPublished(book);
  check(label, "saves the published locator", saved.ok);
});

// ---------- built WebView security ----------
const cspDirectives = (policy) =>
  new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );

scenario("built-csp", async () => {
  const label = "built CSP";
  const configured = cspDirectives(
    JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp,
  );
  // The policy the WebView received with the application document.
  let documentHeaders;
  const off = cdp.on((method, params) => {
    if (method === "Network.responseReceived" && params.type === "Document")
      documentHeaders = params.response.headers;
  });
  await cdp.send("Network.enable");
  await evaluate("location.reload(); true").catch(() => {});
  await until(async () => documentHeaders !== undefined, 15000);
  off();
  await cdp.send("Network.disable");
  for (let i = 0; i < 100; i++) {
    const loaded = await evaluate(
      `document.readyState === "complete" && !!document.querySelector("main")`,
    ).catch(() => false);
    if (loaded) break;
    await delay(200);
  }
  await evaluate(probe);
  const header = Object.entries(documentHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === "content-security-policy",
  )?.[1];
  check(label, "the application document carries a Content-Security-Policy header", header);
  const effective = cspDirectives(header ?? "");
  // Tauri adds hashes and nonces for its own scripts and styles, and nothing else.
  const added = /^'(nonce-[^']+|sha(256|384|512)-[^']+)'$/u;
  for (const [name, sources] of configured) {
    const got = effective.get(name) ?? [];
    const missing = sources.filter((source) => !got.includes(source));
    const extra = got.filter((source) => !sources.includes(source) && !added.test(source));
    check(
      label,
      `${name} is the configured policy`,
      got.length > 0 && missing.length === 0 && extra.length === 0,
      missing.length || extra.length ? `missing ${missing} extra ${extra}` : "",
    );
  }
  const unconfigured = [...effective.keys()].filter((name) => !configured.has(name));
  check(
    label,
    "adds only script hashes and nonces",
    unconfigured.every((name) =>
      effective.get(name).every((source) => source === "'self'" || added.test(source)),
    ),
    unconfigured.map((name) => `${name} ${effective.get(name).join(" ")}`).join("; "),
  );
  // The policy is enforced: none of these reach the network or run. DevTools evaluation is
  // exempt from the eval restriction unless asked not to be.
  const reply = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: false,
    expression: `(async () => {
    const violations = [];
    const record = (event) => violations.push(event.effectiveDirective);
    document.addEventListener("securitypolicyviolation", record);
    let evaluated = false;
    try { evaluated = eval("true"); } catch {}
    const inline = document.createElement("script");
    inline.textContent = "window.__readerRealInline = true";
    document.body.append(inline);
    inline.remove();
    const fetched = await fetch("https://example.com/").then(() => true, () => false);
    const image = await new Promise((done) => {
      const img = new Image();
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = "https://example.com/komori-csp-check.png";
    });
    await new Promise((done) => setTimeout(done, 300));
    document.removeEventListener("securitypolicyviolation", record);
    return { evaluated, inline: window.__readerRealInline === true, fetched, image, violations };
  })()`,
  });
  if (reply.error || reply.result?.exceptionDetails)
    throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 800));
  const enforced = reply.result.result.value;
  check(label, "eval is refused", !enforced.evaluated);
  check(label, "an injected inline script does not run", !enforced.inline);
  check(label, "a remote fetch is refused", !enforced.fetched);
  check(label, "a remote image is refused", !enforced.image);
  check(
    label,
    "each refusal is a CSP violation",
    ["script-src", "connect-src", "img-src"].every((name) =>
      enforced.violations.some((directive) => directive.startsWith(name)),
    ),
    enforced.violations.join(" "),
  );
});

// ---------- updater signatures ----------
// This build's updater asks a local server instead of the GitHub releases and trusts the same
// key as the release build, so it must refuse every installer this server offers.
const UPDATE_PORT = 47653;

async function offerUpdate({ version, signature, payload }) {
  const server = createHttpServer((request, response) => {
    if (request.url === "/latest.json") {
      const platform = { url: `http://127.0.0.1:${UPDATE_PORT}/installer` };
      if (signature !== undefined) platform.signature = signature;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ version, platforms: { "windows-x86_64": platform } }));
    } else response.end(payload);
  });
  await new Promise((done) => server.listen(UPDATE_PORT, "127.0.0.1", done));
  try {
    const offered = await cdp.invoke("check_for_update").catch((error) => error);
    const installed = await cdp.invoke("install_update").then(
      () => "installed",
      (error) => String(error.message),
    );
    return { offered, installed };
  } finally {
    await new Promise((done) => server.close(done));
  }
}

scenario("update-signatures", async () => {
  const label = "updates";
  const configured = JSON.parse(readFileSync(join(here, "tauri.conf.json"), "utf8")).plugins.updater
    .endpoints;
  if (configured[0] !== `http://127.0.0.1:${UPDATE_PORT}/latest.json`)
    throw new Error(`The smoke build's updater endpoint is not port ${UPDATE_PORT}.`);
  // Let the automatic check after launch pass first, so it does not find these updates.
  await delay(Math.max(0, launchedAt + 7000 - Date.now()));
  const fixture = JSON.parse(
    readFileSync(join(root, "scripts", "fixtures", "update-signature.json"), "utf8"),
  );
  const pid = app.pid;
  for (const [name, offer] of [
    ["an installer signed with another key", fixture],
    ["an unsigned installer", { ...fixture, signature: "" }],
    ["an installer with no signature", { ...fixture, signature: undefined }],
  ]) {
    const { offered, installed } = await offerUpdate(offer);
    if (offered?.version) {
      check(label, `${name} is offered as ${fixture.version}`, offered.version === fixture.version);
      check(
        label,
        `${name} is refused`,
        installed.includes("failure.updateInstall"),
        installed.slice(0, 200),
      );
    } else {
      // A manifest without a signature is refused when it is read.
      check(label, `${name} is refused`, String(offered?.message).includes("failure.updateCheck"));
    }
  }
  check(label, "Komori keeps running after refusing them", alive(pid));
});

// ---------- window lifecycle ----------
// These bring the window forward (a second launch shows and focuses it), so they run last.
const windowState = async (pid) => {
  const [status, visible, iconic] = (await windows().command(`state ${pid}`)).split(" ");
  return status === "ok" ? { visible: visible === "1", iconic: iconic === "1" } : null;
};

async function until(condition, timeout) {
  for (const end = Date.now() + timeout; Date.now() < end; await delay(100))
    if (await condition()) return true;
  return condition();
}

/** Starts Komori again with the same identity; resolves its exit code, or null if it stays. */
function secondLaunch(timeout = 15000) {
  const child = spawn(exe, [], { stdio: "ignore", env: appEnv() });
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeout);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

/** Sends the native close and resolves how long the process took to exit, or null. */
async function timedClose(timeout) {
  const pid = app.pid;
  const started = Date.now();
  await windows().command(`close ${pid}`);
  const exited = await until(() => !alive(pid), timeout);
  const elapsed = Date.now() - started;
  cdp?.close();
  if (!exited) process.kill(pid);
  await delay(1500);
  return exited ? elapsed : null;
}

scenario("single-instance", async () => {
  const label = "single instance";
  const pid = app.pid;
  await evaluate("window.__readerRealFirst = true");
  const code = await secondLaunch();
  check(label, "a second launch exits", code === 0, `exit ${code}`);
  check(
    label,
    "the first instance keeps running with the same page",
    alive(pid) && (await evaluate("window.__readerRealFirst === true")),
  );
  await windows().command(`minimize ${pid}`);
  check(label, "the window is minimized", (await windowState(pid))?.iconic);
  const again = await secondLaunch();
  const restored = await until(async () => {
    const state = await windowState(pid);
    return state?.visible && !state.iconic;
  }, 5000);
  check(label, "a second launch restores the minimized window", again === 0 && restored);
  await windows().command(`place ${pid} ${WIDTH} ${HEIGHT}`);
});

scenario("close-to-tray", async () => {
  const label = "close to tray";
  const pid = app.pid;
  await cdp.invoke("save_startup_preferences", { changes: { minimizeToTray: true } });
  try {
    await evaluate("window.__readerRealPage = 'kept'");
    await windows().command(`close ${pid}`);
    const hidden = await until(async () => (await windowState(pid))?.visible === false, 8000);
    check(label, "closing hides the window and keeps Komori running", hidden && alive(pid));
    // Past the native close deadline, a hide must not turn into an exit.
    await delay(6000);
    check(label, "keeps running past the close deadline", alive(pid));
    check(
      label,
      "keeps the same page while hidden",
      (await evaluate("window.__readerRealPage")) === "kept",
    );
    const code = await secondLaunch();
    const shown = await until(async () => (await windowState(pid))?.visible, 5000);
    check(label, "a second launch exits and shows the hidden window", code === 0 && shown);
    check(
      label,
      "shows the same page again",
      (await evaluate("window.__readerRealPage")) === "kept",
    );
  } finally {
    await cdp.invoke("save_startup_preferences", { changes: { minimizeToTray: false } });
    await windows().command(`place ${pid} ${WIDTH} ${HEIGHT}`);
  }
});

scenario("close-deadline", async () => {
  const label = "close deadline";
  // The page acknowledges an ordinary close well before the native deadline.
  const acknowledged = await timedClose(15000);
  check(
    label,
    "an acknowledged close exits before the five-second deadline",
    acknowledged !== null && acknowledged < 4000,
    `${acknowledged} ms`,
  );
  await launch();
  // A page that cannot answer: its script stops in the debugger before the close. A pause
  // requested while the page is idle can be dropped (as by a navigation) and the page then
  // answers at once, so the page is paused by a debugger statement and seen to be paused.
  let paused = false;
  const stop = cdp.on((method) => {
    if (method === "Debugger.paused") paused = true;
  });
  const enabled = await cdp.send("Debugger.enable");
  await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => { debugger; }, 0)" });
  const stopped = !enabled.error && (await until(() => paused, 10000));
  stop();
  check(label, "the page is paused before its window closes", stopped);
  const unanswered = stopped ? await timedClose(20000) : null;
  check(
    label,
    "a close the page never acknowledges exits at the native deadline",
    unanswered !== null && unanswered >= 4500 && unanswered < 12000,
    `${unanswered} ms`,
  );
  if (!stopped) await closeApp();
  await launch();
});

// ---------- run ----------
let failed = false;
try {
  await launch();
  const database = new DatabaseSync(join(dataDir, "library.sqlite3"), { timeout: 15000 });
  database.prepare("INSERT INTO library_folders (path) VALUES (?)").run(booksDir);
  database.close();
  const imported = await cdp.invoke("scan_library_folders", { operationId: null });
  const library = await cdp.invoke("list_library");
  for (const book of books) bookId[book.name] = library.find((b) => b.title === book.title)?.id;
  const missing = books.filter((b) => !bookId[b.name]).map((b) => b.name);
  if (missing.length)
    throw new Error(
      `Not imported: ${missing.join(", ")} (${JSON.stringify(imported).slice(0, 400)})`,
    );

  for (const { name, run } of scenarios) {
    if (only && !name.includes(only)) continue;
    console.log(name);
    try {
      await run();
    } catch (error) {
      check(name, "runs", false, String(error?.stack ?? error).slice(0, 400));
      if (!app || !alive(app.pid)) await launch();
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (app && alive(app.pid) && !args.includes("--keep-open"))
    await closeApp().catch(() => process.kill(app.pid));
  windowControl?.quit();
}

const liveAfter = [stamp(liveStore), stamp(`${liveStore}-wal`)];
check(
  "isolation",
  "the real library was not touched",
  liveAfter.every((v, i) => v === liveBefore[i]),
);
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, "latest.json"), JSON.stringify(results, null, 1));
const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
process.exit(failed || failures.length ? 1 : 0);
