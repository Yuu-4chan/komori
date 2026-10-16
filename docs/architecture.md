# Komori architecture

This document describes how Komori is built and the contracts its subsystems keep. It is written for anyone changing the code: read the overview and the map first, then only the sections for the area you are working in. Code and tests are the final authority; when this document disagrees with them, the document is corrected.

## Overview

Komori is a Tauri 2 desktop application for Windows. The interface is a React and TypeScript application running in WebView2; everything that touches the filesystem, a database or the network is Rust in `src-tauri/`, reached through Tauri commands and events. The frontend never receives a private source path: books and dictionaries are referred to by Komori-owned IDs.

- **Library.** EPUBs are imported by reference, never copied or modified. Native code keeps the catalog, covers, reading positions, bookmarks, notes and reading sessions in `library.sqlite3` in the application-data folder.
- **Reader.** EPUB.js renders a book inside the Komori-owned renderer adapter (`src/features/reader/`), which owns pagination, continuous scrolling, vertical text, themes and the scanning used by lookup. Book files, covers and Reader fonts are served by native `komori-book`, `komori-cover` and `komori-font` protocols; book content is never given generic filesystem, network or database access, and runs under the application's Content-Security-Policy.
- **Dictionary.** Imported dictionary archives (Yomitan format) are parsed natively into their own `dictionaries.sqlite3`. Lookup (deinflection, longest-match scanning, term, kanji, frequency and pitch data) is native; the Reader popup and the Dictionary page render its results.
- **Anki.** Cards are built natively from saved templates and sent to AnkiConnect on the local machine.
- **Preferences** (appearance, Reader, popup, startup, window and Anki settings) are validated records in the same database's `preferences` table, read and written only by native code.

## Repository map

```text
src/                    frontend (React, TypeScript)
  app/                  app-wide behavior: navigation, window lifecycle, autoscroll, WebView surfaces
  brand/                logo and app-icon palettes
  components/ui/        reusable primitives
  components/layout/    application shell and window controls
  features/<area>/      one folder per area: reader, library, dictionary, anki, appearance,
                        statistics, backup, startup, updates, storage, selection, operations
  pages/                one component per route
  i18n/                 interface languages (messages/) and failure-code text
  styles/               tokens, themes and the CSS for each area
src-tauri/              native application (Rust)
  src/                  one module per area; lib.rs builds the app and registers commands
  src/epub/, dictionary/, anki/, backup/, reader_fonts/, startup/
                        larger areas split into submodules
  capabilities/         Tauri permissions for the main window
  vendor/               vendored third-party sources (the Lapis note type)
  tauri.conf.json       application config; tauri.release.conf.json and
                        tauri.updater.conf.json are merged for release builds
scripts/                build, validation, release and maintenance scripts (Node)
  reader-real/          real-engine Reader smoke test
patches/                pnpm patches for dependencies (EPUB.js)
docs/                   this documentation
```

## Baseline stack

- Tauri 2, Rust and WebView2 (Windows only)
- React 19, React Router 7, TypeScript and Vite, with pnpm
- EPUB.js 0.3.93, patched in `patches/epubjs@0.3.93.patch`, behind the Komori Reader renderer adapter
- SQLite (`rusqlite`) only for Komori-owned durable state
- plain CSS in `src/styles/`, built on the tokens in `tokens.css` and the themes in `theme.css`
- self-hosted Inter variable font (`@fontsource-variable/inter`) for application chrome
- Phosphor Icons for interface icons
- Vitest and Testing Library for frontend tests; `cargo test` for native tests

Do not add a large UI or state-management framework without a demonstrated need.

## Contents

- Application: Frontend boundaries, Native/backend ownership, Appearance preferences, Settings navigation, Shortcuts, Window size, Closing, Startup preferences, Updates, Backups
- Library: Library presentation, Book progress, Reading sessions, Statistics
- Reader: EPUB subsystem, Reading position, Reader presentation, Reader themes, Reader images, Reader find in book, Reader bookmarks, Reader notes, Reader lookup
- Dictionary and Anki: Dictionary subsystem, Anki cards
- Building and validation: Validation and builds

## Frontend boundaries

React Router owns URL-backed boundaries for Library, Reader, Dictionary, Statistics, and Settings. `AppShell` owns the persistent frame for Library, Dictionary, Statistics, and Settings: a top bar that is also the window's title bar (brand, the current page's search slot, Settings, Add books, and the window controls) and a floating bottom dock (Dictionary, Library, Statistics) over one scrolling main surface. The top bar comes first in the document, so Tab reaches it before the page, and the dock last. Reader is a separate full-window route with its own chrome, sidebar, viewport, and footer. It is code-split with `React.lazy`, so EPUB.js and its ZIP reader stay out of the startup bundle until a Reader route opens. A page with nothing to show yet shows an empty state, never sample data.

The main window has no system frame (`decorations: false`, with the system shadow, so Windows still resizes it from its edges and maximizes it to the work area). The top bar is a `data-tauri-drag-region="deep"`: its empty parts drag the window and a double-click maximizes or restores it, while its controls keep their clicks. `WindowControls` draws minimize, maximize/restore (following `onResized`), and close with the Windows glyph font, flush in the top right; close goes through the normal close path. The Reader, outside the shell, has its own drag strip along the top and the same controls in the top right of its reading area, in the Reader theme's footer color. A modal dialog (`ConfirmDialog`, the font manager, the image viewer) makes the page behind it inert, so it renders `DialogCaption` in its own top layer: a 2rem drag strip along the top with the same controls on its right (light in the image viewer). Those controls are out of the dialog's Tab order and never take focus on click, so the dialog's focus trap and Esc stay as they are. Nothing renders outside the desktop application. The top bar's controls float as frosted glass once the main surface scrolls under them. Settings and Add books, like the search, appear only on the Library. Add books runs the shared import (`libraryImport.ts`), which the Library's own empty-state action also uses; one picker opens at a time, and each finished import makes the Library list again. Theme choice lives in Settings. The search slot (`src/components/layout/shellSlots.ts`) keeps the same width on every page; the Library renders its search there through a portal, and renders it in place outside the shell, as in tests. The dock marks the current destination with `aria-current`, an accent tint, and a larger icon. Changing route keeps the main surface's scroll position; the Library restores its own (see Library presentation). At `820px` and below the brand hides and the search takes the bar's free width; the dock stays, with smaller items.

`AppearanceProvider` owns application theme, accent, and every Reader appearance setting, including the wheel step and lookup popup theme, dimensions, and corner radius, and applies one semantic CSS-token layer at the document root. These appearance preferences are saved natively (see Appearance preferences). In the desktop application the provider renders nothing until the saved preferences load, so a saved theme never flashes the default. A load that fails shows the defaults, and so does one that takes over 2 s. A late result still applies when nothing was changed. Changes made before the saved record is known are kept and nothing is written: they apply over the record once it loads (a failed load is retried on the next change), so a write never replaces saved preferences with unseen defaults and a late load never undoes a newer change. Otherwise each change is saved at once. A change made during a write is saved after it, and of several such changes only the latest is written. Outside the desktop application, as in tests, the provider has no store and renders the defaults at once.

A root error boundary (`src/app/AppErrorBoundary.tsx`) replaces the app with a Reload action when rendering throws, instead of leaving a blank window. Each lookup entry (Dictionary page and Reader popup) has its own boundary, so an entry whose imported data cannot be rendered shows a one-line failure in its place and the other entries stay. The Reader adapter's typed errors are not routed through these boundaries.

Accent tokens separate decorative base color from contrast-sensitive ink and action roles. User-selected accent values are mixed toward known light/dark anchors before they are used for text or button backgrounds, so custom colors do not silently make controls unreadable. Muted text tokens remain readable on their supported theme surfaces.

Brand presentation goes through `src/brand/BrandMark.tsx`, which draws the logo in `src/brand/komori.svg`. `node scripts/app-icons.mjs` renders the window, tray and executable icons from that logo and the palettes in `src/brand/appIcons.ts`; replacing the logo changes no page layout.

Komori draws its own versions of WebView2's browser surfaces (`src/app/nativeSurfaces.ts`, hosted by `NativeSurfaces` in `src/components/layout/`). Each guarded document (the app, and each book section the Reader shows) holds an element's `title` aside while the pointer is over it and shows it in Komori's tooltip after 600 ms; answers a right-click that no Komori menu took with Komori's text menu (Cut, Copy, Paste and Select all in a text field, Copy for selected text, nothing elsewhere); opens Komori's option list for a `<select>` (pointer, Enter, Space, F4 or Alt+arrow; arrows, Home/End, letters, Escape and Tab inside) and for a field's datalist suggestions (focus stays in the field; arrows and Enter choose), changing the real control so React and tests see a normal change (pressing an open select again dismisses its list without changing its value); and, after the app's own handlers, cancels browser shortcuts (Ctrl+F/G/H/J/N/O/P/R/S/U, F3, F5, F7), link and image drags, the native middle-button default (Komori owns autoscroll), and modified or middle clicks on links that would open a browser window. Popups for controls inside a modal dialog render inside it. Paste reads the clipboard natively (`read_clipboard_text`, Windows Unicode text, cut at 1M characters) because the web clipboard read shows WebView2's permission prompt. The window is built with WebView2's general autofill off, so no browser suggestion list appears under fields. Every enabled button, select and option shows the hand cursor unless a component chooses another. The color field's swatch opens Komori's picker (saturation and brightness square, hue bar, pointer and arrow keys, Shift for larger steps) instead of the system color dialog.

Reusable primitives live in `src/components/ui/`: `Button`, `IconButton`, `MenuButton`, `ContextMenu`, `Select`, `SegmentedControl` (labelled as `ChoiceField`), `Switch` and `ToggleSetting`, `Stepper`, `TextField`, `ColorField`, `SelectionBox`, `Card`, `EmptyState`, `ConfirmDialog`, `NoticeClose` and `ErrorBoundary`. The shell's own parts (`AppShell`, `PageHeader`, `WindowControls` with `DialogCaption`, `NativeSurfaces`) live in `src/components/layout/`. New UI should reuse these before adding another.

The UI uses local React state for Library loading/import/relink/removal results plus Context only for appearance. It does not introduce a general-purpose client store. Library cards share a reusable accessible context-menu surface that supports pointer context-click, a visible actions button, keyboard navigation, and catalog actions. Missing/unreadable cards also expose a prominent relink action without requiring a context click. Destructive removal uses a focused confirmation dialog with explicit source-file safety copy. A reusable selection hook (`src/features/selection/useSelection.ts`) owns only selection mode and a set of stable IDs (Library catalog IDs, dictionary IDs), dropping IDs that are no longer listed; it supports card/row/checkbox toggling, Select all, Cancel/Escape, and ID-based bulk actions without coupling selection to removal. The Library and Settings → Dictionary sources both use it.

Outside selection mode, each Library card has a keyboard-accessible full-card Reader link at `/reader/:catalogId`; the existing actions menu also offers Reader entry. Selection mode removes that link and continues to toggle catalog-ID selection. The Reader resolves a direct route through the single-record `get_library_book(id)` lookup (no whole-catalog scan or cover backfill), keeps only a narrow projection of that catalog DTO in Reader state, and shows the cover thumbnail from the record's `coverUrl` after validating it (see the cover thumbnails under Native/backend ownership). Unknown IDs, missing/unreadable sources, and native resolution failures have distinct safe shell states. The route and Reader state contain no source path or filename. The unscoped `/reader` direct route remains an empty shell, but is not a shell navigation destination; readers enter books from the Library.

Use a real navigation abstraction for Library, Reader, Dictionary, Statistics, and Settings rather than ad hoc page-switching state.

## Native/backend ownership

Native code owns:

- filesystem access
- database access
- import operations
- security-sensitive capability boundaries
- durable application state

EPUB content must never gain generic filesystem, network, or database access.

Library imports are references, not managed-file copies. Native code presents file pickers through Rust `rfd`, validates and reads selected EPUBs without writing to them, and stores each canonical private source path in `library.sqlite3` behind a stable Komori catalog ID. The versioned schema keeps the source reference unique and separate from the ID. Metadata and bounded raster cover bytes are Komori-owned derived data in that same database. The frontend invokes only `list_library`, `get_library_book`, `import_books`, the book-folder commands `list_library_folders`/`add_library_folder`/ID-scoped `remove_library_folder`/`scan_library_folders`, catalog-ID-scoped `relink_book`, catalog-ID-scoped `set_book_series`/`reset_book_series`, `get_library_store_size`, catalog-ID-scoped `remove_book`/`remove_books`, the Reader's catalog-ID-scoped `get_reading_position`/`save_reading_position`/`save_book_progress`/`save_reading_session`, Statistics' `list_reading_sessions`/`list_library_kanji`/`edit_daily_activity`, Settings' `get_statistics_counts`/`delete_reading_sessions`, the Library's catalog-ID-scoped `mark_book_unread`, the catalog-scoped `list_bookmarks`/`create_bookmark`/`rename_bookmark`/`remove_bookmark`, `list_reader_notes`/`create_reader_note`/`edit_reader_note`/`remove_reader_note`, and `get_appearance_preferences`/`save_appearance_preferences`, the no-argument Reader background commands `get_reader_background`/`choose_reader_background`/`remove_reader_background`, the Startup commands (`get_startup_preferences`/`save_startup_preferences`, `get_startup_book`/`remember_last_book`, and the token-scoped `finish_window_close`), the Backup commands (`get_backup_settings`/`save_backup_settings`, `export_backup`, `open_backup_file`/`open_snapshot`/`restore_backup`, `list_snapshots`/`create_snapshot`/`delete_snapshot`), and the dictionary commands `list_dictionaries`/`import_dictionaries`/`lookup_terms`/`lookup_kanji`/`remove_dictionary`/`remove_dictionaries`/`move_dictionary`/`get_dictionary_store_size`; it receives catalog-safe metadata, availability, typed relink/removal outcomes, and a cover thumbnail URL on the `komori-cover` protocol, and the display paths of the book folders the reader chose, but no source paths, archive paths, discovery diagnostics, or generic filesystem capabilities.

Failures a reader can act on (a damaged or non-EPUB file, a missing book, a duplicate or unopenable book folder, a store from a newer Komori) cross the native boundary as stable `failure.*` codes defined in `src-tauri/src/failure.rs`. The frontend shows them through `failureText` in `src/i18n/failure.ts`, which translates a known code into the interface language and passes any other text through unchanged; unexpected I/O and storage errors keep their English detail. `src/i18n/failure.test.ts` checks that every native code has an entry in every catalog.

At application setup, native code resolves `<app_data_dir>/library.sqlite3` once, migrates it to the current schema, and stores that private path in managed native state; neither setup nor `list_library` reads an EPUB. Books imported before the current cover resolver get their covers on the background startup thread, before missing thumbnails are built: each book is read outside any transaction and the results are saved 50 books per transaction, with the Library refreshing (`library-details-updated`) after each chunk that found covers. Every Library command reuses that exact resolved catalog location. Development and packaged builds with the same application identifier therefore use the same runtime location; automated tests pass explicit temporary database paths and never silently substitute a second live catalog. Legacy or unrelated SQLite files beside `library.sqlite3` are not treated as fallback catalogs.

Catalog identity is independent from the replaceable source reference. Each catalog load checks each source's file attributes (`std::fs::metadata`), without opening it: a missing file lists as missing, and a path that is not a file or cannot be queried as unreadable. Listing never opens an EPUB, so large Libraries list quickly without an antivirus scan per file; the Reader opens and validates a source before reading it. Missing and unreadable files remain visible with explicit statuses. Re-importing an already cataloged canonical source returns an `alreadyImported` result. So does a source another writer adds while the import reads the file: the insert skips a conflicting source path instead of failing. Relinking is scoped to one existing catalog ID: native code opens a single-file EPUB picker, validates the replacement's container and package structure (see Reader content access below) and reads its metadata before starting a transaction, rejects a canonical source already owned by another record, then updates only that row's private source reference and source-derived metadata/cover fields. The catalog ID, import timestamp, and dependent Komori-owned state remain attached to the same row. Cancellation and validation/read failures perform no catalog mutation. Catalog schema version 2 records a native-only cover-discovery diagnostic and resolver version. Resolver version 2 classifies successful resolution, no credible evidence, unsupported representation, invalid/unreadable targets, and safety rejection. Library loading retries coverless rows from older resolver versions, writes newly resolved derived cover data, and records the native diagnostic for unresolved rows.

Native EPUB drops (`src-tauri/src/library_drop.rs`) retain OS-selected paths in
one bounded native slot (at most 2,000 input items), filter any-case `.epub` files
and exclude directories. Windows uses WebView2's DOM file-drag events for Library
feedback and `postMessageWithAdditionalObjects` to transfer actual `File` objects.
The main window disables Wry's native drag takeover so these events reach the page.
The shared document guard prevents default file-drop navigation in the app and
displayed EPUB frames; Library listeners still receive events, and other routes
remain inert. The guard releases its listeners with each document's lifecycle.
The native receiver accepts only the fixed Library message from Komori's Library
route and origin (the configured dev origin only in development), casts additional
objects to `ICoreWebView2File`, and resolves absolute file paths natively. It never
accepts caller-supplied path strings or archive bytes. Other platforms retain the
main-window `WindowEvent::DragDrop` route. `library-file-drag` emits only enter/leave/drop, an
acceptance flag and a random drop UUID; no paths or filenames are in this event.
`import_dropped_books` takes that single-use ID and an operation ID, consumes it
within 30 seconds, and reuses the catalog write lock and read-only import pipeline.
A new staged drop replaces an unused drop; unknown, expired or reused IDs refuse without
catalog mutation. The Library subscribes only while mounted, clears its overlay on
leave/drop/blur, handles nested enter/leave events without flicker, reports an
unavailable File handoff, refuses drops during conflicting actions/dialogs, and shares the
shell import controller's progress, per-file outcomes and catalog refresh. Other
routes do not consume drops. Non-EPUB files are ignored, folders are not scanned,
and duplicate EPUBs retain the ordinary already-imported result.

Native title cleaning (`src-tauri/src/title_cleaning.rs`) embeds
`title-cleaning-list.txt`: nonempty, non-comment lines are literal, case-sensitive
substrings removed wherever they occur, including repeated tags and the listed
unbracketed text. Removal repeats until stable, then trims outer Unicode
whitespace. Unrelated text, punctuation, case/width variants and internal whitespace
remain (so `A (GA文庫) B` becomes `A  B`). No general title/author normalization
is applied. An empty result is null, using the existing Untitled book and filename
fallback. The EPUB metadata reader applies this before new imports, folder imports
and relink store a title. Catalog schema version 7 transactionally cleans existing
cached titles once, including missing/unreadable books, by updating only `books.title`;
IDs, source references, import times, covers and dependent state stay intact. It
does not reopen or edit EPUBs or alter historical session titles. Future changes
to the list that need existing titles refreshed require another catalog migration.

Covers are stored inline, before `imported_at` and `cover_revision` in each row, so
reading a column after them walks the cover's pages. Opening the catalog creates the
index `books_imported` on `(imported_at DESC, id DESC, cover_revision)` without a
schema bump (an older Komori opens it unchanged): the Library list, the startup
details and thumbnail passes, and backup collection and restore matching read the
import order and cover revision from it. Cover presence is read
as `length(cover_bytes) IS NOT NULL`, which SQLite answers from the row header.

Book folders (`src-tauri/src/library_folders.rs`) are two additive catalog tables created without a schema bump: `library_folders` (an integer ID, the canonical folder path, when it was added; at most 64) and `library_folder_files` (every EPUB path a scan met, its source stamp, and whether it is or was in the Library). `add_library_folder` picks a folder natively through `rfd`, refuses one already added, and scans it at once; `list_library_folders` returns each folder's ID, display path (without Windows' verbatim prefix), availability, and how many Library books have their source in it; `remove_library_folder(id)` deletes the folder row, so its books stay, and forgets the met files under it that are no longer a Library book's source unless another folder still covers them, so adding the folder again imports books removed meanwhile; the frontend never passes a path. A scan (one at a time) walks each folder and its subfolders (not following links, 32 levels, 100,000 EPUBs per folder) for `.epub` files of any case, read-only, and imports with the ordinary import only the files it has not met, or met as failed and changed since (size or modified time), so a book removed from the Library is not imported again, nor one already imported; a missing folder is skipped until it returns. The shell scans when Komori starts and the Library on every visit or reload; a scan that imported or failed shows the import notice, and imported books make the Library list again. Folders are not in backups, which hold no paths. Komori does not watch folders while it runs or remove books whose files left them.

Removing a book deletes only its catalog row and row-owned derived metadata/cover bytes. SQLite foreign keys are enabled, so catalog-owned dependent rows such as the Reader position are deleted with the book; reading sessions are kept (see Reading sessions). Single and bulk operations accept Komori catalog IDs only; they never receive, return, delete, rename, move, or modify a source path. Bulk removal reports one result per requested ID so successful deletions persist while missing or failed records remain selected and receive precise frontend feedback.

Book and dictionary imports/removals, including adding or checking book folders,
accept an optional opaque UUID `operationId` for native `bulk-progress` events to
the main window. Events contain only that ID, `completed`, `total` (unknown until
selection/discovery finishes), and `phase` (`picking`, `discovering`, `processing`
or `reclaiming`). Every attempted item advances the count once, after its outcome,
including duplicates, missing IDs and failures. Folder scans discover and deduplicate
eligible files across all folders before publishing one total; already remembered
files remain skipped. There is no estimated percentage or source path in progress.

`src/features/operations/bulkOperation.ts` owns each invocation and its listener,
subscribing before invoking and allowing one tracked action per store. Its small
session snapshot survives page unmounts and retains the last outcome until a page has
shown it: once the last notice showing a finished outcome closes (the page is left),
the outcome is cleared, so it never reappears on later visits; an outcome finished
while no page showed it appears on the next visit. The shell's book import controller
(`src/features/library/libraryImport.ts`) keeps its result and error the same way:
they clear once the Library that showed them is left. Pages observe
it for pending controls/notices, reject stale counts/IDs/phases, reconcile final counts
from the returned item results, and refresh their lists after completion. Late list
responses cannot replace a newer refresh. Empty automatic scans and picker
cancellation retain the preceding outcome. Picker/confirmation cancellation keeps
existing behavior; an accepted deletion stays pending through reclamation.

Single and bulk book/dictionary removals return `{results, maintenance}` natively;
`results` keeps the single outcome or ordered item array, and `maintenance` is null
without a successful deletion, otherwise the existing typed compaction result.
The frontend APIs unwrap the item outcomes while the invocation snapshot retains
maintenance feedback. Once any item is removed, the command compacts its store
once under its write lock, but only when its free pages reach 256 MiB and a tenth
of the database file, otherwise reporting `notNeeded` (the free pages are reused by
later imports). Catalog removals delete in transactions of 200 books, each book
under its own savepoint, so a refused deletion keeps the others and every book keeps
its own outcome. Catalog import/folder/removal commands share a catalog
write lock; dictionary mutations keep their existing write lock. Both stores'
compactions additionally share one native maintenance lock, so only one rewrite
uses temporary disk space at a time. Quitting hides the window and interrupts a
running compaction, which SQLite rolls back; once `VACUUM` is writing the store
back, which it cannot interrupt, quitting waits for it to finish, then exits. The catalog's
first open at startup is read-write (never creating it), so SQLite rolls back a
journal left by a write that a kill or power loss interrupted instead of refusing
to start. Reclamation failure keeps successful
deletions and surviving state, and explains that the next removal tries again (a
compaction rewrites the whole store). There is no manual compaction command; reclamation
happens only after removals.

The Tauri capability manifest grants `core:default` plus only the window permissions the custom title bar needs (`start-dragging`, `internal-toggle-maximize`, `minimize`, `toggle-maximize`, `close`); no generic frontend filesystem, network, database, dialog, or shell plugin is enabled. `scripts/tauri.mjs` only ensures the standard Cargo bin directory is available before delegating to the official Tauri CLI; it does not add native capabilities.

Catalog schema version 6 adds `books.cover_revision` and `book_thumbnails` (one row per catalog ID, `ON DELETE CASCADE`: the revision it was built for, MIME type, bytes). `src-tauri/src/covers.rs` makes a book's thumbnail from its cached cover: a JPEG (quality 85) fitting 400x600 px with the cover's proportions, transparency drawn on white. A PNG, JPEG, WebP, or GIF cover already within those bounds is kept as it is, and a cover in a format the native decoders do not support (such as AVIF) keeps its original bytes for the webview to show. A cover over 12,000 px per side or 256 MiB decoded, or one that fails to decode, gets no thumbnail: the protocol answers 404 and the card shows the title cover, so the webview never decodes pixels Komori refused. Import and relink store the thumbnail in the same transaction as the record; relink and a cover backfill increment the revision. At startup a background thread builds every missing or stale thumbnail, newest imports first, so a Library from before thumbnails converts once; a request that finds none builds it at once.

