# Features

What each screen offers, in brief. `architecture.md` holds the complete behavior and
`design.md` the visual rules. Komori has its own design identity: the Library,
Dictionary and Statistics pages are the reference for new screens, in a clean,
native-feeling desktop style in the manner of macOS.

## Shell

A floating top bar (also the window's title bar, with the brand, the Library's search,
Settings and Add books) and a floating bottom dock (Dictionary, Library, Statistics)
around one scrolling page. Application pages switch with Ctrl+D/S/G from Library,
Dictionary, Settings and Statistics; Ctrl+B returns to the Library from the latter
three, while the Reader keeps it for bookmarks.

## Library

A Calibre-like Library of real covers and progress: Continue reading (books read past their start) under the toolbar;
grid/list, search, status filters, Cards details, sort and direction; grouping by series
or language as carousels with See all pages; per-card selection boxes with bulk removal,
relink and import with native progress. Drop EPUB files from Windows Explorer anywhere
on the Library to add them; a drag overlay shows the accepted file type or a busy
operation, and imports report progress and per-file outcomes. Authors show in full, wrapping long names.
Words take the place of characters for western books everywhere (sort, summary, cards,
Statistics). Book folders and the card size are in Settings > General; removing a folder
forgets the books it met that are no longer in the Library, so adding it again brings them
back. The search stays in the top bar even in an empty Library.

## Reader

- **Sidebar.** Round Back, Appearance and Pin buttons; the book's card (cover, title,
  author, series when it has one); floating tiles for Images, Bookmarks, Notes and Search
  under it; the chapters under a `Chapters` label as a scrolling timeline (read, current, unread) with each entry's
  start; at the bottom, the current chapter with its read percentage and the book's
  `Ch.` (or `Wo.`) position with a progress bar. Pinned or floating, it is the same
  vertically centered card no taller than 960px. Appearance, Images, Bookmarks, Notes
  and Search take the whole card under its round buttons, without the book's card, the
  tiles or the bottom progress, until Back returns to the chapters. Pinning keeps it visible and reserves
  reading space on roomy windows. Floating, it is hidden when a book opens until the
  window's left edge, focus or S brings it. S toggles the
  sidebar (reopening on its controls), A toggles Appearance, G opens Images, Ctrl+F Search, Ctrl+B Bookmarks and R
  the last bookmark; a double Escape shows a floating return warning. After a jump to a
  far place from Images, Chapters or R, a small pill above the footer
  offers to return to the previous place or be dismissed.
- **Appearance.** Rows without explanatory text: Theme (15 presets and up to 32 named
  custom themes), Background image (Choose/Replace, Remove, saved blur 0–40 px),
  Typography (editable Western and Asian font dropdowns holding only usable fonts of
  their own collection: installed presets, included and downloaded Google families,
  added fonts and installed families; defaults Georgia and the included Noto Sans JP;
  Zen Old Mincho, Klee One and Noto Sans JP, SC and KR come with the installer; the
  adjacent + opens a floating manager on Asian, Western or Added fonts tabs for
  TTF/OTF imports up to 100 MB and 93 Google families with separate weights or variable ranges;
  each font has its own Weight dropdown, limited to its available managed weights;
  size,
  line height, indentation, letter and word spacing), Page flow (Continuous,
  Semi-continuous, Paginated or VN; writing mode, pages, orientation, margins, maximum
  width and height, wheel step, VN paragraphs and reveal speed, chapter wheel
  threshold), Reader footer items, Text behavior (justification, pretty
  wrap, hide furigana with Hide, Partial, Toggle or Full styles and per-word
  hover/click/keyboard reveals) and Images (blur all or after the contents page, revealed by
  click, Enter or Space).
- **Scrollbar.** A continuous book's scrollbar runs along the window's right edge, or
  its bottom edge for vertical text, however narrow the text column.
- **VN.** Centered groups of the chosen number of paragraphs; images alone and at once.
  Show all text, a click in the book or Space finishes the reveal, then reads on.
