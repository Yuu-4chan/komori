// Checks a built release (`pnpm tauri:build` or `pnpm tauri:release`) before it is published: one
// version everywhere, GUI-subsystem executables, the license, notices and included fonts bundled, no source or
// build-machine paths in what the user sees, no signing key anywhere in the output and, when the
// updater artifacts exist, a signature that verifies against the key installed copies trust.
// Usage: node scripts/check-release.mjs [--tag v<version>]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { verifySignature } from "./release-manifest.mjs";
import { containsSigningKey } from "./signing-key-scan.mjs";

/** The PE subsystem of a Windows executable: 2 is a GUI program, 3 a console program. */
export function peSubsystem(bytes) {
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.toString("latin1", header, header + 4) !== "PE\0\0") throw Error("Not a PE file.");
  // The optional header follows the 4-byte signature and the 20-byte COFF header.
  return bytes.readUInt16LE(header + 24 + 68);
}

/** The file and product versions of a PE file's fixed version resource (VS_FIXEDFILEINFO). */
export function peVersions(bytes) {
  const at = bytes.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (at < 0) return null;
  const pair = (offset) => {
    const high = bytes.readUInt32LE(at + offset);
    const low = bytes.readUInt32LE(at + offset + 4);
    return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join(".");
  };
  return { file: pair(8), product: pair(16) };
}

// Absolute Windows or UNC paths and repository source paths. The license texts' "s:\r\n" and
// similar are not paths: a drive path continues with a name character.
const absolutePath =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:Users|Windows|Program Files|a[\\/])[^\s"'<>]*/gu;
const sourcePath =
  /(?<![\w./-])(?:src-tauri[\\/]|src[\\/](?:features|app|components)[\\/])[\w./\\-]+/gu;

/** Paths in text a user reads, other than those `allowed` names on purpose. */
export function pathsIn(text, allowed = []) {
  return [...text.matchAll(absolutePath), ...text.matchAll(sourcePath)]
    .map((match) => match[0])
    .filter((path) => !allowed.some((prefix) => path.startsWith(prefix)));
}

const files = (directory) =>
  existsSync(directory)
    ? readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      })
    : [];