The webview loads thumbnails as ordinary images from the read-only `komori-cover` protocol (`http://komori-cover.localhost/<catalog UUID>/<revision>` on Windows/Android, `komori-cover://localhost/...` elsewhere), which `list_library`/`get_library_book` return as `coverUrl` (null without a cover). The handler accepts only GET from the main webview and a path of exactly a catalog UUID and a decimal revision, with no query; it never names a file. It answers the current thumbnail with `nosniff`, cached for a year as immutable when the URL names the current revision and `no-cache` otherwise, and 404 for unknown or coverless books. A relink therefore changes the URL and the card shows the new cover. `src/features/library/coverUrl.ts` accepts only those two URL forms before any cover reaches an `<img>`, in both Library and Reader. `BookCover` shows the image as soon as it decodes, with no fade (the cover's plain color stands in), and the title cover when there is no cover or the image fails. WebView2 does not keep custom-protocol responses across a Library remount, but a built thumbnail is served in tens of milliseconds. The production CSP adds only `komori-cover:` and `http://komori-cover.localhost` to `img-src`; `data:` stays for the Reader's inert SVG images.

Book details are Komori-derived catalog data in two additive tables keyed by catalog ID with `ON DELETE CASCADE` (created without a schema bump, so an older Komori still opens the catalog). `book_details` (`src-tauri/src/book_details.rs`) holds a details version, the declared language (the first `dc:language`, normalized to a BCP 47 tag with ISO 639-1 where one exists, so `jpn` is `ja`; `und` names none), the shown language (the language alone, so `ja-JP` shows and groups as `ja`, except Chinese, which keeps its script as `zh-Hans` or `zh-Hant` from the tag's script or else its region, CN/SG/MY or TW/HK/MO; shown tags stored before are reduced when the catalog opens), the book's series and index (Calibre `calibre:series`/`calibre:series_index`, else an EPUB 3 `belongs-to-collection` of type series or no stated type with its `group-position`, prefixed `opf:` or not), and for Chinese, Japanese, and Korean books the character count, unique-kanji count, and the sorted kanji themselves, plus the source's size and modified time. `src-tauri/src/epub/details.rs` counts every linear spine document's text (skipping `linear` values other than `yes` or empty, as EPUB.js and the Reader's progress do) outside the head, scripts, styles, and ruby annotations (`rt`, `rp`), with numeric character references decoded and malformed markup tolerated: characters are letters and numbers, as the Reader counts them; kanji are distinct CJK unified and compatibility ideographs, never Hangul. A book is CJK by the Reader's rule (CJK letters at least half of all letters); then Japanese when kana are at least 5% of its CJK letters, else Korean when Hangul is half, else Chinese, and that text language replaces a declared non-CJK language (exported metadata often keeps a default `en`). Other books with text store their word count instead, as the Reader counts words (runs of letters, numbers and combining marks joined across an internal apostrophe or hyphen, each text node on its own, so a tag ends a word); a details version change counts every book again without touching sessions, notes or progress. Import and relink store details in the record's transaction; at startup a background thread reads every book with no current-version details or whose source size or modified time changed (as when Calibre embeds new metadata), reading only file attributes to decide, and emits `library-details-updated` every 1.5 s of progress and at the end, which the Library answers by listing again. Bump `DETAILS_VERSION` to count every book again. `book_series` holds a series set by hand from the Library (or none, as a null series), numbered in the order given, which overrides the book's own and survives relink; `set_book_series(ids, series)` accepts 1–10,000 UUIDs and a name of 1–200 characters (whitespace collapsed, no control characters) or null, and `reset_book_series(ids)` returns books to their metadata. Neither can create rows for unknown IDs. `list_library` returns `language`, the shown `series`/`seriesIndex` (hand-set first), `seriesManual`, `characters`, `uniqueKanji`, and `words`; the kanji list stays native for statistics.

Reader content access starts with `prepare_book_content(id)`. Native code accepts only a Komori UUID catalog ID, looks up the private source reference in the catalog, opens it read-only, and validates its ZIP container and package document. The package must have a `package` root with `manifest` and `spine` children and at least one spine item naming a manifest item whose file is in the archive; import and relink require the same before any catalog change. This check (`epub::validate`) does not run cover discovery, which belongs to import/relink/backfill; it repeats on every protocol request. It returns a typed `ready`, `unknown`, `missing`, `unreadable`, `invalid`, `tooLarge`, or `failed` result; only `ready` carries a URL containing the catalog ID. The frontend content service accepts only that exact Komori protocol URL and suppresses native error details. Only the EPUB.js adapter calls the content service; Reader components receive a small Komori-owned mount result.

The URL uses the Komori-owned `komori-book` Tauri custom protocol (`http://komori-book.localhost/<id>` on Windows/Android, `komori-book://localhost/<id>` elsewhere). Its asynchronous handler accepts only GET from the main webview with a Komori app origin, re-resolves and validates the ID on every request, and returns `application/epub+zip` binary bytes with no-store, no-sniff, and a restricted CORS origin. A removed or relinked record takes effect on the next request. There is no session handle, extraction directory, or persistent copy to clean up. The handler caps one response at 512 MiB because Tauri's protocol response holds a byte buffer, and sizes that buffer from the file length up front. Production `connect-src` explicitly permits both platform URL forms. No protocol route accepts an archive entry path or arbitrary filesystem path.

This transport gives the EPUB.js adapter one binary transfer instead of repeatedly copying the archive through JSON/base64 IPC. The adapter passes only the catalog URL to EPUB.js, restricts its request method to that exact URL, and lets EPUB.js resolve archive entries internally. No archive entry or source path becomes a native protocol route. The protocol remains a Komori boundary, so another renderer can replace EPUB.js without changing catalog identity or the native source reference.

Catalog schema version 3 adds `reading_positions`, one row per catalog ID with `ON DELETE CASCADE`. It stores only a renderer-neutral locator: spine index, optional 8-hex section fingerprint, and text progress in `[0, 1]`. Native code accepts only a Komori UUID and a bounded, validated locator, and upserts only while the catalog row exists, so a late save cannot recreate state for a removed book. An invalid stored row loads as no position. Relink leaves the row untouched; the Reader decides whether it still resolves in the new source.

## Appearance preferences

Install defaults apply only where no valid value was saved. Loading never writes
them into a record: native appearance loading still returns sparse validated
fields, and the frontend fills missing/invalid ones. Startup, backup and Anki
keep their native defaulting paths; Anki’s missing duplicate scope uses Collection
in native deserialization and the frontend. Valid stored choices (including former
defaults), legacy migrations, backup export and restore semantics stay unchanged.

Scrolling choices share the appearance record: `middleClickAutoscroll` is a boolean,
default `true`, and `readerChapterWheelThreshold` is an integer from 1 through 20
wheel steps, default 3. Native/frontend loads validate each independently, so old
or invalid stored fields use their defaults. Invalid native saves leave the record
unchanged; invalid frontend setters are ignored. Settings > General > Startup and behavior
holds the autoscroll switch; Reader Appearance does not repeat it. Page flow
exposes Chapter wheel threshold in Paginated and Semi-continuous view; the saved value survives view
changes and applies to every book without reflowing or remounting it.

The appearance record saves `readerWesternFont` and `readerAsianFont` independently
as `{ source: "preset", id }`, `{ source: "system", family }`, or
`{ source: "google", id }`. Both roles retain every former catalog option.
Defaults remain Segoe UI (Western) and Yu Mincho (Asian). Native/frontend validation
accepts only preset/curated IDs or one bounded family name, never CSS, a URL or a
path. Missing/invalid choices default independently; invalid setters/saves do not
mutate preferences. Unavailable saved choices remain valid across computers.
When a new field is absent, legacy Group 1 migrates to Asian and Group 2 to Western,
retaining its exact preset ID. A present new field takes precedence, even if invalid;
it never silently resurrects an old choice. The next save persists the migration.
The old allowlisted fields remain readable for compatibility with old records.

Each role's font is an editable dropdown (`ReaderFontControls.tsx`). Its arrow
opens Komori presets, downloaded Google families, imported faces and `On this
computer`. Native `list_system_fonts` enumerates Windows GDI families (dropping
vertical aliases and unsafe names), sorted and without duplicates, once per run;
150 matching installed families are shown at a time. Typing edits the family
directly: Enter or leaving applies a valid whole name, including an unavailable
name; Escape cancels. Arrows and Enter also choose suggestions. Native
`check_system_font` checks exact installation without mistaking fallback for it and
returns validated GDI full face names, weights and styles for local Reader aliases.
Unavailable saved choices stay selected with fallback feedback. Chrome keeps Inter.

The adjacent + on either row opens `ReaderFontManager`, a floating modal with
search, local Import fonts, added-font removal, and Asian/Western Google groups.
Each static weight has its own Download/Remove action; variable faces show their
supported weight range and download once for that range. Pickers never download.
The shared `googleFontCatalog.json` defines 24 families (13 Asian, 11 Western),
including Klee One 400/600, Zen Old Mincho 400/500/600/700/900, Noto Japanese,
Simplified Chinese and Korean serif/sans families, and Western serif/sans choices.
`scripts/update-reader-font-catalog.mjs` reproduces paths, weights, exact sizes,
font hashes and OFL hashes from Google Fonts commit
`9710da1eacb3be272583c3224dcb70f9da6eadbb`. Existing regular IDs/hashes remain valid.

`reader_fonts.rs` deserializes that same owned catalog. WinHTTP fetches fixed
HTTPS paths on `raw.githubusercontent.com` only, refuses redirects, uses timeouts
and a 32 MiB font/16 KiB license cap, and verifies size and both hashes before
atomic publication under `<app_data_dir>/reader-fonts`. Native writes are serialized.
Only fixed owned files are removed; reparse points/symlinks are refused and known
partial directories are cleaned at startup. Failure keeps a download retryable.
Each restart listing verifies bytes/licenses. Removal retains the saved choice
and triggers fallback/reflow; downloading again makes the selected family usable.

`import_reader_fonts` opens a native multi-file TTF/OTF picker, reads each source
without writes (100 MB / 100,000,000 bytes each; 128 managed imported faces maximum), validates its
sfnt face with `ttf-parser` and extracts a bounded family, weight/range and style.
Collections, compressed webfonts and invalid files are refused. Valid files are
copied atomically to `upload-<SHA-256>/font.ttf`; identical imports deduplicate.
Partial failures report failed imports while retaining successes; cancellation
retains existing fonts. Imported choices persist as `{source:"uploaded", id}`,
where id is a lowercase SHA-256, independently validated on load/save and in the
adapter. Listings reparse/hash-check owned files; a removed choice falls back.
All imported weights/styles of a selected family feed its Reader alias. Fonts
are never installed into Windows. Managed fonts remain outside portable backups;
restored selections require importing/downloading on that computer.

Native commands accept bounded family names, fixed font IDs or imported hashes,
and an opaque operation UUID; no source path or caller URL crosses IPC. Progress
is scoped to the operation/face and its pinned size. `readerFonts.ts` owns one
pending action/listener across panel unmounts, ignores obsolete progress/list
results, and validates listed metadata and exact owned URLs. The existing Reader
presentation queue handles availability/weight changes without remounting; each
downloaded static weight or variable range gets its own `@font-face`, and layout
waits for the actual selected weight. Each role has an independent Weight dropdown:
managed static faces contribute only their available weights; variable ranges
contribute 100-step choices within their bounds plus their exact endpoints.
Imported normal faces of the selected family are grouped, with italic faces used
when that family has no normal face. Missing managed resources disable the weight
control. Presets/system fonts retain the 100–900 menu; Windows/CSS chooses supported
local faces and glyph fallback. Generic fallback families remain platform-owned.
`readerWesternFontWeight` and `readerAsianFontWeight` persist whole CSS weights
1–1000 (default 400). An absent role migrates the valid legacy shared
`readerFontWeight`; a present invalid role defaults independently. The legacy field
remains readable. Availability resolves a saved unsupported preference by CSS
matching order without overwriting it, so a re-added face restores that preference.
The adapter maps script-specific face aliases onto the book's CSS weights: static
faces select real files/local names and variable instances pin their `wght` axis.
Publisher numeric/relative/inline emphasis contributes actual computed weights,
without splitting text nodes or changing locations/ruby. The existing queue reflows
weight/resource changes at the retained anchor, including late section documents.
The read-only main-webview `komori-font`
protocol accepts only exact catalog ID/hash paths or `/uploaded/<hash>.ttf`,
re-verifies bytes, refuses methods/queries, and uses `nosniff`/`no-store`. CSP
still permits only this protocol in `font-src`; network capabilities are unchanged.
Google OFL licenses stay beside their unmodified fonts. Source/license references
are in `real-data-and-safety.md`.

The appearance record saves Reader-only `readerPopupDefinitionSources`, `readerPopupFrequencySources`, and `readerPopupPitchSources` independently. Each is `{ mode: "all" }` (legacy/default), `{ mode: "none" }`, or `{ mode: "selected", ids: [...] }`. IDs are unique positive safe integers (at most 128 per role); an empty explicit list is valid. Native and frontend validate each stored role independently, omit invalid roles on load, and reject invalid saves/setters without mutation. Explicit IDs survive reorder and the retirement of the global enable switch. Removed IDs stay unavailable and never select a reimport's new ID. All uses every eligible imported source, including new imports; None and empty/unavailable explicit choices never fall back to All. These preferences do not change standalone Dictionary or global order.

The appearance record stores the complete Reader lookup trigger preferences, validated independently on native/frontend load and native save. Booleans `readerPopupShiftLookup` and `readerPopupKeyboardShortcut` default to `true`; `readerPopupMouseSelection`, `readerPopupClickLookup` and `readerPopupHoverLookup` default to `false`. `readerPopupShortcutPreset` accepts `shift-enter` (default), `alt-x`, or `ctrl-space`; `readerPopupMouseTrigger` accepts `left` (default), `double`, `shift-right`, or `middle` (a middle press on readable text scans it in the window's capture phase, ahead of autoscroll and popup closing, and suppresses its auxclick; on blank space autoscroll proceeds); `readerPopupCloseBehavior` accepts `escape-outside` (default), `outside`, or `persistent`; `readerPopupHoverDelay` (Scan delay) accepts integer milliseconds from 0 through 1200, default 0; `readerPopupScanLength` 1–64 characters, default 16; `readerPopupMaxResults` 1–64, default 5; `readerPopupChildLevels` 0–5, default 5 (0 turns child popups off); `readerPopupReadingPosition` accepts `beside` (default) or `above`. Missing/invalid stored values fall back independently. Native saves reject an invalid record without mutation; frontend setters ignore invalid fields. Settings saves each choice immediately, keeping Mouse selection independent.

The appearance record stores `readerPopupShowPitch` and `readerPopupShowFrequency`, independent booleans defaulting to `true`. Native saves reject non-boolean values; native/frontend loading drops missing or invalid values independently, retaining enabled legacy defaults. The retired `readerPopupPitchBeforeDefinitions` field is ignored and omitted from subsequent saves. Settings > Reader popup saves Show pitch and Show frequency immediately. Show pitch hides/restores the complete pitch section above each headword's definitions. Show frequency hides/restores term frequency chips under the headword and kanji frequency rows. Lookup results, source-name visibility, independent definition disclosures, frequency expansion, and book mount stay intact without another lookup. Standalone Dictionary always retains its frequency and pitch metadata in its existing layout. There are no placement controls.

The appearance record stores `readerPopupShowDictionaryNames`, a boolean defaulting to `true`. Native saves reject non-boolean values; native/frontend loading drops missing or invalid values independently, preserving enabled legacy defaults. Settings > Reader popup saves Show dictionary names immediately. It controls only visible frequency and pitch source names in Reader popups, including kanji frequencies. Hidden names remain accessible text, with source tooltips retained; metadata values, row/pattern order, contours, marks, tags, frequency expansion, and definition source headings/state stay intact. Toggling it does not repeat lookup or remount the book. Standalone Dictionary metadata always keeps its source names.

The appearance record also stores `readerPopupEnabled`, a boolean defaulting to `true`. Native saves reject non-boolean values; native/frontend loading drops a missing or invalid value independently, so legacy records keep lookup enabled. Settings > Reader popup saves each change immediately. The record also stores `readerPopupVoiceAction`, a boolean defaulting to `true`, with the same independent legacy/invalid loading and native non-boolean rejection. The Voice action toggle hides pronunciation buttons only in Reader lookup entries; reenabling restores them as they were. Removing a button stops its active playback through the shared pronunciation cleanup. Standalone Dictionary controls remain available regardless of this preference.

Catalog schema version 4 adds `preferences`, one JSON record per name. `src-tauri/src/appearance_preferences.rs` owns the `appearance` record: `theme` (Light, Dark, Sakura, Matcha, Hojicha, Midnight, Ember, Forest preset IDs, or `custom`), `accentColor` (`#rrggbb`), `readerWheelStep` (10–2000 px in steps of 10), `readerFontSize` (8–72 px), `readerLineHeight` (1–3 in steps of 0.05), `readerFontWeight` (100–900 in steps of 100), `readerParagraphIndent` (0–20 em in steps of 0.5), `readerParagraphMargin` (0–200 px in steps of 2), `readerLetterSpacing` (−10–60 whole px) and `readerWordSpacing` (−20–120 whole px), validated independently, `readerMaxWidth` and `readerMaxHeight` (100–1,000,000 CSS px in steps of 10; live control limits come from the current monitor), `readerPageLayout` (`single` or `double`), `readerWritingMode` (`horizontal` or `vertical`), `readerTextOrientation` (`mixed` or `upright`), `readerHideFurigana` (a boolean), `readerBlurImage` (a boolean), `readerViewMode` (`continuous`, `semi-continuous`, `paginated`, or `vn`), `readerSidebarPinned` (a boolean), `readerTheme` (a preset's ID, or the ID of one of the custom themes), and `readerCustomThemes` (at most 32 custom Reader themes, each `{ id, name, background, text, highlight, selection, footerText }`: a lowercase UUID unique in the list, a name of 1–40 characters with no surrounding whitespace or control characters, and five `#rrggbb` colors; anything else a stored theme carries is dropped, so a theme is never CSS). A save naming a custom theme not in the list is rejected. When loading, each stored custom theme is kept on its own, the first of a repeated ID and the first 32 only, and a chosen custom theme that was not kept is left out. Native code rejects a save with any invalid field and leaves the stored record unchanged. It validates each stored field on its own when loading, so a missing, invalid, or unknown field is left out and unreadable JSON loads as nothing saved. The frontend applies its default for anything left out, including records saved before a field existed. The older `readerWheelSpeed` field is ignored. The record also stores `readerPopupWidth` (320-1200 px) and `readerPopupHeight` (200-1200 px), each in steps of 20; missing or invalid saved fields default independently to 480 x 440 px. Settings > Reader popup exposes editable steppers; dimensions are requested sizes and placement still clamps or shrinks to fit the reading area. The record also stores `readerPopupTheme` (`application`, `classic`, `paper`, `night`, or `custom`), default Application. Missing or invalid saved choices default independently; invalid saves are rejected without changing the record. The record also stores `readerPopupRadius` (0-28 px in steps of 1), default 18 px. Missing or invalid stored radii default independently of palette and dimensions; invalid saves leave the record unchanged. New preferences need no schema change. `src/features/appearance/appearancePreferences.ts` mirrors this validation and holds the defaults: Hojicha application theme, `#b8743c`, wheel step 100 px, 16 px, line height 1.65, font weight 400, paragraph indentation 1 em, paragraph margin 0 px, maximum text width 4000 px, max height 4000 px, double pages, Horizontal writing mode, Mixed text orientation, furigana shown (`false`), images unblurred (`false`), paginated view, a floating Reader sidebar (`false`), the Hojicha Reader theme, and no custom themes. No Reader setting defers to a book's own or an automatic value: every one is the reader's choice, or its default, for every book. One structured `readerPopupCustomPalette` stores `{ background, text, accent, border, tag }`, five `#rrggbb` colors, initially Classic’s colors. Native/frontend loading drops the entire palette when any color is missing or invalid while keeping other preferences independently; unknown properties are dropped. Invalid saves leave the record unchanged. Frontend colors normalize to lowercase. A missing palette, including when Custom is selected, uses the initial palette. Selecting another palette preserves the saved custom colors.

The appearance record stores `interfaceLanguage`: `en` (default), `ja`, `zh-CN`, `ko` or `pt-BR`. Chinese ships in Simplified characters (`zh-CN`). Native (`src-tauri/src/interface_text.rs`, `LANGUAGES`) and frontend (`src/i18n/languages.ts`) validate it like the other fields: an invalid save is rejected without mutation and a missing or invalid stored value loads as English. Settings > General's Appearance card starts with an Application language row; each language is named in itself. `src/i18n/i18n.tsx` is the only message lookup. `src/i18n/messages/en.ts` is the source catalog, and every user-visible string, accessible name, notice and error shown to the reader is a key in it; the other catalogs hold the same keys and placeholders, a missing key falling back to English. Plurals use `key_one`/`key_other` with `Intl.PluralRules` (Brazilian Portuguese counts zero as plural), and `{name}` placeholders format numbers in the language. Dates, numbers, relative times, lists, language names and sorting use `Intl` with the interface language. Brazilian Portuguese compact counts use K/M/B/T with localized decimals (23K, 12,3M). Japanese and Chinese catalog text joins counts, Latin names and placeholders to surrounding text without added spaces; Korean retains normal word spacing and attaches count suffixes and grammatical particles. Imported text is untouched. Components read the translator with `useI18n()`; code outside components uses `i18n()`. Notices that outlive a render keep a key or a function, so they follow a later language change. `AppearanceProvider` wraps the app in `I18nProvider` and sets `document.documentElement.lang` before paint, so a saved language that loads within 2 s applies on the first frame (a slower load shows English first and applies the saved language when it arrives, unless the reader changed it meanwhile) and CJK text gets its fonts and line breaking. A change re-renders in place: nothing remounts, and the Reader keeps its book, place and panels. Native text the reader sees follows the saved language: the tray's Show Komori and Quit items (relabelled at once on a save or restore) and native dialog titles, file-type filters and the default backup file name. Book and dictionary content, imported names, Anki field data and native diagnostic details (which stay English) are not translated.

The appearance record also stores `appIcon`, one of the sixteen icons in `src/brand/appIcons.ts` (`beige` by default), validated natively against `src-tauri/src/app_icon.rs` (`APP_ICONS`, which a test keeps equal to the frontend list) like the other fields. `appIconSvg` builds each icon from the logo; `node scripts/app-icons.mjs` renders every one to `src-tauri/icons/app/<id>.png` (128 px, embedded in the executable) and the default as the executable's full icon set. Native applies the saved icon at startup, on every saved appearance change and after a restore: Tauri's window icon plus the big icon (`WM_SETICON`, `ICON_BIG`) that the taskbar and Alt+Tab show, and the tray icon. The executable, its shortcuts and a pinned taskbar button while Komori is closed keep the built-in default.

Application colors are defined in `src/features/appearance/appThemes.ts`. Eight presets supply a light/dark base, Background, Surface, Text, and their own accent, which the app shows while the preset is chosen (`resolveAppAccent`). One custom application theme is stored as `appCustomTheme: { base, background, surface, text }`, with a light/dark base and three `#rrggbb` colors; the saved `accentColor` is its accent, edited with its other colors. Native and frontend validation drop unknown fields and reject invalid saves. The custom theme initially uses Hojicha’s Light base, Background `#f1eadf`, Surface `#fbf7f1`, Text `#34291f` and accent `#b8743c`. Settings has no separate accent picker. Surface, text, and border tokens derive centrally from these colors; the app fills its window without an inset outer frame. Reader book colors stay separate.

The appearance record also stores `libraryView` (grid/list), `librarySort` (recent/added/title/progress/characters/words; a saved retired `pages` loads as nothing saved), `librarySortReversed`, `libraryFilter` (all/reading/completed/not-started), `libraryGroup` (none/series/language), and `libraryCardSeries`, `libraryCardLanguage`, `libraryCardKanji`, `libraryCardLastRead` booleans, and `libraryCardSize` (the narrowest a grid card may be: 100–480 px in steps of 10). Defaults are grid, title, normal direction, all books, no groups, Series, Unique kanji, Language and Last read on, and 180 px cards. Missing/invalid stored values use those defaults.

The appearance record also stores how reading statistics are recorded (`src/features/statistics/statisticsPreferences.ts`): `statisticsEnabled` (boolean, default true), `statisticsSessionStart` (`auto` (default), `first-read`, or `manual`), `statisticsJumpLimit` (0–100,000 whole characters or words, default 5,000; 0 never ends a session), and `statisticsIdleMinutes` (0–120 whole minutes, default 5; 0 never stops counting). Each is validated on its own like the other preferences; native saves reject invalid values without mutation. Settings > Statistics saves each at once.

## Settings navigation

Settings uses a category-navigation layout with seven sections (`/settings?section=<id>` opens one), in one continuous list: General, Storage, Shortcuts, Reader popup, Dictionary, Statistics and Anki. The `section` values `appearance` and `library` open General, and `backup` opens Storage. The current category has its icon and title above its cards; its description shows only in the navigation. Its navigation button is `aria-current="page"`, and each button is described by its description line. Navigation writes the section URL, follows URL/history changes without remounting Settings, and preserves other query parameters. The sticky sidebar scrolls independently in short windows, keeping every category and Komori's version reachable; compact widths place the navigation above the cards. Choosing a compact category scrolls its heading below the title bar into view, including an already-active category, while keeping keyboard focus on its navigation button; on roomy widths a category visit scrolls only when the previous section left the new heading above the view, and the sticky sidebar scrolls itself to keep the chosen category visible, including one opened by URL. General holds Appearance (the application theme gallery and custom theme editor with its accent), Library (one grouped box: Card size, a Book folders header row with secondary Add folder and Check for new books, then a row per folder or the empty row) and Startup and behavior (Launch at startup, Restore last book, Remember window size and position, Minimize to tray, backed by the native startup store (see Startup preferences), and Middle-click autoscroll). Storage holds Disk space (the Library and dictionary sizes, read again after each removal), Backup (Automatic local backups, Frequency, Keep, then Export, Import and Create snapshot rows) and Snapshots (one grouped box with a row per snapshot: date, kind, size, with Restore and confirmed Delete at the standard button size); an import or snapshot restore opens a preview dialog and changes nothing until Restore is confirmed, then reports the restored books and sessions and names books not in this Library (see Backups). Shortcuts lists grouped bindings and their current availability, with the configured Reader lookup shortcut (see Shortcuts), every context's table on the same fixed columns (28 / 38 / 34 %). Reader popup holds, in order, Reader lookup popup (behavior and content switches), Lookup appearance (popup themes, custom colors, width, height, corners, reading position), the real preview, Dictionary cards (Term, Frequency, Pitch sources), Lookup triggers and Scanning and results. Dictionary links to Reader popup and keeps import, per-row selection/removal and ordering. Statistics holds Reading sessions (Record reading statistics, Session start, Jump limit) and Recorded statistics, with how many sessions Komori holds and two confirmed deletions done natively: statistics of books no longer in the Library (disabled when there are none) and all reading statistics; books, progress and positions are never deleted there. Every setting is a row of a rounded grouped list (`.settings-list`): switches (`ToggleSetting`, its description read as the switch's accessible description), fields (`.settings-field`: label and `.settings-field__hint` on the left, the control centered on the right) and actions (`.settings-row`); stepper units read as words (`16 characters`, `0 ms`); each card has its own icon; extra detail opens from a `.settings-disclosure`. Anki's connection port and key, deck, note type and duplicate choices (with Include child decks as a switch) are rows too, its field contents stay one table, and its explicit Save configuration sits at the right of the card's end, like every other action, with pending, success and failure feedback. Appearance and Reader preferences save immediately through the existing native appearance store.

## Shortcuts

Ctrl+A (or Meta+A) keeps native select-all in text inputs, textareas and editable
text, including descendants and read-only text fields. Elsewhere the shared
document guard cancels page/book select-all after Komori's handlers, in both the
application and every EPUB document published through the renderer adapter;
ordinary book-text selection and lookup are retained. While Library selection is
active, it replaces the selection with every stable ID in the current searched,
filtered and grouped collection, including unrendered virtual rows/carousel cards.
Settings > Dictionary sources selection selects every installed ID in native
order, including sources disabled for lookup. Collection keys accept exactly Ctrl
or Meta, without Shift/Alt, composition, repetition or an already handled event.
They apply from that collection or its selection toolbar, or the unfocused page;
other focused Settings/shell controls, editable text, selects, menus, listboxes
and open modal dialogs never change the background selection. Source-policy
dialogs retain their existing manual choices and Apply/Cancel behavior. Escape
and Library Delete keep their existing actions within the same collection scope.

`src/components/ui/SelectionBox.tsx` shares the Library's rounded box, accent check,
focus outline and disabled treatment across native checkboxes/radios and existing
choice indicators (Library menus, application themes and Komori select options).
The real input covers the box for pointer use and keeps native keyboard/label
behavior. Dictionary maintenance, popup role choices, Series and Anki child-deck
choices use it without changing their eligibility, persistence or action policies.

`src/features/reader/shortcuts.ts` shares command bindings between dispatch and
Settings > Shortcuts (`/settings?section=shortcuts`). The reference groups Library,
Reader, lookup, popup, gallery and control keys, including the saved lookup preset
and enabled states. Ctrl+F in Library focuses search. The application shell owns
Ctrl+D/S/G for Dictionary/Statistics/Settings from Library and each of those pages;
Ctrl+B returns to Library from Dictionary, Statistics and Settings. A shortcut to
the current page keeps its existing state. Reader G opens Images, B saves a quick bookmark, R goes to the last bookmark, N creates
a selected-passage note, S toggles even a pinned sidebar (hiding leaves Appearance, so it
reopens on the reader controls), A opens Appearance and a second A returns to the controls,
Ctrl+F focuses Find, Ctrl+B opens Bookmarks, and P starts, pauses and resumes the reading session.

Commands accept exact modifiers, with no composition, repeat, handled events or
editable targets. Reader commands also work while a button or link is focused (such
as a sidebar or Appearance control just clicked), whose own keys are only Enter and
Space; selects, menus, listboxes, comboboxes and dialogs keep their keys. Identical dispatch is attached to EPUB documents. The topmost
lookup owns Alt+E (existing Add action), Alt+B (existing Browser action only) and
Alt+wheel down/up (next/previous expression, clamped). Expression navigation scrolls
the popup's own body to the entry's beginning, including when the previous entry
is taller than the viewport; it never scrolls an ancestor or book. The active entry
has a screen-reader status without a visible indicator line.
Pointer/focus also chooses the active expression. Disabled/missing Anki actions
stay unavailable and their shortcuts never bypass native readiness, duplicate,
pending or failure handling. Popup wheel handling consumes the event before book
scrolling/turning, including when focus remains in the EPUB.

Escape dismisses an open gallery/dialog, deepest dismissible lookup or floating
sidebar first. With Reader/book focus (a Reader button or link included; text
fields, menus, listboxes and dialogs keep their own Escape) and no such dismissal, the first press shows
an accessible floating warning ("Press Escape again to return to library."); a separate second press within 1,800 ms returns
through the existing Library navigation and reading-state lifecycle. Timeout,
another key/action, pointer/wheel input, focus loss, book change and leaving the
Reader clear the warning. Held Escape never confirms.

Plain Escape in the Library, Dictionary or Reader search field (`searchEscape`)
releases its focus, even when empty, and goes no further. Library search also
clears its query; Dictionary and Find in book keep their query and results, and
Find hands focus to the book without arming the Library return.

On Windows the main window swallows the bare-Alt `SC_KEYMENU` command
(`src-tauri/src/alt_menu.rs`). Komori has no menu bar, but releasing Alt after a
short Alt+wheel would otherwise enter Windows' invisible menu mode, which eats
ordinary wheel input until Alt is pressed again. Alt+Space and every other window
command stay native.

## Window size

`src-tauri/src/window_size.rs` owns the main window's size and place. Remember window size and position defaults on; when off, setup ignores the saved record and opens at the configured default without restoring maximization, and every resize/close write, including an already queued write, is skipped. The previous record stays unchanged. Turning it on resumes saving on the next resize or close. The configured window is not created automatically (`create: false`); at setup native code reads the `window` record in `preferences` and creates the window from its configuration at the restored inner size in logical pixels, maximized if it was maximized, so the window never shows at another size first. A saved size below the configured minimum (960x640) opens at the minimum. A saved size larger than the primary monitor's work area (where the window is centered), an unknown work area, or a missing, unreadable, or invalid record opens at the configured default of 1440x900; a saved maximized state is kept even then. The default and the minimum are each made no larger than that work area (in logical pixels), so on a small or highly scaled screen (1080p at 150% or 200%) the first window and its title bar fit. After the window moves to another monitor or its scale changes, the minimum becomes the configured one again or that monitor's smaller work area. Native code records the inner size on each window resize and saves it once the size has settled for 500 ms and again when the window closes. While maximized, the record keeps the size from before, so un-maximizing after a restart returns to it, and a minimized window leaves the record unchanged. The record also keeps the window's outer position in physical pixels, saved with the size; the window reopens there unless less than 120x40 px of its top edge would show on any screen's work area, and then opens centered. A record without a position opens centered. The frontend has no window-size command.

## Closing

Tao runs the event loop through a hidden top-level window, "Tao Thread Event Target", on the main thread. While Komori's window is minimized, Windows' main-window heuristics (`taskkill` without `/F`, `Process.CloseMainWindow`) pick that hidden window, and its default `WM_CLOSE` handling would destroy it, after which the event loop never wakes to exit and closing Komori's window leaves the process running without a window. `src-tauri/src/event_target.rs` subclasses the hidden window at setup so a `WM_CLOSE` sent to it is posted to Komori's main window instead, which then closes through Komori's normal path.

`src-tauri/src/window_lifecycle.rs` owns that path; a pure decision state (close requested, frontend acknowledged, deadline elapsed, tray Show and Quit, second launch, deciding flush, hide, show and focus, or exit) is unit-tested apart from Tauri, and the single-instance callback goes through it. Minimize to tray defaults off, so closing (`WM_CLOSE`, `SC_CLOSE`, or the custom title bar), whether shown, maximized or minimized, saves and exits (see the flush rules under Reading position: a write that fails keeps the window closing and is logged, not retried). When on, closing hides the same window and keeps its Reader mounted, with a native tray icon. Clicking the icon or its Show Komori menu action shows, un-minimizes and focuses the window; Quit always saves and exits. Only one Komori runs at a time (`tauri-plugin-single-instance`, registered first): opening it again, from a shortcut, the pinned button or the executable, even while it waits hidden in the tray, shows, un-minimizes and focuses the running window the same way, and the second process exits without opening the catalog. The tray is prepared before enabling the choice, so a failed tray creation cannot strand a hidden window. Disabling the choice removes the icon and shows the window. Window size is saved on the native close request when its preference is on. Native prevents the close and sends a one-time `komori-window-closing` token; `src/app/windowLifecycle.ts`, installed before React mounts, pauses hidden reading time and awaits registered position, progress, session, note, appearance and startup writes before `finish_window_close` acknowledges that token. Only the matching pending token hides or exits; repeated closes share it, and Quit upgrades a pending hide. A 5 s native deadline closes even if the webview is unavailable. Showing emits `komori-window-visible`, so hidden time never counts even when WebView2 still reports a visible document.

## Startup preferences

`src-tauri/src/startup.rs` owns the validated `startup` preferences record: `launchAtStartup` (default false), `restoreLastBook` (true), `rememberWindowSize` (true), and `minimizeToTray` (false). Missing or invalid stored fields use their own defaults. Settings > General loads through `get_startup_preferences` and saves one changed boolean at a time through `save_startup_preferences`; controls wait for native confirmation, with load retry and write failure feedback. The frontend never receives or supplies an executable or registry path.

On Windows, `startup/launch.rs` reads the real current-user `Software\Microsoft\Windows\CurrentVersion\Run` value named Komori and its matching `Explorer\StartupApproved\Run` value. An absent entry or a Windows-disabled approval reports off regardless of the cached preference. Enabling writes the quoted current executable and removes only Komori's approval value so Windows enables the entry; disabling removes only these two values. An unrelated startup choice never rewrites the launch entry. A failed registry or catalog change restores the exact previous value types and bytes, reporting a rollback failure explicitly. Startup choices are in backups; restoring an enabled launch choice registers the executable performing that restore.

After a catalog book becomes Reader-ready, `remember_last_book` keeps its UUID in the native `last-book` preferences record even while Restore last book is off. On the initial `/` route, `get_startup_book` returns it only when restoration is on, its catalog row exists, and its private source is a readable file by the Library's attribute check. A missing, removed, invalid or unavailable record opens the Library, without substituting an older book; a failed read or a read taking over 2 s also opens the Library. The Reader then uses its normal saved locator and source-validation fallback. Direct routes stay unchanged. The application-root Library import controller scans book folders at startup even when the destination is the Reader, retaining its results for the next Library visit. The last book ID is runtime state and is not in backups.

## Updates

`src-tauri/src/updates.rs` checks the project's GitHub releases through `tauri-plugin-updater` (rustls). The endpoint (`https://github.com/Yuu-4chan/komori/releases/latest/download/latest.json`) and the minisign public key are fixed in `tauri.conf.json`; the frontend supplies no URL and has no updater plugin permission. `requireSignedVersion` makes the updater refuse a signature whose signed version differs from the version the manifest announces, so a manifest cannot pair a new version number with an older signed installer; no insecure-transport, invalid-certificate or downgrade allowance is set. `check_for_update` returns null or `{version, currentVersion, notes}` (release notes trimmed to 20,000 characters) and keeps the found update natively; `install_update` installs only that kept update (`failure.updateGone` otherwise), downloading it, verifying its signature, running the NSIS installer in passive mode and exiting. Before installing, the frontend awaits the same pending writes as closing (`flushPendingWrites`).

The startup record's `checkForUpdates` (default true, in backups) makes `UpdatesProvider` check once, 5 s after launch; a failed automatic check stays silent. Settings > General's Updates row shows the version or the check's state and a Check for updates button (Show update once one is found), and reports manual failures. A found update opens a dialog with its version, the release notes rendered as plain headings and bullet lists, Later, and Install and restart.

`pnpm tauri:release` builds with `src-tauri/tauri.updater.conf.json` (`createUpdaterArtifacts`), which signs the installer with `TAURI_SIGNING_PRIVATE_KEY` and its password, then `scripts/release-manifest.mjs` checks that `package.json`, `tauri.conf.json` and `Cargo.toml` agree, that `CHANGELOG.md` has a section for the version and that the installer's signature verifies against the configured public key for that version (the same key, installer and signed-version checks the updater makes), and writes `latest.json` with that section as the notes. The signing key and its password come only from the environment (locally) or the release workflow's secrets; `*.key` is ignored by Git, and tests and `scripts/check-release.mjs` fail if a key appears in a tracked file or the release output. `scripts/tauri.mjs` builds with `--remap-path-prefix` for the repository and the Cargo home, so executables name no build-machine path. `.github/workflows/release.yml` runs on a `v<version>` tag on Windows: `pnpm validate:release`, `pnpm tauri:release` with the secrets, `scripts/check-release.mjs`, then a draft GitHub release with the installer, its signature, `latest.json` and SHA-256 sums; publishing the draft releases the update. `docs/release-checklist.md` lists the owner's manual release checks. The installer's uninstaller offers to delete Komori's application data and removes the Launch at startup value; an update keeps both.

## Backups

`src-tauri/src/backup.rs` owns backups of Komori's own data. A backup is a JSON file (`.komoribackup`, `{ format: "komori-backup", version: 1, createdAt, komoriVersion, preferences, dictionaries, books, sessions }`) holding the `appearance` record (only its valid fields), the Anki configuration, the backup settings, the saved startup choices, every catalog book with its catalog ID, source file name and size, title and author, its hand-set series (a null name is No series), position and progress with their saved times, and bookmarks/notes, and every reading session with its book ID, kept title and `finishCleared`. `dictionaries` lists the installed dictionaries as `{ id, title, revision }` (none when the dictionary store cannot be read), because dictionary IDs are local to each installation. It never holds EPUBs, dictionary content, source paths, covers, details, the window size, or the Anki request journal. Export reads the catalog in one read transaction and writes through a native save dialog, to a `.partial` file renamed into place. Backups and snapshots share one 256 MiB limit: a backup that would serialize larger is not written (export reports it failed, and a restore whose snapshot cannot be written is refused), and import reads at most that much. Import picks a file natively (or names a snapshot by ID), and refuses without changes a file that is not JSON with the Komori format marker (`foreign`), a later version (`newer`), or anything Komori would not have saved, including unknown fields (`damaged`). A valid backup becomes a preview (books, how many match this Library, the unmatched titles, places, bookmarks, notes, sessions, whether settings are included) held natively behind a one-time token; the frontend never sees a path. The preview names only non-zero contents, and words a backup with no books or no matching books as such rather than as zero counts. Books match by catalog ID, then source file name and size, then file name, title and author, then title and author; after the catalog ID each step needs exactly one unmatched book on each side to fit, so an ambiguous book stays unmatched and the preview names it; each catalog book matches once. `restore_backup` first saves a `restore` snapshot (refusing if it cannot), then in one transaction replaces the appearance and Anki records (removing one the backup lacks, so defaults apply; when the backup lists its dictionaries, the popup's Term, Frequency and Pitch source selections and each Anki mapping's `{{dictionary:N}}` placeholders and tag dictionaries are pointed at the dictionary installed here with the same title and revision when exactly one dictionary on each side has them, and the others are cleared: removed from a selection, which then selects nothing rather than All, and removed from templates and tag dictionaries; a backup without the list restores its IDs as they are), the backup settings, and each matched book's hand-set series, position, progress, bookmarks and included notes with the backup's, including their absence; sessions are added by ID, the backup's version replacing the same session, moved to the matched book, and those of unmatched books keep their title as removed books. Books the backup lacks are untouched. When startup choices are present, the native restore also applies the Windows launch entry and tray choice, refusing the restore if the entry cannot be changed and rolling it back if the catalog restore fails. A backup made before Startup choices leaves them unchanged. Afterwards the frontend reloads the appearance record (`reloadAppearance`); General reads the restored startup choices when opened.

Version-1 backups include an optional `notes` array per book, with validated locator, passage, body and timestamps. Current exports always include it. An absent array in an older backup leaves existing notes untouched; a present array replaces exactly the matched book's notes, including an empty array clearing them. Restored notes receive fresh UUIDs; unmatched books stay untouched. Snapshots use the same contract and retain the notes from before a restore.

Snapshots are backup files in `<app data>/backups`, named `<kind>-<Unix ms>.komoribackup` with kind `automatic`, `manual` or `restore`; commands accept only such an ID. The `backup` preferences record holds `automatic` (default true), `frequency` (`daily`, `weekly` or `monthly`: 1, 7 or 30 days) and `keep` (3, 7 (default), 14 or 30), each validated on its own; invalid saves are refused. A background thread checks 30 s after startup and then hourly, and saving the settings checks at once: when automatic backups are on and the newest automatic snapshot is at least the frequency old (or dated in the future), it takes one. The newest `keep` automatic snapshots and 3 `restore` snapshots are kept; manual ones stay until deleted. Import backup and a snapshot's Restore are disabled while the preview loads, so the restore dialog takes its opener explicitly (`ConfirmDialog`'s `returnFocus`) and cancelling it returns focus there.

## Library presentation

Authors display their full text with normal wrapping and breaks within an
unbroken name when needed, without ellipsis or a line limit. The shared Library
card applies this to grid/list, grouped collections and Continue reading (which
keeps grid cards). Cards/virtual rows grow to fit; cover proportions, muted author
typography, title limits, progress, actions and selection remain unchanged.

The Library page (its level-1 heading visually hidden) is one Library section. Under the Library's title, summary and toolbar comes Continue reading, under a group-style heading with `N books in progress` beside it: every unfinished book read past its start (`hasReadingProgress`; a book only opened, say to look at its illustrations, stays out), most recently read first, as the same grid cards as the Library (with their actions menu), adding rows as books are added rather than linking to another page. An All books heading then heads the ungrouped books; grouped, the groups' own headings follow. Continue reading steps aside while selecting, searching, or filtering, and a group's page has none. The Library section's title has a one-line summary (books, or `N of M books` while searching or filtering, then the characters the whole Library holds across every counted CJK book and the words of every other counted book), with the toolbar beside it: Filters, Group, Cards, Sort and its direction, and the grid/list segmented control last. Search, in the shell's top bar, matches every query word against title, author, series, and filename, ignoring case; Escape in the field clears it and releases its focus. Grid/list, status filters, grouping, card detail toggles, sorting and reversal persist; the query is local. Under each card's progress bar, with its percentage, is what the Reader counted (`current / total` characters for Chinese, Japanese, and Korean books, words for the rest); a book not yet opened shows `0 / N characters` (CJK) or `0 / N words` from what Komori counted at import. Cards show optional chips for Series (its name only), Language (an English display name from `Intl.DisplayNames` for the language alone, and Chinese Simplified or Chinese Traditional for `zh-Hans`/`zh-Hant`, `languageName`), Unique kanji (`漢` and the count), and Last read. Group by Series heads each series alphabetically, its books by series index then the chosen order (reversing the sort does not reorder a series), with No series last; Group by Language heads each language by its display name with Unknown language last. Sort by Characters puts the longest counted CJK books first and Sort by Words the longest word-counted books (both counted at import, so unopened books sort too), books without that count after them; reversing reverses only the counted ones. Grid cards in a row are as tall as its tallest, their progress bar and count at the bottom, so they line up whatever the title, author and chips take. Settings > Library saves the card size, which sets the grid's narrowest card (`--library-card-min`); each row shares its remaining width among its cards, and carousels use the same width. Each group's heading shows its books and, when it has counted books, their characters and words (`9 books · 1.6M characters · 240K words`). Grouped, each group is one carousel: its books in one sideways-scrolling row, with See all beside its heading and previous/next arrows floating over the row's edges, centered on the covers, that move by the cards that fit; each arrow shows only while the row can move that way, which opens the group's own page, `/library?group=<section key>` (`series:<name>` or `language:<tag>`, empty after the colon for books without one). That page keeps the Library's search, filters, Cards, Sort and view, without Continue reading or Group: a Library back link above the group's name and summary, then only its books as one collection in the carousel's order. Escape (outside text fields, menus and dialogs, once selecting has ended) and Alt+Left also go back to the whole Library. Each group page starts at the top and leaves the Library's saved scroll position alone, so returning shows the Library where it was left. A carousel renders only the cards within one visible width of its view; list cards in a carousel are two grid cards wide, with progress under the details.

A card's actions menu offers Mark as unread for a book with saved progress or position: after confirmation `mark_book_unread` deletes its position and progress rows, so it lists as not started and reopens at the start, and marks its recorded sessions so they no longer count it as finished; reading time stays. The Library lists again afterwards.

Each collection of cards (Continue reading, the Library's books, each group's carousel) is one Tab stop (`src/features/library/cardRoving.tsx`): the card last focused, or the first one rendered, holds it with its open link (its selection box while selecting), and the arrow keys move between the cards in the order shown, keeping to the same control: Left/Right by one book, Up/Down by a grid row (by one in the list view, not at all in a carousel). On a focused card Space selects it (focus moves to its box) and Shift+F10 or the context-menu key opens its actions under the actions button. The corner box, the actions button and Relink are out of the Tab order; the box and the actions button show while the card has keyboard focus. Selecting: each card's corner box (top left, showing on hover or focus like the actions button on the right, and always while selecting), a Ctrl/Cmd+click on a book, Space on a focused card, or a Shift+click starts it (Ctrl/Shift+click selects instead of opening). While selecting, a click or Ctrl/Cmd+click flips one book and makes it the anchor, Shift+click adds every book shown between the anchor and it, Ctrl+A selects every shown book, Delete asks to remove the selection, and Escape ends selecting. The actions float above the dock in a frosted bar rendered on the document body (count, Select all, Clear, Series…, Remove, Done), so they stay at hand however far the Library scrolls. Series… opens a dialog: a name (suggesting the Library's series, starting from the one the selection shares) numbered 1, 2, 3… in the order shown, No series, or each book's own metadata; saving lists again and ends selecting.

The Library section always lists every matching book, like Calibre's library, and renders only the rows near the view. `LibraryCollection` lays out grid rows of as many columns as the responsive card width fits (measured from a hidden probe with the grid's tracks in either view) or one book per list row, or one row per group, its heading above its `LibraryCarousel`; `useVirtualRows` positions each row at its offset in a list as tall as all of them and renders the rows within one screen above and below the scroll container's visible area, so their covers are loaded before they show. Rows measure themselves, headings keeping their own typical height; a row above the view that changes height scrolls by as much, keeping the books in view in place, and each layout's typical row height is kept for the session. Where layout cannot be observed (no `ResizeObserver`, as in tests) every book renders in normal flow. Cards stay memoized, so scrolling renders only rows entering the range. `libraryCache` keeps, for the session, the last listing, each Library page's place (the whole Library and each group's page), each group carousel's sideways offset, and the Library page shown last: returning to the Library shows it at once, where it was left, while it lists again. A place is the row at the top of the view (by its lasting key: group, or group and first book) and how far above the view it begins, with the plain offset while the list's top is still in view; a restore puts that row back and holds it for 1.5 s (until the reader scrolls, presses or types) while covers, measured rows and Continue reading above the list settle, so a book opened from deep in the Library, which then joins Continue reading, leaves the books around it in place. The Reader's Back to Library returns to the Library page the book was opened from (a group's page included) with `libraryReturn` state, which restores that group page's place; See all still opens a group's page at its top. Selection mode keeps ID-based Select all over the shown books, removal confirmation, partial failure, relink, and Reader entry behavior over the whole matching collection. Filters/Cards/Sort use labelled radio/checkbox menus with initial focus, arrow/Home/End navigation, Escape dismissal and focus return; Tab and outside clicks dismiss.

Native `book_progress` is an additive catalog table keyed by catalog ID with cascade removal. `save_book_progress(id, { unit, current, total })` accepts characters/words (the Reader's two units) and integer counts satisfying `0 <= current <= total <= 1,000,000,000`, with a positive total; unknown IDs cannot create rows. Source EPUBs remain read-only. Library DTOs add nullable `progress` and `lastReadAt` (the later saved position/progress timestamp); corrupt progress loads as absent. Existing positions count as opened until progress is recounted on next Reader open. Reaching the final page records completion, and retreating updates the latest position again. `useReaderRenderer` saves positive-total progress through its catalog-bound store, throttled to two seconds with ordered writes and flush on unmount; position saves keep their existing contract.

## Book progress

Sidebar Contents shows each destination's start offset beside its title (for
example `4,400 ch.`, or `words`), with the offset against the whole-book count
(`4,400 / 20,000 ch.`) as the entry's accessible description. The adapter publishes
locations after its existing linear-spine character/word count, excluding ruby
annotations, without navigating or exporting destinations. Section starts and
resolved fragments share the same measure as progress; aliases retain the same
start. Captions remain independent of reflow, view mode and the current chapter.
Counting is explicit until completion; unresolved fragments, non-linear or
unreadable destinations, non-navigable groups and books with no counted text show
Location unavailable. Navigation keeps its existing fallback behavior. Captions
are accessible descriptions of the original chapter-labelled jump buttons.
Disposal/book switches discard late count publications.

The optional `onProgressChanged` callback publishes a path-safe `ReaderBookProgress` `{ unit, current, total, chapter }` in readable units. `src/features/reader/readingMeasure.ts` defines them. Readable text is every text node of a section body except ruby annotations (`rt`, `rp`), so furigana is not counted. A character is a Unicode letter or number code point, so whitespace, punctuation, and symbols are not counted either. A word is a run of letters, numbers, and marks, with internal apostrophes or hyphens joining it into one word. Each book gets one unit, `characters` when Han, Hiragana, Katakana, or Hangul make up at least half of its letters, otherwise `words`. These counts agree with Calibre and ttu-reader for Japanese books. The reading-position locator keeps its own raw text measure, so saved positions are unaffected.

After the first page is displayed, the adapter counts every linear spine section. It parses each section from the in-memory archive through `book.load(section.url)`, independent of the rendition, and yields to the event loop between sections, so page turns never wait on the count. It counts both units and the script letters in the same pass, then chooses the unit. `total` is the linear sum. `current` is the linear units before the displayed section plus the units before the first displayed character, or `total` on the book's final page, the same end condition that disables advancing. The adapter resolves the first displayed character from EPUB.js's page-start CFI and the page end from its end CFI, in the displayed document. EPUB.js splits text into ranges only at spaces, so in text without spaces, such as Japanese, a paragraph that began on an earlier page reports its own start, and one that continues on a later page its own end. When the first rendered character from the reported start, or the last before the reported end, lies outside the reading area, the adapter moves the point within that text node to the first character rendered inside the reading area, or just past the last. A page holding no text of its own, such as an illustration after a section's last paragraph, has its start reported in that paragraph on the previous page; when no character of that text node from the reported start is inside the reading area, the page start is the first character or image after it, in reading order and skipping ruby annotations, rendered inside the reading area. A point EPUB.js reports correctly, as in spaced text, is kept. That first character is also the saved position and the reading point reflows keep. That document can differ slightly from the parsed one, so its units scale to the counted section length. The displayed document's readable text is read once and kept until its text changes, so counting the text before each page edge does not walk the section again. EPUB.js measures a paginated page's location from the section's start on every request, so a location is reused for the rest of the task that found it while the reading area and its views lie unchanged; a turn deep in a long section measures it once. A point with nothing counted before or after it maps exactly to the section's start or end. Without a resolvable CFI, the locator's text fraction estimates the position. A non-linear section adds nothing to `total`, and while it is displayed `current` is the linear units before it. Progress is published once the count completes and then with each settled turn or contents jump; a revision counter keeps a count completion from overwriting a newer turn. A section that cannot be read counts as empty. A book with no counted units publishes nothing and reading continues. Disposal stops the count.

`chapter: { current, total }` uses the same unit. A chapter is the text between consecutive navigable contents destinations, taken in reading order rather than contents order. Nested entries are included. During the count, each destination in a linear section resolves to the units before its section start or fragment anchor. A missing anchor uses its section start. Destinations in non-linear or unknown sections are skipped. Entries that resolve to the same position share a chapter, which includes image-only entries followed by counted text. Text before the first destination is its own chapter. A book with no usable destination uses each linear section with counted text as a chapter. The current chapter is the last one that starts on or before the displayed page, including one that starts on it. A chapter whose start is at the page end also starts on the page when its heading is displayed there, that is, when the anchor's first character, or its element box without text, is rendered within the reading area. A heading holding only an image can be the page's last content, with the chapter's text on the next page. Its `current` is the chapter units before the first displayed character, so it is 0 on a chapter's start page. Its `current` becomes `total` once the page end reaches the next chapter's start, or on the book's final page. A chapter that fits on one page therefore shows 100%. A page with no counted text at a section end belongs to the chapter that starts there.

In semi-continuous view, the current chapter is the one shown, the progress chapter holding the shown chapter's start, so text-less pages at its end, such as illustrations before the next chapter's destination, count as its end rather than the next chapter's start, and the next chapter's heading is never displayed.

The chapter also carries `entryId`, the session-local ID of the contents entry that begins it, so the sidebar can mark it. Several entries can share one chapter start, such as image-only sections, a part and its first chapter, or a missing anchor at its section start. Those are ordered by reading position (spine index, then raw text before the anchor, then contents order), and the current entry is the last of them at or before the displayed section, or the first when all of them come after it. After a successful contents jump, the jumped entry is published instead, including when the count completes on that page, until the next settled turn. Text before the first destination and the linear-section fallback have no `entryId`.

The Reader footer is the bottom-center pill over the reading area. It shows `current / total Ch.` (or `words`) and `floor(current / total × 100)%` for the book, then the chapter's `current / total` and `Chapter N%`, in the order and separated by its dot. Reader Appearance's Reader footer card independently saves Reading position, Percentage, Chapter position and Chapter percentage as native booleans `readerShowReadingPosition`, `readerShowPercentage`, `readerShowChapterPosition` and `readerShowChapterPercentage`; book position and percentage default to true, chapter position and percentage to false. Missing/invalid stored values fall back independently; native deserialization rejects non-boolean saves without mutation, and frontend setters ignore invalid fields. Groups with no visible values and the all-hidden pill are absent, as are unavailable chapter counts. The footer is absent until the count is ready. The Reader's status (such as "Reader ready") is announced as a visually hidden status. At `640px` and below, the pill stacks the book and chapter values on two rows. Numbers are formatted in the saved interface language (`useI18n`). The section measurements behind the footer are computed per open book; the book's `current / total` is saved as book progress (see Library presentation) and the import-time counts as book details.

The same card saves independent `readerShowClock` and `readerShowReadingTime` booleans, defaulting to true and false respectively and following the same validation. They appear in the upper-center pill once the book is ready, with a dot only when both are shown. Clock shows local 24-hour hours/minutes, refreshed each second while enabled and the document is visible; hiding the app suspends its timer, returning refreshes immediately, and disabling, book changes or unmount remove it. Neither pill uses a live region for ticking values. Accessible labels identify each value. While a presentation reflow is active, the layout-status pill temporarily takes the upper pill's place. All six visibility choices affect only Reader chrome: no adapter presentation, reflow, navigation, lookup or progress calculation changes, and existing space around the book remains reserved. Reading time shows the current reading session's active time (see Reading sessions) with seconds, as `12m 05s` or `1h 02m 05s`, refreshed each second while shown and the document is visible; a new session starts at `0m 00s`. While reading statistics are off it reads `Statistics off` (with an explaining tooltip) and the speed is hidden. With the Manual session start, `P` alone starts and pauses counting, with no control or state shown; it works anywhere in the Reader or the book except in fields, dialogs and menus. The same card's Reading speed toggle saves `readerShowReadingSpeed` (default false, same validation) and shows the current session's speed as the lower footer pill's last group, after the chapter values, in the order: units read forward per hour of active time, as Statistics computes it, in the book's unit (`31,200 chars/h` or `14,400 words/h`), refreshed each second while shown and the document is visible. It is absent until a minute was read, so a new book hides it again, and the pill shows with speed alone once it is present.

## Reading sessions

`src-tauri/src/reading_sessions.rs` owns `reading_sessions`, an additive catalog table (no schema bump) keyed by a session UUID. Sessions outlive their book's removal: each save stores the book's title (`book_title`, its title or file name), so Statistics still names a removed book, until Settings deletes them. The first version's table, which cascaded and kept no title, is rebuilt once into the current one with its titles filled from the catalog. `finish_cleared` marks sessions of a book marked unread since. A session stores its Unix-millisecond start and end, active milliseconds, unit (characters/words), units read, and the book's position at its start and end with the book's total. `save_reading_session(id, session)` accepts a Komori UUID and a validated session (start from 2000 on, end at or after it and within 31 days, active time at most the span and a day, units within the book-progress bounds, no unknown fields) and inserts only while the book exists; saving the same session again updates it but cannot move it to another book or start. `list_reading_sessions` returns every well-formed session oldest first (corrupt rows left out) with its `bookTitle` and `finishCleared`; `get_statistics_counts` returns the sessions and those (and their books) no longer in the Library; `delete_reading_sessions(orphans)` deletes those of books no longer in the Library, or every session, returning how many; `mark_book_unread(id)` deletes a catalog book's position and progress and sets `finish_cleared` on its sessions in one transaction (false for unknown IDs); `list_library_kanji` groups the counted kanji of `ja` and `zh` books (see Book details) into each kanji's book count and whether a completed book (saved progress at its total) contains it, most widespread first. The frontend validates both answers again (`statisticsApi.ts`). Reading positions and book progress are unchanged by sessions.

`ReadingSessionTracker` (`src/features/statistics/readingSession.ts`) measures one session; `useReadingSession` runs them for a ready book in the Reader while `statisticsEnabled` is on (off, no tracker runs and nothing is saved). The session start mode decides when one counts: Auto from the book's opening, First character read from the first forward move (its start is where that move began, its start time that moment), Manual only between `P` presses (paused, it counts neither time nor reading; reading while paused is skipped, not counted later). `P` pauses and resumes a session in every mode; a session paused with `P` stays paused across forward moves and jumps until `P`. A move further than the jump limit from the last position, forward or back, by any means, counts nothing: it saves and ends an automatic session, and the next forward move starts a new one; it pauses a manual session. A new limit applies from the next session. Active time accrues from one-second ticks while the native window is focused and shown. Time since the last forward move (or a pause or the start) stays provisional: once that shown time passes `statisticsIdleMinutes`, it is dropped from the session and its end returns to that move, so time away never lowers the speed, and counting waits for the next forward move; a pause keeps it; a minimized window (WebView2 keeps `visibilityState` visible, so the native window's minimized state is asked on each resize) or a hidden document adds nothing, and a gap between ticks over 5 s is skipped. Native focus loss counts the focused fraction up to the event and flushes immediately. Returning skips the background interval without changing a pause or a waiting first-read session. Focus is native-window-wide, so moving between chrome and book iframes never pauses reading; an initial probe cannot overwrite a newer focus event. Background input/navigation counts no time or units and establishes a baseline for subsequent reading. Units read count forward moves from where reading began or last jumped: going back and reading again counts once, a contents, bookmark, search or image jump or a reflow (`progressJumped` from `useReaderRenderer`) starts counting afresh, and one forward step over 5,000 units (a scrollbar drag) is a jump. A session is saved once it has a counted book and has read something or been active for 30 s: every 30 s while it changes, when the window hides, on page hide, and when the book closes, changes, or stops being ready.