- **Footer.** Book and chapter position and percentage in a lower pill with reading speed;
  clock and session reading time in an upper pill; both center over the available
  reading area, including while the sidebar is pinned. Empty pills disappear.
- **Images.** The book's illustrations as cards and a modal viewer with zoom, rotation,
  reset, panning and Go to location; clicking an unblurred book image opens it.
- **Find in book.** Whole book or this chapter, up to 100 results with excerpts.
- **Bookmarks and Notes.** Optional labels, B quick bookmarks, N notes from selected
  text, editing, removal, note search and order; saved passages use the theme's
  Highlight color with a little room around the letters, show the hand on hover, and
  clicking one offers Open in notes or Delete. Right-clicking selected text
  offers Copy, Add note and Highlight (a saved passage with no note); right-clicking a
  book image, or the image viewer, offers Copy image and Save image. Locations use
  section and text fraction, never invented pages.
- **Book content.** Character images follow the text size; standalone images and
  covers center within their page, and wide spreads show whole within the margins;
  chapter titles enlarge slightly; damaged EPUBs show the Reader error surface
  recommending another copy or an EPUB editor and relinking.

## Lookup popup

A lookup trigger (by default Shift scan, the Shift+Enter shortcut and a middle click on a
word; mouse selection and hover can be turned on in Settings > Reader popup) opens a borderless floating sheet beside the text with the
Dictionary's result entries: headword (kept close to its definitions' size), reading
(beside, or above as furigana spread over each kanji run), tags,
frequency chips, pitch, and numbered, source-labelled collapsible definitions.
Headword kanji and dictionary links open child popups up to the saved level. Each entry
has Voice (a recorded pronunciation from the word audio sources) and, left to right, Open in Dictionary, Open card in Anki (when a card
exists), and the one-click Anki + action on its headword row; kanji cards have no Anki action
and centre the character under their Kanji label.
With click lookup on, the mouse trigger can also be a middle click, which scans text and
leaves blank space to autoscroll.
Alt+wheel reveals the beginning of a tall selected entry.
The text a scan, click or hover lookup matched is marked in the book as selected text is,
in the theme's Selection color, until the popup closes.

The Dictionary style (Settings > Reader popup > Popup style) turns the popup
into a compact dictionary for reading with fast lookups: each headword with its furigana
right on its kanji over a thin rule, then each dictionary's definitions right under its name as a small
tinted label, numbered ①, ② when it has more than one. It leaves out voice, tags, notes, pitch, frequency, Anki and Open in
Dictionary; triggers, child popups, size, colors, corners, text size and line height
are the popup's own settings. The popup's headwords, readings and definitions, in either
style, use the chosen popup font, by default the included Zen Old Mincho.

## Dictionary

A search bar and a source rail listing only dictionaries with matches, in the Settings
order. Lookup is exact, or the longest matching start (with deinflection chains named in
the header and on each entry), followed by shorter matching starts. Single kanji show a
Kanji card first. Pitch positions merge across agreeing sources, with nasal, devoiced
and tag marks. Until an installed dictionary can supply definitions, this page and the Reader's
lookup popup (and its Settings preview) offer Get dictionaries, linking to Settings; the
Dictionary page says it has no dictionaries only in that offer.

## Statistics

Range menu; reading activity metrics (characters or words read, time, speed per hour,
books finished); the daily activity calendar with day details and editable daily
books (right-click or pencil); Library overview, language breakdown, completion
and the character explorer whose tiles open their Dictionary search.
Completion shows 300 books until Show all.
Reader statistics pause while Komori's window is unfocused, hidden or minimized
and resume on returning; P pauses and resumes a session in every start mode, and a
paused session stays paused. After the minutes set in Settings > Statistics (default 5,
0 never) without reading forward, counting stops and that stretch is dropped, so time
away never lowers the speed.

## Settings

Eight categories, each a stack of cards whose settings are rows of one grouped list:

