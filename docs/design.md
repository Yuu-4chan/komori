# Komori design guide

## Overview

Komori uses a compact Inter interface, Phosphor icons, real book covers, and rounded controls. It has its own identity: a clean, native-feeling desktop design in the manner of macOS. The Library, Dictionary and Statistics pages are the reference for new screens; extend what they establish rather than inventing a screen-local style. Feature-level behavior of each screen is summarized in [features](features.md).

The application fills its window. The Library gives covers and reading progress prominence; the Reader gives book content the full window and keeps its tools in a separate sidebar and floating lookup sheet. Application colors and book colors are independent.

**Key Characteristics:**

- Compact, labelled tools with visible selected, hover, focus, and disabled states.
- Tonal surfaces, restrained internal borders, and soft offset shadows.
- Real covers and progress; explicit unavailable or untracked data.
- Japanese serif lookup headwords with source-numbered definitions.

Runtime themes remain defined in [application themes](../src/features/appearance/appThemes.ts), [Reader themes](../src/features/reader/readerThemes.ts), and [CSS tokens](../src/styles/tokens.css); extend those sources rather than adding screen-local palettes.

## Colors

### Primary

The accent supplies selected navigation, action buttons, tags, and small emphasis areas. Use accent ink for text, accent action for filled actions, and soft or faint accent for tinted surfaces. The decorative base color is independently editable; readable ink and action tones derive from it. Each application preset brings its own accent; only the custom theme edits one.

### Neutral

Background colors the window and sidebar; Main colors page content. Card, Subtle, and Raised distinguish containers and controls. Primary, Secondary, and Muted text preserve hierarchy. Borders define internal controls and groups without enclosing the application in an inset frame.

Application presets are Light, Dark, Sakura, Matcha, Hojicha, Midnight, Ember, and Forest. Each preset has its own accent. A custom application theme chooses a light/dark base plus Background, Surface, Text, and Accent. Cards, subtle and raised surfaces, text hierarchy, and borders derive centrally. Secondary text uses a 74% text share and muted text a 68% share toward the main surface in both bases.

### Status and dictionary categories

Progress uses the progress-fill role. Destructive actions use danger mixed into a readable action color. Imported dictionary tag categories retain their centralized category colors, mixed into theme-aware ink and tint; undefined categories use the accent treatment. Their full category vocabulary is in the CSS tokens.

**The Separate Surfaces Rule.** Application chrome and lookup follow application colors. Reader page, text, selection, and footer follow the chosen Reader theme; never derive one theme from the other.

Reader presets are Paper, Sepia, Night, Sakura, Matcha, Hojicha, Solarized, Nord, Gruvbox, Rosé Pine, Tokyo Night, Latte, Frappé, Macchiato, and Mocha. Custom Reader themes keep the same five book-color roles: background, text, selection, highlight and footer text.

## Typography

Interface typography uses the self-hosted Inter variable font with Windows and Japanese sans-serif fallbacks. Phosphor icons accompany labels and actions. Japanese lookup expression and reading use Noto Serif JP with Yu Mincho and other Japanese serif fallbacks; this is distinct from configurable book typography. The exact stacks and sizes are defined in the application styles.

Use the headline role for page titles, title for section headings, body for general interface copy, label for controls, and caption for metadata. Library book titles use the label size with a two-line limit; authors and optional details use the caption scale. Counts, percentages, and frequency values use tabular numerals.

At wide desktop density (1800px and above), captions grow to 0.75rem, labels to 0.875rem, body to 1rem, and section titles to 1.25rem. The lookup expression, reading, and definition sizes remain dedicated popup roles. Source labels are smaller than the expression, with enough room for dictionary names.

## Layout