Daily activity corrections use the additive `units_adjustment` and
`active_adjustment` columns, defaulting to zero for existing sessions.
`edit_daily_activity(edit)` accepts a book UUID, local midnight start/end bounds,
the existing characters/words unit, replacement daily totals and the displayed
totals/session count. Native code validates actual system-local day bounds
(including DST), whole amounts from 0 to 1,000,000,000 and time from 0 to 24 hours,
then checks the current day's sessions in an immediate transaction. Unknown days,
mixed units and stale totals/counts are refused without mutation. Removed books'
retained sessions can still be corrected. The replacement totals are distributed
proportionally across the day's sessions with exact integer totals (when a prior
total is zero, the first session receives that measure). Only measurement offsets
change: timestamps, positions, start/end/total units, session IDs/counts and finish
markers stay original. Listing returns the original session and bounded offsets;
Statistics uses their clamped sum for time, volume, speed, shading and streaks,
while started/finished counts retain their original checkpoint semantics.
Subsequent Reader saves retain offsets and add new measured reading; a unit change
clears incompatible offsets. Deleting sessions removes their corrections too.
Backups/snapshots include validated offsets; older backups restore zero offsets.

## Statistics

The Statistics page lists the Library, the sessions and the Library's kanji, keeping the Library cache, and answers `library-details-updated` by listing again. Loading and failure are explicit (Try again); a kanji failure fails only the character explorer. While reading statistics are off, an honest note above Reading activity says Komori records no new sessions, keeps what was recorded, and links to Settings > Statistics. A range menu (Today, This month, All time; `MenuButton`) sets the Reading activity cards: reading time, sessions, characters read, words read, average characters (or words) per hour over the active time of sessions in that unit (shown after a minute), and books finished (a session reaching the book's total from before it, unless the book was marked unread since) with books started (a session from position 0 that read something). Sessions of removed books count everywhere and show by their kept title, with a title cover and `Removed from Library`. Today and This month compare with the day and month before. Sessions belong to the local day they started on. The Daily activity calendar shows one month (Monday first, back to the first session's month and up to the current one), each day shaded by its reading time (none, under 15, 30, 60 minutes, more); the month is one Tab stop (the inspected day, else today, else the 1st), moved by the arrows a day or a week at a time and by Home/End to the month's ends; hovering, focusing or choosing a day shows its time, characters, words and sessions and up to three books read with their covers. Library overview counts books (and those imported this month), the words of word-based books Komori counted (at import, else the Reader's total), the CJK characters counted at import, completed books, and the current streak of days read (to today, or yesterday while today has none) with the month's best. Language breakdown is a donut of CJK characters by language with the other languages' book counts; Completion overview is one dot per book, completed first; the two reading-volume cards show the range's characters and words with the three most-read books and their progress; the character explorer shows Japanese or Chinese kanji with their book counts, completed books' kanji in green, searchable by any character typed, 48 at first with Show all, each opening its Dictionary search. No placeholder metrics are shown: empty ranges and Libraries say so. A metric tile's hint wraps to a second line before it is cut short.

Right-clicking a daily book row, or its keyboard-accessible Edit button, opens a
floating modal editor for that captured book/day. Whole characters or words and
minutes (fractional minutes allowed, rounded to milliseconds) have visible bounds
and validation; an unchanged displayed time preserves the exact stored duration.
Save disables editing/dismissal while pending. Cancel, Escape and backdrop dismiss
without invoking native code; focus returns to the row's Edit button.
Calendar hover requires deliberate pointer movement, so uncovering a cell when
the modal closes does not switch the selected day or lose the returning focus.
Failures keep the draft and previous statistics without exposing native diagnostics. A
stale save refreshes the displayed sessions and asks the reader to cancel/reopen.
A successful save returns the committed session listing, refreshes every affected
daily/range/volume/speed/streak calculation and announces success; obsolete load
responses cannot replace it. Daily books still preview three rows; Show all books
makes the remaining recorded books editable. Editing stays available while new
statistics recording is disabled.

## EPUB subsystem

`src/app/autoscroll.ts` owns middle-click autoscroll for Library and Reader,
including EPUB iframe input. It shows an origin marker and scroll cursor; moving
outside a 12 px dead zone scrolls in the pointer's direction, faster the farther the
pointer goes with no ceiling; sub-pixel distance carries between frames so slow speeds
move evenly.
Library uses the nearest scrolling collection/carousel, in either axis. Reader
uses the adapter's reading axis and direction in scrolling views and queued page
turns in Paginated view, including the chapter wheel guard. Semi-continuous view
turns to the neighbouring chapter only after the same threshold of wheel steps at
the shown chapter's scroll edge; scrolling within the chapter resets the count. Buttons, links, editable fields, menus,
dialogs, sidebar and lookup controls retain their input and do not start book
autoscroll. A second click, Escape/key input, wheel, context menu, pointer
cancellation, window blur/hide/resize, disable, route/book/view change, failure or
disposal cancels the session and pending autoscroll turns. Holding the middle
button while moving ends the session on release. Cancellation clicks are consumed
so they cannot open a book or activate the control underneath. Each section's
listeners/styles are released when its document leaves the rendition. WebView2's
native middle-button default stays suppressed by the document guard because
Komori owns the complete scrolling session.

In Paginated view, the adapter reports laid-out chapter edges through
`advanceChapter`/`retreatChapter`, including spine edges on text-less pages and
counted authored chapter starts within a section. `WheelNavigationQueue` keeps
ordinary page turns at one page per wheel step, with fine touchpad movement
accumulated. At a settled chapter edge, fresh movement in one direction must reach
the saved threshold before one crossing is queued. A step is 100 px of browser
wheel delta, three lines or one page; normal mouse steps count once even under
display scaling. Input queued before arriving at an edge is discarded there;
input during the boundary crossing cannot queue another move, and excess movement
does not carry into the next chapter. Direction reversal, 700 ms without input,
explicit navigation, book/view/layout/threshold changes and cleanup reset the
partial count and queue. Arrows and explicit Contents/bookmark/search/image
navigation bypass this guard. Continuous and semi-continuous wheel behavior stays
unchanged. No EPUB location or CFI crosses the adapter boundary.

Rounded scrolling surfaces use shared scrollbar styling: `.scroll-safe` insets
the scrolling box inside its rounded parent using `--scroll-radius`; independently
rounded scrollers inset both track ends by that radius. The lookup body and floating
Reader sidebar use the shared inset, so horizontal and vertical thumbs remain
inside the corners, including compact layouts and a changed popup radius.

Reader UI depends on the small Komori-owned `ReaderRenderer` contract in `src/features/reader/renderer.ts`, not directly on EPUB.js types/state. Its lifecycle is `mount(host, signal, onPageTurnsChanged, onContentDocument?, onContentsChanged?, position?, onProgressChanged?, presentation?, onSelectionChanged?): Promise<ReaderMountResult>` and idempotent `dispose()`. The optional selection callback reports the reader's text selection as a path-safe `ReaderSelection` (see Reader lookup). The optional DOM-document callback lets the Reader attach input handlers inside isolated EPUB iframes without taking on EPUB.js types. The optional contents callback publishes the book's authored table of contents as a path-safe `ReaderContentsEntry` tree: label, session-local ID, `navigable` flag, children, and an optional counted `location` (`{ current, total, unit }` or null). The mount result is path-safe `ready`, `missing`, `unreadable`, `invalid`, `tooLarge`, or `error`, so the shell can distinguish native content outcomes without seeing EPUB.js objects. The contract also exposes `advancePage()` and `retreatPage()` for one displayed page in logical reading order, plus availability and normalized forward-arrow state, `goToContentsEntry(id)` for an authored contents destination, `setPresentation(presentation)`, and `scrollBy(distance)` for a continuous or semi-continuous book (see EPUB subsystem). `useReaderRenderer` owns one instance per selected catalog ID, reports empty/loading/result, page-turn, contents, current-entry, navigation-failure, and book-progress state, serializes turns, contents jumps, and presentation changes as one navigation queue, aborts pending work, disposes, clears the host, and ignores late completion after unmount or book switch. The EPUB.js patch makes its view managers and stage remove the window `unload` and `orientationchange` listeners they add; disposal also restores the view-manager method the adapter wraps and drops its document anchors, so a closed book leaves nothing the window can reach. No book source, renderer location, CFI, or EPUB.js object enters Reader component state; bookmark state contains only the bounded Komori DTO described below; the Komori locator passes from the adapter to the position saver without entering component state.

`src/features/reader/epubRenderer.ts` is the sole EPUB.js import. It prepares content by catalog ID, opens the returned Komori protocol URL explicitly as an EPUB archive, then mounts a rendition in EPUB.js's isolated iframe inside the existing Reader viewport. Without a usable saved position, it opens the first displayable linear spine section in authored order. A spine cover, title, image, notice, or contents page is retained; package cover metadata never creates a synthetic reading page. EPUB resources, including relative CSS, images, and fonts, are resolved from the in-memory archive into EPUB.js managed blob URLs. The book's own CSS remains in the iframe; Komori's Inter typography stays in application chrome. Scripted EPUB content is disabled.

Broken EPUB tolerance is limited to defects observed in real published books. Native
package inspection retries an undeclared `dc` prefix by adding the standard Dublin
Core namespace to an unprefixed package root, then requires strict XML again.
The adapter's `epubTolerance.ts` applies the same package correction; for XHTML it
removes an identical adjacent duplicate XHTML namespace on the HTML root and
exactly sixteen trailing `U+0010` padding characters after a complete document;
for NCX it moves a simple fragment written after the `src` attribute's closing
quote inside that quote. Every repair must produce valid XML. Other unknown
prefixes, mismatched tags, conflicting attributes and truncated chapters are not
guessed or reconstructed. Valid documents take the original parsing path.

Before displaying a book the adapter checks every linear spine document through
the in-memory archive, without section styling or publishing reading state.
OPF, NCX and XHTML reads are capped at 2 MiB of UTF-8, with the ZIP size checked
before inflation; spine preflight is capped at 10,000 sections and 64 MiB of
declared uncompressed content. Invalid content returns `invalid`, exceeded adapter
bounds return `tooLarge`, and cancellation/book switches discard late results.
An unreadable optional navigation document resolves to the existing empty
contents state instead of leaving EPUB.js's navigation promise pending. Import
continues to validate the package and extract metadata; a cataloged book with a
damaged chapter receives the honest Reader refusal when opened. Failed opening
does not overwrite its position or progress. All corrections are in memory:
the native protocol still serves original bytes, and the source is never changed.
Invalid-book feedback recommends another copy or an EPUB editor followed by
Library relinking; it does not expose archive paths or parser diagnostics.

For an OPF that declares `primary-writing-mode` as `vertical-rl` or `vertical-lr`, the adapter promotes that declared mode to each displayed XHTML document root before EPUB.js formats it, including sections reached from the contents. EPUB.js measures the root rather than a vertically styled body when choosing its axis. Without this narrowly scoped correction, a vertical body with a right-to-left spine can inherit CSS `direction: rtl` and begin short lines at the bottom of the viewport. The correction preserves the book's declared mode; a chosen writing mode replaces it (see Reader presentation).

The Reader has no visible Previous/Next buttons. EPUB.js chooses physical turn direction from the book's progression and layout, or from a chosen writing mode; the adapter converts relocation state to Komori's availability and normalized forward-arrow direction. Horizontal LTR uses Right to advance; RTL or declared vertical-rl uses Left, as does a paginated horizontal section that sets itself right to left (see Writing mode). Vertical wheel down advances and up retreats regardless of page direction. Reader input is scoped to content and excludes interactive and internally scrollable surfaces. `src/features/reader/navigationInput.ts` measures wheel movement in wheel steps: 100 px of delta, the delta the browser reports for one mouse wheel step (three lines in line mode, one page in page mode). An event of at least half a step is a mouse wheel's, and counts as its whole steps and at least one, so a step a display scale makes slightly larger still counts once. In paginated view each wheel step turns one page. Steps that arrive during a turn wait and turn one after another as each turn finishes, and a step in the other direction drops the waiting ones. Finer movement, such as a touchpad's, turns a page for each whole step's worth built up in one direction. The adapter completes a turn once the new page is located and disables turns during reflow. EPUB.js reports a relocation from a single animation frame and reports nothing when the new view has not been sized by then, as can happen when a turn leaves a text-less page such as an illustration or part title. After each navigation resolves, the adapter therefore also reads the rendition's own location on every following frame, and the relocation or the first location found settles the turn. The 1.5 s relocation wait remains only a bound for a view that never gets a location. When EPUB.js retreats across a section boundary to that section's first page, the adapter targets its last text character so retreat still moves one displayed page, then publishes the settled position. A turn into another section, or to another fixed-layout page or spread, would show an empty reading area while the new section loads: EPUB.js removes the page it leaves first and shows the new view only once it is laid out. The adapter keeps the page in sight where it is, clipped to the reading area and inert, until EPUB.js shows the new view, hides it in the same frame, and tears its section down once that frame is drawn. EPUB.js locations and CFI remain confined to the adapter. EPUB.js sizes a paginated section to its text's measured width plus the body's left and right padding; when the text already starts inside the left padding the adapter counts that padding once, so a full last column never adds an empty page between sections.

Continuous view uses EPUB.js's continuous view manager, which stacks the displayed sections in one scrolling element. EPUB.js adds sections within an offset of the reading area and removes those beyond it; the adapter gives it an unbounded offset, so as a book opens it lays out every linear section in reading order before the reading point is shown, and keeps them all. The scroll length is then the whole book's, and nothing is added or removed while reading, so the scrollbar never grows or jumps. A change of presentation, writing mode, or window size lays the whole book out again. While it opens, the book lays out and moves to the reading point unseen (the host is transparent and inert until the Reader is ready), so neither its text nor its scrollbar jumps behind the message "Laying out the whole book."; and a "Laying out the book" pill, like the footer's, appears at the top of the reading area once a reflow has taken 300 ms, until it finishes. Input waits for both. EPUB.js chooses the view manager with the rendition, so a change of view mode destroys the rendition, keeping the book, its loaded section documents, and only the new rendition's section hooks, and renders the book again. A continuous book scrolls along one axis for all its sections: down for horizontal text and right to left for vertical text. A chosen writing mode sets the axis. With each book's own mode, a book declared vertical, or found vertical when EPUB.js renders one of its sections vertically, is vertical throughout: every section's root takes the vertical mode, while the elements inside keep the book's own, including horizontal cover pages, and sections already shown in the other axis are shown again at the reading point. Fixed-layout books always turn pages. In reflowable continuous view, the adapter limits raster and SVG images to the scrollable reading area's width and height before section layout. It refreshes those limits after a writing-mode or window-size change, while preserving each image's proportions; other paginated illustrations and fixed-layout pages keep their book sizing. Standalone illustrations and image headings share the logical spacing rules described under Reader images in every reflowable view. Fixed-layout pages keep the book's sizing and spacing. A book is fixed-layout, as EPUB.js decides, when its package declares `rendition:layout` `pre-paginated` or its iBooks display options declare a fixed layout; its pages also keep their own font size, line height, font weight, paragraph indentation and spreads, whatever the Reader's choices.

The adapter corrects EPUB.js's continuous view manager where it fails. It sets the scroll direction once a section reports its axis, converts right-to-left scroll offsets for vertical text as well, and formats displayed sections again in their own axis after each layout. On a fresh vertical continuous open, the first section's axis changes the stage to a horizontal scrollbar; the adapter then measures the scrollable height and resizes the section view before EPUB.js formats it, so its fixed height matches the reading area as it does after switching into Vertical. After every section it adds, EPUB.js shows every view again, forcing a layout per view (quadratic in a long book); the adapter leaves a view that is already shown alone. It ends the display of a section removed while it renders, which EPUB.js would otherwise wait for in its queue forever; a section asked to display again while it renders, as by an update during EPUB.js's own display, waits for the display under way instead of loading again, which would leave the first display unended. It skips EPUB.js's cleanup while no section is displayed or when a section was already removed, and waits at most 1.5 s for sections to be added or shown. Contents jumps scroll to their section's view without clearing the others. The scroll element's own scrollbar is hidden: the Reader draws its own (`ReaderScrollbar`) along the reading area's right edge, below the window controls, or along its bottom edge when vertical text scrolls sideways, so a narrowed or shortened text column never leaves a scrollbar floating mid-window. It follows the adapter's `scrollMetrics()` (axis, right-to-left, position, scroll length, size in view) through `watchScroll`, which reports scrolls and size changes of the scroll element and its sections; dragging the thumb moves the book with `scrollToPosition`, proportionally, and pressing the track pages 90% of the view toward the press. A right-to-left book's thumb starts at the right end. The wheel over it scrolls the book as anywhere in the Reader. The browser's scroll anchoring and EPUB.js's partial compensation are replaced by one rule: when a section lying entirely before the reading area changes size, such as one EPUB.js adds before it and renders later, the adapter scrolls by as much, so the text in view stays in place. Removing such a section is compensated the same way.

`scrollBy(distance)` scrolls a continuous book along its reading order, and the page-turn availability's `scrollAxis` tells the Reader that the book scrolls and in which axis. The Reader sends it the Wheel step distance for each mouse wheel step, and finer movement in proportion, and each arrow press, repeating while the key is held: Down and the forward arrow read on, Up and the other arrow read back, by a tenth of the reading area, at least 40 px. `advancePage()` and `retreatPage()` scroll 90% of the reading area. `scrollBy` returns false, without scrolling, when a semi-continuous book is already at its chapter's end reading on, or its start reading back, and another chapter follows or precedes it; the Reader then turns a page in its navigation queue.

Semi-continuous view scrolls one chapter at a time. A chapter is the text between consecutive navigable contents destinations in linear sections, as in Book progress: it begins at the book's start or at a destination, a missing anchor begins it at its section's start, destinations with no counted text between them share a chapter that begins at the first of them, a destination with no counted text after it begins none, and without destinations each linear section with counted text begins one. The adapter finds the starts once per book from each section's document. It uses the continuous view manager and whole-book layout, so each chapter is laid out whole before it shows, and shows only the chapter holding the reading point: every section outside it is collapsed to nothing along the reading order (`max-height` or `max-width` 0), a section the chapter ends within is cut off at the next chapter's anchor, and a section it begins within is shifted back by a negative start margin (`margin-top`, or `margin-right` for right-to-left vertical text) so the text before its anchor lies beyond the scroll's start, where it cannot be reached. An anchor is measured at the earliest of its element box, first character and ruby annotation boxes, so both the heading and its furigana show whole. The first section receives two base-font em of clearance along the reading axis; a clip path excludes preceding chapter content while retaining that lead. Later sections in the same chapter receive no added clearance. The scrollbar spans only the chapter, and its length does not change while reading it. A section still rendering where the chapter begins or ends stays collapsed until it is rendered, and a section's resize applies the clips again, keeping the text in view in place by the part of each section shown. `advancePage()` and `retreatPage()` scroll like continuous view, except at the chapter's end (or start), where they show the next chapter from its start (or the previous one from its end). Restores, contents jumps, reflows, and changes of view mode show the chapter holding their point, and a point with no text before it in its chapter shows the chapter from its start. The reading point, footer, and current entry are found only within the shown chapter, and the book's start and end are the first chapter's start and the last chapter's end. Switching between continuous and semi-continuous view keeps the rendition and its layout.

The Reader shell attaches key/wheel listeners to each displayed section document and releases those of documents EPUB.js has discarded when the next section arrives, so long sessions do not retain old section DOMs. On unmount, Back, catalog switch, or failure, the adapter aborts the protocol fetch, destroys EPUB.js book/rendition/archive resources and listeners, revokes generated CSS blob URLs, and clears its host. A late asynchronous display completion receives another cleanup pass so an old iframe cannot remain in the Reader. The production CSP permits `blob:` only for renderer images and styles, and `font-src 'self' data: blob: komori-font: http://komori-font.localhost` for embedded and managed Reader fonts; `connect-src` remains restricted to the Komori content protocol, and `object-src 'none'` blocks plugin content in EPUB documents. There is no asset-protocol allowance. `scripts/check-csp.mjs` in `validate:task` requires those directives, each directive at most once and each with exactly its expected sources, and rejects wildcards, `unsafe-eval`, broad schemes, and added script sources.

Native EPUB package inspection lives outside the Library catalog service. Its cover resolver ranks evidence rather than selecting an arbitrary image: EPUB 3 `cover-image`, EPUB 2 cover metadata, package guide cover references, then exact cover-named manifest items. A candidate may resolve directly to sniffed raster bytes or through an XHTML/HTML/SVG wrapper image. Archive paths are normalized within the package, percent-decoded with a raw fallback, and matched case-insensitively only after an exact lookup. Independent explicit candidates are tried in order so a malformed declaration does not mask another valid declaration. XML/document reads are bounded at 2 MiB and cached raster payloads at 4 MiB; raw SVG documents are not passed to the frontend.

Conceptual boundary:

```text
Reader UI
  ↓
Komori Reader/Renderer service
  ↓
Renderer adapter interface
  ↓
EPUB.js adapter
```

The Reader sidebar's Contents section shows the actual EPUB navigation labels and hierarchy, or an honest empty state when the book has no usable navigation document. Authored hrefs are resolved relative to the navigation document inside the adapter and kept in an adapter-owned map keyed by session-local entry IDs; entries without an href or with external links are shown as non-navigable labels. EPUB.js displays only spine documents. A converter such as Calibre can drop a book's own cover page from the spine, add its own cover page there, and leave the contents pointing at the dropped page. An entry whose document is outside the spine therefore opens the declared cover page (the EPUB 3 `cover` landmark, else the EPUB 2 guide `cover` reference) when that page is in the spine and the entry's document shows one image and no readable text. Any other entry outside the spine is a non-navigable label. A resolved cover entry takes part in chapters and current-entry marking like any spine destination. Selecting an entry displays its section and, for a fragment, the rendered anchor's own position so vertical books land on the heading rather than the section start. The anchor is measured from its first character, or, when it has no text, such as a heading holding only an image or an empty element, from its rendered element box. A jump whose section or anchor cannot be found shows a path-safe retry message; a completion from a previous book is ignored. Contents navigation is disabled while a turn or reflow is pending; entries use `aria-disabled` rather than `disabled`, so the chosen entry keeps focus during the jump. The entry of the chapter being read is marked with `aria-current="location"` and the existing current-entry style. It follows the book progress (see Book progress) as pages turn and once a book opens or resumes. A successful jump marks the chosen entry immediately, even before the count, and it stays marked until the next settled turn. Nothing is marked for text before the first destination, or in a book without usable contents. The tree does not scroll or expand to the marked entry. After a successful jump, the shell moves focus to the Reader content region (`#reader-main`) so page-turn keys work immediately, unless the reader has already moved focus elsewhere; a floating sidebar then hides unless the pointer is over it, and always in the compact layout. A failed jump leaves focus on the entry. The reading area has no focus ring; the sidebar precedes it in the document, so Shift+Tab returns to the contents tree.

The sidebar's gear button ("Reader appearance", `aria-pressed`) opens the in-reader Appearance panel in place of the contents, under the book's card, until the back arrow or a second press returns to them. Focus then returns to the gear. The panel has no introduction or explanatory hints (only live status and errors). Each section is a small muted title over a rounded box of rows, each setting's name on the left and its control on the right: Theme (see Reader themes), Background image (an Image row with Choose/Replace and Remove, Blur background and its level), Typography (Western font and weight, Asian font and weight, Font size, Line height, Paragraph indentation, Letter spacing, Word spacing), Page flow (View mode's four choices at full width, then Writing mode, Pages (Single/Double, paginated horizontal only), Text orientation, Paragraph margin, Maximum text width, Reader max height, Wheel step, the VN steppers in VN, and Chapter wheel threshold when paginated), Reader footer, Text behavior (Text justification, Pretty text wrap, Hide furigana) and Images (Blur image, Blur mode). Switches are pressable rows (`aria-pressed`). When the sidebar's content is at most 300 CSS px wide, each control drops under its name.

The Reader fills the window, with no top or bottom bar; its heading ("Komori Reader") is visually hidden. The reading area covers the window and keeps `--reader-pill-space` (3.5rem) free above and below the book's pages, so the centered footer pill never covers text. The reading area takes the Reader theme's page, text, and footer colors (`--reader-page`, `--reader-ink`, `--reader-footer-text`, set on it by the Reader) in both application themes, and keeps a light color scheme even in dark Reader themes, so the book's iframe stays transparent over one continuous page (see Reader themes). Only the sidebar follows the application theme. The sidebar's top bar holds round buttons only: the back arrow ("Back to Library" to the Library, or "Back to reader controls" inside a panel) on the left, the sun (Reader appearance) and the pin on the right; the panel's name is visually hidden. Below the book's card and tool tiles, the contents mark every entry before the current one in flattened reading order as read (`data-progress="read"`) and the current one as `current`; a card along the bottom shows the current chapter's label and whole read percentage (`Chapter N% read`) and the book's position with the `Book progress` bar, once the book is counted. The application's light/dark theme is chosen in Settings, not in the Reader.

The sidebar is floating by default: the inset rounded card over the book, `clamp(410px, 28vw, 490px)` wide (`clamp(380px, 38vw, 440px)` below 1200px). It starts hidden whenever the Reader opens, so a book opens immersed even with the pointer in the middle of the window, and hides when the pointer leaves it, when Escape is pressed (focus then moves to the reading area), when a page is turned from the book while neither the pointer nor focus is in it, and when focus moves on to the book. An 18px strip along the window's left edge shows it on hover or tap, and keyboard focus entering it shows it. The pin ("Pin reader sidebar" / "Unpin reader sidebar", `aria-pressed`) keeps the same bounded card visible and moves the reading area beside it. At `1080px` and below there is no room to read beside it: a saved pin is set aside, the sidebar floats and hides as an unpinned one does, and the Pin button is not shown; wider again, the saved pin docks it. The choice is saved as `readerSidebarPinned`, so the Reader opens as it was left.

EPUB.js lays the book out again only when the window resizes, and then shows the start of the paragraph it last reported, which in text without spaces can be pages before the reading point, so repeated resizes drifted back. The adapter therefore observes its host's size itself. When a window resize or the Reader's own layout, such as a pin or unpin, changes it, the adapter waits 150 ms for the size to settle and for EPUB.js's own display after a window resize (until it relocates, or until that display and its location report are done when the report finds no location, as during a drag), lays the pages out again at the new size, sizes the displayed views to the new pages (EPUB.js keeps a view's fixed axis, such as a horizontal page's height, at the size it was created with until a window resize rebuilds it), and shows the page holding the first character of the last settled page, like a presentation change, then publishes the new position. That point is kept from before the change because EPUB.js measures its container again whenever its location is read, so a page measured afterwards has already moved. Consecutive size changes keep the same point until the next turn or jump, so resizing back and forth returns to the same page, in paginated and continuous views alike. Only that reflow publishes while it is due: a scroll that settles before it, such as the scroll of EPUB.js's own display, publishes nothing, and after a window resize the point is shown again even when the host's size has come back to the one last followed.

## Reading position

The contract's `ReaderLocator` is `{ spineIndex, sectionKey?, progress }`: the spine position, an FNV-1a fingerprint of that section's href, and the fraction of the section's text characters before the first displayed character. Text progress is independent of window size, fonts, and pagination, and contains no path or CFI. `mount` takes an optional `ReaderPositionBinding` whose `initial` promise supplies the saved locator. `onLocationChanged` is called after a page turn, contents jump, presentation change, host-size reflow (including after a window resize), or continuous scroll has settled. Initial display does not publish. EPUB.js's empty location right after a new section display is resolved in the same way as a turn.

On mount, the adapter restores a locator only when its spine item exists and its fingerprint matches. It displays that section and then the page containing the saved character. Otherwise, or if display fails, it quietly opens the authored start. EPUB.js's paginated `moveTo` rounds a vertical target to the horizontal page width, so for vertical sections the adapter displays the section and then scrolls EPUB.js's view manager once by whole multiples of the layout page height, the step EPUB.js's own `next()` takes, to the page containing the target. It then settles the new location like a turn. One move rather than one `next()` per page keeps a retreat into a long section as prompt as a short one. The move is limited by the view's rendered height, which EPUB.js sets just before it. Every element transitions all its properties by default, so the application's reduced-motion rule makes transitions instant (0 s) rather than 1 ms: any positive duration would apply that height a frame late, and a retreat would stop one or more pages short of a short final page. Contents fragment jumps and cross-section retreats to a final page use the same helper, so vertical pages stay aligned to the page height. A cross-section retreat targets the previous section's last content: its last character, or a rendered image after it, such as an illustration closing a chapter on a page of its own. A horizontal section is displayed at a range holding only the target character, because EPUB.js extends a collapsed target to the next space or its text node's end and pages to that range's leftmost box, which in text without spaces can be on a later page. A point before an element, such as a contents anchor that is a heading holding only an image, is displayed by that element's ID instead, or a temporary ID removed once it is shown: EPUB.js cannot resolve the CFI it builds for the start of an element without text and would show the section's first page.

In continuous view, the reading point is the first character, or image, at least half inside the reading area, found from layout across the displayed sections in reading order, and the page end is the point just after the last one. After scrolling has stayed still for 250 ms, the point publishes like a turn's, ending a jumped entry's marking and the kept reflow point, unless it is the point already published, as when the adapter keeps the text in place. The book's start and end are shown when the first linear section's start, or the last one's end, is in view. Contents jumps, restores, and reflows scroll their point to the start of the reading area, and again once EPUB.js has finished laying the sections out. A locator's text fraction is found again at the earliest place with that much text before it. Where only collapsible whitespace (spaces, tabs, line breaks) or markup lies there, as between blocks, the point is the next image (`img`, `svg`, `image`, or `video`) or character in reading order, so an image found again from its fraction, such as a heading holding only an image or an illustration after a section's last paragraph, is that image rather than the text after it. An image directly followed by a character, as in running text, has that character's fraction and yields to it. When the first visible text starts just after an image but has the same text count as the image, the adapter saves a small affinity within the fraction, then restores the text after the image; an image that is at least half in view keeps its exact fraction and restores to the image. A point in collapsed whitespace that remains, such as a reflow's kept point, is measured at the next element, in both views.

`src/features/reader/readingPosition.ts` owns locator validation, the catalog-ID-bound `readerPositionStore` over the two native commands, and `ReaderPositionSaver`. `ReaderPage` creates the store alongside the renderer factory for the selected catalog ID. `useReaderRenderer` creates one saver per mount. A position is written promptly, later writes are throttled to one per second with the latest position winning, writes run in order, and duplicates of a saved position are skipped. A position stays pending until its write succeeds: the store rethrows native failures, and the next update or flush retries the position (no retry timer), even when it repeats. Disposal on Back, book switch, or unmount flushes a pending position to the same catalog ID and ignores later locations. A failed load opens at the authored start. Native window closing flushes these savers, and the appearance saver, which keeps a failed choice pending the same way, before hiding to tray or quitting; a flush that reports unsaved work is logged without details and the window closes anyway; hiding keeps the current Reader mounted and showing it again keeps its place. Before either flush, a continuous scroll that has not settled yet publishes where it stopped (`settlePosition`), unless a navigation or reflow is under way, so a close right after scrolling saves the place shown.

## Reader presentation

VN is the fourth saved Reader view (`readerViewMode: "vn"`). Reader Appearance >
Page flow uses a compact two-column view choice and exposes `readerVnParagraphs`
(1–20 whole paragraphs, default 1) and `readerVnTextSpeed` (0–200 graphemes/second,
default 40; 0 is instant). Native/frontend loads validate each independently;
invalid setters/saves preserve prior preferences. Count and speed survive view,
book and application changes through the existing appearance record and backups.

The EPUB adapter reuses its continuous layout and bounded-section clipping for VN.
`vnGroups.ts` identifies authored paragraph blocks (`p`, list items, leaf containers,
and indivisible tables/preformatted blocks), retaining ruby and inline glyph images.
Headings and authored chapter anchors restart grouping. Images, image-only blocks and
whole figures (with their captions) always form a group of their own, so a group shows
either text or an image, never both.
Groups never cross a linear spine section. Image-only sections appear whole.
Bare mixed container text or more than 20,000 blocks in a section uses a whole-section
fallback with an honest notice; derived navigation is capped at 100,000 groups.
Fixed-layout books keep their original pages and show a VN-unavailable notice.
The paragraph count is an upper bound when a section/chapter ends sooner.

VN shows only the group containing the reading point. The group spans its first
block's text, ruby and images through its last block's, so furigana before its first
line show and blank paragraphs, margins or the next group's ruby never do; every other
section collapses. A group shorter than the reading area is centered along the reading
order (vertically in horizontal text, horizontally in vertical text) by a lead before
its clipped section, with a clip path hiding what the lead would bring back into view;
the clipped-start measurements already account for both. Text keeps its authored
alignment across the reading order: the host box, sized and centered by Maximum text
width and Reader max height, is what centers it there. Any reflow (including a max
width/height change, which first refits images to the new area) measures the group
again. Long groups start at the area's start and scroll along the
chosen writing axis before arrows/wheel/autoscroll cross to the neighbouring group;
backward crossings show the previous group's end. Contents, search, bookmarks,
notes, images, resume, count changes and resize/reflow use the existing kept anchor
and show its group. Whole-book and authored-chapter statistics retain their existing
text counts and jump rules; changing reveal speed or completing a reveal publishes
no reading position or extra progress. No new locator or source mutation is needed.

`vnReveal.ts` uses CSS Custom Highlight ranges to mask unrevealed text in place,
without inserting wrappers, changing the DOM text, altering layout/CFIs or delaying
images. Unicode grapheme boundaries keep surrogate pairs/combining sequences intact;
ruby text remains in its authored DOM. The Reader's Show all text action, a plain
click in the book, Space, or a text selection/lookup completes the reveal without
navigation; once all of a group's text shows, a plain click or Space reads on as the
forward arrow does (a held Space does not repeat). A click that closes or opens a lookup
or follows a link never reads on. A VN book shows a pointer
cursor, since a click always reveals or reads on. The mask is applied whenever a group's clip is (a turn,
a destination, a newly rendered section or a reflow), so a group never paints whole
before its reveal starts and the Reader's reveal state is published at once. Arrows and
Space pressed while focus stays on a control of a floating sidebar that hid as the
pointer left it go to the Reader viewport instead. Speed changes retain the
amount already revealed, as does a reflow of the same group; a new group starts a new
reveal. Hidden windows pause the timer; book/view changes and disposal remove masks
and timers. Missing Highlight support or more than 100,000 reveal graphemes displays
text immediately with honest feedback. Image-only sections never wait for a reveal.

