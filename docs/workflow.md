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
- `pnpm android:dev` runs Komori on the connected Android device or emulator with the Vite development server; `pnpm android:build` builds the debug APKs for arm64 phones and the x86_64 emulator under `src-tauri/gen/android/app/build/outputs/apk/`. Both need the Android SDK and NDK (`ANDROID_HOME`, `NDK_HOME`) and a JDK (`JAVA_HOME`).
- `pnpm tauri:build` builds the release executable and the NSIS installer under `src-tauri/target/release/bundle/nsis/`.
- `pnpm tauri:release` builds the signed installer for a published release. It needs `TAURI_SIGNING_PRIVATE_KEY` (the private key or its path) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment, a version that matches in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and a `CHANGELOG.md` section for that version. It refuses to write `latest.json` unless the signature verifies against the public key in `tauri.conf.json`.
- `node scripts/check-release.mjs [--tag v<version>]` checks the built output: versions, GUI subsystem, bundled notices, paths, signing key and, after `tauri:release`, the signature and `latest.json`.
- Releases are made by `.github/workflows/release.yml`: pushing the tag `v<version>` builds, checks and signs on Windows and Linux and attaches `Komori_<version>_x64-setup.exe`, its `.sig`, `latest.json`, `Komori_<version>_android-arm64.apk` and `SHA256SUMS.txt` to a draft release; installed copies find it through `releases/latest` once the draft is published. The steps before and after are in `release-checklist.md`; `node scripts/release-books.mjs <folder>` writes its synthetic books and `node scripts/update-rehearsal.mjs build | serve <folder>` rehearses an update before publishing.
- Generated validation files are ignored under `artifacts/`; never commit them.

## Website

`site/` is the project's website: a landing page (`index.html`) and the user documentation (`docs/index.html`), as static files with no build step. `.github/workflows/pages.yml` publishes it to GitHub Pages at `https://yuu-4chan.github.io/komori/` whenever `site/` changes on `main`.

- Its download buttons ask the GitHub API for the latest release in the browser and fall back to the releases page, so a release needs no change to the site.
- The pages allow only their own files and, on the landing page, `api.github.com` (the Content Security Policy in each `<head>`): styles, scripts, fonts and images stay in `site/assets/`, with no inline styles or scripts.
- URLs are relative, because the site is served from `/komori/`.
- The site looks like the application, not like a product landing page: the name with its summary and the download buttons beside it, one screenshot viewer under them with a segmented control (each screenshot appears once on the page), group headings over a hairline, and grouped panels with accent icon tiles for features and downloads. Its text says what Komori does in plain words; headings are names (Features, Android, Themes, Download), with no slogans.
- It wears the application's themes: Hojicha in light mode and Ember in dark mode until the visitor chooses one of the eight in the Themes section, which is remembered in the browser (`assets/theme.js` applies it before the page is drawn). Each theme is four colors in `site/assets/site.css`, copied from `src/features/appearance/appThemes.ts`, and the rest are mixed from them. The logo files in `site/assets/logo/` are `src/brand/komori.svg` with each theme's logo color baked in, mixed as `.brand-mark` mixes them in `src/styles/shell.css`.
- When a release changes what users see or do, update the documentation page and retake the affected screenshots in `site/assets/img/`.

The plain design guide is `design.md`; runtime design values remain in application themes, Reader themes, and CSS tokens.

## Local configuration

Machine-specific paths and private workflow steps belong in the untracked `docs/local-development.md`, never in tracked files or production configuration. Agents read it when it exists. A minimal one names the read-only test folders:

```text
EPUB: <path to a folder of EPUB files>
DICT: <path to a folder of dictionary ZIP archives>
```

Never copy these files into the repository, tests or fixtures.