The shell is one scrolling main surface between a floating top bar (4.5rem, which is also the window's title bar; brand at the left (the Komori logo, `src/brand/komori.svg`, drawn in the application accent with no chip around it; the application icon is the logo on a rounded-square tile with the book, cat, petal and sakura tinted to it, the sakura cut out in the tile's colors and the drawing centered optically between the book and the tail (`src/brand/appIcons.ts`; Settings > General's App icon row offers each one as the icon itself, two rows of eight, chosen with the theme options' accent ring)), then a centered pill search of clamp(18rem, 36vw, 38rem) beside circular Settings and Add books buttons of 2.75rem with the search's raised surface and border, shown only on the Library as the search is, and the Windows minimize, maximize, and close buttons flush in the top right, 46x32 px with a red close hover) and a floating bottom dock, in the manner of macOS. The bar's controls are flat raised surfaces at the top and turn to frosted glass with a float shadow (`--shadow-float`) once the page scrolls under them; the window controls sit in a corner strip (hairline left/bottom edge, rounded lower-left corner) that frosts with them, and the bar itself becomes a frosted strip with a hairline lower edge, so scrolled content passes under a surface rather than under loose controls. The main scroller keeps a stable scrollbar gutter, so pages are the same width with or without a scrollbar, and its scrollbar runs below the bar. The dock is a frosted rounded panel of icon-and-label items; the current one is accent-tinted with a larger icon (1.85rem instead of 1.45rem). Page content is centered with a maximum width (112rem) and responsive horizontal and vertical padding. At 1800px, controls grow to 2.875rem high. At 2300px, page padding grows to 4.5rem horizontally and 3.75rem vertically.

The Library page is the Library's headline-size title with a one-line summary below it and the toolbar beside it, then Continue reading under a group heading (title-size name, muted count, hairline under it), then an All books group heading when ungrouped. Continue reading uses the Library's grid cards and columns and wraps into more rows. The Library's toolbar sits beside its title, aligned to its bottom and wrapping under it when narrow: Filters, Group, Cards, and Sort menu buttons, a sort-direction icon button, then a segmented grid/list control (a raised tab on a sunken track). Each card's selection box (rounded square, filled accent action when checked) sits in its top-left corner, mirroring the round actions button top right. While selecting, a frosted pill (1.1rem radius, float shadow) floats centered just above the dock with the count, a muted Shift+click hint, quiet text actions, a danger Remove, and a round Done. Grouped Libraries head each group with a title-size name, a muted book and character count, and a hairline under it, with an accent See all text link at its right; the group's cards scroll sideways beneath, with no visible scrollbar, and 2.5rem round frosted previous/next arrows (float shadow) sit over the row's left and right edges, centered on the covers, only while the row can move that way. A group's page puts a muted back link above its title. Toolbar controls share one 2.25rem height, 0.7rem radius, quiet raised surface, and hairline border; an active menu button takes the accent tint, and Cards is active only while a card detail differs from its default. Import results and failures are neutral notices (no warning colour) ending in a quiet close button. An empty Library's top bar has no search, so its Settings and Add books buttons sit centered without the search's reserved width. Menus are frosted panels (0.85rem radius, float shadow) whose chosen option leads with a check mark and whose hovered option takes the accent's soft tint. Grid columns auto-fill from the saved card size (180 px by default, Settings > General); cover aspect ratio is 2:2.85.

At 820px and below the top bar's brand hides and its search takes the free width, the dock's items shrink, and list-row progress moves below identity. These are adaptations of the same controls.

Reader lookup stays within the reading area beside the selected or scanned text. Its saved width and height fit within the reading area; its body scrolls independently. The query remains in the accessible dialog name without a visible results summary or close button. Keep the Dictionary handoff visible.

## Elevation & Depth

Most hierarchy comes from surface color, spacing, and internal dividers. Reusable low and medium shadows support cards, menus, and dialogs. Covers have their own offset shadows and a small hover lift. Lookup is a borderless floating sheet: soft offset shadows separate it from the book, including in dark themes; it has no perimeter ring.

Fast control transitions use the shared fast duration and easing; cover transitions use the normal duration. Existing reduced-motion styles disable transitions and reduce animations to a single short iteration. Shadow and motion values remain defined in the application styles.

## Shapes

Use the shared rounded scale: small controls, medium book covers and shelf cards, large containers, extra-large summary, and pill badges. The lookup sheet matches the large radius. Keep borders on fields, menus, chips, and internal groups where they convey structure. Preserve standard native title-bar and window controls above the full-window application.

