// Rehearses an update through the real updater before a release is published, on a test machine:
//   node scripts/update-rehearsal.mjs build
//     builds Komori 0.0.1 under its own identifier, with an updater that asks this machine's
//     port 47654 instead of the GitHub releases and trusts the release key, into
//     artifacts/validation/update-rehearsal/;
//   node scripts/update-rehearsal.mjs serve <folder>
//     serves a release (the workflow's komori-release artifact: the installer, its .sig and
//     latest.json) to it, with the installer address pointed at this server. The signature is
//     the release's own, so Install and restart in the rehearsal build installs that release.
// Run the rehearsal build and the server on the same test machine, never on one whose Komori
// you use: the update installs the real Komori.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const PORT = 47654;
const IDENTIFIER = "app.komori.updaterehearsal.test";
const root = process.cwd();
const out = join(root, "artifacts", "validation", "update-rehearsal");
const [mode, folder] = process.argv.slice(2);

if (mode === "build") {
  mkdirSync(out, { recursive: true });
  const config = join(out, "tauri.conf.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: "0.0.1",
      identifier: IDENTIFIER,
      plugins: {
        updater: {
          endpoints: [`http://127.0.0.1:${PORT}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }),
  );
  const target = join(root, "src-tauri", "target", "update-rehearsal");
  execFileSync(
    process.execPath,
    ["scripts/tauri.mjs", "build", "--no-bundle", "--config", config],
    {
      stdio: "inherit",
      env: { ...process.env, CARGO_TARGET_DIR: target },
    },
  );
  const exe = join(out, "Komori-update-rehearsal.exe");
  copyFileSync(join(target, "release", "komori.exe"), exe);
  console.log(`Rehearsal build (Komori 0.0.1, ${IDENTIFIER}): ${exe}`);
} else if (mode === "serve" && folder) {
  const release = resolve(folder);
  const manifest = JSON.parse(readFileSync(join(release, "latest.json"), "utf8"));
  const platform = manifest.platforms["windows-x86_64"];
  const installer = decodeURIComponent(new URL(platform.url).pathname.split("/").pop());
  if (!existsSync(join(release, installer))) throw Error(`${installer} is not in ${release}.`);
  platform.url = `http://127.0.0.1:${PORT}/${encodeURIComponent(installer)}`;
  createServer((request, response) => {
    console.log(`${request.method} ${request.url}`);
    if (request.url === "/latest.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(manifest));
    } else if (request.url === `/${encodeURIComponent(installer)}`) {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(readFileSync(join(release, installer)));
    } else {
      response.statusCode = 404;
      response.end();
    }
  }).listen(PORT, "127.0.0.1", () =>
    console.log(`Offering Komori ${manifest.version} on port ${PORT}; stop with Ctrl+C.`),
  );
} else {
  console.error("Usage: node scripts/update-rehearsal.mjs build | serve <release folder>");
  process.exit(2);
}
