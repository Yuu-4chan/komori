//! The lookup language and what it decides about a lookup: its deinflection rules and word
//! classes, the variants of a text it also looks up, whether a lookup's starts must end at a word
//! boundary, and whether the Japanese-only behaviors apply (the kana ranking, する nouns, the
//! trailing-particle reorder and the kanji lookup). Each dictionary belongs to one language, and a
//! lookup uses only that language's dictionaries. Adding a language is adding a variant here and
//! its rule table in `deinflect`.

use serde::{Deserialize, Serialize};

use super::deinflect::{self, Candidate};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum Language {
    #[default]
    #[serde(rename = "ja")]
    Japanese,
    #[serde(rename = "en")]
    English,
}

impl Language {
    const ALL: [Self; 2] = [Self::Japanese, Self::English];

    /// The language's ISO 639-1 code, as word audio sources and dictionaries name it.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::English => "en",
        }
    }

    /// The language a code names, as preferences and the dictionary store save it.
    pub(crate) fn from_code(code: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|language| language.code() == code)
    }

    /// The language a dictionary's declared source language names, if it is one of these: a tag
    /// matches by its primary subtag, in either case, as a two- or three-letter code (`en-US`,
    /// `EN`, `eng`).
    pub(crate) fn declared(tag: Option<&str>) -> Option<Self> {
        let primary = tag?
            .trim()
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        Self::ALL.into_iter().find(|language| {
            let three = match language {
                Self::Japanese => "jpn",
                Self::English => "eng",
            };
            primary == language.code() || primary == three
        })
    }

    /// The forms `text` may be an inflection of in this language.
    pub(crate) fn deinflect(self, text: &str) -> Vec<Candidate> {
        match self {
            Self::Japanese => deinflect::ja::deinflect(text),
            Self::English => deinflect::en::deinflect(text),
        }
    }

    /// The word classes a term's space-separated rules name.
    pub(crate) fn word_classes(self, rules: &str) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::word_classes(rules),
            Self::English => deinflect::en::word_classes(rules),
        }
    }

    /// The word classes a term's rules can name.
    pub(crate) fn dictionary_forms(self) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::DICTIONARY_FORMS,
            Self::English => deinflect::en::DICTIONARY_FORMS,
        }
    }

    /// `text` and the other spellings a lookup also tries, each once: in English, with its
    /// typographic apostrophes as ASCII ones, then also lowercased, with its first letter
    /// capitalized, and lowercased with its first letter capitalized (Running: running; london:
    /// London; NASA: nasa, Nasa).
    /// Japanese tries only the text.
    pub(crate) fn variants(self, text: &str) -> Vec<String> {
        let mut variants = vec![text.to_owned()];
        if self == Self::English {
            let ascii = text.replace('\u{2019}', "'");
            let lower = ascii.to_lowercase();
            let capitalized_ascii = capitalized(&ascii);
            let capitalized_lower = capitalized(&lower);
            for variant in [ascii, lower, capitalized_ascii, capitalized_lower] {
                if !variants.contains(&variant) {
                    variants.push(variant);
                }
            }
        }
        variants
    }

    /// Whether a lookup's starts end only at word boundaries, as in languages that space their
    /// words: `looked` is not also looked up as `look` or `lo`.
    pub(crate) fn spaces_words(self) -> bool {
        self == Self::English
    }

    /// Whether the Japanese-only lookup behaviors apply: the kana ranking, する nouns, the
    /// trailing-particle reorder and the kanji lookup.
    pub(crate) fn is_japanese(self) -> bool {
        self == Self::Japanese
    }
}

/// `text` with its first letter capitalized.
fn capitalized(text: &str) -> String {
    let mut characters = text.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(characters).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_also_tries_ascii_apostrophes_and_capitalization() {
        assert_eq!(
            Language::English.variants("Running"),
            ["Running", "running"]
        );
        assert_eq!(Language::English.variants("london"), ["london", "London"]);
        assert_eq!(
            Language::English.variants("NASA's"),
            ["NASA's", "nasa's", "Nasa's"]
        );
        assert_eq!(
            Language::English.variants("Cat\u{2019}s"),
            ["Cat\u{2019}s", "Cat's", "cat's"]
        );
        assert_eq!(
            Language::English.variants("look up"),
            ["look up", "Look up"]
        );
        assert_eq!(Language::Japanese.variants("Running"), ["Running"]);
        assert_eq!(
            Language::Japanese.variants("読む\u{2019}"),
            ["読む\u{2019}"]
        );
    }

    #[test]
    fn declared_source_languages_name_a_language_by_primary_subtag() {
        for tag in ["ja", "JA", "ja-JP", " jpn "] {
            assert_eq!(
                Language::declared(Some(tag)),
                Some(Language::Japanese),
                "{tag}"
            );
        }
        for tag in ["en", "en-US", "EN_gb", "eng"] {
            assert_eq!(
                Language::declared(Some(tag)),
                Some(Language::English),
                "{tag}"
            );
        }
        for tag in [
            None,
            Some(""),
            Some(" "),
            Some("zh"),
            Some("jav"),
            Some("english"),
            Some("e"),
        ] {
            assert_eq!(Language::declared(tag), None, "{tag:?}");
        }
    }

    #[test]
    fn languages_round_trip_by_code() {
        for language in [Language::Japanese, Language::English] {
            let json = serde_json::to_string(&language).unwrap();
            assert_eq!(json, format!("\"{}\"", language.code()));
            assert_eq!(serde_json::from_str::<Language>(&json).unwrap(), language);
            assert_eq!(Language::from_code(language.code()), Some(language));
        }
        assert_eq!(Language::from_code("fr"), None);
        assert!(serde_json::from_str::<Language>("\"fr\"").is_err());
        assert_eq!(Language::default(), Language::Japanese);
    }
}
