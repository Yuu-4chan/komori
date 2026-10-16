import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const cliPath = join(process.cwd(), "node_modules", "@tauri-apps", "cli", "tauri.js");
const cargoBin = join(homedir(), ".cargo", "bin");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const environment = {
  ...process.env,
  [pathKey]: `${cargoBin}${delimiter}${process.env[pathKey] ?? ""}`,
};

// Built executables name source files in panic locations; record them relative to the
// repository and the Cargo home instead of the paths of the machine that built them.
if (process.argv[2] === "build") {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const existing =
    process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f") ??
    (process.env.RUSTFLAGS ?? "").split(/\s+/u);
  environment.CARGO_ENCODED_RUSTFLAGS = [
    ...existing.filter(Boolean),
    `--remap-path-prefix=${cargoHome}=cargo`,
    `--remap-path-prefix=${process.cwd()}=komori`,
  ].join("\x1f");
  delete environment.RUSTFLAGS;
}

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to start the Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
