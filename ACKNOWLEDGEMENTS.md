# Acknowledgements

Komori stands on the work of many people. Legal notices are in [NOTICE](NOTICE) and, for
binaries, `THIRD-PARTY-NOTICES.txt`; this page gives credit.

## Formats

Komori imports dictionaries in the Yomitan dictionary format and creates Anki notes with the
Lapis note type through [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect), the add-on
that lets programs talk to [Anki](https://apps.ankiweb.net).

## Yomitan

[Yomitan](https://github.com/yomidevs/yomitan) (and Yomichan before it) shaped how Komori looks
words up.

- Komori's Japanese, English, French, Spanish, Korean and German deinflection rules and the
  engine that applies them are adapted from Yomitan's transforms for those languages and its
  language transformer (GPL-3.0-or-later). The Portuguese, Italian and Russian rules are
  Komori's own, written in the same form.
- The kanji code-point ranges, the dictionary tag category colors and the frequency harmonic and
  average ranks for Anki follow Yomitan's.
- Listing every start of the scanned text, numbered senses and the lookup popup's layout were
  inspired by Yomitan.

## Lapis and JP-study

[Lapis](https://github.com/donkuri/lapis), by Ruri, itokatsu, kuri and contributors, is the
Anki note type Komori creates. It is bundled unmodified under GPL-3.0. Lapis builds on
[rudnam](https://github.com/rudnam)'s [JP-study](https://github.com/rudnam/JP-study).

## Libraries

[EPUB.js](https://github.com/futurepress/epub.js) renders books, with a small Komori patch.
Komori is built with [Tauri](https://tauri.app) and [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/),
[React](https://react.dev), [React Router](https://reactrouter.com) and
[SQLite](https://sqlite.org) through [rusqlite](https://github.com/rusqlite/rusqlite). Among the
Rust crates it relies on, [zip](https://github.com/zip-rs/zip2) opens EPUBs and dictionary
archives, [roxmltree](https://github.com/RazrFalcon/roxmltree) reads a book's package files,
[image](https://github.com/image-rs/image) makes covers,
[ttf-parser](https://github.com/harfbuzz/ttf-parser) reads Reader fonts,
[reqwest](https://github.com/seanmonstar/reqwest) and [rustls](https://github.com/rustls/rustls)
fetch downloads and word audio, [regex](https://github.com/rust-lang/regex) finds series in
titles and [rfd](https://github.com/PolyMeilex/rfd) opens file dialogs. Every bundled package is
listed with its license in `THIRD-PARTY-NOTICES.txt`.

## Icons and fonts

Icons are [Phosphor Icons](https://phosphoricons.com). The interface font is
[Inter](https://rsms.me/inter/) by Rasmus Andersson, through
[Fontsource](https://fontsource.org).

The installer includes five Reader fonts from [Google Fonts](https://github.com/google/fonts),
each under the SIL Open Font License 1.1:
[Noto Sans JP, KR and SC](https://github.com/notofonts/noto-cjk) (Google, from Adobe's Source
Han Sans), [Klee One](https://github.com/fontworks-fonts/Klee) (Fontworks) and
[Zen Old Mincho](https://github.com/googlefonts/zen-oldmincho) (Yoshimichi Ohira).

## Downloaded on request

These are not part of Komori; it downloads them only when you choose to, and shows their
attribution and license where you add them.

- Wiktionary dictionaries and IPA pronunciations for every lookup language, from
  [Wiktionary](https://www.wiktionary.org) contributors (CC BY-SA 4.0), extracted by
  [Kaikki.org](https://kaikki.org) and packaged by
  [wiktionary-to-yomitan](https://github.com/yomidevs/wiktionary-to-yomitan).
- [JMdict, JMnedict and KANJIDIC](https://www.edrdg.org/edrdg/licence.html) by the Electronic
  Dictionary Research and Development Group, packaged by
  [yomidevs](https://github.com/yomidevs/jmdict-yomitan).
- [Jitendex](https://jitendex.org) by Stephen Kraus, with examples from
  [Tatoeba](https://tatoeba.org) and furigana from
  [JmdictFurigana](https://github.com/Doublevil/JmdictFurigana).
- The [Jiten](https://jiten.moe) Japanese media frequency list by Sirus.
- More Reader fonts from [Google Fonts](https://github.com/google/fonts), each kept with its Open
  Font License.

## Word audio

When you ask for a word's pronunciation, Komori fetches recordings from
[JapanesePod101](https://www.japanesepod101.com) for Japanese and from
[Wikimedia Commons](https://commons.wikimedia.org) contributors for every lookup language.
Recordings are played, and added to Anki cards when you ask, but never bundled.

## Discord

The optional Discord status talks to the [Discord](https://discord.com) app on your computer.
The Discord logo shown in Settings is a trademark of Discord Inc.; Komori is not affiliated with
Discord.

## Artwork

The Komori logo and the icons made from it were created by the project owner with an AI image
tool. They are covered by Komori's license, GPL-3.0-or-later.