Reader Appearance places a Background image card after Theme, with native Choose /
Replace, Remove, retry feedback, a saved Blur background switch and a Background
blur level stepper. The switch is
the independent boolean `readerBackgroundBlur`, default false; native/frontend
loads drop invalid values independently and saves/setters refuse invalid values.
`readerBackgroundBlurLevel` saves an independent whole-pixel radius from 0 through
40 (default 16), including while blur is off. Native/frontend validation drops
invalid stored levels alone and refuses invalid saves/setters. Zero keeps the
image clear. Neither control changes the Images card's spoiler blur. The background
applies to every
book and all Reader views/writing modes, including loading/empty/error surfaces.

`reader_background.rs` owns one `reader_background` catalog row containing a new
opaque UUID revision and normalized PNG bytes. Its no-argument native commands
`get_reader_background`, `choose_reader_background`, and `remove_reader_background`
never accept or return source paths. The native picker accepts PNG, JPEG, WebP,
GIF and BMP; native code checks signatures, reads at most 32 MiB, refuses dimensions
over 8192 px or 32 megapixels, limits decoding to 128 MiB, and fits the image within
2560 × 2560 px while retaining proportions/transparency. Animated files use their
first frame. Re-encoding removes source metadata and bounds the managed PNG to
28 MiB. Source files remain read-only and are not needed after selection.
One native change runs at a time; decoding completes before an atomic row replacement
under the catalog write lock. Cancellation/failure retains the old image. Replacement
and removal release the old blob and revoke its URL; SQLite can reuse freed pages
and the next automatic compaction after a removal can reclaim them. No extracted/staging files exist.
The image is local managed state, omitted from portable backups; restoring a backup
leaves it intact while restoring the blur preference with other appearance settings.

