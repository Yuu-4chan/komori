# Privacy

Komori is a local application. It has no account, no telemetry, no analytics, no crash reporting. Your books, reading history, notes and dictionaries stay on your computer.

## What is stored, and where

Komori keeps its data in `%APPDATA%\app.komori.reader`:

| Location               | Contents                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `library.sqlite3`      | The Library catalog (references to your EPUB files, metadata, covers and thumbnails), preferences, reading positions, reading sessions and statistics, bookmarks, notes and highlights, and the Reader background image. |
| `dictionaries.sqlite3` | Imported dictionary entries. The ZIP archives you import are not kept or changed.                                                                                                                                        |
| `backups\`             | Automatic and manual snapshots (`.komoribackup`) of Komori's own data, if backups are on.                                                                                                                                |
| `reader-fonts\`        | Downloaded and imported Reader fonts, with their licenses.                                                                                                                                                               |
| `starter-dictionaries` | A small journal and temporary staging files for starter dictionary downloads.                                                                                                                                            |

The embedded browser engine (WebView2) keeps its own cache in `%LOCALAPPDATA%\app.komori.reader\EBWebView`.

When **Launch at startup** is on, Komori adds a `Komori` value under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`; turning it off, or uninstalling Komori, removes it.

Komori never moves, copies or rewrites your EPUB files or dictionary archives: it reads them read-only. Exported backups are written only to the file you choose. Komori writes no log files.

## Network use

Komori contacts the network only for these features:

- **Starter dictionaries.** Settings > Dictionary can download a few curated open dictionaries over HTTPS from GitHub release assets and from the frequency list publisher's download endpoint. Downloads from GitHub are checked against pinned SHA-256 digests.
- **Reader fonts.** The font manager downloads curated Google Fonts families over HTTPS from Google's font repository on GitHub, pinned to a fixed commit and checked against pinned hashes. Zen Old Mincho, Klee One and Noto Sans JP, SC and KR come with the installer, so the default fonts need no download; when the computer has no Yu Mincho and it is the chosen Japanese font, the Reader shows the included Zen Old Mincho instead. Nothing is downloaded without your action.
- **Updates.** When **Check for updates automatically** is on (Settings > General), Komori asks the project's GitHub releases for the latest version a few seconds after it starts; the button beside it checks on demand. An update is downloaded only when you choose **Install and restart**, and its signature is verified before the installer runs.
- **Word audio.** When you press Voice, or add a card whose fields use Word audio, Komori asks the word audio sources in Settings > Dictionary for a recording of the word, in order: JapanesePod101 by default, and any URL you add. The request carries the word and its reading. Recordings are kept in memory only while Komori runs.
- **Anki.** When you use Anki features, Komori talks to AnkiConnect on your own computer (`127.0.0.1`) only.
- **Discord status.** Off by default. When you turn it on in Settings > Discord, Komori tells the Discord app on your computer, through its local pipe, the open book's title, book and chapter progress and reading speed (each can be hidden), which Komori page you are using outside the Reader (Library, Dictionary, Statistics or Settings; can be hidden), or Idle. To tell when you stop using a page, Komori counts your clicks and key presses on it; what you typed or clicked is not recorded, and Discord is told only the page. Discord then shows this on your profile to the people who can see your activity. Komori itself sends nothing over the network for it: Discord loads the Komori icon shown with the status from GitHub, and the icon links to Komori's GitHub page.
- **Links.** Dictionary links and source or license links open in your default web browser; Komori does not fetch them itself.

Those requests carry no identifier and no information about your library or reading. EPUB content is rendered offline, with scripts disabled and no access to remote resources.

## Removing your data

The uninstaller offers to delete the application data. Leave it unticked to keep your library for a reinstall; tick it to remove `%APPDATA%\app.komori.reader` and `%LOCALAPPDATA%\app.komori.reader`. Your EPUB files and dictionary archives are not affected.
