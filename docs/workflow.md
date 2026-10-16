# Development workflow

## Sources of truth

| Source                      | Responsibility                               |
| --------------------------- | -------------------------------------------- |
| `AGENTS.md`                 | General agent workflow and repository rules. |
| Architecture/subsystem docs | Permanent contracts and decisions.           |
| Tests                       | Regression protection.                       |
| Code                        | Implementation reality.                      |

Each fact should have one home. Long-term behavior belongs in the authoritative docs and tests.

## Development cycle

small change → implementation → automated validation → real/manual validation when relevant → focused follow-up fix if needed → regression coverage.

Manual failures with real files outrank green synthetic tests: reproduce the problem, then improve both the implementation and its coverage.

## Build and validation commands

- `pnpm install` installs the pinned dependencies.
- `pnpm tauri:dev` runs Komori with the Vite development server.
- `pnpm validate:task` runs formatting, lint, type, CSP, frontend and native checks with concise evidence.
- `pnpm validate:full` runs the same checks as the full local gate.
- `pnpm validate:release` additionally builds the frontend and runs the real-engine smoke test (`pnpm test:reader-real`) on synthetic EPUBs under an isolated app identifier, including the built WebView's effective CSP and the updater refusing installers not signed by the release key.
- `pnpm tauri:build` builds the release executable and the NSIS installer under `src-tauri/target/release/bundle/nsis/`.
- `pnpm tauri:release` builds the signed installer for a published release. It needs `TAURI_SIGNING_PRIVATE_KEY` (the private key or its path) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment, a version that matches in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and a `CHANGELOG.md` section for that version. It refuses to write `latest.json` unless the signature verifies against the public key in `tauri.conf.json`.
- `node scripts/check-release.mjs [--tag v<version>]` checks the built output: versions, GUI subsystem, bundled notices, paths, signing key and, after `tauri:release`, the signature and `latest.json`.
- Releases are made by `.github/workflows/release.yml`: pushing the tag `v<version>` builds, checks and signs on Windows and attaches `Komori_<version>_x64-setup.exe`, its `.sig`, `latest.json` and `SHA256SUMS.txt` to a draft release; installed copies find it through `releases/latest` once the draft is published. The steps before and after are in `release-checklist.md`; `node scripts/release-books.mjs <folder>` writes its synthetic books and `node scripts/update-rehearsal.mjs build | serve <folder>` rehearses an update before publishing.
- Generated validation files are ignored under `artifacts/`; never commit them.

The plain design guide is `design.md`; runtime design values remain in application themes, Reader themes, and CSS tokens.

## Local configuration

Machine-specific paths and private workflow steps belong in the untracked `docs/local-development.md`, never in tracked files or production configuration. Agents read it when it exists. A minimal one names the read-only test folders:

```text
EPUB: <path to a folder of EPUB files>
DICT: <path to a folder of dictionary ZIP archives>
```

Never copy these files into the repository, tests or fixtures.
