# Security policy

Komori is maintained by me. Security fixes go into the latest release only.

## Reporting a vulnerability

Please report security problems privately first, so they can be fixed before details are public:

- **Discord:** send a direct message to **nahccuy** or ping me on the [learnjapanese.moe](https://learnjapanese.moe) (TMW) Discord server Komori's thread.
- **GitHub issue:** if you cannot reach me on Discord, [open an issue](https://github.com/Yuu-4chan/komori/issues/new) saying you have a security report and how to contact you. Do not include exploit details, proof-of-concept files or crafted EPUBs or dictionaries in a public issue.

Please include the Komori version (shown under the Settings categories), your Windows version, what an attacker can achieve, and the steps to reproduce it.

## Scope

Of particular interest are problems where a crafted EPUB, dictionary archive, font, backup or image could:

- run script or reach the network or file system from the reader or the lookup popup;
- read, write or delete files outside what you chose;
- change or corrupt your source EPUBs or dictionary archives;
- exhaust memory or disk beyond Komori's documented limits.

Problems with updates are also in scope: installing anything not signed with the release key, or reaching another endpoint. Word audio sources you add yourself are fetched as you configured them.

Komori's security boundaries are described in [docs/real-data-and-safety.md](docs/real-data-and-safety.md) and [docs/architecture.md](docs/architecture.md).
