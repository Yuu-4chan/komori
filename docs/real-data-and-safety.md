# Real data and safety

## Test data

- Real EPUBs and dictionary archives used for manual testing live outside the repository and are **strictly read-only**. Their machine-specific locations belong in the untracked `docs/local-development.md`, never in committed code or configuration.
- Use small representative subsets during normal development.
- The repository holds only small synthetic or freely licensed fixtures, added when they make automated tests deterministic. No copyrighted book or dictionary content is committed.
- Real files are used early to expose malformed-but-common EPUB behavior and dictionary scale problems.

## File safety

Komori must never rewrite source EPUBs or source dictionary archives as part of reading/importing/indexing.

EPUB tolerance repairs only diagnosed XML variations in memory (see
`architecture.md`, EPUB subsystem). Import and Reader delivery retain read-only
source handles and the original protocol payload. Strict parsing after repair,
bounded XML/spine reads and refusal of truncated content prevent recovery from
inventing missing text or bypassing resource limits. Every archive entry the
Reader reads is checked against its declared size, a 32 MiB entry limit and a
512 MiB running total before it is read; native code refuses an entry declared
over 32 MiB and stops reading one whose data exceeds its declared size, is
shorter than declared or is damaged. Manifest assets count toward the total in
manifest order as the book opens, before the spine preflight, though each is
read only when a stylesheet or a shown section names it. A refused or damaged
asset is left out of
the pages that name it; a damaged linear document or an exceeded total refuses the
open, which always settles. A refused Reader open leaves
saved position/progress intact; import and relink retain their existing per-item
outcomes, cancellation and transactional rollback.

Imported EPUBs remain at their original filesystem locations by default. Komori records a private durable reference and reads the source strictly read-only; it does not copy every book into application storage. The current importer stores metadata and bounded raster cover bytes as derived data in Komori's application database. Cover refresh/backfill reopens only the private source reference and writes only newly resolved derived cover data; it never rewrites the EPUB. Reader resume positions are stored in the application catalog by catalog ID and never written to the EPUB. Thumbnails, statistics and other reading state also live in application storage.

Dictionary archives are opened read-only and read bank by bank into memory; Komori never writes, extracts, or moves them, and does not keep a reference to them after import. Imported rows are Komori-owned derived data in `dictionaries.sqlite3`, written in one transaction per archive so a failed or refused import leaves nothing behind. Removing a dictionary deletes only its rows, in one transaction, and never touches the archive it came from; removing several removes each in its own transaction. The confirmation says the ZIP file (or files) is not deleted. Moving a dictionary changes only stored positions. The automatic compaction after a removal rewrites only `dictionaries.sqlite3` (through its own log and a temporary copy in the system temporary directory), keeping every remaining dictionary and row.

“Remove from Library” is catalog deletion, never source deletion. Single and bulk removal are scoped to Komori catalog IDs and remove only rows plus Komori-owned dependent/cache data. Cancellation performs no native mutation. The confirmation UI must state that the original EPUB will not be deleted. Bulk results preserve successful catalog removals and report failed IDs without ever accepting a source path.

Missing or moved sources remain visible in the catalog with an honest unavailable status. “Relink EPUB” is scoped to one stable Komori catalog ID and uses a native-owned file picker. Native code checks the selected EPUB's container and package structure (package root, manifest, and a spine itemref that resolves to an archive entry) and reads its metadata before transactionally replacing the private source reference and refreshing source-derived metadata and cover data. The existing ID and Komori-owned dependent state are preserved. Cancellation, invalid/unreadable files, and sources already linked to another record leave both records untouched; duplicate records are never merged automatically.

Any feature that exports or writes files uses an explicit destination and never silently mutates source files. Backups do so: Export writes only to the file chosen in a native save dialog (through a `.partial` file beside it), snapshots only to `backups` in Komori's data folder, and neither holds or touches an EPUB or dictionary. Importing reads the chosen file only; restoring writes only Komori's catalog records, after a snapshot of the state it replaces, and deleting a snapshot removes only that file, named by its validated ID.

