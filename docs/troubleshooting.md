# Troubleshooting

## Komori does not start, or the window stays blank

Komori needs the Microsoft Edge WebView2 Runtime. It is part of Windows 11 and of most Windows 10 installations, and the installer downloads it when it is missing; if that download failed or the runtime was removed later, install the Evergreen runtime from Microsoft and start Komori again.

## Windows warns that the installer is from an unknown publisher

Komori's installer is not code-signed, so Microsoft Defender SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**, only if you downloaded the installer from the project's GitHub releases page.

## A book is shown as unavailable

The EPUB was moved, renamed or deleted after it was added. Choose **Relink EPUB** on the book's card (or in its menu) and pick the file at its new location; reading position, notes, bookmarks and statistics are kept.

## A book does not open

Komori shows an error page when an EPUB is damaged or not a valid EPUB. Try another copy of the book, or repair it with an EPUB editor, then use **Relink EPUB**. DRM-protected EPUBs cannot be read; Komori does not remove DRM.

## Nothing happens when I select a word

- Lookup needs at least one dictionary that supplies definitions. Settings > Dictionary can download a few curated open dictionaries, or add your own ZIP archives.
- By default, lookup starts with **Shift** over the text or the **Shift+Enter** shortcut on a selection. Mouse selection, click and hover lookup can be turned on in Settings > Reader popup.
- Make sure **Reader lookup popup** is on in Settings > Reader popup.

## A dictionary will not import

Komori imports dictionary ZIP archives with a root `index.json` in format 2 or 3 (the format used by popular pop-up dictionary extensions). Archives that are damaged, use format 1, or exceed the size limits are refused with a reason. A dictionary that is already installed with the same title and revision is not imported twice.

## Starter dictionary or font downloads fail

Check your internet connection, proxy and firewall, then retry. Downloads use HTTPS to GitHub and, for the frequency list, its publisher's site. You can always import dictionary ZIP files you downloaded yourself.

## Voice is unavailable or finds no audio

Voice plays a recording from the sources in Settings > Dictionary > Word audio, which need an internet connection. The button is unavailable when the list is empty: add JapanesePod101 back or another source. When no source has the word, the button says there is no audio for it; a source you add (such as a local audio server) may have it.

## Checking for updates fails

Update checks use HTTPS to the project's GitHub releases. Check your connection, proxy and firewall, then use **Check for updates** in Settings > General. You can also download the latest installer from the releases page and run it over the installed version; your data is kept.

## Anki cards are not created

- Anki must be running with the AnkiConnect add-on installed.
- In Settings > Anki, check the port (8765 by default) and the key, if you set one in AnkiConnect, then use **Test connection**.
- Choose a deck and note type, and map at least one field.

## Removing a dictionary or book does not free disk space

Komori compacts its stores automatically after a removal. Compaction needs free disk space up to about twice the store's size while it runs; free some space and remove another item, or check the sizes in Settings > Storage.

## Undoing a change to Komori's data

Settings > Storage keeps snapshots of Komori's own data (catalog, preferences, progress, notes, statistics). Restore one from **Snapshots**; a snapshot of the current state is taken first.

## Reporting a problem

Open an issue on GitHub with your Windows version, Komori's version (shown under the Settings categories) and the steps that reproduce the problem. Do not attach copyrighted books or dictionaries. For security problems, see `SECURITY.md`.