- **General.** Appearance (Application language, App icon (sixteen tinted icons for
  the taskbar, Alt+Tab and tray; beige by default), then application themes and the
  custom theme, initially Hojicha), Library (card size and book folders) and Startup and behavior (launch
  at startup, restore last book, remember window size and position, minimize to tray, middle-click
  autoscroll, check for updates automatically) with an Updates row (version, Check for
  updates). A found update opens a dialog with its changes, Later and Install and restart. The interface reads in English, Japanese, Simplified Chinese, Korean or
  Brazilian Portuguese; books, dictionaries and Anki data keep their own language.
- **Storage.** Disk space of the Library and dictionaries (given back automatically on
  removal), Backup (automatic snapshots, frequency, keep, export, import, create) and
  Snapshots (restore with a preview, delete).
- **Shortcuts.** Every binding by context, on one set of aligned columns.
- **Reader popup.** In order: Reader lookup popup (enable, popup style, dictionary names,
  Anki and voice actions, pitch and frequency; the Dictionary style disables the last
  four), Lookup appearance (Application, Classic, Paper, Night and Custom palettes,
  width, height, font size, font, line height, corners, reading position), the real
  preview of 読む, Dictionary cards (Term, Frequency, Pitch sources), Lookup triggers and
  Scanning and results.
- **Dictionary.** Add dictionaries (and, when empty, starter downloads of five curated open dictionaries: two Japanese–English dictionaries, a word frequency list, a kanji dictionary and a proper-name dictionary, credited in `ACKNOWLEDGEMENTS.md`), the sources in
  lookup order with a selection box, ≡ handle and Remove on each row; choosing rows shows
  Select all, Remove selected and Clear. Word audio lists the recording sources in order
  (JapanesePod101 by default, audio URLs and audio list URLs with `{term}`, `{reading}` and
  `{language}`) with Move up/down and Remove, and adds new ones.
- **Statistics.** Recording, session start, jump limit and confirmed deletions.
- **Anki.** Connection (port, key, Test connection, the bundled Lapis license), card
  configuration (deck, note type, field contents table, tags, duplicates) and
  interrupted requests. Duplicate scope initially covers the entire collection.
- **Discord.** Discord status (off by default): shows the open book in Discord with its
  title, book progress as a percentage, chapter progress and reading speed, each of
  which can be hidden, and Idle after 5 minutes without reading or with no book open.

The application and Reader themes default to Hojicha. The Library initially sorts
by Title and shows Series, Language, Last read and Unique kanji. Reader popup mouse
selection defaults off, with 0 ms scan delay, 5 results and 5 child popup levels.
The Reader shows its clock and book position/percentage, with chapter
position/percentage off.

Dropdowns are pop-up buttons whose menus mark the single choice with a check mark.
Pressing the open button again closes the menu without changing its choice.

## Anki

Settings → Anki tests the connection on entry. Field rows map imported dictionaries,
standard content or custom templates; Lapis defaults use ExpressionFurigana, formatted
MainDefinition, all definitions in Glossary, the book cover in Picture, the word's recording in ExpressionAudio and the text
selected in the popup when + is pressed in SelectionText, with Lapis's
own glossary markup. Card tags include text tags and dictionary tags (frequency tiers or
dictionary names), lowercase. The popup's + creates the card at once from the saved
settings; progress, success, duplicate (Prevent, Overwrite, Allow) and problems show on
the action itself, and Edit in Anki Browser hands off manual editing.

## Themes

Application themes: Light, Dark, Sakura, Matcha, Hojicha, Midnight, Ember, Forest and one
custom theme (Light/Dark base, Background, Surface, Text, Accent). Reader themes are
separate: Paper, Sepia, Night, Sakura, Matcha, Hojicha, Solarized, Nord, Gruvbox, Rosé
Pine, Tokyo Night and Catppuccin Latte, Frappé, Macchiato and Mocha, plus named custom
themes. Custom Reader themes are structured values, never arbitrary CSS.

## Responsive targets

Verify around 1280, 1440, 1920 and 2560 px, plus compact windows. Prefer flexible
grids, `minmax()`, `clamp()` and sensible maximum content widths.

## Branding

The cat logo and the sixteen tinted app icons sit behind an asset abstraction, so
branding can change without changing page layouts.