**The Outer Frame Rule.** Keep the application flush with its window and lookup borderless; do not add an enclosing inset frame or a popup perimeter ring.

## Components

### Buttons and fields

Primary buttons use the action accent and white text; secondary buttons use Raised with a medium border; quiet buttons use faint accent and accent ink. Every button has a hover state: primary deepens, secondary tints its surface and takes the accent border, quiet takes the soft accent. Inline text links keep a faint underline that turns solid on hover. Destructive buttons use the danger action mix. Shared buttons use the control height, horizontal padding, small radius, and label typography. Active press scales slightly; disabled controls lower opacity. Keyboard focus is explicit: every control uses one solid 2px accent-ink ring (`--focus-ring`), each keeping its own offset; search fields keep their accent border and soft halo. Containers focused only by code (the Reader's reading area) show no frame; the image viewer's pan area takes the same ring. Every scrolling surface, including Reader panels and continuous books (thumb in the Reader ink), uses the application's rounded thumb rather than the system's arrowed scrollbar. Selects are pop-up buttons: the raised card surface, a medium border, a small shadow and up/down chevrons, ending a long choice in an ellipsis. Their options open in the Library's frosted menu panel; a single choice is marked only by a leading check mark (an empty column of the same width keeps the other labels aligned), never by checkboxes. Checkbox boxes are only for choosing several things at once, and radios show a round dot. A field added to a dialog sits a space-4 gap below its description.

Search fields use the raised surface and an internal border, with a search icon, clear control when applicable, and accent focus treatment. Typed text is primary text; only the icon and placeholder are muted. Retain accessible labels independently of placeholder text. Search fields and code-like fields (ports, keys, tags) have no spelling check; prose such as a note keeps it. A hint is one clause, and only where the label does not already say it (no hint under Launch at startup, a font that is installed, or a series from the book's metadata). Every disclosure is marked by Komori's chevron, pointing right when closed and down when open, never the browser's triangle.

### Navigation and menus

Navigation combines icon and label with a selected accent tint, stronger weight, and a larger icon. The dock holds Dictionary, Library, and Statistics; Settings and Add books sit beside the Library's search; the theme is chosen in Settings; books open through the Library.

Settings reads like a system settings window. Its sticky category sidebar is one continuous list with no gaps between groups; each item is a white icon on an accent tile beside its name and description, and the chosen item is filled with the accent action color (white text, its tile a faint white tint rather than white). Compact layouts stack the categories above the section. Each card has a 2.5rem tinted icon, a title-size heading and a short description. Every setting is a row of one subtle rounded grouped list divided by hairlines, whatever its control: the label (label size, 650 weight) over its muted hint on the left, the control on the right (switches at their natural size; selects, steppers and text fields up to 17rem wide, centered vertically). Actions are rows too: what they do on the left, a secondary button on the right. Extra detail sits in a disclosure in the same box and type. Small grids of choices (themes, dictionary roles) use the same subtle box, radius and type. Never leave one setting alone in its own card: fold it into the closest related card. Library floating menus use rounded raised surfaces, concise section labels, and check-marked or checkbox options. Selection is visible and keyboard reachable; Escape dismisses and returns focus.

### Reader sidebar

The sidebar is always a rounded card centered vertically, shorter than the window (86% of it, at least 600px, at most 960px, fitting within 14px window insets). Pinning keeps the same card visible and reserves its width plus the insets beside the book; at 1080px and below it floats and hides as unpinned, with no Pin button. Information pills center over the available reading area. It has 40px round Back, Appearance (a sun) and Pin buttons at the top, with no title between them. Below, the open book: a large rounded cover beside its title, author, and its series name when it has one. Under the cover, four equal floating tiles (icon over name, each its own small card) open Images, Bookmarks, Notes and Search; the open panel's tile is accent-tinted and pressing it again returns to the contents. The contents fill the remaining height under a small `Chapters` label, between a hairline below the label and one at the list's foot, and scroll by themselves as a timeline: a dot per entry on one vertical line, filled in the accent with an accent line for entries already read, an accent ring on a tinted rounded row for the current one, and hollow muted dots with secondary text for the rest; each row has the title on the left and where it starts on the right. Along the bottom, a card names the current chapter with its read percentage in an accent pill, over the book's `current / total Ch. · N%` beside a progress bar. Positions read `Ch.` for books counted in characters and `Wo.` for books counted in words; in the bottom card the chapter's name leads and the book's position is smaller and muted. The panels (Images, Bookmarks, Notes, Search) have a title and no description, hints or instructions for obvious actions; labels are short (`Bookmark title`) and empty states one short line. The series line shows the series (a group) by name only, never a number. Search fields are one rounded field (icon, input, no inner outline) that shows focus itself, with Find beside it on the same row. Bookmark and note cards keep their actions centered on the right of the icon and text, and a note shows at most four lines there. Appearance follows the same pattern: each section is a small muted label over a rounded box of inspector rows, the name on the left and the control on the right, with no explanatory text.

The Reader theme and optional backdrop continue behind the sidebar card, including
while pinned; the reserved space has no separate application-colored strip.

Semi-continuous chapters begin with two base-font em of clearance along the
reading axis. Clip boundaries include heading furigana, so annotations remain
whole; the clearance follows the font size and writing direction.

### Cards, covers, and progress

Reader font fields combine a typed family name and a dropdown arrow, with a compact,
quiet + icon button beside each field (the shared 2rem control token, no resting
box). Each font's Weight row immediately follows it. The + opens a floating font
manager using the shared dialog, grouped rows, typography and tokens. Font
downloads and imports belong in that manager; font dropdowns contain choices
already available to Komori.

Grid books place real covers above identity and progress without a surrounding card box; a row's cards share its height and keep their progress at the bottom, so bars and counts line up. List rows use bordered raised cards. A cover fallback is an explicit title/icon treatment when a real image is unavailable. Covers show as soon as they decode, with no fade or shimmer; the cover's plain color stands in. That behavior belongs to the shared BookCover primitive.

Progress is a narrow rounded green bar beside percentage, with read/total counts below. Missing counts use an explicit pending message. Keep selection, import, removal, missing-source warnings, relink, and Reader entry available with the visual card treatments.

### Chips and lookup sheet

Library metadata chips are compact bordered pills. Lookup tags are rounded tinted chips; frequency chips pair a source with a value. Headword, reading, tags, frequency, and pitch precede the definitions.

Each dictionary definition has its own numbered source header and collapse control. Its body is indented under that header; structured numbered senses have small circular numbers. Keep imported safe content and interactive dictionary term links shared with the Dictionary page. Kanji results keep their own content within a flattened subtle container. The sheet retains loading, no-match, failure, audio availability and Open in Dictionary states, with Escape/outside-click dismissal.

## Do's and Don'ts

### Do:

- **Do** reuse semantic tokens and shared UI primitives across screens.
- **Do** keep every configuration consistent with the others: the same row, type, border and spacing rules, with no screen-local fonts or borders.
- **Do** keep independent application and Reader theme roles.
- **Do** show untracked time/streak and unavailable metadata honestly.
- **Do** preserve visible focus, native window controls, source labels, and collapsible definitions.
- **Do** keep interface text (labels, headings, rows, cards) out of drag selection, as a native app does; text fields, dictionary entries and the popup, notes, book folder paths and error messages stay selectable for copying.

### Don't:

- **Don't** add an inset outer application frame or lookup perimeter ring.
- **Don't** substitute placeholder covers, statistics, or dictionary entries for real data.
- **Don't** mark a single choice with checkboxes, or explain a setting's obvious behavior in prose.
- **Don't** name Yomitan in interface text; only a dictionary's licence credit may name its packager.
- **Don't** use the decorative accent directly where readable action or ink tokens exist.
- **Don't** hide existing Library controls to simplify a layout.
- **Don't** turn imported dictionary styling into application design tokens.
