# Changelog

All notable changes to Komori are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.7.2

- Series from titles keeps a title's own brackets and marks in the series name, such as IS＜インフィニット・ストラトス＞, 運命に愛されてごめんなさい。<…> and ギブあっぷ！, instead of cutting the closing ＞ or the ！.
- Series from titles now groups （上） and （下） volumes, such as 優等生がアダルトグッズを買いに来た（上）/（下）, and a volume whose title only adds a subtitle, such as たかがアイドル！～されど、やっぱり顔はいい～01 with たかがアイドル！02. A spin-off that repeats a volume number the series already has stays on its own.
- In Settings, row buttons now match the height of the fields above them and line up in one column, so Delete and Delete all are the same size.
- Settings steppers no longer cut their number or wrap their unit in any language. Jump limit's hint now says it counts characters or words, and Stop counting after reads "5 min".

## 1.7.1

- Dictionary lookups show the word's dictionary form first when the other match is an entry no frequency list knows, such as a conjugated form listed on its own, a Pixiv tag or an album title. 書いた now leads with 書く, 寝ろ with 寝る and 見て with 見る; the other entry follows right after. Entries with a frequency rank of their own, such as 高さ, stay first.

## 1.7.0

- The interface is now also in French, Italian, Spanish, German, Russian and Traditional Chinese. Choose one in Settings > General > Application language; the tray menu, file dialogs, the backup file name and the Discord status follow it.
- Series from titles is on by default. A choice already saved in Settings > General stays as it is.
- Settings shows Discord's own logo in the Discord section.

## 1.6.0

- A group's own page keeps a sort of its own, saved apart from the Library's, so each can have its preferred order. Grouped, the Library's sort orders the groups and each carousel shows its books in the group page's order.
- Books in a group follow the chosen sort and its direction, even when their series numbers were set by hand in separate batches.
- A custom Reader theme is deleted by right-clicking its swatch, or with Shift+F10 or the menu key on it, and choosing Delete theme.
- The custom theme editor's name row lines up with its color rows.
- Covers drawn as SVG images show at their own size in the Images panel and the image viewer instead of stretched, and tiny spacer images no longer show as blank tiles.

## 1.5.0

- Series from titles in Settings > General, off by default, puts numbered volumes that share a title, such as `Title 01` and `Title 02`, in one series when the books name none. Series read from a book or set by hand come first.
- Groups follow the chosen sort and its direction: by name, by the latest book opened or added, by progress, or by the characters or words they hold. A series keeps its volumes in order, and books without a series or language stay last.
- Mark as completed, in a book's menu or for the selected books, moves their progress to the end.
- Continue reading stays while selecting books, so a book chosen there or below keeps its place.
- A book's series or language on its card opens every book of that series or language.
- Titles drop store, edition and bonus tags in brackets, such as 【電子版】, (Kindle版), 【BOOK☆WALKER限定 特典付き】, (角川文庫) or (Light Novel), in full- or half-width brackets, even mixed as in （電子版). A title's own bracketed words, such as （上）, stay. Titles already in the Library are cleaned once when Komori starts.

## 1.4.0

- An image opened from the Reader sidebar's Images panel shows behind the sidebar, which stays open over it, so another image can be chosen without closing the viewer. Images opened from the book still fill the window.
- A, G, Ctrl+B and N open Appearance, Images, Bookmarks and Notes and, pressed again, return to the contents. S shows the contents from any panel and, on the contents, hides or shows the sidebar.
- Page Down and Space turn a whole page forward, and Page Up and Shift+Space back, in every view. The Up and Down arrows read back and on, and Home and End go to the start of the chapter and to the next chapter.
- A search result marks its match for a few seconds and offers a way back to where you were. A floating sidebar moves aside when the match is under it.
- Bookmarks, notes, search results and images show their chapter instead of a section number.
- Page margin in the Reader's Appearance sets the space at the outer edges of the text, 40 px by default.
- VN view centers each group of lines in the reading area, and a click reads on.
- Appearance hides settings that would change nothing in the current view, such as Text orientation for horizontal text and Wheel step for turning pages.
- The book title, author and series on the Reader sidebar can be selected by dragging from anywhere around them. A right-click offers Copy, and selects the line under the pointer when nothing is selected.
- Selected text is marked strongly enough in the accent color to see on any background.
- Escape closes an open menu without also hiding the sidebar behind it.
- Right-clicking selected book text offers Look up.
- The lookup popup has a Reader theme that follows the page's colors, used by new installs. A short entry makes the popup shorter instead of leaving empty space.
- Holding Shift over punctuation no longer opens the popup.
- A lookup in kana lists the most frequent word first, so よむ shows 読む first.
- Popup entries show four tags and frequencies, then a count of the rest. Settings > Reader popup describes the chosen Popup style.
- Settings is on the top bar of every page.
- Adding a bookmark shows one notice instead of two.
- The Library summary counts the books shown, such as `3 of 9 books` while searching or filtering. Selection boxes show on any cover.
- Series… suggests the series the chosen books share, or the name their titles begin with.
- Statistics shows `<1m` for reading under a minute, and word counts only when the Library has books counted in words.

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
