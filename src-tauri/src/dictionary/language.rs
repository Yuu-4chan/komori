//! The lookup language and what it decides about a lookup: its deinflection rules and word
//! classes, the variants of a text it also looks up, whether a lookup's starts must end at a word
//! boundary, and whether the Japanese-only behaviors apply (the kana ranking, する nouns, the
//! trailing-particle reorder and the kanji lookup). Each dictionary belongs to one language, and a
//! lookup uses only that language's dictionaries. Every language but Japanese spaces its words.
//! Adding a language is adding a variant here and its rule table in `deinflect`.

use serde::{Deserialize, Serialize};

use super::deinflect::{self, Candidate};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum Language {
    #[default]
    #[serde(rename = "ja")]
    Japanese,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "fr")]
    French,
    #[serde(rename = "pt")]
    Portuguese,
    #[serde(rename = "it")]
    Italian,
    #[serde(rename = "es")]
    Spanish,
}

impl Language {
    const ALL: [Self; 6] = [
        Self::Japanese,
        Self::English,
        Self::French,
        Self::Portuguese,
        Self::Italian,
        Self::Spanish,
    ];

    /// The language's ISO 639-1 code, as word audio sources and dictionaries name it.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::English => "en",
            Self::French => "fr",
            Self::Portuguese => "pt",
            Self::Italian => "it",
            Self::Spanish => "es",
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
            let three: &[&str] = match language {
                Self::Japanese => &["jpn"],
                Self::English => &["eng"],
                Self::French => &["fra", "fre"],
                Self::Portuguese => &["por"],
                Self::Italian => &["ita"],
                Self::Spanish => &["spa"],
            };
            primary == language.code() || three.contains(&primary.as_str())
        })
    }

    /// The forms `text` may be an inflection of in this language.
    pub(crate) fn deinflect(self, text: &str) -> Vec<Candidate> {
        match self {
            Self::Japanese => deinflect::ja::deinflect(text),
            Self::English => deinflect::en::deinflect(text),
            Self::French => deinflect::fr::deinflect(text),
            Self::Portuguese => deinflect::pt::deinflect(text),
            Self::Italian => deinflect::it::deinflect(text),
            Self::Spanish => deinflect::es::deinflect(text),
        }
    }

    /// The word classes a term's space-separated rules name.
    pub(crate) fn word_classes(self, rules: &str) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::word_classes(rules),
            Self::English => deinflect::en::word_classes(rules),
            Self::French => deinflect::fr::word_classes(rules),
            Self::Portuguese => deinflect::pt::word_classes(rules),
            Self::Italian => deinflect::it::word_classes(rules),
            Self::Spanish => deinflect::es::word_classes(rules),
        }
    }

    /// The word classes a term's rules can name.
    pub(crate) fn dictionary_forms(self) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::DICTIONARY_FORMS,
            Self::English => deinflect::en::DICTIONARY_FORMS,
            Self::French => deinflect::fr::DICTIONARY_FORMS,
            Self::Portuguese => deinflect::pt::DICTIONARY_FORMS,
            Self::Italian => deinflect::it::DICTIONARY_FORMS,
            Self::Spanish => deinflect::es::DICTIONARY_FORMS,
        }
    }

    /// `text` and the other spellings a lookup also tries, each once: in a language that spaces
    /// its words, with its typographic apostrophes as ASCII ones, then also lowercased, with its
    /// first letter capitalized, and lowercased with its first letter capitalized (Running:
    /// running; london: London; NASA: nasa, Nasa); in French and Italian, then also all of those
    /// for the text without the elided word that begins it (l'homme: homme; dell'Italia: Italia).
    /// Japanese tries only the text.
    pub(crate) fn variants(self, text: &str) -> Vec<String> {
        let mut variants = vec![text.to_owned()];
        if !self.spaces_words() {
            return variants;
        }
        let elided = self.without_elision(text);
        for text in std::iter::once(text).chain(elided.as_deref()) {
            let ascii = text.replace('\u{2019}', "'");
            let lower = ascii.to_lowercase();
            let capitalized_ascii = capitalized(&ascii);
            let capitalized_lower = capitalized(&lower);
            for variant in [
                text.to_owned(),
                ascii,
                lower,
                capitalized_ascii,
                capitalized_lower,
            ] {
                if !variants.contains(&variant) {
                    variants.push(variant);
                }
            }
        }
        variants
    }

    /// `text` without the elided word that begins it (l', d', qu'; dell', un'), when more
    /// follows it.
    fn without_elision(self, text: &str) -> Option<String> {
        let words: &[&str] = match self {
            Self::French => &[
                "l", "d", "j", "m", "n", "s", "t", "c", "ç", "qu", "jusqu", "lorsqu", "puisqu",
                "quoiqu", "presqu",
            ],
            Self::Italian => &[
                "l", "dell", "all", "dall", "nell", "sull", "coll", "un", "quest", "quell", "c",
                "n", "d", "s", "m", "t", "v",
            ],
            _ => return None,
        };
        let (word, rest) = text.split_once(['\'', '\u{2019}'])?;
        (words.contains(&word.to_lowercase().as_str()) && !rest.is_empty()).then(|| rest.to_owned())
    }

    /// Whether a lookup's starts end only at word boundaries, as in languages that space their
    /// words: `looked` is not also looked up as `look` or `lo`.
    pub(crate) fn spaces_words(self) -> bool {
        self != Self::Japanese
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
        assert_eq!(
            Language::French.variants("L’homme"),
            ["L’homme", "L'homme", "l'homme", "homme", "Homme"]
        );
        assert_eq!(
            Language::French.variants("qu'il"),
            ["qu'il", "Qu'il", "il", "Il"]
        );
        assert_eq!(
            Language::Italian.variants("dell'Italia"),
            [
                "dell'Italia",
                "dell'italia",
                "Dell'Italia",
                "Dell'italia",
                "Italia",
                "italia"
            ]
        );
        assert_eq!(
            Language::Portuguese.variants("d'água"),
            ["d'água", "D'água"]
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
        for (tag, language) in [
            ("en", Language::English),
            ("en-US", Language::English),
            ("EN_gb", Language::English),
            ("eng", Language::English),
            ("fr-CA", Language::French),
            ("fre", Language::French),
            ("fra", Language::French),
            ("pt-BR", Language::Portuguese),
            ("por", Language::Portuguese),
            ("it", Language::Italian),
            ("ita", Language::Italian),
            ("es-MX", Language::Spanish),
            ("spa", Language::Spanish),
        ] {
            assert_eq!(Language::declared(Some(tag)), Some(language), "{tag}");
        }
        for tag in [
            None,
            Some(""),
            Some(" "),
            Some("zh"),
            Some("de"),
            Some("jav"),
            Some("english"),
            Some("e"),
        ] {
            assert_eq!(Language::declared(tag), None, "{tag:?}");
        }
    }

    #[test]
    fn languages_round_trip_by_code() {
        for language in Language::ALL {
            let json = serde_json::to_string(&language).unwrap();
            assert_eq!(json, format!("\"{}\"", language.code()));
            assert_eq!(serde_json::from_str::<Language>(&json).unwrap(), language);
            assert_eq!(Language::from_code(language.code()), Some(language));
        }
        assert_eq!(Language::from_code("de"), None);
        assert!(serde_json::from_str::<Language>("\"de\"").is_err());
        assert_eq!(Language::default(), Language::Japanese);
    }
}
