import { readFileSync } from "node:fs";

// The production CSP is a security boundary. Each allowance below exists for a named feature;
// anything broader must be a deliberate change to this check and the architecture docs.
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const csp = config.app?.security?.csp;

if (typeof csp !== "string") {
  fail("Komori requires an explicit production Content Security Policy string.");
}

const directives = new Map();
for (const directive of csp.split(";")) {
  const [rawName, ...sources] = directive.trim().split(/\s+/);
  if (!rawName) continue;
  const name = rawName.toLowerCase();
  if (directives.has(name)) fail(`Duplicate production CSP directive: ${name}.`);
  directives.set(name, sources);
}

const approved = new Map([
  // The application bundle, also the effective script-src when it is omitted.
  ["default-src", ["'self'"]],
  ["object-src", ["'none'"]],
  // Bundled images, inert SVG viewer images, EPUB archive images, covers and Reader backgrounds.
  [
    "img-src",
    [
      "'self'",
      "data:",
      "blob:",
      "komori-cover:",
      "http://komori-cover.localhost",
      "komori-background:",
      "http://komori-background.localhost",
    ],
  ],
  // Application styles/inline presentation and EPUB.js archive stylesheets.
  ["style-src", ["'self'", "'unsafe-inline'", "blob:"]],
  // Bundled/embedded EPUB fonts and Komori-owned font downloads on every platform.
  ["font-src", ["'self'", "data:", "blob:", "komori-font:", "http://komori-font.localhost"]],
  // Word audio: recordings native code fetched, played from in-memory blobs.
  ["media-src", ["blob:"]],
  // Native IPC and catalog-scoped EPUB content, without general remote fetch authority.
  ["connect-src", ["ipc:", "http://ipc.localhost", "komori-book:", "http://komori-book.localhost"]],
  ["script-src", ["'self'"]],
]);

for (const [name, sources] of directives) {
  const allowed = approved.get(name);
  if (!allowed) fail(`Production CSP directive ${name} is not approved.`);
  if (
    sources.length !== allowed.length ||
    sources.some((source) => !allowed.includes(source)) ||
    allowed.some((source) => !sources.includes(source))
  )
    fail(`Production ${name} must contain exactly ${allowed.join(", ")}.`);
}

for (const name of approved.keys()) {
  if (name !== "script-src" && !directives.has(name))
    fail(`Production CSP requires ${name}; script-src may use the self-only default-src fallback.`);
}

console.log(
  "Production CSP grants only Komori's documented cover, EPUB resource, and protocol allowances.",
);

function fail(message) {
  console.error(message);
  process.exit(1);
}
