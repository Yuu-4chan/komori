// Writes THIRD-PARTY-NOTICES.txt for a Komori binary: the license notices of every npm package
// in the locked production closure and every Rust crate the Windows executable links, plus the
// material Komori vendors or adapts. Identical license texts are printed once, after the list of
// packages they cover. A package with no license file and no known license fails the build.
// Usage: node scripts/third-party-notices.mjs [output] (default dist/THIRD-PARTY-NOTICES.txt)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const target = "x86_64-pc-windows-msvc";
const licenseFile = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._ ].*)?$/i;
// Texts for packages that declare a license but ship no file; MIT and BSD take a copyright line.
const templates = { MIT: "MIT.txt", "BSD-3-Clause": "BSD-3-Clause.txt", "MPL-2.0": "MPL-2.0.txt" };

const read = (path) =>
  readFileSync(path, "utf8")
    .replace(/^﻿/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trim();

/** The license files at a package's root, in name order. */
function licenseTexts(directory) {
  return readdirSync(directory)
    .filter((name) => licenseFile.test(name) && statSync(join(directory, name)).isFile())
    .sort()
    .map((name) => read(join(directory, name)))
    .filter(Boolean);
}

/** The alternatives of an SPDX-like expression, accepting the older `MIT/Apache-2.0` form. */
export function licenseChoices(expression) {
  return String(expression ?? "")
    .replace(/[()]/gu, " ")
    .split(/\s+OR\s+|\s*\/\s*/u)
    .map((choice) => choice.trim())
    .filter(Boolean);
}

/** A template text for a package without a license file, or null when none applies. */
export function fallbackText(expression, holders, root) {
  const choices = licenseChoices(expression);
  const choice = choices.includes("MIT") ? "MIT" : choices.find((id) => templates[id]);
  if (!choice) return null;
  const text = read(join(root, "scripts", "licenses", templates[choice]));
  return choice === "MPL-2.0" ? text : `Copyright (c) ${holders}\n\n${text}`;
}

const names = (people) =>
  people
    .map((person) => (typeof person === "string" ? person : person?.name))
    .filter(Boolean)
    .map((person) => person.replace(/\s*[<(][^>)]*[>)]/gu, "").trim())
    .filter((person) => person && !person.includes("@"))
    .join(", ");

/** The production npm closure, as installed from pnpm-lock.yaml. */
function npmPackages(root) {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const patched = new Map(
    [...workspace.matchAll(/^ {2}"?([^"\s]+)"?:\s*(patches\/\S+)$/gmu)].map((m) => [m[1], m[2]]),
  );
  const installed = (from, name) => {
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      if (dirname(directory) === directory) return null;
    }
  };
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pending = Object.keys(manifest.dependencies ?? {}).map((name) => [root, name]);
  const seen = new Map();
  while (pending.length > 0) {
    const [from, name] = pending.pop();
    const directory = installed(from, name);
    if (!directory)
      throw new Error(`${name} is not installed; run pnpm install --frozen-lockfile.`);
    if (seen.has(directory)) continue;
    const info = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    seen.set(directory, info);
    const dependencies = { ...info.dependencies, ...info.optionalDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (installed(directory, dependency)) pending.push([directory, dependency]);
      else if (!info.optionalDependencies?.[dependency]) {
        throw new Error(`${dependency} (needed by ${info.name}) is not installed.`);
      }
    }
  }
  const packages = [];
  for (const [directory, info] of seen) {
    // Type declarations are never bundled.
    if (info.name.startsWith("@types/")) continue;
    const id = `${info.name}@${info.version}`;
    const escaped = id.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    if (!new RegExp(`^ {2}'?${escaped}['(:]`, "mu").test(lockfile)) {
      throw new Error(
        `${id} is installed but not in pnpm-lock.yaml; run pnpm install --frozen-lockfile.`,
      );
    }
    const repository = info.repository?.url ?? info.repository ?? info.homepage;
    packages.push({
      kind: "npm",
      name: info.name,
      version: info.version,
      license: info.license ?? info.licenses?.map((entry) => entry.type ?? entry).join(" OR "),
      source: typeof repository === "string" ? repository.replace(/^git\+/u, "") : undefined,
      holders: names([info.author, ...(info.contributors ?? [])]),
      note: patched.has(id) ? `modified by Komori (${patched.get(id)})` : undefined,
      texts: licenseTexts(directory),
    });
  }
  return packages;
}