function main(root = process.cwd(), args = process.argv.slice(2)) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${message}`);
    if (!ok) failures.push(message);
  };
  const read = (path) => readFileSync(join(root, path), "utf8");

  // ---------- version ----------
  const { version } = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/mu)?.[1];
  const lock = read("src-tauri/Cargo.lock").match(
    /^name = "komori"\r?\nversion = "([^"]+)"/mu,
  )?.[1];
  check(
    tauri.version === version && cargo === version && lock === version,
    `version ${version} in package.json, tauri.conf.json (${tauri.version}), Cargo.toml (${cargo}) and Cargo.lock (${lock})`,
  );
  check(
    new RegExp(`^## ${version}$`, "mu").test(read("CHANGELOG.md")),
    `CHANGELOG.md has ## ${version}`,
  );
  const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : undefined;
  if (tag !== undefined) check(tag === `v${version}`, `tag ${tag} is v${version}`);

  // ---------- executables ----------
  const release = join(root, "src-tauri", "target", "release");
  const nsis = join(release, "bundle", "nsis");
  const exe = join(release, "komori.exe");
  const installer = join(nsis, `Komori_${version}_x64-setup.exe`);
  for (const [name, path] of [
    ["komori.exe", exe],
    [`Komori_${version}_x64-setup.exe`, installer],
  ]) {
    if (!existsSync(path)) {
      check(false, `${name} exists (run pnpm tauri:build)`);
      continue;
    }
    const bytes = readFileSync(path);
    check(peSubsystem(bytes) === 2, `${name} is a GUI program (subsystem ${peSubsystem(bytes)})`);
    const versions = peVersions(bytes);
    check(
      versions?.file.startsWith(`${version}.`) && versions?.product.startsWith(`${version}.`),
      `${name} file and product version ${versions?.file} / ${versions?.product}`,
    );
  }

  // ---------- notices ----------
  const notices = [
    ["LICENSE", join(root, "LICENSE")],
    ["NOTICE", join(root, "NOTICE")],
    ["THIRD-PARTY-NOTICES.txt", join(root, "dist", "THIRD-PARTY-NOTICES.txt")],
  ];
  for (const [name, source] of notices) {
    const bundled = join(release, name);
    check(
      existsSync(bundled) &&
        existsSync(source) &&
        readFileSync(bundled).equals(readFileSync(source)),
      `${name} is bundled beside komori.exe and matches its source`,
    );
  }
  const script = join(release, "nsis", "x64", "installer.nsi");
  const nsi = existsSync(script) ? readFileSync(script, "utf8") : "";
  for (const [name] of notices) check(nsi.includes(`\\${name}"`), `the installer installs ${name}`);
  check(/LicenseData|MUI_PAGE_LICENSE/u.test(nsi), "the installer shows the license");
  const thirdParty = existsSync(join(root, "dist", "THIRD-PARTY-NOTICES.txt"))
    ? read("dist/THIRD-PARTY-NOTICES.txt")
    : "";
  check(
    ["epubjs", "@phosphor-icons/react", "@fontsource-variable/inter", "tauri "].every((name) =>
      thirdParty.includes(name),
    ),
    "THIRD-PARTY-NOTICES.txt covers EPUB.js, Phosphor, Inter and the Rust crates",
  );

  // ---------- included Reader fonts ----------
  const catalog = JSON.parse(read("src/features/reader/googleFontCatalog.json"));
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const font of catalog.fonts.filter((font) => font.bundled)) {
    const folder = join(release, "reader-fonts", font.id);
    check(
      existsSync(join(folder, "font.ttf")) &&
        existsSync(join(folder, "OFL.txt")) &&
        sha256(join(folder, "font.ttf")) === font.hash &&
        sha256(join(folder, "OFL.txt")) === font.licenseHash,
      `${font.family} is bundled beside komori.exe, verified, with its license`,
    );
    check(
      ["font.ttf", "OFL.txt"].every((name) => nsi.includes(`reader-fonts\\${font.id}\\${name}"`)),
      `the installer installs ${font.family}`,
    );
    check(thirdParty.includes(`${font.family} google/fonts`), `the notices cover ${font.family}`);
  }

  // ---------- paths in what the user sees ----------
  // The interface, its strings and the notices; the notices name the one modified source file
  // the GPL asks them to.
  const shown = [...files(join(root, "dist")), ...notices.map(([name]) => join(release, name))]
    .filter((path) => /\.(js|html|css|json|txt)$|LICENSE$|NOTICE$/u.test(path) && existsSync(path))
    .flatMap((path) =>
      pathsIn(readFileSync(path, "utf8"), [
        "src-tauri/src/dictionary/deinflect.rs",
        "src-tauri/vendor/",
      ]).map((found) => `${relative(root, path)}: ${found}`),
    );
  check(
    shown.length === 0,
    `no source or absolute paths in the interface or notices ${shown.slice(0, 5).join("; ")}`,
  );
  // Panic locations in the executable are relative once the build remaps them.
  if (existsSync(exe)) {
    const text = readFileSync(exe).toString("latin1");
    const machine = [homedir(), root].filter(
      (path) => text.includes(path) || text.includes(path.replaceAll("\\", "/")),
    );
    check(machine.length === 0, `komori.exe names no build-machine path ${machine.join(", ")}`);
  }

  // ---------- signing key ----------
  const output = [...files(nsis), ...files(join(root, "dist")), exe].filter((path) =>
    existsSync(path),
  );
  const leaked = output.filter((path) => containsSigningKey(readFileSync(path)));
  check(
    leaked.length === 0,
    `no signing key in the release output ${leaked.map((path) => relative(root, path))}`,
  );

  // ---------- updater artifacts ----------
  const signature = `${installer}.sig`;
  if (existsSync(signature)) {
    let verified = "";
    try {
      verifySignature({
        pubkey: tauri.plugins.updater.pubkey,
        signature: readFileSync(signature, "utf8"),
        data: readFileSync(installer),
        version,
      });
    } catch (error) {
      verified = error.message;
    }
    check(
      !verified,
      `the installer signature verifies against the trusted key for ${version} ${verified}`,
    );
    const manifestPath = join(nsis, "latest.json");
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : null;
    const platform = manifest?.platforms?.["windows-x86_64"];
    check(
      manifest?.version === version &&
        platform?.signature === readFileSync(signature, "utf8").trim() &&
        platform?.url ===
          `https://github.com/Yuu-4chan/komori/releases/download/v${version}/Komori_${version}_x64-setup.exe`,
      "latest.json announces this version, its signature and its release URL",
    );
  } else
    console.log(
      "  --   no updater signature (pnpm tauri:build); run pnpm tauri:release to check it",
    );

  console.log(
    failures.length ? `\n${failures.length} release checks failed.` : "\nRelease checks passed.",
  );
  return failures.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main() ? 0 : 1);
}
