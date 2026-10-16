import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const profile = process.argv[2] ?? "task";
const allowedProfiles = new Set(["task", "full", "release"]);

if (!allowedProfiles.has(profile)) {
  console.error(`Unknown validation profile: ${profile}`);
  process.exit(2);
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  console.error("Run validation through pnpm so the repository can resolve its package manager.");
  process.exit(2);
}

// Prefer the rustup-managed Cargo; fall back to whatever Cargo is on PATH.
const rustupCargo = join(
  homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "cargo.exe" : "cargo",
);
const cargoCommand = existsSync(rustupCargo) ? rustupCargo : "cargo";
const checks = [
  pnpmCheck("format", ["format:check"]),
  pnpmCheck("lint", ["lint"]),
  pnpmCheck("typecheck", ["typecheck"]),
  {
    name: "production-csp",
    command: process.execPath,
    args: ["scripts/check-csp.mjs"],
  },
  pnpmCheck("frontend-tests", ["test:run"]),
  {
    name: "rust-format",
    command: cargoCommand,
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  {
    name: "rust-check",
    command: cargoCommand,
    args: ["check", "--manifest-path", "src-tauri/Cargo.toml"],
  },
  {
    name: "rust-clippy",
    command: cargoCommand,
    args: [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    name: "rust-tests",
    command: cargoCommand,
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
  },
];

if (profile === "release") {
  checks.push(pnpmCheck("frontend-build", ["build"]));
  checks.push(pnpmCheck("reader-real", ["test:reader-real"]));
}

function pnpmCheck(name, args) {
  // pnpm may be a JavaScript entry point (run through Node) or a standalone executable.
  return /\.[cm]?js$/i.test(pnpmCli)
    ? { name, command: process.execPath, args: [pnpmCli, ...args] }
    : { name, command: pnpmCli, args };
}

const startedAt = new Date().toISOString();
const results = [];

for (const check of checks) {
  const started = Date.now();
  const result = await run(check.command, check.args);
  results.push({
    name: check.name,
    success: result.code === 0,
    durationMs: Date.now() - started,
    summary: result.summary,
  });

  if (result.code !== 0) {
    break;
  }
}

const failedChecks = results.filter((result) => !result.success).map((result) => result.name);
const evidence = {
  profile: `validate:${profile}`,
  success: failedChecks.length === 0 && results.length === checks.length,
  startedAt,
  finishedAt: new Date().toISOString(),
  checks: results,
  failedChecks,
};

const evidenceDirectory = join("artifacts", "validation");
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(join(evidenceDirectory, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(
  join(evidenceDirectory, "latest.txt"),
  [
    `${evidence.profile}: ${evidence.success ? "PASS" : "FAIL"}`,
    ...results.map(
      (result) =>
        `${result.success ? "PASS" : "FAIL"} ${result.name} (${result.durationMs}ms)${result.summary ? ` — ${result.summary}` : ""}`,
    ),
  ].join("\n") + "\n",
);

console.log(`\nValidation evidence: ${join(evidenceDirectory, "latest.txt")}`);
process.exit(evidence.success ? 0 : 1);

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    const capture = (chunk, stream) => {
      const value = chunk.toString();
      stream.write(value);
      tail = `${tail}${value}`.slice(-4000);
    };

    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.on("error", (error) => resolve({ code: 1, summary: error.message }));
    child.on("close", (code) => {
      resolve({ code: code ?? 1, summary: summarize(tail) });
    });
  });
}

function summarize(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Vitest prints a "Tests  N passed" line before its timing line.
  const vitest = lines.findLast((line) => /^Tests\s+\d+/.test(line));
  if (vitest) return vitest.replace(/\s+/g, " ");
  // Cargo prints one result per test target; the last is usually an empty doc-test run.
  const cargo = lines
    .map((line) => line.match(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/))
    .filter(Boolean);
  if (cargo.length > 0) {
    const [passed, failed, ignored] = [1, 2, 3].map((group) =>
      cargo.reduce((total, match) => total + Number(match[group]), 0),
    );
    return `${passed} passed; ${failed} failed; ${ignored} ignored`;
  }
  return lines.at(-1);
}
