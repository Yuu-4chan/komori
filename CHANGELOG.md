# Changelog

All notable changes to Komori are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.3.0

- Discord status can show the Komori page you are using outside the Reader: Browsing the library, Using the dictionary, Viewing statistics or Changing settings. It shows Idle after 5 minutes without using the page. Turn it off with Komori pages in Settings > Discord.
- The numbers and symbol rows that separate the parts of a chapter, such as a lone 7, ００１, －Ⅱ－ or ◇◆◇, are centered and slightly enlarged like chapter titles. A number in the text, such as a countdown or a reply number, keeps its place.
- Chapter titles are centered and enlarged in more books, including those whose contents point to an empty line before the title and those that start a chapter with its title as plain text.
- A title that a book indents with wide spaces is centered on its own text instead of sitting off center.
- The book title on the Reader sidebar can be selected and copied.
- While the rest of a long book is still loading, the Reader saves the place you are reading instead of one section earlier.

## 1.2.1

- In Continuous, Semi-continuous and VN view a book shows where you were reading in about a third of a second, and the rest of the book loads behind it. A book with 2,000 sections that took 40 seconds to open shows in under 2 seconds. Until the rest has loaded, jumps and layout changes wait for it, and Continuous view shows no scrollbar.
- Books open faster in every view, large illustrated books most of all: a 151 MB book shows its first page in a tenth of a second instead of more than a second. A downloaded Reader font no longer slows opening.
- The first book opened after Komori starts shows in its chosen font weight at once, instead of changing weight a moment later.
- Long books in Continuous view open and resize faster.
- Right-to-left books turn through every page, and a book that forces vertical text follows the chosen horizontal writing mode.
- Books whose contents page is empty or a placeholder list their chapters from the book's other table of contents.
- Images and styles that a book names with slightly wrong paths load.
- Fixed-layout books pair their pages into two-page spreads as the book places them, in either reading direction.
- Books with more than 1,000 sections open instead of hanging, and books with SVG pages open and show their drawings.
- In VN view, a chapter chosen from the contents opens at its start instead of at the end of the chapter before it.

## 1.2.0

- The lookup popup has a Popup style in Settings > Reader popup: Standard, or Dictionary, which shows only each headword with furigana right on its kanji and each dictionary's definitions under a small label with its name, numbered ①②③ when there is more than one.
- Settings > Reader popup > Lookup appearance has a Font for the popup's headwords, readings and definitions, Zen Old Mincho by default, chosen from the same fonts as the Reader.
- The Standard popup's headword, dictionary names, tags, frequencies, pitch lines and voice button are smaller, so the definitions lead. A wrapped pitch line no longer starts with a comma.
- A lookup marks its matched text the way a selection is marked, in the Selection color. Highlight colors saved passages only.
- Appearance, Images, Bookmarks, Notes and Search take the whole Reader sidebar, without the book card, tool tiles or progress card, until Back.
- Wide two-page spread images show whole in every Reader view instead of losing their edge or being pushed off their page.
- Settings rows use smaller controls, and a font picker is laid out like the other rows. In narrow windows a menu's arrow stays inside its field.

## 1.1.0

- Discord status: Settings > Discord can show the book you are reading in Discord, with its title, book progress, chapter progress and reading speed, each of which can be hidden. After 5 minutes without reading it shows Idle. The Komori icon in the status opens Komori's GitHub page. It is off by default.
- Reading speeds read as `Ch./h` and `Wo./h` (`Ca./h` and `Pa./h` in Portuguese).
- Statistics no longer shows the reading volume cards, which repeated the reading activity.

## 1.0.2

- Komori now includes Noto Sans JP, Noto Sans SC, Noto Sans KR, Zen Old Mincho and Klee One, ready without a download.
- New installs read Asian text in Noto Sans JP and Western text in Georgia. A saved Yu Mincho shows in the included Zen Old Mincho when Windows has no Yu Mincho.
- The Western and Asian font menus offer only fonts that can be used on this computer.
- The Fonts window shows Asian and Western fonts on separate tabs, with about twice as many Google Fonts to download.
- New installs look words up with a mouse click instead of mouse selection. A click in a visual-novel book reads on unless it looks a word up.
- Double pages no longer show a blank page beside a text page, or an image page beside a blank page instead of the text that follows it, a new chapter's included.
- Double pages show the cover and other single image pages in the middle of the spread, and image pages that a book places in a full-page frame are centered on their page.
- Turning between two pages from different parts of a book no longer briefly shows one page over the other.

## 1.0.1

- Double pages show consecutive image pages two to a spread, one image a page, instead of each beside a blank page. The cover stays alone.
- An image page no longer turns onto a blank page in single-page layout.
- The lookup popup's font size and line height can be set in Settings > Reader popup.
- New installs turn mouse-selection lookup on, with the middle button as the click trigger, and start the Reader's maximum width and height at the monitor's size.
- When Windows has no Yu Mincho, Komori downloads Noto Serif JP once and uses it for Japanese text.
- Reading speed is recorded for vertical books scrolled with a sideways or Shift wheel.
- The image viewer moves to the next or previous image with the mouse wheel.

## 1.0.0

First public release.

- Library of EPUBs read in place, with covers, progress, Continue reading, search, filters, sorting, series and language groups, book folders, Explorer drag and drop, and relinking of moved files.
- Reader with continuous, semi-continuous, paginated and visual-novel views, horizontal and vertical writing, detailed typography with curated and imported fonts, Reader themes and custom themes, background images, furigana hiding, image blur, bookmarks, notes, highlights, find in book, an image gallery and a configurable footer.
- Lookup popup with configurable triggers, deinflection, furigana readings, pitch accent, frequency, tags, kanji cards, nested lookups, and Voice with recorded word audio from JapanesePod101 or your own sources.
- Dictionary page, import of dictionary ZIP archives, ordering and removal, and starter downloads of curated open dictionaries.
- Reading statistics with automatic pause, an activity calendar with editable days, library overview and a character explorer.
- One-click Anki cards through AnkiConnect, with the bundled Lapis note type, configurable fields, tags, word audio and duplicate handling.
- Signed automatic updates that ask before installing and show what changed, and an uninstaller that offers to delete Komori's data.
- Automatic snapshots, backup export and import, application themes, sixteen app icons, launch at startup and minimize to tray.
- Interface in English, Japanese, Simplified Chinese, Korean and Brazilian Portuguese.