/** The crates the Windows executable links, as locked in Cargo.lock. */
function cargoPackages(root) {
  const rustupCargo = join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  const cargo = existsSync(rustupCargo) ? rustupCargo : "cargo";
  const metadata = JSON.parse(
    execFileSync(
      cargo,
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        target,
        "--manifest-path",
        join(root, "src-tauri", "Cargo.toml"),
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  const packages = new Map(metadata.packages.map((info) => [info.id, info]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  // Normal dependencies only: build scripts and dev dependencies do not ship.
  const linked = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (linked.has(id)) continue;
    linked.add(id);
    for (const dependency of nodes.get(id).deps) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
    }
  }
  linked.delete(metadata.resolve.root);
  return [...linked].map((id) => {
    const info = packages.get(id);
    const directory = dirname(info.manifest_path);
    const texts = licenseTexts(directory);
    if (info.license_file && existsSync(join(directory, info.license_file))) {
      const declared = read(join(directory, info.license_file));
      if (!texts.includes(declared)) texts.push(declared);
    }
    return {
      kind: "crate",
      name: info.name,
      version: info.version,
      license: info.license,
      source: info.repository ?? info.homepage ?? `https://crates.io/crates/${info.name}`,
      holders: names(info.authors ?? []),
      texts,
    };
  });
}

/** Material that is not a package: vendored, adapted, or linked from outside a package. */
function extraEntries(root, crates) {
  const gpl = read(join(root, "LICENSE"));
  const mit = read(join(root, "scripts", "licenses", "MIT.txt"));
  const bsd = read(join(root, "scripts", "licenses", "BSD-3-Clause.txt"));
  const entries = [
    {
      kind: "vendored",
      name: "Lapis",
      version: "f4eb29b",
      license: "GPL-3.0",
      source: "https://github.com/donkuri/lapis",
      note: "by Ruri, itokatsu, kuri and contributors; unmodified (src-tauri/vendor/lapis)",
      texts: [gpl],
    },
    {
      kind: "adapted",
      name: "Yomitan Japanese transforms",
      version: "67db60d",
      license: "GPL-3.0-or-later",
      source: "https://github.com/yomidevs/yomitan",
      note: "Copyright (C) 2024-2026 Yomitan Authors; adapted and modified in src-tauri/src/dictionary/deinflect.rs",
      texts: [gpl],
    },
    {
      kind: "runtime",
      name: "Rust standard library",
      version: "",
      license: "MIT OR Apache-2.0",
      source: "https://github.com/rust-lang/rust",
      texts: [`Copyright (c) The Rust Project Contributors\n\n${mit}`],
    },
  ];
  const webview = crates.find((crate) => crate.name === "webview2-com-sys");
  if (webview) {
    entries.push({
      kind: "linked",
      name: "Microsoft WebView2 loader",
      version: `via webview2-com-sys ${webview.version}`,
      license: "BSD-3-Clause",
      source: "https://www.nuget.org/packages/Microsoft.Web.WebView2",
      texts: [`Copyright (C) Microsoft Corporation. All rights reserved.\n\n${bsd}`],
    });
  }
  return entries;
}

/** The complete notices text for the current lockfiles and installed packages. */
export function thirdPartyNotices(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const crates = cargoPackages(root);
  const entries = [...npmPackages(root), ...crates, ...extraEntries(root, crates)];
  const groups = new Map();
  const texts = new Map();
  const missing = [];
  for (const entry of entries) {
    if (entry.texts.length === 0) {
      const holders = entry.holders || `the ${entry.name} authors`;
      const text = fallbackText(entry.license, holders, root);
      if (text) entry.texts = [text];
      else missing.push(`${entry.name} ${entry.version} (${entry.license ?? "no license"})`);
    }
    // Texts that differ only in line wrapping are one license.
    const key = entry.texts.map((text) => text.replace(/\s+/gu, " ")).join("\n");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
    if (!texts.has(key)) texts.set(key, entry.texts.join("\n\n-----\n\n"));
  }
  if (missing.length > 0) {
    throw new Error(`No license text for: ${missing.join(", ")}. Add its text before release.`);
  }
  const rule = "=".repeat(80);
  const order = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  const sections = [...groups]
    .map(([key, members]) => [texts.get(key), members.sort(order)])
    .sort(([, a], [, b]) => order(a[0], b[0]))
    .map(([text, members]) =>
      [
        rule,
        ...members.map((entry) =>
          [
            `${entry.name}${entry.version ? ` ${entry.version}` : ""} (${entry.kind}) — ${entry.license}`,
            entry.note ? `  ${entry.note}` : null,
            entry.source ? `  Source: ${entry.source}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        "",
        text,
        "",
      ].join("\n"),
    );
  return [
    `Third-party notices for Komori ${manifest.version}`,
    "",
    "Komori is licensed under GPL-3.0-or-later; see LICENSE and NOTICE. It includes the",
    `software below (${entries.length} components). Each list of components is followed by the`,
    "license text that covers them.",
    "",
    ...sections,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const output = resolve(root, process.argv[2] ?? join("dist", "THIRD-PARTY-NOTICES.txt"));
  try {
    const text = thirdPartyNotices(root);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
    console.log(`Third-party notices: ${relative(root, output)}`);
  } catch (error) {
    console.error(`Could not write third-party notices: ${error.message}`);
    process.exit(1);
  }
}