## Security boundary

Reader background selection uses a native-only raster picker and read-only source
handle. Signature, byte, dimension, pixel, decoding and normalized-output bounds
are documented in `architecture.md` (Reader presentation). Only one normalized PNG
blob/revision is saved in Komori's catalog; cancel/refusal leaves it intact and
replace/remove changes only that managed row. No image source paths, arbitrary URLs
or executable formats cross IPC. The main-webview `komori-background` image protocol
serves only the current UUID, with no queries, foreign supplied origin/referrer or
write methods; its two exact CSP image sources add no network/filesystem capability.
Source images, EPUBs, and dictionary archives are never rewritten.

Statistics daily corrections accept only a stable book UUID, validated local-day
bounds, an existing unit, bounded replacement measurements and expected totals.
Native transactions update measurement offsets in Komori's session rows only;
stale/refused/failed edits and cancelled dialogs preserve prior state. They never
open or write source EPUBs/dictionaries or alter reading positions/book progress.
Corrections follow session deletion and validated backup/snapshot restore.

Reader monitor reporting is a native command returning only width and height in
logical/CSS pixels for Komori’s current monitor. Layout preferences are bounded
numbers and allowlisted page IDs. Contents captions reuse adapter-owned archive
reads and counted destinations; they expose only offsets, totals and units, with
no source path, CFI, external access or source mutation.

Bulk-operation progress accepts only an opaque operation UUID alongside existing
native-owned selections or record IDs. Events contain counts and phases only,
without filenames, private paths, SQL errors or archive diagnostics. Automatic
reclamation follows successful book/dictionary deletions and rewrites only their
Komori-owned stores, serialized with other native store maintenance.
Deletion outcomes are returned separately from maintenance success/failure;
failed maintenance never restores a deleted entry or damages a surviving record.

- Filesystem/network/database access is native-owned.
- Explorer EPUB drops keep selected paths in a bounded native slot and expose only
  a short-lived, single-use UUID. The frontend cannot submit file paths; dropped
  files use the existing read-only importer, duplicate handling and catalog lock.
  Windows hands actual WebView2 File objects to a native receiver restricted to
  Komori's Library route/origin (the configured dev origin in development only).
  Native code casts those objects and resolves their private paths; arbitrary
  path strings, archive bytes and messages from other origins/routes are refused.
  Directories and unrelated files are ignored; source files are never moved or rewritten.
- Starter dictionary downloads accept only native-curated source IDs (five
  freely licensed sources credited in `ACKNOWLEDGEMENTS.md`). Source/license
  browser links are also resolved by ID natively. WinHTTP HTTPS downloads are
  size/time bounded; automatic redirects are disabled, with one repository-scoped
  GitHub release asset redirect allowed. GitHub-hosted snapshots require their
  pinned SHA-256; the frequency list, served by its publisher's API without a
  pinned digest, requires strict ZIP integrity, index/title/role and expansion
  checks. All use the existing transactional bank importer. Only
  Komori's `starter-dictionaries` journal and fixed staging names are written or
  cleaned; symlinks/reparse points are refused and archives are never extracted.
  Completed staging files are opened read-only for verification/import, then
  removed. External user archives/EPUBs and their metadata are untouched. Restart
  cleanup and explicit retry cannot duplicate a committed title/revision. The
  frontend gains no network capability or caller-controlled download path/URL.
