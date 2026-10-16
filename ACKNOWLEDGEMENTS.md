# Acknowledgements

Komori stands on the work of many people. Legal notices are in [NOTICE](NOTICE) and, for
binaries, `THIRD-PARTY-NOTICES.txt`; this page gives credit.

## Formats

Komori imports dictionaries in the Yomitan dictionary format and creates Anki notes with the
Lapis note type through AnkiConnect.

## Yomitan

[Yomitan](https://github.com/yomidevs/yomitan) (and Yomichan before it) shaped how Komori looks
words up.

- Komori's Japanese deinflection rules are adapted from Yomitan's Japanese transforms
  (GPL-3.0-or-later).
- The kanji code-point ranges, the dictionary tag category colors and the frequency harmonic and
  average ranks for Anki follow Yomitan's.
- Listing every start of the scanned text, numbered senses and the lookup popup's layout were
  inspired by Yomitan.

## Lapis and JP-study

[Lapis](https://github.com/donkuri/lapis), by Ruri, itokatsu, kuri and contributors, is the
Anki note type Komori creates. It is bundled unmodified under GPL-3.0. Lapis builds on
[rudnam](https://github.com/rudnam)'s [JP-study](https://github.com/rudnam/JP-study).

## Libraries and fonts

[EPUB.js](https://github.com/futurepress/epub.js) renders books, with a small Komori patch.
Komori is built with [Tauri](https://tauri.app), [React](https://react.dev),
[React Router](https://reactrouter.com) and [SQLite](https://sqlite.org) through
[rusqlite](https://github.com/rusqlite/rusqlite). Icons are
[Phosphor Icons](https://phosphoricons.com); the interface font is
[Inter](https://rsms.me/inter/).

## Downloaded on request

These are not part of Komori; it downloads them only when you choose to, and shows their
attribution and license where you add them.

- [JMdict, JMnedict and KANJIDIC](https://www.edrdg.org/edrdg/licence.html) by the Electronic
  Dictionary Research and Development Group, packaged by
  [yomidevs](https://github.com/yomidevs/jmdict-yomitan).
- [Jitendex](https://jitendex.org) by Stephen Kraus.
- The [Jiten](https://jiten.moe) Japanese media frequency list by Sirus.
- Reader fonts from [Google Fonts](https://github.com/google/fonts), each kept with its Open Font
  License.

## Artwork

The Komori logo and the icons made from it were created by the project owner with an AI image
tool. They are covered by Komori's license, GPL-3.0-or-later.