The main-webview read-only `komori-background` protocol accepts only an exact
UUID path without queries, rejects foreign supplied origins/referrers and non-GET
requests, and serves only the current bounded PNG with `nosniff` and `no-store`.
CSP permits only its scheme and Windows localhost origin in `img-src`; no generic
filesystem or network capability is added. `backgroundResource.ts` retains a shared
operation across panel/Reader unmounts, validates exact owned URLs, ignores stale
image error callbacks and lets failed loads retry or replace/remove the image.

`ReaderBackgroundSurface` uses an inert, noninteractive image underneath the
Reader shell, including behind the pinned sidebar card. Cover fitting fills the window; a 90% Reader
theme overlay preserves text readability, and the chosen blur level filters only
the image. Loading or failed images fall back to the theme. Theme changes recolor
the overlay; resource and blur changes never enter the adapter presentation queue,
alter layout, remount the book, navigate, dismiss lookup or write a reading position.
The iframe, authored book images, sidebar, footer and lookup retain their behavior.

The sidebar uses application surfaces, borders, spacing and shared controls: the
round top bar; the book's card, a 6.5 x 9 rem cover beside the title, author and series
name (only when the book has one, from the Library's series, without a number); four
equal floating tiles under it (Images, Bookmarks, Notes, Search, each an icon over its
name, which is also its accessible name, the open one accent-tinted and `aria-pressed`;
pressing it again returns to the contents); then the contents, or a panel; and, along
the bottom, a card with the current chapter's label and read percentage over the book's
`current / total Ch. · N%` and its progress bar once the book is counted (see
`design.md`, Reader sidebar). The tiles precede the panels in the document, so
Shift+Tab from the book still reaches the last contents entry. The contents show under
a small "Chapters" label as a timeline that fills the remaining height and scrolls by
itself: one row per entry marked read, current or unread, with the title on the left
and its start (`5,250 ch.`) on the right; the full `current / total` location stays the
entry's accessible description. Appearance,
Search, Images, Notes and Bookmarks share one panel heading. Visiting a panel starts
at its heading; session filters, saved preferences, keyboard actions, pinning and
focus return keep their behavior. Theme swatches show three to a row when the sidebar
content is at most 350 CSS px wide. The sidebar clips rather than hides its overflow,
so revealing a control never scrolls the sidebar itself. Floating scrolling stays
inset inside the rounded sidebar.

The sidebar has the same bounded, rounded card dimensions when pinned or floating:
14 px insets, 86% height with a 600 px minimum/960 px maximum, fitting shorter windows.
Pinning reserves the card width plus 28 px by moving the reading area's left edge,
rather than padding its contents; all pills and lookup coordinates therefore use
that area's actual bounds. At 1080 px and below the sidebar floats over the full-width
reading area. The Reader theme/backdrop fills the window behind the card, without
a full-height application-colored strip. Visibility, saved pinning, focus and
panel navigation keep their behavior.

`hangingIndentLayout.ts` adapts the Japanese EPUB `vrtl`/`hltr` convention when
the chosen writing direction differs from the authored root class. Numeric
`h-indent-N`/`h-indent-Nem` classes (0–20) move their authored top/left padding
onto `padding-inline-start` in an owned CSS layer. Returning to the authored mode
or removing the explicit choice removes that layer, so a vertical book's em
indent does not appear as a large horizontal subchapter gap. Authored blank
paragraphs, scene breaks, margins, text/ruby, anchors and DOM/CFIs remain intact;
fixed-layout books ignore the rule with the other reflowable presentation choices.

Number-only subchapters in those hanging-indent wrappers keep their authored
spaces and negative text indent, but lose the duplicated inline padding when
the writing direction changes. Detection reads the single paragraph's text,
including publisher whitespace outside it; prose hanging indents keep their
padding. An owned attribute selects the numbered wrappers without XML-escaped
CSS combinators. The style and attribute survive section serialization and are
removed when the authored direction returns; text, elements and CFIs stay intact.

Reader Appearance's Text behavior card saves `readerTextJustification` and
`readerPrettyTextWrap` as independent native booleans, both defaulting to false
to preserve existing publisher composition. Missing or invalid stored values
fall back independently; non-boolean native saves reject without mutation and
invalid frontend setters are ignored. `ReaderPresentation` carries the optional
`textJustification` and `prettyTextWrap` choices on mount and through the existing
serialized presentation queue. False or absent restores the book's own alignment
or wrapping independently; fixed-layout pages ignore both.

`paragraphLayout.ts` applies justification (`text-align: justify` with
`text-align-last: auto`) and pretty wrapping (`text-wrap: pretty`) to reflowable
prose `p` elements in both writing modes and every reflowable view. Centered authored
headings, their descendants and image-only blocks keep their composition. One
early important CSS layer overrides publisher rules; affected inline declarations
retain their original values, order and priorities for independent restoration.
Heading/image marks are applied before these inline overrides. The XHTML style
and markers survive section serialization; cached, displayed, newly loaded and
stale late-rendered sections receive the current choices. Text, ruby annotations,
font sizes and source resources are unchanged.

Paragraph changes reflow through the existing kept reading anchor, update progress
and navigation, and dismiss active lookup and pending scans whose geometry is
stale, without remounting the book. Equal choices are no-ops. Pretty wrapping is a
browser request, not a guaranteed composition algorithm: support and results
depend on the WebView, text and writing mode, particularly vertical text. When
CSS support reports it unavailable, publisher wrapping remains and the panel
shows that limitation while retaining the saved choice.

`ReaderPresentation` carries an optional `fontPair` containing the Western/Asian
choices and the available downloaded IDs. `fontChoices.ts` generates an Asian
`@font-face` alias restricted to CJK/Hangul/kana/Bopomofo/compatibility ranges;
other characters use the Western choice. Missing glyphs/families fall through the
other choice, then system serif. Generic choices use system fallback. The included
Inter asset and curated files get owned face names. No EPUB text, ruby, sizes or
source resources are rewritten. The adapter's earlier important layer and inline
family restoration override publisher composition only on reflowable pages.
Cached, displayed and late sections receive current choices; font loads wait at
most 1.5 s before layout. Changes to choices or downloaded availability reflow at
the kept reading anchor, dismiss stale lookups and update progress/navigation in
all views and writing modes. Equal choices are no-ops, font changes never recreate
the book/rendition, and fixed-layout books ignore them. Optional adapter
Group 1/2 fields keep their ordered behavior for older saved records.

`ReaderPresentation` (`src/features/reader/renderer.ts`) is `{ fontSize, lineHeight?, fontPair?, fontFamilyGroup1?, fontFamilyGroup2?, fontWeight?, paragraphIndent?, paragraphMargin?, letterSpacing?, wordSpacing?, textJustification?, prettyTextWrap?, sideMargin?, maxWidth?, pageLayout?, maxHeight?, writingMode?, textOrientation?, hideFurigana?, furiganaStyle?, blurImage?, blurMode?, textColor?, selectionColor?, highlightColor?, viewMode?, vnParagraphs?, vnTextSpeed? }`. `fontSize` is the book's base font size in CSS pixels, from 8 to 72 px in steps of 1 px, default 16 px. `lineHeight` is a multiple of the font size, from 1 to 3 in steps of 0.05, default 1.65. `fontWeight` is the weight of the book's normal text, from 100 to 900 in steps of 100, default 400. `paragraphIndent` is the first-line indentation of the book's indented paragraphs in em of each paragraph's font size, from 0 to 20 em in steps of 0.5, default 1 em. `paragraphMargin` is the space before and after each paragraph along the text's block direction in CSS pixels, from 0 to 200 px in steps of 2 px, default 0 px. `maxWidth` limits each page’s text width in CSS pixels; `pageLayout` selects Single or Double (default). `sideMargin` is an adapter-only option; the Reader never sends it. `maxHeight` is the tallest the reading area may be in CSS pixels, from 100 to 1,000,000 px in steps of 10 px, default 4000 px; live controls stop at the current monitor size and requested sizes fit the available area. `writingMode` is `horizontal` or `vertical`, default `horizontal`. `textOrientation` is `mixed` or `upright`, default `mixed`. `hideFurigana` and `blurImage` are booleans, default `false`. `textColor`, `selectionColor`, and `highlightColor` are `#rrggbb` colors from the Reader theme (see Reader themes); anything else is ignored. `viewMode` is `continuous`, `semi-continuous`, `paginated`, or `vn`; absent, pages turn, which is the default. The other fields are described in their own sections below. `src/features/reader/presentation.ts` owns the ranges and defaults, and the native preferences validation repeats the ranges. Each is one saved preference, so every book opens with them, and the Reader passes every current preference field. The adapter still treats an absent field as the book's own (or EPUB.js's automatic margins, or the full height), which only its tests use. `mount` takes the current presentation, so a book opens with it without a second layout. A change while a book opens applies once it is ready, and a change during a turn or jump applies after it; the latest presentation wins, and turns and jumps wait for the reflow. Each styled section root records the presentation it was styled with. EPUB.js serializes a section when it starts rendering a view, and a continuous book renders views as it scrolls, so a view serialized before a change can finish loading after it; the adapter styles such a view again as it is rendered, and EPUB.js resizes it to its new text.

The Appearance panel's steppers step from the chosen value by their step and stop at their limits; none has a book or automatic value or a Reset button. Each stepper's value, between − and +, is also a text field labelled with the stepper's label, with its unit (px, em) beside it. Clicking into the field selects the value, so typing replaces it. Enter or leaving the field applies the typed number, rounded to the stepper's step and kept within its range, like a button press, and the field then shows the applied value; the stepper's own unit and a decimal comma are accepted. Escape, or an empty or non-numeric entry, returns to the current value without a change, and an Escape that cancels an entry does not also hide the floating sidebar. A hidden live region still announces each value, its unit as a word (`16 px`). Line height offers 1–3 in steps of 0.05, default 1.65.

The adapter sets the size in pixels as the font size of each section's root element, at every size including the default, so it replaces any root size the book sets itself. The book's relative sizes (em, rem, %) follow it; text the book sizes in absolute units (px, pt) does not. A chosen line height is set on the root element as an important declaration, and one injected rule has the body and every element but ruby annotations (`rt`, `rp`) inherit it, overriding the book's own line heights; each element's spacing is then the multiple of its own font size. An absent line height removes the override and restores any root line height the book set itself. The adapter styles a section when EPUB.js loads it, before layout. It also styles the section documents EPUB.js has cached for later display, and the displayed documents. A change then has EPUB.js measure the displayed text at once, instead of a frame later, and displays the page containing the reading point in the same way as a restore. The reading point is the first character displayed before the change. Consecutive changes keep the same point until the next turn or contents jump, so they do not creep backwards, whichever of family, size, line height, weight, indentation, paragraph margin, maximum text width, page layout, and max height changes, and a jumped entry stays current. The new position then publishes like a turn, so book progress, the current entry, and page turns reflect the reflowed page.

Each font role has its own Weight select (see Reader fonts). A chosen role weight moves the book's weights by the same distance from normal (400), so available heavier faces preserve emphasis: at 700, normal text requests 700 and bold 1000. `bolder` and `lighter` keep following the text around them. Weights stop at CSS's 1–1000, and how many visible steps a book shows depends on the faces its fonts have; at 900 nothing can be heavier. The adapter reads each section's stylesheets from the archive once per book, following `@import` (within its media, ending cycles), and its style elements, keeping each font-weight and text-indent declaration's selector, `!important`, and enclosing `@media`/`@supports`. It then appends one style element after the book's own that sets the root weight, shifts the elements browsers make bold themselves (`h1`–`h6`, `th`), and repeats each of the book's weight rules, shifted, with the same selector, so the book's specificity and order still decide between them. Inline weights are shifted in place, keeping their own value to restore. At 400 the book's own weights stay as they are. An absent weight removes the style element and restores the inline weights, leaving the book untouched. EPUB.js waits for the rules before it serializes a section, so it lays out at the chosen weight.

The Paragraph indentation stepper shows the indentation in em. It offers 0–20 em in steps of 0.5, with a default of 1 em, the usual indentation of both Japanese and English books.

The Page flow card offers Single and Double pages only in Paginated view with the
Horizontal writing mode. The saved choice remains independent of view and writing
mode and defaults to Double. Horizontal Double uses EPUB.js spreads from 800 CSS px
of available width; narrower areas fit one page. Single disables horizontal spreads.
Vertical text has no double pages: it uses the existing vertical pagination axis,
one column a turn, whatever the saved choice. Page changes use the existing
kept-anchor reflow and lookup invalidation without replacing the book or rendition.
Fixed-layout books retain authored composition while the spread choice uses
EPUB.js's page fitting.

Maximum text width limits each page's physical
text width, including vertical text, and centers a capped reading host. Paginated
horizontal Double allows two requested page widths; other modes use one. Requested
widths fit the available area after sidebar and window changes. Horizontal Double
falls back to one capped page below the 800 px spread threshold, including narrow
requested widths; container growth restores the spread when it fits. Reflowable pages
use a 20 px outer inset (40 px column gap). Covers/illustrations retain proportions
and center within their own page. Continuous views keep their existing manager,
scroll direction and chapter behavior. The adapter-only side margin applies only
when no maximum width is supplied.

Maximum width and Reader max height store integer CSS pixels from 100 through
1,000,000 in steps of 10, each defaulting to 4000. The durable bound permits values
from larger monitors to remain valid on smaller ones. Native
`get_reader_monitor_size` reports only the containing monitor's width and height
in logical/CSS pixels (physical size divided by scale). Controls refresh on move,
resize and scale changes, rounding the monitor limit up to a 10 px step so it can
be filled. Missing monitor reporting is stated in the panel; fitting still works.
The host centers a shorter height inside the existing footer clearance. Stepping
height down from beyond the area's height jumps just below its current height;
typed height applies directly and supersedes a pending measured step.

Appearance records without maximum width convert a valid older
`readerSideMargin` to `roundTo10(1200 - 2 * margin)` CSS px (1120 for the old
40 px default). This stable conversion does not vary with the monitor at restart;
explicit width takes precedence, and an invalid explicit width uses the default.
Subsequent frontend saves omit the retired margin. Native loading retains it only
when no width field exists, for frontend migration and older backups. Invalid
width/height fields drop independently; invalid native saves reject the record
without mutation. Single/Double accepts only the two saved IDs. Other preferences
and reading locators remain unchanged.

The Writing mode choice offers the Horizontal, the default, and Vertical. The chosen mode applies to every reflowable section of every book: the adapter sets it on the section's root as an important declaration, where EPUB.js reads the section's axis, and one style element has the body and every element in it inherit it, replacing the modes the book sets, declared in its package or set only in its CSS. An absent mode removes both and restores any root mode set inline before, such as a declared one. Pages follow the displayed mode: Horizontal reads and turns left to right (Right advances), in Single or Double pages as chosen, and Vertical right to left (Left advances), paging by height one column at a time. The adapter sets that page direction on EPUB.js's rendition, view manager, and layout, whose copy formats each section's columns, instead of the book's own progression; without it a right-to-left Japanese book shown horizontally would run its text right to left. A paginated section whose root sets itself right to left, as its own `dir="rtl"` does, has EPUB.js lay its columns out right to left whatever the progression, so it reads and turns right to left (Left advances) from its first page in Horizontal or in a horizontal book's own mode: as EPUB.js formats each section, the adapter takes the progression from the section root's own direction and sets it on the rendition, the layout, and the view manager with its page mapping and stage, without laying the pages out again, before EPUB.js positions the section; the next section without its own direction returns to the mode's progression. Vertical reads such a section's root and body from the top (`direction: ltr`), since EPUB.js cannot page lines and pages that run upwards; the elements inside keep their own direction. EPUB.js takes a section's axis only as it renders it, so a change of mode styles the loaded sections, clears EPUB.js's views, displays the section of the kept reading point again, and then shows the page holding that point like any reflow. Its first layout in the new axis is laid out again as with a chosen margin. In continuous view, the reading area's side inset (present only while the book scrolls vertical text horizontally) and EPUB.js's scroll axis, with its scrollbar, are set for the new mode and EPUB.js measures the reading area again before the section is shown, so the new sections span the reading area as when the book opens in that mode rather than keeping the old mode's width. EPUB.js drops its two-page spread only when its axis changes to vertical scrolling, never for the vertical scrolling a continuous book opens with; the spread sets how wide it lets images be, so the adapter keeps the spread the book opened with, and images, such as covers, keep their opening size. Fixed-layout books ignore a chosen mode.

The Text orientation choice, below Writing mode, offers the Mixed, the default, and Upright. Mixed lays Latin letters and digits sideways in vertical text, and Upright stands every character upright. A chosen orientation applies to every reflowable section of every book: one style element sets it as important on the root, the body, and every element in it, replacing the orientations the book sets, including upright or sideways runs its CSS sets; an absent orientation removes it. It only affects vertical text, so horizontal sections, including a vertical book shown Horizontal, lay out as before. The book's own `text-combine-upright` runs (tate-chū-yoko) stay combined. The axis is unchanged, so a change reflows in place to the page holding the kept reading point, like a size change. Fixed-layout books ignore a chosen orientation.

Hide furigana remains off by default. When on, Text behavior shows a Hide furigana
style dropdown: Hide, Partial, Toggle and Full. The
appearance record stores `readerFuriganaStyle` as `hide` (legacy/default),
`partial`, `toggle` or `full`, independently of `readerHideFurigana`. Native and
frontend loads discard missing/invalid styles independently; invalid native
saves preserve the record and invalid frontend setters do nothing. Existing saved
hide switches keep their behavior. Turning the switch off preserves its style;
backups and restores include the style with appearance, and older backups use Hide.

Hide removes `rt`/`rp` from layout with `display: none`. Partial keeps readings at
35% opacity, revealing them on hover, keyboard focus or click. Toggle reserves
their space but hides them until clicking or pressing Enter/Space on their ruby
base, with another activation hiding them again. Full reserves their space and
reveals on hover/focus or activation; an activated Partial/Full reading stays
revealed for that book session. Enabled styles hide fallback parentheses. Off
restores the authored presentation. Fixed-layout books ignore every style.

`src/features/reader/furigana.ts` owns per-ruby reveal state, keyed by section and
occurrence, inside the EPUB adapter. Loaded section documents and displayed
iframes receive the same style and reveal state; revisiting/re-rendering keeps
reveals until the book closes, without persisting them. Interactive ruby bases
have accessible button semantics; original attributes return on Off/Hide.
Ordinary reveals consume only their click/key, so they cannot also trigger lookup,
notes or VN advancement. Text selection, modified lookup gestures and authored
links retain their actions; ruby inside links/controls does not become a button.
Listeners are released for discarded documents and on disposal. Changing between
Off and the space-preserving styles, or revealing an individual reading, does not
reflow, navigate or publish progress. Entering/leaving enabled Hide reflows to the
kept reading point. Base text and annotations stay in the DOM, so counts,
chapters, search, selections and saved positions still exclude annotation text.
Source EPUBs are never modified and no new readings are generated.

The Images section follows Text behavior with the title, description and
blue accent. Blur image defaults off. Blur mode offers All (legacy/default) and
After ToC, saved independently as allowlisted `readerBlurMode` values `all` and
`after-toc`. Native/frontend loads drop invalid or missing modes independently;
invalid setters are ignored and native saves leave the stored record unchanged.
The choice remains saved when blur is off.

All affects every raster image, video and outer SVG in reflowable book content.
After ToC leaves images through the authored contents page clear. The adapter
requires usable navigable contents, then resolves the EPUB 3 ToC landmark, EPUB 2
guide ToC reference, or in-spine EPUB 3 navigation document, in that order. Only
linear spine destinations qualify; labels and filenames are never guessed. A
fragment uses the end of its containing nav/doc-toc or target element within the
section; an absent or unresolved fragment uses that section's end. Without an
identified page, All applies and the panel explains the fallback. Fixed-layout
books retain unblurred images and the panel explains that exception. The adapter's
`getImageBlurBoundary()` exposes only available/unavailable/fixed-layout status.

Affected images act as focusable reveal toggles: a primary unmodified click, Enter
or Space reveals or reblurs one occurrence, with a stable accessible name,
`aria-pressed` state, action hint and inset keyboard focus indicator. Pointer reveals have no added outline; the keyboard indicator uses the system highlight color inside the image box. These actions consume book
links/lookup activation on the image while blurring is enabled; modified clicks
and surrounding text keep their existing behavior. Each occurrence uses its spine
index and media ordinal, so repeated resources reveal independently. Adapter-owned
reveals survive turns, contents/bookmark/search/image jumps, resize, font and view/
writing-mode changes, and blur off/on or scope changes during the same open-book
session. They reset on disposal, book change or restart and are never persisted.
Listeners leave discarded documents and are removed on disposal. Original image
accessibility attributes return when it leaves the blur scope or blur is disabled.

One early important CSS layer applies a 20 px filter only to affected unrevealed
media, with outer SVGs blurred once. Cached sections are styled before serialization;
displayed and late-rendered sections are refreshed from the current session state.
Blur/scope/reveal changes alter no layout, scroll, progress or saved position and
never navigate or remount. Gallery thumbnails and the viewer remain clear.

Every image alone on its line is centered along the inline axis in every reflowable section of every book, horizontally in horizontal text and vertically in vertical text, with no setting. The adapter marks a section from its markup when EPUB.js loads it, before layout, in displayed and cached documents alike. A block (such as `p`, `div`, `section`, or `body`) whose only content is images, however they are wrapped, such as `<p><span><img></span></p>`, centers its lines with no first-line indentation, and those images take auto inline margins, which center the ones the book displays as blocks. An image directly between blocks, with only whitespace or line breaks beside it, takes auto inline margins too. Images in running text or ruby stay inline, and images in headings are left to heading centering. `img` and outer `svg` elements count as images. One style element, added only to a section with such images, holds the important rules. Character sizing, illustration gaps and horizontal image-only page fitting follow Reader images. The marks change no text, so book progress, chapters, and saved positions are unchanged. Fixed-layout books are not marked.

Every chapter heading, text or image, is centered along the inline axis in every reflowable section of every book, with no setting, instead of where the book's CSS places it (Japanese books usually indent a heading a few em from the line's start through a wrapping `div`). A chapter heading is the block that a contents entry's anchor begins, with no text before the anchor in it: the anchor element itself when it is a block or `h1`–`h6`, the heading right after an empty anchor such as `<a id="toc-1"/>`, or otherwise the anchor's nearest block. An entry that opens a section without an anchor marks the section's first `h1`–`h6` when no text comes before it. A block with no text or image, or with more than 100 characters, is not a heading, and headings no contents entry begins, such as a right-aligned signature, keep the book's placement. The adapter knows the contents before any section loads and marks each section from its markup when EPUB.js loads it, before layout, so displayed and cached documents carry the marks. The heading and every block around it that holds nothing else get one important style that outranks the book's rules: centered lines (`text-align: center`, `text-align-last: auto`), no `text-indent`, and auto inline margins with no inline padding, so a wrapper's start margin and a hanging indentation do not push it off center while a heading narrower than its line is centered too; its images take auto inline margins. Only the actual text-title block takes a 1.1 layout scale; wrappers are not scaled again, so publisher font sizes and the title/subtitle hierarchy remain relative. Image titles are not enlarged. Weight stays the book's; image-heading gaps follow Reader images. The style is not read back as the book's own indentation, and presentation changes retain the existing reading anchor.

A chapter-name image often draws its title on one side of a larger blank image, such as a vertical title at the top of a page-tall strip. For each heading `img`, the adapter reads the image file from the archive while the section loads, finds the content's bounds against the background shared by its four corners (within 32 per channel, transparent pixels counting as background, measured at up to 1024 px on the long side), and keeps the share of the image by which the content is off center, horizontally and vertically, as custom properties on the image. Along the inline axis only, horizontally in horizontal text and vertically in vertical text (a section root in vertical text is marked `data-komori-vertical`), the heading style translates the image by that share of its own size and clips away the blank part moved past its edge, so the drawn title sits centered where the box already is. Translation and clipping change no layout, so pages, progress, and positions are unchanged. An image with corners of different colors, no content, content less than 1% off center, or that cannot be read or decoded keeps its content where it is. Each image file is measured once per open book.

The Paragraph margin stepper leads the Page flow grid, before Maximum text width. It offers 0–200 px in steps of 2, default 0 px. The margin applies to every reflowable section of every book: one style element sets `margin-block-start` and `margin-block-end` on every `p` as important declarations, so it lies above and below paragraphs in horizontal text and to their right and left in vertical text, and adjacent paragraphs are that far apart. Headings and other blocks keep the book's own spacing. An absent margin removes the style element. The axis is unchanged, so a change reflows in place to the page holding the kept reading point, like a size change. Fixed-layout books ignore it.

Letter spacing and Word spacing steppers follow Paragraph indentation in the Typography grid. They offer −10–60 px and −20–120 px in whole pixels, default 0 px, saved as `readerLetterSpacing` and `readerWordSpacing` and passed to the renderer as `letterSpacing` and `wordSpacing`. 0 keeps the book's own spacing; any other value applies to every reflowable section of every book through one style element first in the head, whose important declarations in a cascade layer (`@layer komori-text-spacing`) replace the book's own spacing on the body and every element in either writing mode. Ruby annotations (`rt`, `rp`) keep normal spacing beside their base, and combined upright text (tate-chu-yoko) ignores spacing as CSS requires. Word spacing changes only spaces between words, so it leaves Japanese text unchanged. The axis is unchanged, so a change reflows in place to the page holding the kept reading point in every view, like a size change; returning both to 0 removes the style element. Fixed-layout books ignore them.

The Wheel step stepper follows Reader max height in the Page flow grid. It sets how far one mouse wheel step scrolls a continuous book, 10–2000 px in steps of 10, default 100 px, a browser's own step. It is saved as `readerWheelStep`; it is an input preference rather than part of `ReaderPresentation`.

The View mode choice offers Continuous, Semi-continuous, Paginated and VN above Writing mode (VN is described above). Paginated, the default, turns pages as described above, for every reflowable book whatever `rendition:flow` its package declares: the adapter passes EPUB.js the paginated flow, which would otherwise take a declared scrolled flow and show each section as one unpaged view; fixed-layout books keep their own layout. A change keeps the reading point: paginated view shows the page holding it, and continuous and semi-continuous view scroll it to the start of the reading area. EPUB.js sizes its views to the host as its view manager attaches, so the adapter sets the host's inset for the new view before rendering the book again; paginated pages after a continuous vertical book are then as wide as the host rather than as the inset reading area, which would hide their last lines. Semi-continuous view takes margins like continuous view. In continuous view, horizontal text takes the margin as each section body's left and right padding, as on a page; without one, EPUB.js pads it by a twelfth of the width. Vertical text scrolls horizontally, so its margin is the reading area's own left and right inset, where the text scrolls in and out: the adapter sets `--reader-side-inset` on its host, which the Reader's stylesheet applies as padding of at most a quarter of the width. Without a margin, it is inset by the 20 px EPUB.js gives a vertical page's sides.

A chosen indentation changes how far the paragraphs the book indents are indented; the book still decides which ones. Every positive indentation the book sets becomes the chosen one: the adapter repeats each of the book's text-indent rules, in order, in one style element after the book's own, with the same selector, so the book's specificity and order still decide between them. Zero, negative (hanging), and relative values such as `inherit` are repeated unchanged. Japanese books usually indent a paragraph by beginning it with an ideographic space (U+3000) rather than with CSS. A `p` whose readable text (without ruby annotations) begins with one is marked, and an important rule sets its text-indent to the chosen indentation less 1 em, so the space and the text-indent together make the chosen indentation; at 0 the space hangs outside the line. Only the first space counts, and a paragraph within a selector the book gives a hanging indentation is not marked. Paragraphs that begin with dialogue brackets, and other unindented paragraphs, stay unindented, and a book that indents nothing is unchanged. Positive inline indentation is replaced in place, keeping its own value to restore. The text itself never changes. An absent indentation removes the style element and the marks and restores inline indentation.

## Reader themes

The Reader theme colors the book surface only; the application keeps its own application theme, and the sidebar follows the application. `src/features/reader/readerThemes.ts` holds 15 presets: Paper, Sepia, Night, Sakura, Matcha, Hojicha (the default), Solarized, Nord, Gruvbox, Rosé Pine, Tokyo Night, and Catppuccin Latte, Frappé, Macchiato, and Mocha. A preset's footer text is its text mixed 62% toward its background. Custom themes add a name and their own Background, Text, Highlight, Selection, and Footer text colors. Missing Highlight in an older saved theme loads as its saved Selection color, preserving its pointer-match appearance; subsequent Selection edits leave Highlight alone. Explicit invalid Highlight values discard the stored theme, and saves require all five valid colors. Each preset has its own Highlight default.

The Appearance panel's Theme section, marked with the blue accent, shows the swatches four to a row: the presets, a swatch for each custom theme (its colors and name) in the order they were made, and the Custom swatch last. Each theme swatch is pressable (`aria-pressed`). Custom creates a theme from the shown theme's colors, named "Custom N" with the first free N, and chooses it; at 32 themes it is disabled. While a custom theme is chosen, a Theme name field and the color fields (a swatch opening Komori's color picker beside a HEX field, the shared `ColorField`) edit it below the swatches, with a Delete theme button. A typed color applies once it is a whole `#rrggbb` value, and a typed name once it is valid; leaving a field with anything else returns it to the current value. Deleting the chosen theme returns to Hojicha, with focus on Hojicha's swatch. Highlight edits temporary pointer-match paint independently of Selection.

The Reader resolves the chosen theme (Hojicha when it is unknown) and sets its page, text, and footer colors on the reading area; a continuous book's scrollbar takes the text color too. It passes text, browser-selection, and pointer-match colors to the renderer as `textColor`, `selectionColor`, and `highlightColor`. The adapter adds one style element to every reflowable section when EPUB.js loads it, before layout, and a change restyles the displayed and cached documents without a reflow, as Blur image does: nothing is displayed, cleared, resized, scrolled, or published. Its rules sit in a cascade layer (`@layer komori-colors`), whose important declarations outrank the book's important ones whatever their specificity. They set the text color on the root and every element, replacing the colors the book sets in its stylesheets and inline (only an inline `!important` color would win), tint links (`a[href]` and everything in them) 40% toward blue so they stay distinguishable, make the book's own backgrounds transparent, except those of images, so the text keeps its contrast on the page, and set Selection on `::selection` and Highlight on `::highlight(komori-pointer-match)`, and Highlight on the saved-passage marks, independently. Without colors, the style element is removed and the book keeps its own. Fixed-layout books ignore the presentation colors, though the reading area around them takes the theme.

## Reader images

The Images command opens the Book media panel and image-card stack. The
adapter's `listImages(signal)` reads original linear spine documents in reading
order and publishes only session-local IDs, bounded plain alt text, authored
chapter labels and real section ordinals. Each `img` or outer SVG occurrence is a
place, including repeated uses of one resource; nested SVG is not counted twice.
Discovery stops at 500 images, 2,000 spine sections or 32 million document
characters, with explicit partial/failed-section feedback. Empty, loading and
failure states and Retry images never substitute placeholder content.

`loadImage(id, size, signal)` resolves resources only inside the adapter's current
archive. External, data, blob and escaped paths are refused. ZIP metadata is checked
before decompression: section/SVG documents are limited to 2 MiB and one image's
combined raster resources to 16 MiB. Raster signatures are sniffed. Inline and
referenced SVG is rebuilt from an inert drawing subset without authored CSS,
scripts, active attributes or external references; up to eight embedded images
must resolve to archive raster bytes. Unsupported drawings or undecodable images
show explicit failure with retry. At most three image reads/decodes run together;
decoding is bounded to ten seconds and rejects dimensions above 40 million pixels
or 20,000 pixels on either axis. Only adapter-owned blob URLs cross the UI boundary.
Thumbnails are high-quality PNGs fitting 1024 × 768, preserving proportions and
supporting dense displays. Raster thumbnails never upscale; rebuilt SVG drawings
render at that thumbnail bound even when their intrinsic box is tiny. The viewer
retains the sniffed raster bytes or rebuilt inert SVG after bounded decoding, with
the original dimensions and embedded raster detail; it does not flatten SVGs or
downsample large rasters to 4096 px. The existing input byte, pixel, axis, drawing
complexity and concurrency bounds remain enforced. No authored SVG reaches UI state.
Embedded SVG rasters are decoded and checked against the same dimension bounds
before rebuilding the drawing, including drawings with a tiny intrinsic box.
Cards request thumbnails only near the sidebar's viewport and release them when
they leave it. Viewer changes release the previous image. The adapter owns and
revokes every generated URL; panel/book changes and disposal reject obsolete reads
and jumps, and disposal aborts decodes and revokes remaining resources.

The native modal viewer keeps the dark overlay, centered fitted image,
side arrows, location caption and Go to location. It adds labelled Close, zoom
(50–400% in 25% steps), clockwise rotation and reset controls. Left/Right browse
without wrapping; +/− zoom, R rotates, and 0 resets. Zoomed images pan by drag or
scrollbar. Escape, Close and a click on the overlay return focus to the image card.
Tab stays within the dialog. Browsing, transforms and closing never navigate,
reflow or remount the book or write reading state. Opening dismisses lookup and
queued wheel turns; book input and new lookup reports wait while the viewer is
open. Blur image applies only to the book, so the viewer can inspect its artwork.
`goToImage(id, signal)` is the explicit position-changing action: it joins the
existing navigation queue and resolves the actual rendered image occurrence in
every view/writing mode. A successful jump closes the viewer, publishes normal
resume/progress and hands focus to the book; a failure keeps the viewer available
with a retry message. No image bytes or source EPUB are exported or modified.

The toolbar and captions reserve their own space; the remaining measured area
fits the complete portrait or landscape image at its original aspect ratio. Side
arrows stay inside the available width in narrow windows. Rotated artwork centers
in a canvas sized to its rotated bounds; zooming changes only the display size.
Boundary arrow keys keep the current transforms. An unmodified primary click on
an unblurred book image opens the same carousel at that occurrence, including
repeated resources and outer SVGs. The adapter resolves its displayed section and
ordinal against original archive discovery, never the rendered resource URL.
An open gallery's active discovery is reused so its card IDs and requests stay valid.
Blurred occurrence toggles retain their reveal/reblur interaction. Direct-open
requests cancel on replacement, viewer closing, book change and disposal; failed
or bounded-out occurrences show honest feedback without navigating.

For reflowable horizontal paginated sections with a maximum text width or adapter side margin, the
adapter uses the layout's actual column width as the image/SVG width limit.
EPUB.js subtracts the column gap from that width a second time in its image hook,
which shrinks illustrations to one pixel at a large margin. The adapter corrects
only that width limit; fixed-layout image sizing stays unchanged.

Reflowable image layout lives in `bookImageLayout.ts`. Explicit publisher character
images (`gaiji` / `gaiji-*` / `gaiji_*`, `glyph`, `inline-character`,
`text-image`, inline wrappers with those classes, or images within ruby) use a
one-em inline box with contained artwork, zero margins/padding and middle alignment.
This follows the surrounding text size in both writing modes. Illustration dimensions
alone never classify an image as a character. Text, ruby and resource attributes stay
unchanged; only the adapter's derived DOM is styled.

Continuous and semi-continuous vertical sections use their measured content width,
with a pixel allowance for EPUB.js's rounded measurement. They do not round up to
page-width intervals: chapter text, first illustrations and adjacent image sections
join without unused page space. Horizontal section sizing and fixed pages retain
EPUB.js's sizing and the existing kept-position and chapter-clipping lifecycle.

Standalone illustrations and image-only headings use block image lines with one
1.5-em logical gap between consecutive images and after their outermost image-only
wrapper (or after an unwrapped image before a caption/text block). Nested wrapper margins/padding and inline baseline space cannot add another
gap. The gap follows the reading direction: below horizontal images and left of
vertical images, in every reflowable view. Running-text illustrations keep their authored
placement. Horizontal image-only pages, including covers, fit the actual column or
scroll area with auto raster dimensions; an SVG box uses its viewBox proportions.
In paginated views, a text-free section centers its cover or illustration on both
axes inside one page, including one column of a horizontal spread. Its original
wrapper remains in place, its extra image gap is suppressed, and fitting leaves
room for page padding. Continuous fitting reserves the common gap; continuous
vertical covers and fixed-layout pages retain the renderer's image sizing.
Serialized/cached/displayed and
late sections refresh limits through the existing kept-position reflow lifecycle.

## Reader find in book

The sidebar's Find in book command and Ctrl+F from non-interactive Reader content
open the approved Search panel. A labelled query, Whole book / This chapter
choices and Find submission support pointer and keyboard use, with accessible
initial, searching, no-match, failure/retry and bounded-count states. Queries are
trimmed literal text, case insensitive through Unicode simple case folding, at
most 256 Unicode characters; regular expressions and persistent indexes are absent.
Results show authored chapter labels when available, section ordinals and escaped
plain-text excerpts with the matched text marked. At most 100 results are returned;
100+ means more exist, not an exact total. Excerpts contain at most 160 Unicode
characters, including truncation marks. Searches are explicit submissions; editing
the query or changing scope cancels the previous search and its result jumps.

`ReaderRenderer.searchBook(query, scope, signal)` reads original linear spine
documents through the adapter's existing archive access. Its temporary per-section
text map joins inline text and ruby bases, separates blocks and line breaks, and
excludes rt/rp, scripts, styles, templates, noscript and explicitly hidden content.
Renderer-injected styling never becomes searchable. Search reads at most 4 million
UTF-16 units per section and 32 million per request, failing safely rather than
silently reporting a partial book. It yields between sections and stops once an
additional match proves the result limit. This chapter snapshots the actual chapter
at submission using the existing authored chapter boundaries, including anchors
within one spine section and chapters spanning several sections.

Only session-local match IDs, labels, section numbers and excerpt text cross to UI
state. The adapter retains offsets and expected text for the current search;
`goToSearchResult(id, signal)` rejects obsolete IDs and cancelled requests, verifies
the original and displayed text, and resolves the match's first character across
inline/ruby markup. It uses the existing navigation queue and point-display logic
in paginated, continuous and semi-continuous views and both writing modes. A jump
dismisses lookup/highlights, publishes resume/progress, and hands focus to the book
under the contents-jump rule. Failure retains result focus. Query/scope changes,
panel closure, another book and disposal cancel pending resolution and suppress
late success, focus and position publication. A movement already applied before
cancellation is not rewound. Appearance and bookmarks remain intact; no archive
path, CFI or persistent search data reaches components or native storage.

## Reader bookmarks

Catalog schema version 5 adds `bookmarks`, keyed by a native UUID and catalog ID
with `ON DELETE CASCADE`. The catalog-scoped `list_bookmarks`, `create_bookmark`,
`rename_bookmark`, and `remove_bookmark` commands use only Komori-owned data and
never access a source file. Each book holds at most 1,000 bookmarks. Optional
labels are trimmed plain text of at most 80 Unicode characters; excerpts are
adapter-derived plain text of at most 160, with no control characters in either.
Invalid stored locators are omitted. Unknown or removed catalog IDs cannot create
dependent rows; rename/removal also require the owning catalog ID.

`ReaderBookmarkLocator` extends the resume locator with a required section
fingerprint and a 64-hex SHA-256 `contentKey`. The adapter hashes the original
archive section document, independently of injected presentation and generated
resource URLs. It captures the currently displayed text fraction, including the
initial reading place, without moving the book or changing selection. Native
creation rounds the fraction to nine decimal places and atomically returns the
existing bookmark for a duplicate locator, retaining its label. The existing
resume locator and its fallback behavior are unchanged.

The sidebar's Bookmarks command opens the Saved places panel with real
labels, excerpts and honest section/fraction captions. It precedes Contents so
Shift+Tab from the reading area still reaches the last contents entry. The panel
offers Save current place with an optional label, inline Rename with Save/Cancel
and Escape, and Remove; loading, empty, save/duplicate and retryable failure states
are accessible. B from non-interactive Reader or book content saves an unlabeled
place and gives floating, live feedback after native confirmation (including
duplicates and failures). Ctrl+B opens the list without creating a bookmark. R goes
to the most recently saved bookmark of the book.
Repeated presses, editing fields and pending navigation are excluded. Bookmarks
remain manageable when the source cannot be opened.

`bookmarkStore` owns catalog-bound IPC and DTO validation; `useBookmarks` discards
loads and mutation results from an obsolete store or unmounted Reader. Captures
and bookmark jumps use `useReaderRenderer`'s navigation queue with turns, contents
jumps and presentation changes. Only the adapter resolves saved locations. Before
moving, it requires the same spine section, href fingerprint and original-content
hash; a mismatch after relink shows an unavailable-location message and performs
no fallback jump. Unresolved bookmarks stay renameable/removable. Successful jumps
publish resume/progress and hand focus to the book using the contents-jump rule;
failed jumps retain button focus. Jumps invalidate lookup and pointer highlights
like other navigation. Capture, jump and storage responses after disposal/book
change are ignored; the adapter clears its per-book fingerprint cache on disposal.

## Reader notes

`src-tauri/src/reader_notes.rs` creates the additive `reader_notes` table in a
schema-6 catalog, without a version bump. Each native UUID belongs to one catalog
book (`ON DELETE CASCADE`) and holds a bookmark locator, selected passage, note
body, and creation/update times. At most 1,000 notes belong to a book. Passage and
body are trimmed, nonempty plain text of at most 4,096 Unicode characters each;
LF and tab are allowed, other control characters are refused. The catalog-scoped
`list_reader_notes`, `create_reader_note`, `edit_reader_note` and
`remove_reader_note` commands validate IDs, text and the canonical bookmark
locator. Invalid stored rows are omitted, unknown books cannot gain notes, and
editing/removal requires both owner and note IDs. Relinking retains the notes.

N captures the current selection through the adapter and opens a Save/Cancel
editor. Capture clones selected DOM fragments, omitting ruby annotations, hidden
content and active elements, retaining paragraph breaks without truncation. The
locator records the selection's start in original section text and its original
content hash. Empty, oversized or changed selections, navigation, book changes
and disposal refuse capture. The Notes sidebar uses real passage/body cards with
section/fraction captions, Jump, Edit and Remove; loading, pending, failure and
retry states remain explicit. Note bodies wrap in full, preserving line breaks and
breaking long words within the card instead of using bookmark-label ellipsis.
Source-unavailable notes remain editable/removable;
an unresolved jump uses the bookmark hash check and never substitutes a place.
`useNotes` ignores obsolete loads and mutation completions, serializes saves, and
registers pending writes with window closing. Successful jumps publish the usual
resume/progress and return focus to the book.

Notes search is an immediate literal substring match over both full saved bodies
and passages, using Unicode lowercase and ignoring query-edge whitespace. An empty
or whitespace-only query shows all notes. Clear empties the query and returns focus
to the search field; the panel reports visible/total counts and distinguishes an
empty collection from no matches. Creation order (the default) preserves the native
oldest-first list, whose timestamp ties use ascending UUID; new notes append.
Reading order uses ascending spine section, text fraction, then UUID as a stable
tie independent of body edits or list refresh. Neither view changes stored rows,
locators or reading positions. Mutations immediately recompute results; filtered
jump/edit/remove actions target the note's ID, retaining full cards and feedback.
If a mutation removes the last visible card, focus returns to search.

`useNotes` owns the query and order above the conditionally mounted panel. They
survive panel visits, appearance/navigation changes and note reloads for the same
book store. A book/store change or leaving Reader discards them; returning to a
book starts with an empty query and creation order. No preference is persisted.

Saved note passages are painted in the book with the Reader theme's Highlight
color, independently of Notes search/order and lookup paint. The adapter checks
the saved section fingerprint and original-content hash, then resolves the passage
only at its saved start fraction, matching paragraph/line whitespace and excluding
ruby annotations and inactive content. Changed or unresolvable passages receive
no substitute highlight. Saved passages paint as padded, rounded marks in one
layer appended to the section's root element, outside the body, behind the text and
without pointer events; pieces on one line join into one mark, and the layer repaints
after every reflow. This preserves book markup, layout and browser selection. A
highlight is a note whose body is empty; the frontend, `reader_notes` and backups
accept an empty body or a valid note text. Book images are copied as PNG through the
web clipboard and saved through the native `save_book_image` command, which takes the
raw image bytes (at most 32 MiB, PNG/JPEG/WebP/GIF by content), cleans the suggested
name and writes only where the user picks in the save dialog. An image a section wraps
in SVG with a single picture and no drawing hands over that picture's own bytes; any
other SVG is drawn to a PNG whose longest side is at least 2048 px. A plain left click
on a saved passage, with nothing selected and not on a link, opens a Saved passage
menu; the pointer shows the hand over a saved passage while nothing is selected and no
button is held (`noteHoverCursor` follows the pointer through the section, since the
marks take no pointer events, and sets `data-komori-note-hover` on its root). The menu
offers Open in notes, which shows the Notes panel with that note focused, clearing its
search if it hides the note, and Delete; the return pill's buttons show the hand too. A
right-click on one with nothing selected
opens the same menu. Selected text paints as the same per-line marks in the theme's
selection color while the browser's own selection stays transparent, so a selection
across paragraphs reads as lines rather than one block; the layer exists only while
text is selected. All saved notes paint after load/creation and in newly displayed
documents, including after reflow/reopen; removal clears their paint. Obsolete
asynchronous paints and disposal are cancelled. This reuses existing note data
without adding stored range ends or EPUB writes. Fixed-layout pages, which retain
publisher colors, use a soft yellow note highlight.

## Reader lookup

Settings > Reader popup's Scanning and results card saves `readerPopupCjkOnly`
("Only look up Japanese/CJK text"), default false. When enabled, automatic book
and child-popup gestures require at least one Han, Hiragana, Katakana or Hangul
character in the lookup text. Selection, shortcut, keyboard release, Shift,
click and hover are gated before reports/scans or native requests; rejected
gestures preserve browser selection and ordinary context menus. Changing it
cancels pending adapter scans and dismisses an English root popup without reflow.
Manual Dictionary searches, explicit headword/glossary links and Settings previews
remain available independently.

Above headwords reserve a shared 16 px annotation inset. Ruby readings are
positioned above their bases without contributing to the expression's 42 px row;
voice, tags and actions center on that row in parent/child popups and both previews.

Reader popup and Settings preview pass the same three-role policy to native term and kanji lookup. Definition sources (word and kanji) filter SQL probes and retrieval before exact, prefix and deinflected winner selection or tag resolution; excluded sources cannot determine a match or contribute definitions/tags. Frequency sources independently filter word and kanji metadata, and pitch sources independently filter word pitch metadata. Existing imported-source order, shorter starts, reading matching, deduplication, and safe DTO rendering remain intact. A retained popup/preview refreshes after policy changes or completed dictionary maintenance, clears obsolete match paint before requesting, and rejects earlier responses. The book renderer and browser selection are untouched; master/owning-trigger invalidation still dismisses Reader work.

Settings > Reader popup provides one row per role (Term, Frequency and Pitch dictionaries) in a grouped list: the active sources by name under the role (`All imported sources · …`, the chosen names, `None`, or `No suitable dictionaries imported.`) and a single Choose… button, or Open dictionary settings when none is eligible. An accessible modal offers All imported sources, Selected sources, and None; Apply saves one role, Cancel/Escape preserves choices and restores opener focus. Removed and ineligible selections remain explicit and labelled unavailable; loading/failure/empty states are honest, with Retry and a Dictionary settings handoff. The popup preview in Settings > Reader popup always looks up 読む (there is no query field), reusing `ReaderLookupPopup`, `LookupEntry`, kanji content, pronunciation availability, definition disclosures, frequency expansion and Dictionary handoff. It works with master/automatic triggers disabled, has initial/searching/no-match/safe-error states, and retains a separate neutral palette preview. Palette/custom colors/radius/dimensions/reading position and visibility/voice changes update existing result presentation without lookup; source choices and collection changes refresh with disposal/stale-response rejection.

The complete Lookup triggers card controls Mouse selection, Shift lookup, Keyboard shortcut, Click lookup, and Hover lookup, independently of book presentation. The master Enable reader popup switch gates all lookups before dictionary requests; standalone Dictionary remains independent. The adapter's optional `setLookupTriggers` updates section listeners and cancels timers without remounting/reflowing the book or changing browser selection. Disabling the master or the trigger owning a popup dismisses it, clears match paint, and rejects its pending response. Unrelated trigger changes keep the popup/result content. Reenabling requires a deliberate new gesture; an unchanged browser range's later key release does not reopen lookup.

Keyboard shortcut looks up selected text using Shift + Enter (default), Alt + X, or Ctrl + Space. Only the exact preset's modifiers match; repeats, composition, already-handled events, and input/textarea/select/contenteditable/textbox targets are ignored. The default is prevented only when an enabled shortcut finds non-whitespace book text. Keyboard-selection release lookup remains independently enabled under the master switch, regardless of Mouse selection or Keyboard shortcut. Shortcut handling records the range to avoid a second lookup on key release.

Shift lookup scans the touched character on Shift press or held-Shift pointer movement. Click lookup offers Left click, Double click, and Right click + modifier (Shift + right click). Hover lookup waits the saved Scan delay (0 ms by default, 0–1200 ms in 10 ms steps; 0 scans at once) over one character; movement within it keeps the deadline, movement to another restarts it. Movement off text, leaving the section, pointer press/cancel, a key, blur, scrolling, layout invalidation, settings changes, and disposal cancel pending hover. Trigger preference changes do not reuse an old pointer location or pending timer.

Gesture precedence: pressing/dragging cancels hover and suppresses scans during selection drags; a noncollapsed browser selection wins over Left click, even when Mouse selection is disabled. Double click uses touched-character extraction and suppresses that gesture's automatic selection lookup, retaining the browser range. Enabled Shift scanning takes priority over hover and ordinary left/double click while Shift is held. The configured Shift right-click action uses the click trigger and suppresses the context menu only if it handles readable text; ordinary/unconfigured/disabled/off-text context clicks keep the browser menu. Every pointer trigger reuses the same bounded extraction, ruby exclusion, placement, revision checks, and match highlighting. Each report identifies its owning trigger through `origin`; older unlabelled scans retain Shift compatibility.

Popup close behavior governs Escape and outside pointer presses in both the app and book: Esc or outside click (default) accepts both, Outside click only ignores Escape, and Persistent until next lookup ignores both. An ignored Escape leaves the floating sidebar alone while a popup is open. Each new lookup replaces the previous popup. Navigation, contents jumps, scrolling/layout invalidation, book changes/disposal, master disable, and owning-trigger disable always dismiss and reject stale results. Clearing a browser selection still dismisses its selection-owned popup; pointer lookup never changes that range. Focus inside a dismissed popup returns to the reading area.

`src/features/reader/popupThemes.ts` defines Application (default, inheriting the current application colors), Classic, Paper, Night, and Custom. The three independent presets preserve the Background, Text, Accent, Border, and Tag colors. Derived semantic tokens and the light/dark color scheme are set only on the popup and its Settings preview, including readable accent ink/actions and tag-category contrasts. Plain primary, secondary, muted, and accent text maintain at least 4.5:1 contrast on each preset's background and tag surfaces. Shared glossary, pitch, frequency, Kanji, and status content inherits these scoped tokens. Popup choices never recolor the Dictionary page, application, or book. Settings > Reader popup's Lookup appearance card holds every popup design choice: five pressable palette cards, Custom's colors, width, height, Rounded corners and Reading position, above the 読む preview; a Rounded corners stepper (0-28 px in steps of 1, default 18 px) applies the saved radius to this preview and the actual popup only. Custom exposes the five swatch/HEX fields through ColorField. Complete colors save immediately; incomplete drafts revert on blur. Background, accent, and border stay exact. Custom semantic ink mixes toward the black/white anchor with greatest background contrast until it reaches 4.5:1 on both background and tag surfaces. A conflicting tag surface first mixes toward the background. Secondary/muted text, links, actions, and category-tag ink receive contrast protection; category hues stay scoped. Entered colors remain saved even when rendered semantic colors adjust. Custom color scheme derives from the background.

Successful Shift, click, and hover pointer lookups temporarily highlight the longest matched start in the book using the current Reader Highlight color. The adapter retains detached ranges for each scanned text node, skipping ruby annotations, and reports only a session-local `scanId` alongside the text, rectangle, and writing mode. `highlightPointerMatch(scanId, length)` accepts a Unicode-character length; `null` clears the paint and releases the scan. It registers the matched ranges in that section's CSS Custom Highlight registry (`komori-pointer-match`), styled through the adapter's existing color rules, without wrapping text, changing layout, or touching the browser selection. New scans clear the previous paint while searching; no matches or failed lookups leave no paint. Closing the popup, switching to a browser-selection lookup, changing the layout or book, and disposing the renderer clear it. Popup lookup revisions and adapter scan IDs both reject stale responses. A one-character kanji-only result highlights that character. Browser-selection lookup behavior is unchanged. A renderer without the Custom Highlight API keeps lookup working without painting.

Holding Shift over book text also opens lookup through the same `ReaderSelection` report. `textSelection.ts` remembers the pointer within each displayed section and scans when Shift is pressed in the section or focused app, or when the pointer moves with Shift down. It uses the browser's caret hit-test, checks the boxes of the adjacent Unicode characters to find the one actually under the pointer (rather than the nearest insertion point), and reports text starting at that character, through inline elements within its containing block, stopping at a line break, another block, or the saved Scan length (1–64 Unicode characters, default 16); selections are looked up whole, up to 256 characters. Ruby annotations (`rt`, `rp`) are skipped. The rectangle belongs only to the touched character, in the Reader window's CSS pixels, with its writing mode. Off-text positions, whitespace, and ruby annotations report nothing. Movement within the same character does not repeat the lookup; moving to another character replaces it. Releasing Shift keeps the popup open; pressing Shift again can reopen the same character after closing it. A scan uses detached DOM ranges and never changes the book's selection. Its section and app listeners are released with the section watcher. No capabilities or scripts are added to book content. Scans use the existing popup placement, stale-response handling, and closing triggers described below.

With Mouse selection on (it is off by default; keyboard selection release, Shift and the keyboard shortcut are on), selecting text in the book looks it up in a popup beside the selection, with the same results the Dictionary page shows for that text. The adapter watches each displayed section document it hands the Reader (`src/features/reader/textSelection.ts`, attached as EPUB.js renders a section, released when EPUB.js discards the document or the renderer is disposed) and reports through `onSelectionChanged` only a `ReaderSelection` `{ origin, text, sentence, rect, writingMode }`: the owning trigger (`pointer`, `keyboard`, `shortcut`, `shift`, `click`, or `hover`); the selected text without ruby annotations (`rt`, `rp`), as the document holds it; the union of the selection's boxes clipped to the reading area (the host), or of all of them when none is within it, in the Reader window's CSS pixels; and the writing mode where it starts (`horizontal`, `vertical-rl`, or `vertical-lr`). It reports once a pointer's release has been handled (a pointer reports its selection again even when unchanged, such as a word selected again after its popup closed) and on a key's release only when the selection changed, so releasing a page-turn key or Escape reports nothing; a selection with only whitespace, or a collapsed one, reports `null` once. Book content gains no script, capability, or Komori object; the adapter adds only its own listeners. A window or reading-area resize invalidates the reported selection once through `null`, because its rectangle belongs to the previous layout; releasing a key in the unchanged browser range does not reopen it, while a deliberate new pointer selection can.

`ReaderShell` looks up the selection's trimmed text, its first 256 characters (by Unicode character) when longer, so it is within the native query limit; whitespace alone looks nothing up. `src/features/reader/lookupPopup.ts` places the popup at the saved width and height (480 x 440 px by default) when there is room, within the reading area (the viewport, beside a pinned sidebar) less an 8 px margin, 10 px from the selection : below horizontal text from the selection's left edge, else above; beside vertical text before it in its reading order (left of right-to-left lines, right of left-to-right ones) from its top, else after it. With room on neither side it shrinks into the larger one when that has at least 120 px, and otherwise lies over the selection, clamped to the area. The popup (`ReaderLookupPopup`, a non-modal `dialog` named `Lookup: <text>`, in its saved popup theme above the book, footer, and sidebar) shares the Dictionary page's `lookupDictionary`, pronunciation, kanji links, tag ordering/colors, pitch and safe glossary primitives. `LookupEntry` renders each matched headword as a large Japanese serif expression with its reading beside it or, with Reading position Above (Settings → Reader popup, saved, default Beside), as furigana over each kanji run, aligned on the kana the headword shares with its reading (読み込む: 読[よ]み込[こ]む; a reading that cannot be aligned spans the whole word; each run's reading spans the run with its kana spread evenly over it, centered when wider), its voice and tags, and its Add to Anki and Open in Dictionary actions on the same row (centered on the headword's own line), then frequency chips (six initially with Show more/fewer), pitch, and independently collapsible numbered source definitions, initially expanded. Shorter starts and inflections keep their labels; one-character kanji retain the existing Kanji card. The popup is a borderless floating sheet with a soft offset shadow; the Dictionary page keeps its existing expandable cards. It has searching, no-match, and path-safe failure states, and each entry, and a one-kanji Kanji card, has its own Open in Dictionary action; the no-match state offers one for the query. A popup lists at most the saved Maximum results (1–64, default 5) headwords. Its visible results/query summary and Close lookup button are omitted; the complete query remains in the accessible dialog name. There is no separate action bar, so definitions scroll independently even in a small reading area. It has no source rail. Each selection is a new popup with its own lookup, so a newer selection replaces a pending one and a stale or closed popup's response is discarded. It follows the close behavior described above; navigation/layout invalidation and selection clearing remain independent of Escape/outside-click preferences. With Child popup levels above 0 (0–5, saved, default 5), a Shift scan, hover or mouse selection inside a popup (following the book's trigger settings, scan delay and scan length), a headword kanji, or a glossary term link opens a child popup for that text, placed beside it as for a horizontal selection; each level can open the next up to the saved depth. Child popups keep the root lookup's sentence and book for Anki and do not paint the book. A press inside a parent closes its children, Escape closes the deepest popup first, and every other dismissal closes them all. With 0, headword kanji and glossary term links open the Dictionary page searching that text at `/dictionary?q=<text>`; Open in Dictionary always does: the route opens the page afresh for each query and the page searches it as it opens, with it in the search field.

## Dictionary subsystem

Starter dictionaries (`dictionary/starter.rs`) are a native-owned onboarding
workflow. The empty Dictionary page links to Settings > Dictionary, where readers
can independently download five curated, freely licensed sources (two Japanese–English
dictionaries, a word frequency list, a kanji dictionary and a proper-name dictionary;
`ACKNOWLEDGEMENTS.md` credits each), or use the manual ZIP picker. The offer is one grouped list, a row
per source with its description, attribution, Source and license links, and a
Download (or Retry) button whose accessible name includes the source. The offer names
each publisher, its attribution and CC BY-SA 4.0 license; source/license actions
accept only a curated ID and resolve the browser address natively. The two
Japanese–English dictionaries overlap, so the offer explains that either provides
initial definitions; frequency alone supplies metadata, not definitions. Installations
without a starter workflow keep the ordinary source management.

`get_starter_dictionaries`, `download_starter_dictionary`,
`dismiss_starter_dictionaries` and `open_starter_information` expose only curated
IDs, public descriptions, phases and byte counts, never download URLs or paths.
The native catalog (`src-tauri/src/dictionary/starter.rs`) pins each GitHub-hosted
source to a release and its SHA-256 digest. Sources are appended to the catalog,
since the journal stores each status by position; a journal saved with fewer sources
keeps its statuses and starts the new ones ready. The frequency list comes from its publisher's download endpoint, which has no pinned digest. WinHTTP uses
HTTPS and normal certificate verification, 10/15-second request timeouts, a
180-second transfer bound and a 128 MiB download cap. Automatic redirects are
disabled: only one GitHub redirect to the corresponding repository's signed
release-assets path is accepted; other redirects are refused. Content lengths,
nonempty payloads, pinned hashes where available, ZIP CRCs, duplicate entry names,
20,000-entry/2 GiB expanded bounds, 512 MiB per-entry bounds, the dictionary index,
expected source title and required term, metadata or kanji bank are checked before import.
The existing transactional importer validates bank schemas and deduplicates by
title/revision under its shared write lock. Ordering, popup role eligibility,
lookup, removal and compaction remain the same for these imported sources.

One native starter operation runs at a time, with downloading (received/total
bytes, indeterminate when unknown), verifying and importing phases, followed by
added, already installed, failed or interrupted outcomes. Native snapshots and
revisioned main-window events keep the operation independent of page lifetime;
Settings subscribes before loading a snapshot, ignores older responses, blocks
competing controls while pending and refreshes dictionaries after completion.
An application-lifetime listener also notifies Dictionary/Reader consumers when
the download finishes while Settings is closed, without remounting the book.
The onboarding choices remain available after the first import until Done; a
nonempty installation resumes only a previously started, undismissed workflow.
Empty installations always expose the offer. A small bounded native journal in
`starter-dictionaries` retains outcomes across restarts. Interrupted work becomes
retryable, never automatically downloads or resumes; a retry safely discovers a
revision already committed. Each outcome records the imported title; the list says a source
is added only while a dictionary with that title is installed, so a removed download
(or a journal from before titles were recorded) is offered again as Download. Only known staging files are cleaned on startup and
after an attempt. Archives are never extracted, and the importer opens completed
staging bytes read-only. Reparse points are refused. No persistent archive copy or
automatic dictionary update is introduced.

Each source's provenance and license page is linked from the offer and credited in
`ACKNOWLEDGEMENTS.md`.

`list_dictionaries` reports native-owned `hasDefinitions`, `hasFrequency` (term
`freq` or any kanji metadata) and `hasPitch` (term `pitch`) independently, all
three stored per dictionary at import, so listing reads no imported rows. The
Reader reads the list once per open book, as dictionaries change, for all its
lookup popups.
Definitions require a term with a nonempty glossary, rules or tags, or a kanji row;
empty term-bank placeholders alone do not qualify. Row counts remain the imported
counts. Term-source selection, Anki definition choices and native exact/prefix/
deinflection probes use this eligibility; frequency/pitch metadata remains
independent. Term banks whose glossaries are all empty `[]` therefore supply frequency data
without an empty definition source or false term matches. Native lookups accept
an optional bounded `SourcePolicy`; omission retains all-imported standalone
behavior. Role filtering uses bound JSON ID arrays in SQL, never interpolated
caller SQL or frontend post-filtering. Dictionary import, reorder,
and removal APIs notify mounted source/Reader consumers after completion; source
lists reload in native order without redesigning maintenance.

Kana-only matching starts rank exact kana expressions first, then matching
readings marked usually written in kana, then other kanji headwords. Deinflected
groups compare their dictionary form and use the same tiers across that start's
exact and candidate groups before result limits apply. `uk` term tags and
the structured-content `misc-info`/`uk` sense marker identify usually-kana forms;
ordinary prose does not. Sorting is stable within each tier, preserving source,
score, row and candidate order, metadata and deduplication. A start containing
kanji keeps its previous ranking; shorter-start and rare-particle handling remain.

Keep these concerns separate:

- dictionary import/indexing
- dictionary management UI
- standalone search UI
- result rendering
- Reader lookup trigger behavior
- Reader lookup popup
- source selection

The Reader lookup popup reuses the Dictionary page's lookup and result rendering, `src/features/dictionary/DictionaryResults.tsx` (see Reader lookup).

`src-tauri/src/dictionary/archive.rs` reads a dictionary archive read-only. It requires a root `index.json` with a title, a revision, and `format` (or `version`) 2 or 3; format 1 has another row layout and is refused. It lists the root-level `term_bank_N.json`, `term_meta_bank_N.json`, `kanji_bank_N.json`, `kanji_meta_bank_N.json`, and `tag_bank_N.json` entries in bank-number order and reads one bank at a time into typed rows; glossaries, meta data, and kanji stats stay their original JSON text, and an empty reading is read as the expression. A tag row is exactly a name, category, order (any number), notes, and score (any number) as the format defines them; nulls and other shapes are invalid banks. Optional `index.json` `tagMeta` is an object keyed by tag name; each value is an object with optional category, order, notes, and score fields, defaulting to empty strings or zero. Mistyped or unknown fields, or another `tagMeta` shape, make the index invalid. Styles and media are not read. Like browsers (whose `JSON.parse` and ZIP reader allow it, and which real archives rely on), it ignores ZIP CRCs, skips a leading BOM, and reads unpaired UTF-16 surrogate escapes as U+FFFD. `index.json` is capped at 1 MiB and a bank at 512 MiB (well above the largest banks seen in real dictionaries, about 190 MB). Failures are typed (unreadable, not an archive, missing or invalid index, unsupported format, entry too large or unreadable, invalid bank); entry names and parse details in them are native diagnostics.

`src-tauri/src/dictionary/store.rs` owns `<app_data_dir>/dictionaries.sqlite3`, a database of its own beside the library catalog, resolved and migrated once at setup and kept in managed native state. Schema version 8 has a `dictionaries` table (autoincrement ID, title, revision, format, sequenced, the optional index fields, the four row counts, import time, enabled state, position, definition, frequency and pitch eligibility; title and revision unique together) and `terms`, `term_meta`, `kanji`, `kanji_meta`, and `tags` tables keyed by that ID, with B-tree indexes on term expression, term reading, term-meta expression, kanji and kanji-meta character, tag dictionary and name, and the dictionary ID of terms, term meta, kanji, and kanji meta. Older stores migrate in place when opened, each step in one transaction that never re-reads archives or changes IDs, positions or imported rows: the dictionary-ID indexes are built, the enabled and position columns are added (position starting at each dictionary's ID, so import order is kept), `has_definitions`, `has_frequency` and `has_pitch` are derived from the stored rows, and every `enabled` flag is set to 1. New imports record the eligibility flags in their import transaction. The enabled column and DTO flag remain for storage compatibility; there is no enable/disable command. Popup role choices in the separate appearance record are untouched: All includes these restored sources and new imports, Selected keeps exactly its saved IDs (including unavailable IDs), and None or an empty explicit selection never falls back to All. Standalone Dictionary searches all eligible imported sources. Tag rows keep every imported bank definition in bank order (name, category, `sort_order`, notes, score), duplicates included, followed by `tagMeta` definitions in index source order. A bank definition wins when the same name appears in both. Tags belong to their dictionary ID and go with it. A store that predates tags gains the empty `tags` table; its dictionaries have no tag rows, since their archives are not kept. Glossaries are deflate blobs at the default level, one per term; term-meta data, kanji meanings (a JSON array), and kanji stats stay JSON text. The database is in WAL mode (journal capped at 64 MiB after a checkpoint), so it stays readable while an import writes; this costs about a quarter more import time than a rollback journal.

`import_dictionaries` opens an `rfd` picker for one or more `.zip` archives; cancellation opens nothing and writes nothing. Imports run one at a time. Each archive's index is read first; a dictionary with the same title and revision already stored is refused as `alreadyImported` (another revision of the same title imports beside it). Otherwise one transaction holds the whole archive: banks are read, checked and written one at a time inside it, each bank checked in full before its rows are written (tag banks last, then index `tagMeta`), glossaries are compressed across the available cores, and the row counts are recorded last. Any archive or storage failure rolls the whole archive back. Each archive gets a typed result (`imported`, `alreadyImported`, `invalid`, `unreadable`, `failed`) with its file name and, once read, its title, never a path; archive diagnostics stay native. `list_dictionaries` returns each dictionary's ID, title, revision, enabled state, and row counts in the reader's order: ascending position, then ID. A newly imported dictionary is enabled and goes last (one past the highest position).

`remove_dictionary` takes one dictionary ID plus the optional operation UUID. Imports and removals share one lock, so a removal waits for a running import. In one transaction it deletes the `dictionaries` row and every term, term-meta, kanji, kanji-meta, and tag row with that ID, through the dictionary indexes; any storage failure rolls it back with every row kept. Its `results` field reports a typed `removed`, `notFound` (no dictionary has that ID), or `failed` status, never a path or database diagnostic. The source archive is not involved, since Komori keeps no reference to it. The freed title and revision can be imported again, under a new, higher ID, so it lists after the dictionaries already there. After successful removal, the command automatically reclaims freed pages and returns maintenance separately from the removal status.

`remove_dictionaries` takes a list of dictionary IDs plus the optional operation UUID and removes them under one hold of the same lock, each in its own transaction exactly as `remove_dictionary` does, so a failure rolls back only that dictionary and keeps the removals before and after it. Its `results` array contains one `{id, status}` per requested ID in request order, with the same typed `removed`, `notFound`, or `failed` status and never a path or database diagnostic; a repeated ID is `notFound` once it has been removed, and an empty list returns no results. The other dictionaries' rows, positions, and enabled states are untouched (positions are not renumbered, so the order is kept).

`move_dictionary` takes one dictionary ID and a zero-based position only (a position past the end means last; a negative one is refused by the command), sharing the same lock. In one transaction it moves that dictionary to the position and renumbers every dictionary's position from 1 in the new order; any storage failure rolls it back with the old order kept. It returns a typed `moved` (including when it was already there), `notFound`, or `failed` status, never a path or database diagnostic; no other row changes. The order lasts across restarts, imports (a new one goes last), removals (the others keep their order; a dictionary imported again goes last), and source-policy changes. The position is not returned: the list's order is the order.

`get_dictionary_store_size` returns the store's size on disk in bytes: `dictionaries.sqlite3` plus its `-wal` log (the small `-shm` index is not counted), or a fixed message when it cannot be read. After a dictionary removal that leaves free pages past the threshold above, the store's compaction shares the same lock, so it waits for a running import. It runs `VACUUM`, which rewrites the database without its free pages, then a truncating WAL checkpoint, which copies the rewritten pages into the database file and empties the log, so the file shrinks at once. `VACUUM` builds its copy in the temporary directory and writes it back through the log, so it needs free disk space of up to about twice the store while it runs. Every dictionary, row, enabled state, and position stays; rows keep their relative order, which lookups and tag resolution follow. Its outcome is a typed `{status: "compacted", sizeBefore, sizeAfter}` (sizes as above, measured before and after), `{status: "notNeeded"}` below the threshold, or `{status: "failed"}` in the removal batch's maintenance result, never a path or database diagnostic (debug builds log them). A failed `VACUUM` leaves the store as it was; a checkpoint blocked by a lookup still reading is reported as `failed` too, with the store intact and usable, and a later checkpoint copies the pages back. Compaction runs only after successful dictionary deletions, with the separate maintenance outcome described above.

`get_library_store_size` returns `library.sqlite3`'s size in bytes. After a removal the catalog's `VACUUM` rewrites it without the free pages that removed books, replaced covers and thumbnails, and other deleted Komori data leave behind; it waits for other connections (such as a cover request), needs free disk space of about the catalog's size and keeps every book and its saved state. Settings → Storage (`src/features/storage/StorageSettings.tsx`) shows the Library and dictionary sizes above the backup cards; removals compact their store on their own.

Settings shows a Dictionary sources card (`src/features/dictionary/DictionarySources.tsx`) with one grouped box: an Installed dictionaries header row with a secondary Add dictionaries button, then the imported sources in lookup order as hairline-divided rows with their counts and revisions. A link to Reader popup explains where Term, Frequency and Pitch sources are chosen; there are no per-source switches, Off labels or visible position numbers. Each row has a three-line (≡) handle. Only a primary pointer press on that handle starts a drag; row text remains available for ordinary selection and touch scrolling. The stationary list owns pointer capture while ID-keyed rows preview movement in either direction. Crossing row middles previews order; dropping elsewhere calls `move_dictionary`, while cancellation, lost list capture or an unchanged drop writes nothing. Movable handles use grab/grabbing cursors. Focusable rows retain Alt+Up/Down, end no-ops and ordinary arrows; focus follows the moved dictionary ID through pending and completed writes. A polite live region announces the saved position, without putting numbers back in the rows. Failed moves restore the old order with an error; a missing ID reloads and explains its removal. Pending import/removal/move disables Add, the selection boxes, Remove and reordering. Late list responses and disposed-page refreshes are ignored.

Each row's Remove button opens a confirmation naming its title and revision and stating that its original ZIP is not deleted and can be imported again. Failed or rejected removals leave the dialog open with the row intact; an already-removed ID closes it, refreshes and explains the outcome. Every row has its own selection box before its handle: checking one shows the selection bar with the count, Select all, Remove selected and Clear; Ctrl+A selects every installed source when pressed within the list, or anywhere once something is selected, and Escape or Clear empties the selection. Rows keep dragging, keyboard moves and their own Remove while selected. Remove selected confirms once with every title/revision in a bounded list and the same ZIP safety statement. Bulk results retain successful deletions, explain missing/failed items and keep failed IDs selected; rejected commands keep the dialog and list. Import outcomes explain every archive not added, and native progress/maintenance feedback survives page remounts. Reclamation is automatic after deletion, with sizes in Settings > Storage.

`lookup_terms` trims an exact query and refuses more than 256 characters or 1024 UTF-8 bytes; an empty query returns no entries. It returns `{text, groups}`: `text` is the text the first groups match, each group's `text` is the start of the query it matched, and each group's `deinflection` is `null` unless it was reached as an inflected form. It finds terms whose expression or reading equals the query, inflates their glossary JSON natively, and groups by expression and reading. A non-kana term whose stored reading equals its expression (the archive reader’s fallback for an omitted reading) joins the first matching supplied reading in dictionary/score order, retaining every definition in its source order. Supplied readings stay separate, including historical variants and homographs. Without a matching supplied reading, the expression-only entry stays as-is. Reading queries also include these expression-only definitions when an eligible term supplies that reading; disabled/unselected sources and rejected word classes cannot supply it. Frequency and pitch filtering uses the resulting group reading, without altering stored terms or archives. When no enabled dictionary has such a term, it tries the query's starts from longest to shortest, by Unicode character (so a supplementary-plane character is never split), and returns the groups for the longest start an enabled dictionary matches, exactly or deinflected, with `text` set to that start: 読書する returns 読書's groups. Each shorter start that an enabled dictionary matches, exactly or deinflected, then lists its groups after them in the same per-start order, longest start first (its translator, at commit 67db60d, collects every start's entries, keeps an entry at its longest start, and sorts by source length first); a group (expression and reading) an earlier start listed is not repeated, and each group's `text` names its start. With a typical Japanese–English dictionary, 日本語で lists 日本語, then 日本, then 日; 食べ物を lists 食べ物, then 食べる (continuative) for 食べ, then 食; 読みますか lists 読む (polite) for 読みます, then 読み, whose 読む (continuative) is not repeated. A query that an enabled dictionary matches exactly as a whole lists only its own groups and forms, as before (読む, 今日は, 読み with 読む as its continuative). Shorter starts are listed while fewer than 8 starts (the longest included) and 32 groups are listed: a shorter start's groups past the 32nd are cut, and the longest start's own groups never are (いった lists its 13 forms, then 19 of い's groups). An optional `maxResults` (1–64, the Reader popup's Maximum results) cuts every group past it, the longest start's included. A longest start that is a shorter matching start plus one trailing particle (が, を, は, に, へ, と, で, も, の, か, や, ね) lists after that start when its best rank in the rank-based frequency dictionaries (`frequencyMode` `rank-based`, among the returned frequencies) is more than ten times rarer, or it has none while the shorter start has one; the shorter start then names `text`. 誰がやった lists 誰 (だれ, rank 60) before the poetical 誰が (たが, rank 48528), and それは and 何を follow それ and 何, while 特に and 誰も stay first. Without a rank-based frequency dictionary the longest start leads. Each start (the whole query first) is tried exactly and as an inflection of every dictionary form it may be, and the first start with any match wins, so a longer deinflected start beats a shorter exact one (読んでみる matches 読んで as 読む). Within the kana tiers above, its exact groups come first, exactly what an exact lookup of that start returns, then each matching form's groups in candidate order; a group (expression and reading) reached more than one way is listed once, the first way, with that way's terms. した prefers する and the usually-kana 為る as する (past) before 下 and 舌; きた returns 北, then 来る (past) and the ichidan 着る (past); いった returns the godan verbs read いく (行く), いう (言う), and いる (要る), each (past). A `vs` candidate ending in `する` with a nonempty stem is followed, as a form of its own with the same inflections, by that stem, matching only terms whose rules or definition tags name `vs` (by whole name), as common Japanese–English dictionaries store their する-nouns without する and with no rules, naming `vs` among their part-of-speech definition tags (勉強: `n vs vt`): 勉強して returns 勉強's `vs` senses as 勉強 (-te), and a term stored with する (研究する) is listed before its bare noun (研究), each group once. The searched text is not a candidate, so 勉強する still matches its start 勉強 exactly, and an exact match of the whole start (研究する) is unchanged. Deinflection is a table-driven rule set in `src-tauri/src/dictionary/deinflect.rs` covering every transform in the standard Japanese transforms (`ext/js/language/ja/japanese-transforms.js` at commit 67db60d), written for Komori in its own table form rather than copied: each rule replaces an inflected ending (for the honorific ます stems in い, such as いらっしゃいます → いらっしゃる, a whole word) with a shorter form's ending, applies only to text of the word classes it inflects (the searched text itself takes any rule), and gives the result that form's classes. The classes are the dictionary format's: the dictionary forms `v1`, `v5`, `vk`, `vs`, `vz` (ずる verbs, 信ずる), and `adj-i`, where the ichidan dictionary form is kept apart from the progressive's contracted `てる`/`でる` (so the continuative's ichidan form never takes it) and the godan dictionary form apart from a short causative ending in `さす` (which takes no passive) or in another `す` (which does); and the intermediate ます, ません, て, た, ば, ゃ, ん, なさい, and adverbial く forms, which are never looked up. Each transform covers ichidan, godan, 来る (also spelled 來る), する (also 為る), and ずる verbs where it applies, 行く's irregular forms in every spelling (行く, いく, 逝く, 往く), godan う verbs whose past is `うた` (問うた, こうた, のたもうた), and i-adjectives. Komori departs from the table in a few places: an i-adjective's `くて` takes only the searched text and the Kansai-ben adjective て form (高うて), so the progressive, completive, and preparatory never reach an adjective; a rule usually written with an empty ending that reaches a ます, ません, or ん form keeps the ending that form needs (`ますれば`, `ますまい`, `ませんでした`, `んかった`); the contracted completive keeps its own `行っちゃう`/`いっちゃう` rules before the general `っちゃう`; the potential or passive comes before the passive, so 来られる is 来る as the potential or passive; and it adds the plain negative imperative `な` after a dictionary form (読むな → 読む), usually left to the scanner. The inflection names, from the dictionary form outward in each chain, are: `past` (`た`/`だ`, `ました`, `でした`, the i-adjective `かった`), `-te` (`て`/`で`, `まして`, `くて`), `negative` (`ない`, `ません`, `くない`), `polite` (`ます`, `くあります`), `volitional` (`う`/`よう`, `ましょう`, `かろう`), `volitional slang` (`っか`, 行こっか), `negative volitional` (`まい`), `progressive` (`ている`/`でいる`, `てる`/`でる`, `てゐる`, `ておる`/`でおる`, `とる`, and `ないでいる` after the negative), `completive` (`てしまう`/`でしまう`, `ちゃう`/`じゃう`, `ちまう`/`じまう`), `preparatory` (`ておく`/`でおく`, `とく`/`どく`, and `ないでおく`/`ないどく` after the negative), `-cha` (`ちゃ`/`じゃ`, the contracted `ては`), `conditional` (`ば`), `contracted` (`ゃ`, the contracted ば form: 読みゃ → 読めば → 読む, conditional then contracted), `-tara`, `-tari`, `-zu`, `-nu`, `-n` (the negative `ん`, 知らん), `-zaru`, `-neba`, `-nbakari`, `-ntosuru`, `desiderative` (`たい`, itself an i-adjective: 食べたかった → 食べる, desiderative then past), `-sou` (`そう`), `-sugiru` (`すぎる`/`過ぎる`), `-nasai` (`なさい`), `-garu`, `-yagaru`, `-ge` (`げ`/`気`), `-sa` (the noun `さ`), `adverbial` (`く`), `causative` (`せる`/`させる`), `short causative` (`す`/`さす`), `passive` (`れる`), `potential` (`る` after the imperative stem, `できる`, `これる`), `potential or passive` (`られる`), `imperative`, `negative imperative` (`な`), `negative imperative slang` (`んな`), `continuative` (the ます stem: 読み → 読む), `-mu` (the archaic `む`), `-fu` (the historical `ふ`), `attributive` (the adjective `き`), `-e` (an adjective's slang `え`: すげえ → すごい), `n-slang` (r-column syllables before n: 分かんない), and `kansai-ben` (the Kansai-ben negative `へん`/`ひん` and the verb and adjective て, た, たら, たり, く, and negative forms: 買うた → 買う, past then kansai-ben). A core rule set (the past, て, negative, polite, `ましょう`, progressive, completive, and preparatory endings above, without their ずる, 為る, 來る, 逝く, 往く, うた and honorific forms) comes first: within a step, candidates reached through those rules alone come before any other, and the other forms follow them. A candidate is at most 6 rules from the start (読まされていました → 読む takes six: short causative, passive, -te, progressive, polite, past; 読まされていませんでした's longest match is its start 読まされていません), a start yields at most 64 candidates (none of the format's test texts yields more than 25 within six steps), fewest steps first then in rule order (a specific ending before a general one), a form reached again with the same classes is listed once, the first way, and only candidates of a dictionary word class are looked up. An exact match keeps its exact groups first and unchanged, and the other forms can follow them (しまう lists 占む as its archaic volitional after its exact groups; みんな lists 見る as the negative imperative slang after 皆). A candidate matches, by expression or reading, only a term in an enabled dictionary whose space-separated rules name one of its classes, and its groups keep only such terms (よんだ returns 読む and 詠む but not a noun read よむ), with the same metadata as an exact lookup; each such group's `deinflection` is `{form, inflections}`, the candidate text and its inflection names (above) from the dictionary form outward (読みませんでした: polite, negative, past). Every matching candidate of the winning start is returned, within the step and candidate bounds. Only starts of at most 64 characters are tried (well above the longest expressions real dictionaries hold), each an indexed existence check plus one indexed query per dictionary-class candidate (two for a `vs` candidate ending in `する`); the winning start then reads each matching form's groups, and listing the shorter starts tries each remaining start the same way. In a release build a 256-character query takes a few milliseconds at most. When no start matches either, `groups` is empty and `text` is the trimmed query. A start or form matched only by a turned-off dictionary is skipped. Other languages' transforms are not returned. Terms retain dictionary ID/title, definition tags, rules, score, sequence, and term tags; dictionaries follow the reader's order (position, then ID) and rows within one dictionary follow descending score. Each term also returns `tags`: every name in its definition tags, then its term tags, once each in that order (only U+0020 separates names, so a no-break space such as the one in `priority form` stays inside one name), resolved against the tags its own dictionary ID imported, using the first definition in bank order. A resolved tag has its name, category, order, notes, and score; a name with no stored definition in that dictionary (including every name from a dictionary imported without tags or before schema version 2) has only its name. Another dictionary's tags are never used, and the original definition-tag and term-tag strings are returned unchanged. Frequency term-meta rows for each expression accompany the groups in dictionary order, limited to a group's reading when the meta data specifies one. Pitch term-meta rows accompany the groups as `pitches`, with dictionary ID/title and their original JSON data in dictionary and row order. A pitch row must have a nonempty string reading and a nonempty pitches array whose entries have nonnegative integer positions; malformed rows and rows for another reading are skipped. The command returns no paths. The Dictionary page submits one query at a time, discards stale responses, expands the first group, and shows headword, reading, dictionary, tags, frequency values, plain glossary strings, and text from structured content. Expanded result cards show each distinct valid position once, in first-returned order, as accessible text with its contour, followed by the titles of every matching pitch row that returned it in row order. A row that repeats a position names its source once for it; separate rows with the same title each stay listed. Positions share one column so the agreeing sources line up beside them; long titles truncate with the full title as tooltip and wrap within the row. Each position also gets a contour from the group's kana reading: joined small kana count as one mora, position 0 stays high through the following particle, and a positive position drops after that mora. The contour is decorative and omitted when the reading is not safely representable as at most 32 kana morae or the position exceeds the mora count; its source and position text remain. A pitch entry's optional `nasal` and `devoice` fields, each a one-based mora index or an array of them, mark morae: values that are not safe integers between 1 and the reading's mora count are ignored, and none apply when the reading is unrepresentable. Its optional `tags` string array is shown as-is (trimmed, once each, in imported order), ignoring non-string and blank values; tag names are not resolved through dictionary tag banks. Tags show as muted text beneath the position and contour, before any marks. Marked rows describe their marks as text beneath the position and contour (for example `Nasal が (mora 2); Devoiced き (mora 1)`), wrapping without widening the position column. The contour writes a nasal mora without its dakuten and adds a drawn handakuten ring (か゚), and circles a devoiced mora's label with a dashed ring. Positions merge only when their nasal and devoiced marks and their tag sets (in any order) also match, so a differently marked or tagged position stays a separate row. Structured glossary text keeps paragraph and nested list boundaries in source order through a small text-only renderer. Readings are shown as readings: `ruby` with its `rt`/`rp` becomes ruby markup (a stray `rt`/`rp` outside ruby, and an inline span carrying a `wari` data attribute, becomes a smaller muted reading span), and neither ruby nor readings get the space the renderer otherwise inserts between adjacent inline parts. Nor do inline parts meeting inside Japanese text: when the base text on both sides of a join (readings aside) is Han, kana, or Japanese punctuation (CJK symbols and punctuation, `・`, `ー`, and full-width and half-width punctuation), no space is inserted, so a highlighted keyword inside an example sentence reads 楽譜を読むように; joins with other text, such as English tags and glosses, keep the space. Only `wari` and the exact `data.content` markers described below change presentation; other `data` values are kept only as short `data-sc-*` attributes for Anki cards. Imported inline styles pass the allowlist in `src/features/dictionary/glossaryStyle.ts`: font style, weight and size, text decoration, vertical and text alignment, white-space, word-break, list markers (keywords or a short quoted marker such as `'①'`), border style, width and radius, margins and paddings (bare numbers are em), and colors as hex, names, or nested rgb/hsl/var/color-mix calls. Values are bounded (no headline-sized text or page-sized boxes) and no URL, string other than a list marker, or other function passes. Each glossary maps dictionaries' `--text-color`/`--fg`, `--background-color`/`--canvas` and `--link-color` variables to the current theme, so colored labels stay readable in light and dark popups; text keeps line breaks (`pre-line`) without spacing between imported elements. Tables (with row and column spans, scrolling inside a wide definition), `details`/`summary`, titles and language tags render. A dictionary's own sense markers (①, ◆) replace the popup's numbered circles. A structured link whose `href` is `?query=…` searches that query, whatever its label shows (←記号 searches 記号, ⇒ its target); without one, a label containing Japanese script is searched, without readings (`rt`/`rp` and `wari` spans). Searches stay within the native limit of 256 Unicode characters and 1024 UTF-8 bytes; the button shows the whole label, readings included, and a link nested in a label stays part of that one button. An http(s) link without credentials or quotes (web searches, encyclopedia or source pages) is an underlined link that opens in the default browser through native `open_external_link` (`src-tauri/src/external_link.rs`, ShellExecute after rechecking the address; Komori fetches nothing). Other links stay inert text; media and metadata paths are ignored. Its source rail loads the enabled imported dictionaries in the order `list_dictionaries` returns (saying so when every dictionary is turned off), counts matching term rows per source for the current exact lookup, and filters the returned groups and terms locally by dictionary ID; visible groups retain their frequency and pitch metadata. All sources restores the same lookup without another native call. An empty or failed source list does not prevent search results from rendering. The results header describes only the groups whose `text` is the returned `text` (the longest start's). When the returned `text` differs from the query (only a start matched), the results header reads `Showing results for <start>` with a smaller muted `No exact match for <query>` line below it, wrapping within the header; when every group was reached as one dictionary form with the same inflections, the header adds that form and its inflections after the matched text (`Showing results for 読みました → 読む (polite, past)`), with the query line only when the matched text is a shorter start; when every group was deinflected but through several forms, it reads `Showing results for <text>` alone (いった), and when exact groups are among them it reads as an exact match does (`Results for した`). Each deinflected card names its inflections beside its headword, after its reading, as muted outlined text (`past`) with the tooltip `Inflected: past`, the same words screen readers hear; a chain too long for the card (up to six steps) stays on one line, truncated within the card, with the whole chain in its tooltip and accessible name, and a click on it toggles the card as the rest of the headword does; exact cards have none. Each card whose `text` differs from the returned `text` (a shorter start's) names its start beside its headword, after its reading and before any inflection label, in the same muted outlined style, truncated the same way (`日本`, with the tooltip and accessible name `Matched: 日本`, and `lang="ja"`), and a click on it toggles the card; the source rail counts and filters every listed group; the search field keeps the query, and the Kanji card still depends only on the query being one character. It has distinct initial, no-match (`No matches`, when no start matches either), and failure states.

`lookup_kanji` checks the query like `lookup_terms` (trimmed, the same bounds), then matches only a query that is exactly one kanji: one character in the CJK ideograph ranges the dictionary format treats as kanji (the unified ideographs with extensions A through I, and the compatibility ideographs; not `々`). The ranges live in `src/features/dictionary/kanjiRanges.json` (inclusive hex code point pairs), which native code embeds with `include_str!` and parses once, and which `src/features/dictionary/kanji.ts` (`isKanji`) imports, so the frontend and the lookup agree on what a kanji is. Any other query, including kana, Latin, and several characters, returns no rows without reading the store, even when a kanji bank stores a row for it. It returns `{entries, frequencies}` from enabled dictionaries in the reader's order (position, then ID), each dictionary's rows in stored order: every kanji row with its dictionary ID/title, character, onyomi, kunyomi, and tags as their original strings, meanings as a string array, and stats as its original JSON object, and every kanji-meta frequency row with its dictionary ID/title and original JSON data. Each kanji row also returns `resolvedTags` (every U+0020-separated name in its tags, once each in source order) and `statTags` (every stat name, a whole object key, in the returned stats object's key order), resolved exactly as term tags are: against the tags its own dictionary ID imported, first definition in bank order, with name, category, order, notes, and score, or the name alone when that dictionary defines none. Another dictionary's tags are never used, and no paths are returned. The Dictionary page asks for it only when the trimmed query is one Unicode character, together with `lookup_terms`; a failure of either fails the search, and a stale response is discarded with the other. When kanji rows or kanji frequency rows return, a Kanji card leads the results list, before the word cards, labelled `Kanji <character>`: a large character, the returned frequency rows in the same source-labelled frequency list as a word card, and each kanji row numbered with its dictionary title, its resolved tags shown and ordered exactly as word-card header tags are (notes as tooltip and accessible description, known categories colored, definition order with undefined names last), its meanings as one comma-separated wrapping list, its onyomi (`On`) and kunyomi (`Kun`) readings joined by `、` (a row without either omits it), and its string and number stats in a collapsed `Stats (N)` disclosure. Each stat is labelled by its definition's trimmed notes (its name as the label's tooltip), or by its name when it has no definition or blank notes. Stats are grouped by their definition's category under a heading: the format's `misc` (Statistics), `class` (Classifications), `code` (Codepoints), and `index` (Dictionary indices) first in that order, then other categories under their own name as they first appear; within a group they follow the definition's `order`, lowest first, ties in returned order. Stats with a blank category, then undefined stat names in returned order, follow under Other, which has no heading when it is the only group. The card has no toggle and is always open, so the first word card is still the expanded one. It counts as one entry in the results header, and a kanji with no word results is not a no-match. The source rail counts kanji rows beside term rows per dictionary (frequency rows are not counted, as for words) and filters the kanji rows locally with the words; a filtered kanji keeps every frequency row, and a kanji with only frequency rows shows under All sources alone.

Each entry's headword makes each character `isKanji` accepts a keyboard-accessible button (`Search kanji <character>`) that starts a new Dictionary search for that one kanji exactly as a glossary term link does: the source filter resets, the search field is filled, stale responses are discarded, and the one-character query shows its Kanji card. Kana, `々`, and other characters stay text, and the headword's text is unchanged.

The card header's tags come from the terms' resolved `tags`: each name once, keeping the first returned definition when several matching dictionaries resolve it (a name returned only by name keeps a later dictionary's definition). Tags are ordered by that definition's `order`, lowest first; equal orders keep their source order across the group's terms, and names no matching dictionary defines follow every defined tag in source order. A tag whose notes are not blank shows its trimmed notes as a tooltip (`title`) and accessible description (`aria-description`) and has a dotted underline and help cursor; it takes the pointer so the tooltip can show. A tag without notes is plain text as before. The same definition's category colors the tag when it is one of the format's `name`, `expression`, `popular`, `frequent`, `archaism`, `dictionary`, `frequency`, `partOfSpeech`, `search`, or `pronunciation-dictionary` (matched exactly, exposed as `data-category`): `tokens.css` holds the conventional hue for each (`--tag-<category>`, kebab-case), and `dictionary.css` mixes it into the text color toward `--tag-ink-toward` and a tint of the card by per-theme shares (`--tag-ink-share`, `--tag-tint-share`, redefined for dark in `theme.css`), keeping at least 4.5:1 contrast in both application themes. Other, blank, or missing categories keep the accent tag style. Tag score is not used for display.

The Dictionary page shows its results with the Reader lookup popup's entries (`LookupEntry`) on a borderless floating sheet in application colors: headword (with the popup's saved reading position), pronunciation, tags, Anki action, notes for a shorter matched start or inflections, frequency chips (six, then `+N more`) and pitch, then each source's numbered, collapsible definitions, so every matching source is named on its own definition. Dictionary names, pitch, and frequency always show there, and entries offer no Open in Dictionary action. A one-kanji query's Kanji card leads the sheet, flattened as in the popup: no fill or frame of its own, like the word entries under it. A result's first two entries render with its first frame and the rest once the page is idle (a common word's entry can hold thousands of elements), in the same order; entries out of view skip style and layout (`content-visibility: auto`, standing in at `--lookup-entry-placeholder-height` until first shown). The source rail lists All sources and only the enabled dictionaries with matching definition or kanji rows for the current results, in Settings order, so frequency and pitch dictionaries never appear; before a search it says that dictionaries with matches appear there.

Frequency chips show each returned row's dictionary title beside its display value, in returned order, including repeated rows from one source; long titles truncate with the full title as the chip's tooltip.

The glossary renderer also omits its separating space when either rendered inline edge already has source whitespace, including whitespace inside nested inline elements or readings. It omits the space immediately after an opening or before a closing full-width Japanese bracket even when the other side is Latin text or a number. Other Japanese/English and English/English joins retain their separating space. A glossary link or term link is named by its text without readings, so `<ruby>` labels read only their bases.

Example presentation recognizes only `div` nodes whose `data.content` is exactly `example-sentence`, `example-sentence-a`, or `example-sentence-b`. They provide a subtle group rule, a normal Japanese sentence line, and a smaller muted translation line. The renderer keeps their source order, text, ruby, and supported search labels; it never applies source CSS or exposes other metadata.

Sense notes recognize only `div` nodes whose `data.content` is exactly `sense-note`, `sense-note-label`, or `sense-note-content`. A note uses a compact, muted text row with its source label and content; the renderer preserves their text, order, ruby, and supported search labels. Other note-like markers and source classes stay inert.

Cross-references recognize only a `div` whose `data.content` is exactly `xref`, a `span` with `reference-label`, and a `div` with `xref-glossary`. The cross-reference uses a subtle surface, a smaller source label, and a smaller secondary gloss. The unstyled `xref-content` div keeps its source order and existing exact-search link with ruby reading. Other reference-like markers, source classes, URLs, and arbitrary data stay inert.

Attributions recognize only a `div` whose `data.content` is exactly `attribution` and a `span` with `attribution-footnote`. The source line uses smaller muted text; footnote references use smaller raised muted text. Both keep their source text and order. Source URLs stay inert, while a label that meets the existing exact-search rules remains searchable. Other attribution-like markers remain inert.

Part-of-speech hints recognize only a `span` whose `data.content` is exactly `part-of-speech-info`. They use compact, muted text styling while keeping their source labels and order before the senses. Source titles, tag codes, and other metadata stay inert; supported exact-search labels remain searchable.

Each Dictionary entry has a pronunciation button (Voice) beside the headword. It asks `get_word_audio(term, reading)` for a recording and plays it; when no source has the word it shows `No audio for …` as its title. There is no speech synthesis. One pronunciation plays at a time across the app: starting another stops the earlier recording. The button is pressed while loading or playing, stops its own playback when removed, and is disabled (`No word audio sources`) outside the desktop app or when the source list is empty.

### Word audio

`src-tauri/src/word_audio.rs` owns recorded word audio; the frontend never supplies a URL to fetch. The appearance record stores `wordAudioSources`, an ordered list of at most 8 unique sources (default `[{kind: "jpod101"}]`): `jpod101` (JapanesePod101's audio endpoint, sending only the kana for a kana-only word), `url` (answers with the audio itself) or `list` (answers with JSON `{"audioSources":[{"url"}]}`, of which the first 8 http(s) URLs are tried). Custom URLs are http(s) with a host, at most 2048 characters without controls, and may contain `{term}`, `{reading}` and `{language}` (`ja`), filled percent-encoded. Native and frontend validation drop an invalid stored list, and saves reject it; an obsolete `wordAudioVoice` field in a stored record is ignored. Settings > Dictionary > Word audio lists the sources with Move up/down (also Alt+ArrowUp/Down on a row) and Remove, then New source (JapanesePod101 only when it is not listed, Audio URL, Audio list URL), URL and Add source.

`find(sources, term, reading)` tries the sources in order with reqwest over rustls: 5 s to connect, 10 s per request, at most 4 redirects, audio up to 4 MB and lists up to 256 KB. A response counts only when its bytes are MP3, AAC, Ogg (including Opus), WAV, FLAC, WebM or MP4 audio by their leading bytes; JapanesePod101's "audio not available" clip is refused by its SHA-256. Terms and readings are at most 256 characters without controls. The last 16 recordings found stay in memory. `get_word_audio` returns `{mime, data}` (base64) or null and never a URL, error detail or source; the frontend plays the bytes from a `blob:` URL (CSP `media-src blob:`) and revokes it when playback ends.

## Anki cards

Settings → Anki loads the saved configuration and tests the local connection on
entry. A separate badge shows Checking, Connected, Disconnected or Not checked;
changing port/key clears the tested status. Status describes the latest check,
with an explicit Test connection action beside the port and API key fields. No paragraph repeats the badge: the status line
under the connection rows shows only what it cannot say (no decks or note types, an error, a Lapis outcome). Discovery never creates notes or models.
Save configuration remains explicit. Native storage keeps the loopback port
(1–65535, default 8765), optional API key (up to 256 bytes, no controls), deck and
model identities, and independent mappings for at most 32 note types. Names are
nonblank/control-free and at most 256 UTF-8 bytes; a mapping keeps the ordered
snapshot of 1–128 unique fields. Missing/replaced decks/models, including same-name
replacements, and reordered/changed fields block creation until explicit repair.
Save configuration names such a problem; a deck or note type not chosen yet only
keeps Save disabled, with no problem text.
Accept current fields keeps templates and tags by name/model; Lapis defaults are
explicit and preserve configured tags. Existing custom mappings are kept.

Deck and note type sit side by side. Fields form one compact table: each field's
name, its content dropdown and a pencil Edit template action that opens its custom
text editor (labelled `<field> template`); empty fields are muted. Card tags share
the table's name/content columns after the note fields, with their dictionary
choices and removable chips. Duplicates follow as a separate section. Save
configuration sits at the right of the card's end, without routine
explanatory text. Its button shows saving and a success checkmark (with a live
announcement); validation problems and failed saves appear below it;
saving locks edits and repeated activation until it finishes. A failed save keeps
the draft for retry, a later edit clears the old outcome, and disposal ignores late
feedback. Test connection keeps its own status. Choices include empty, expression, reading, expressionFurigana, definition,
source, frequency, frequencyHarmonic, frequencyAverage, pitch, sentence, bookTitle, glossary,
picture, selectionText, audio and imported
term/kanji dictionaries. Templates use literal text and `{{name}}` placeholders;
`{{dictionary:ID}}` selects returned definitions by stable positive dictionary ID.
Missing/disabled/removed or popup-excluded sources produce empty content without a
fallback. Unavailable saved IDs remain visible. Each template is at most 4096
UTF-8 bytes; unknown/malformed placeholders and stray braces are invalid. Expansion
is one pass, so imported placeholder-looking text stays literal.

Lapis defaults map ExpressionFurigana to `{{expressionFurigana}}` and ExpressionAudio to
`{{audio}}`, leaving ExpressionReading empty. Shared leading/trailing kana stay outside Anki's plain
`expression[reading]` annotation; identical/kana-only readings stay plain.
SelectionText maps to `{{selectionText}}`: the text selected inside the popup holding the

- (or on its results page outside any popup), read at the press, before the click can
  clear it, or at activation for a keyboard press; empty when nothing there is selected.
  MainDefinition uses the first returned definition unless its field selects a
  specific dictionary. Glossary includes every definition returned for that result,
  independent of source disclosure/metadata visibility. Definition parts carry the
  popup's parsed, inert presentation nodes: each top-level glossary, Japanese inline
  joins, ruby/readings, lists, tables, details, recognized example, note,
  cross-reference, attribution and part-of-speech roles, allowlisted styles, short
  `data` values, titles, language tags and http(s) link addresses. Native
  (`src-tauri/src/anki/presentation.rs`) writes the glossary markup card templates
  such as Lapis select on: `<div style="text-align: left;" class="yomitan-glossary">`
  (the class name is Lapis's own selector and script hook), an `ol` of
  `<li data-dictionary="<title>"><i>(<title>)</i> <span>…</span></li>` per source, one
  glossary item as it is or several as a `ul`, and each element's data as
  `data-sc-<key>` attributes named as a browser dataset names them (`content` →
  `data-sc-content`, `用例囲み-g` → `data-sc用例囲み-g`). Lapis's dictionary-specific rules (such as inline
  `sign | symbol | mark` glosses, hidden attribution, its minimal/no-sentence/no-forms
  options) therefore apply. Native rechecks every style
  against the same allowlist and drops the rest, sets no `display` or list-style
  itself (only light role styling, table borders and reading opacity), keeps `href`
  only for http(s) addresses with a host and no user info, and escapes every value.
  Scripts, raw HTML/CSS, media and paths never enter the presentation DTO. Native
  deserialization accepts only the known node/tag/role variants. Presentation is bounded to 128 sections, 256 KiB, 32 levels
  and 8192 nodes per entry. Interrupted requests with original glossary JSON or
  text-only parts keep their original native formatters for replay. `data-dictionary`
  keeps the exact title (Lapis matches some dictionaries by title), encoding
  only `"`, `\` and controls.
  Frequency placeholders produce a native unordered list with one item per returned
  frequency, retaining dictionary labels and display values. Lapis preserves the list
  instead of rebuilding text and losing breaks. This applies in any mapped field,
  including Frequency or a custom FreqSort mapping.
  `frequencyHarmonic` and `frequencyAverage` are Yomitan's frequency-harmonic-rank and
  frequency-average-rank, floored: each source's first returned row counts once,
  `occurrence-based` sources (lookups report each row's declared `frequencyMode`) are
  skipped, and a row's rank is its display value's leading number (11 for 11㋕), else its
  positive numeric value. With no rank both give 9999999, so the card sorts last. Lapis
  defaults map FreqSort to `{{frequencyHarmonic}}`; saved mappings keep their FreqSort.

Each mapping saves up to 32 unique card tags, default `komori`; each is 1–128
UTF-8 bytes without whitespace/controls. Empty tags are valid. Each note type also
keeps up to 32 unique positive dictionary IDs for dictionary tags. Tags retain
lowercase spelling through editing and native save/load, including older
preferences. Text and dictionary-generated tags are sent in lowercase on creation
and overwrite; recovery retains its original journal and never resends a write.
Tags deduplicate after lowercasing, in first-entered order. Original input bounds
and bounds after lowercase expansion both apply. Anki can canonicalize a tag to a
spelling already registered in its collection
(including parent tags); Komori does not rename collection tags or unrelated notes.
See [Anki's tag registration](https://github.com/ankitects/anki/blob/main/rslib/src/tags/register.rs).
The Add dictionary tag
dropdown includes frequency-only dictionaries and removable name chips, retaining
unavailable IDs. Chosen frequency sources contribute their returned display values
(for example vocabulary tiers), falling back to numeric frequency values when
no display value exists. Definition-only sources contribute their names. Returned
metadata is retained regardless of visible frequency controls; popup source policy
still determines which sources are returned. Missing/disabled/excluded sources add
nothing. Up to 128 values per source (1024 bytes each) cross IPC. Values replace
whitespace with underscores, truncate on UTF-8 boundaries at 128 bytes and deduplicate
with text tags; marker-like values gain a `dict_` prefix. Tracking tags
`komori_request_<UUID>` are temporary, reserved and always native-owned. Tags are independent
between note types. Global duplicate policy defaults to prevent; settings also
offer overwrite and allow. Scope defaults to the entire collection; the exact
selected deck and its optional child-deck switch remain available. Matching uses Anki's own
first-field duplicate search for the chosen model; native checks actual card deck
names to exclude child/other decks. It then keeps only notes whose reading fields
(fields after the first mapped to `{{reading}}` or `{{expressionFurigana}}`, read
through Anki furigana, without tags and across hiragana/katakana) are empty or show
the result's reading, so another reading of the same word (誰が だれが and たが) is
not a duplicate; such a note is added with Anki's own first-field duplicate guard
lifted. At most 128 matching notes/1024 cards are
inspected. The addNote deck-scope guard remains enabled unless Allow is saved.
Prevent sends no note write when a match exists and returns the existing note ID.
Overwrite requires exactly one match, replaces all mapped fields, preserves
scheduling and existing tags, adds configured/tracking tags, and verifies the
resulting fields through notesInfo. Multiple matches block overwrite; the Browser
handoff permits manual correction. Allow explicitly adds another note.

Each Reader popup and preview entry has + beside Open in Dictionary on its
headword row, as 30 px borderless controls. Dictionary term cards use the same
action; kanji cards have none. readerPopupAnkiAction remains independently saved
and defaults enabled. Each action loads saved settings and checks Anki before it can
be activated, using the same first-field/model/deck scope as creation. Checking is
disabled; a known existing card has a disabled checkmark plus Browser editing under
Prevent, an Update action for exactly one match under Overwrite, or Add another under
Allow. Multiple overwrite matches remain blocked. Remounts, saved configuration
changes, other completed mining actions and window focus refresh existence; stale
responses are discarded. A check sends only the
first field's parts and the reading (other fields and glossaries are never built for
it). Every check asked for in the same moment (a popup's entries) goes to native
`get_anki_note_statuses` as one batch of up to 64 notes: one AnkiConnect `multi`
holds the deck/model identities, the field names and every duplicate search
(`findCards` for a deck, `findNotes` for the collection); deck scope adds one
`getDecks` and one batch of `cardsToNotes`, and reading filtering one `notesInfo`
for all candidates. A popup's checks take one request. Answers are kept per saved configuration, first field and reading until
a card is created or changed, the configuration is saved, or Komori regains focus;
pending or failed answers are never kept. A five-second total network deadline
covers a batch; the renderer expires stalled IPC after six seconds. Rechecks after
focus, card changes or saved settings keep the last answer usable until the new one
arrives, so a click made while returning from the book is not lost to a recheck. Checks do not queue behind note writes. Marker cleanup tries the write
lock without waiting and is deferred to existing recovery/Browser paths when busy.
Pending writes restore their original recovery action.
Clicking + immediately loads saved settings, expands the
chosen result and creates the card; it opens no review or configuration dialog.
Setup, check and creation problems never show a message box: the action is disabled
and dimmed, and its tooltip and accessible description give the reason and point to
Settings → Anki. An uncertain creation turns the action into `Check whether <word>
was added to Anki`, which checks the original request without resending it. Popup actions are ordered Open in Dictionary, Open card in Anki Browser when available, then Add/Update/Check, for term entries (kanji entries have only Open in Dictionary). A confirmed/duplicate result disables repeated
creation in that lookup and offers Edit in Anki Browser via native guiBrowse/nid.
Changing a lookup/context disposes the action; double activation and late setup
responses cannot send a second request. Book mount, selection, position and lookup
stay intact. Saving new settings invalidates a not-yet-submitted action. Native
creation reloads saved preferences and rediscovers model/deck/fields before writing.

Term cards use dictionary forms, matching pitch positions and returned frequency
source/value order. Reader context carries a safe title, catalog ID and optional
adapter-extracted sentence: its range-start sentence within the readable block,
without ruby/script/style/hidden text, at most 1024 Unicode characters overall and
512 before the range. The sentence content part colors literal matches of the actual
looked-up surface text (including inflections), falling back to the dictionary
expression when no surface text is supplied. Native-owned spans escape both context
and match, using Lapis's theme-aware bold color with a warm fallback; missing matches
stay plain. Japanese 。！？ and newline delimit it; multi-block selections
use their start block. Dictionary/preview cards have no book context unless supplied.
Detached ranges never alter browser selection, layout or mount.

Picture exports the cached raster book cover, resolved natively by catalog UUID.
No cover/book context produces an empty field. Unknown catalog IDs are rejected;
no source/archive path or caller-provided image crosses the command. Covers are
at most 8 MiB, use a native-generated SHA-256 filename and are sent as base64 to
storeMediaFile before the note mutation; native inserts the local img reference.
Word audio (`{{audio}}`, a structured `audio` part carrying the result's expression and
reading) is found natively from the saved word audio sources only when a card is written,
after the duplicate checks, stored as `komori_audio_<SHA-256>.<ext>` through
storeMediaFile, and inserted as `[sound:…]`; when no source has the word the part is empty.
No frontend-supplied URL or dictionary media is permitted. Media filenames are
content-addressed and reused. Failed note creation can leave an unused derived cover in Anki media;
Komori does not delete shared media or modify source EPUBs.

Plain text and structured parts must agree. Raw fields are at most 128 KiB each,
512 KiB total, with a nonblank first field; at most 256 parts/field and 128 entries
per definition part. Native escaping protects HTML and Lapis JS-literal delimiters,
removes CR and turns LF into br. Only native-rendered allowlisted glossary and
native-owned sentence/image markup is emitted: no arbitrary HTML/template code.
Formatted fields are at most 512 KiB each/1 MiB total; the serialized input is
capped at 1 MiB. Oversized content is refused without truncation. Frontend validation
names the empty, oversized or control-bearing field; native contentTooLarge feedback
directs the reader to map Glossary to fewer dictionaries instead of blaming the first field.
The final serialized add/overwrite envelope is checked before media/tag writes or
an uncertain journal intent, so transport-size refusal cannot leave a pending mutation.

Before note mutation, native durably journals the UUID, exact payload, expected
HTML and optional overwrite target in anki_requests. Repeated IDs return the saved
outcome without resending; different contents under an ID are rejected. Timeout,
interrupted IPC or unconfirmed response stays uncertain and disables creation.
Checking searches only the request tag: one note confirms addition; an overwrite
also requires the original target and exact expected fields. The tag alone never
confirms an overwrite. Zero/multiple matches remain uncertain. Pending requests
survive restart and Settings exposes up to 128; a pending first field/model/port
blocks resubmission even across deck changes. Older journals gain the optional
intent and tag-cleanup columns without losing records. Once confirmation is durably
stored, removeTags strips only that request's native-owned marker from the confirmed
note. Cleanup failures retain a pending flag and retry on replay, check, existing-note
lookup or Browser handoff; the note stays confirmed and no content write is retried.
These paths also clean earlier confirmed records for the encountered note (up to 128
markers at a time), preserving user/dictionary tags and scheduling. Uncertain markers
stay until recovery confirms the write. Cleanup and checks require the saved original port/key
and original Anki profile. Completed records persist for replay protection.

Lapis remains pinned at donkuri/lapis f4eb29bd4129ae1dde068c64cf6557b7603462dc,
with upstream GPL-3.0 source/license bundled separately. Fresh discovery must
confirm absence before explicit acceptance creates its original fields, Mining
templates and CSS. No example deck, notes or media are imported. Existing/customized
Lapis is preserved; exact fields enable optional defaults. Failure/uncertainty
requires renewed discovery before retry.

All HTTP is native-owned, fixed to 127.0.0.1 with no DNS/proxy/redirect/retry.
Narrow commands are get_anki_preferences, save_anki_preferences, discover_anki,
create_anki_lapis, create_anki_note, get_anki_note_statuses, check_anki_note, get_anki_pending_requests and
browse_anki_note. Built-in AnkiConnect v6 actions only; blank API keys are omitted.
Each request has a 5-second deadline (shared across existence-check requests),
8 KiB header/2 MiB response caps and a 1 MiB request cap, except bounded cover uploads
(12 MiB). Length-delimited replies complete when their body arrives, without
waiting for socket closure. Mutations and Browser handoff
are serialized. Typed results hide transport/server details; renderer HTTP
capabilities and production CSP remain unchanged.

## Validation and builds

`scripts/validate.mjs` is the repository-owned validation runner. It executes frontend formatting, linting, TypeScript checking, the production CSP check and tests plus Rust formatting, checking, Clippy, and tests in order, then writes concise ignored evidence to `artifacts/validation/latest.json` and `latest.txt`. Task and full validation run the same checks; release validation additionally builds the frontend and runs the real-engine Reader smoke test (`pnpm test:reader-real`), which builds Komori under its own identifier and drives synthetic EPUBs over CDP. None of them builds or exercises the Windows installer.

`pnpm tauri:build` runs the Vite production build and the Tauri release build, which produces only the NSIS installer. `pnpm build` ends with `scripts/third-party-notices.mjs`, which writes `dist/THIRD-PARTY-NOTICES.txt` from the installed production npm closure (checked against `pnpm-lock.yaml`) and `cargo metadata --locked` for the Windows target, plus the vendored Lapis, adapted Yomitan rules, Rust standard library and WebView2 loader; it fails on a package with no license text. Release builds merge `src-tauri/tauri.release.conf.json`, so the installer carries `LICENSE` (also its license page), `NOTICE` and the notices file as resources. Package version is compiled into Settings diagnostics. Builds embed no local development data.