- The frontend receives narrow catalog/import/relink operations, not generic filesystem access or arbitrary source paths. Relink requests contain only a catalog ID, and typed results never include the selected private path.
- Cover-discovery methods remain native diagnostics; neither source paths nor internal archive paths are exposed to the frontend.
- Catalog removal accepts only a Komori ID; the frontend cannot supply an arbitrary source path.
- EPUB content does not receive generic native capabilities.
- Reader content preparation and binary protocol requests resolve a Komori catalog UUID in native code, and every request checks the source again. Only a catalog-ID URL, with an opaque stamp naming the source version, crosses to the EPUB.js renderer adapter; private source paths and native errors remain native. The adapter receives the archive's entry names and declared sizes, as it did when it read the whole archive itself, and asks for entries only by their number in that list, never by a path. The source is opened read-only, validated once per version before any entry is served, and never copied into persistent Komori storage. The protocol is limited to the main webview and Komori origins, with no-store responses; a response holds at most one 32 MiB entry or a bundle of 64 MiB declared bytes.
- The adapter's EPUB.js request method fetches only the exact catalog URL returned by the Komori content service. EPUB entry resources resolve from the native archive under that URL, with no generic native filesystem or network route. EPUB.js and book CSS live in an isolated iframe with scripted content disabled. Reader components see only Komori-owned status values.
- Production CSP allows the Komori protocol in `connect-src`, archive-generated `blob:` images and styles, word audio played from `blob:` media, and embedded `data:`/`blob:` fonts, managed `komori-font` fonts, and sets `object-src 'none'`. These are narrow resource allowances, not generic network or filesystem permissions. The task validation profile checks the policy and rejects broadened sources, duplicate directives and changed source lists.
- Reader position commands accept only a catalog UUID and a bounded locator (spine index, 8-hex section fingerprint, progress). Locators contain no source path, archive path, or CFI, and position failures never surface native details.
- Bookmark commands accept only catalog/bookmark UUIDs, bounded Komori locators with a 64-hex section-content hash, and plain-text labels/excerpts (80/160 Unicode characters, no controls). The native catalog limits each book to 1,000 bookmarks, deduplicates places transactionally and cascades removal. Creation, rename, removal and relink retention never write an EPUB; unresolved locations never silently redirect to another place. The frontend suppresses native storage details.
- Find in book reads original linear spine text through the existing adapter archive boundary without source writes, extraction or a persistent index. Bounded plain-text excerpts and session-local result IDs contain no archive paths or renderer CFIs. Query/scope/book/disposal cancellation rejects obsolete searches and destination resolution; jumps use the existing resume/navigation boundary and never grant new native capabilities.
- Reader notes use only catalog/note UUIDs, the validated bookmark locator and
  bounded plain passage/body text (4,096 Unicode characters each; LF/tab allowed,
  other controls refused). The adapter captures a detached selection and original
  section hash; native storage is limited to 1,000 notes per book, cascades book
  removal and preserves relink ownership. Notes and their backup/snapshot restore
  never modify an EPUB, return paths or grant new content capabilities. Older
  backups without notes leave current notes intact; a present notes array replaces
  the matched book's notes. Unresolved locations never fall back silently.
- Reader Images reads original linear spine image occurrences through that same archive boundary. Only session IDs, plain captions and adapter-owned blob URLs enter UI state. ZIP payload, drawing complexity, raster bytes/dimensions, concurrent decoding and thumbnail output sizes are bounded. SVG is rebuilt from an inert subset with archive-only raster references; external resources and active content are refused. The viewer retains validated raster bytes or rebuilt SVG detail after bounded decoding, never an authored SVG or resource URL. Direct book-image clicks resolve displayed section/occurrence identity through that adapter, without following rendered URLs or opening new capabilities. Thumbnails/viewer URLs are released on visibility changes, cancellation and disposal. Go to location is adapter-owned navigation; browsing and viewing perform no source write, export, extraction or new native access.
- Dictionary import takes only an optional operation UUID: native code presents the picker, and results carry only the archive's file name, title, and a typed status, never a path or archive diagnostic.
- Dictionary lookups accept only a bounded query string and optional independently validated role selections (at most 128 unique positive safe-integer dictionary IDs per role) and return imported rows with dictionary IDs and titles, never a path or database diagnostic. Native SQL binds source IDs before matching/retrieval; frontend choices never grant filesystem access.
- Dictionary removal accepts only a dictionary ID, or for several a list of IDs, and moving one only an ID and a position; each returns a typed outcome (bulk removal one per requested ID, with that ID); removals additionally accept an optional operation UUID and return a separate typed maintenance outcome, never a path or database diagnostic. There is no compaction command; reading the store's size returns only a number.
- Word audio requests are made natively from the saved, validated sources only (no frontend-supplied URL), with bounded sizes, timeouts and redirects, and only audio recognized by its bytes is returned, as base64 data without URLs or errors. Anki stores it as content-addressed media.
- Updates are fetched natively from the fixed release endpoint and installed only when their minisign signature matches the public key in `tauri.conf.json`; the private key never enters the repository.
- Custom themes are structured values rather than unrestricted CSS injection.
- Reader font preferences are typed preset/Google IDs, content hashes for imported files, or one bounded system family
  name, never CSS, URLs or paths. Native GDI checks installed families. Curated
  downloads use native WinHTTP only, fixed HTTPS paths without redirects, bounded
  bytes/timeouts and pinned font/license hashes. Only Komori's `reader-fonts` cache
  is written or removed; partial files and reparse points cannot become available.
  The main-webview read-only `komori-font` protocol accepts exact ID/hash paths and
  serves verified font bytes. CSP adds only that protocol to `font-src`, granting
  no frontend remote access, generic filesystem access or system installation.
  Reader font changes never mutate an EPUB/archive or application font.
  Local font imports have a separate 100 MB (100,000,000-byte) per-file cap, checked
  before reading sources and when reopening/serving owned copies. Source fonts stay
  read-only; system face metadata comes from Windows GDI, never a caller-supplied path.
  The curated fonts and their SIL Open Font License 1.1 are from Google's official
  repository: [Zen Old Mincho](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/zenoldmincho),
  [Zen Kaku Gothic New](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/zenkakugothicnew),
  and [Literata](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/literata).
  Each download keeps its corresponding `OFL.txt` beside the unmodified font, as do the five
  files the installer includes (`src-tauri/fonts`, fetched and verified by
  `scripts/reader-fonts.mjs` at build time and only read at run time); the third-party
  notices carry their licenses. The shared [font catalog](../src/features/reader/googleFontCatalog.json) records every curated family/weight, pinned path and integrity hash; its generator reads the official [Google Fonts OFL repository](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl). Local TTF/OTF imports read user-picked files without changing them, validate bounded sfnt metadata, and publish immutable content-addressed copies under Komori's font cache. No picker path reaches the frontend; only exact verified hash URLs can serve imported bytes. Managed fonts are not installed in Windows or embedded in portable backups.
- SQLite contains only Komori-owned durable state.

## Anki integration

Only native code contacts the configured IPv4 loopback AnkiConnect service.
The renderer has narrow discovery/model-create/note-create/outcome-check/Browser
and existing-note-status commands, without generic HTTP, filesystem, media or card-template access.
Clicking + is the explicit creation action; all configuration belongs in Settings.
Existing models are preserved. Existing note fields are changed only when the user
has saved Overwrite, with exactly one matching note in the configured scope;
scheduling and existing tags remain. The bundled Lapis note type is pinned to an
upstream commit and ships with its license, without example notes, decks or media.

Native exports only the catalog-scoped cached book cover to a content-addressed
Anki media filename. It never accepts caller image bytes, paths or URLs, exports
an EPUB/archive, rewrites a source, or deletes shared Anki media. Dictionary content
is rendered from the popup's inert, bounded node/tag/semantic-role DTO through
native-owned markup and styles, with escaped text/attributes and no scripts, raw
CSS or dictionary media; the only URLs kept are link targets that validate as
`http`/`https` with a host and no user information. Older original-JSON requests
keep their bounded allowlisted renderer for interrupted-request replay. Frequency lists and tier tags
use only metadata returned by the lookup. Unconfirmed adds/overwrites
are journaled before note mutation and never automatically retried; overwrite
recovery checks both its request tag and exact expected fields. Confirmed request
markers are removed after durable confirmation, with failed cleanup retried only
for journal-owned markers on the known note and original connection. User/dictionary
tags, note content and scheduling are preserved during cleanup. Existence checks
create no cards and may perform this bounded marker maintenance. See architecture.md
for bounds and lifecycle rules. Testing note writes requires a disposable Anki
profile; an ordinary profile is used only for read-only discovery/search.
