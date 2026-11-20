//! The Dutch deinflection rules, Komori's own (Yomitan has none), for dictionaries that do not
//! list every inflected form: noun plurals and diminutives, adjective endings with their
//! comparative and superlative, and regular verbs' present, past and past participle. A verb
//! form gives its stem (werkt, werkte, gewerkt: werk), which then takes -en with its spelling
//! restored (loop: lopen, leef: leven, lees: lezen, zit: zitten). Strong verbs' past forms are
//! the dictionaries' job.

use std::sync::LazyLock;

use super::{affix, deinflect_bounded, named_classes, rule, Candidate, Rule, RuleSet, MAX_STEPS};

/// Verbs, in the infinitive.
pub(crate) const V: u32 = 1;
/// Nouns, in the singular.
pub(crate) const N: u32 = 1 << 1;
/// Adjectives, uninflected.
pub(crate) const ADJ: u32 = 1 << 2;
/// A verb's stem, before -en.
const STEM: u32 = 1 << 3;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("v", V), ("n", N), ("adj", ADJ)])
}

const PLURAL: &str = "plural";
const DIMINUTIVE: &str = "diminutive";
const COMPARATIVE: &str = "comparative";
const SUPERLATIVE: &str = "superlative";
const DECLENSION: &str = "declension";
const PRESENT: &str = "present";
const PAST: &str = "past";
const PAST_PARTICIPLE: &str = "past participle";

const CONSONANTS: [&str; 14] = [
    "b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z",
];
const LONG_VOWELS: [&str; 4] = ["a", "e", "o", "u"];

fn leak(text: String) -> &'static str {
    text.leak()
}

/// Rules taking `ending` off a word whose base spells its last syllable differently before it:
/// a doubled consonant (katten: kat), a single long vowel (bomen: boom), v for f and z for s
/// (brieven: brief, huizen: huis).
fn respelled(rules: &mut Vec<Rule>, name: &'static str, ending: &str, applies_to: u32, gives: u32) {
    rules.push(rule(name, leak(ending.to_owned()), "", applies_to, gives));
    for consonant in CONSONANTS {
        let doubled = leak(format!("{consonant}{consonant}{ending}"));
        rules.push(rule(name, doubled, consonant, applies_to, gives));
    }
    for vowel in LONG_VOWELS {
        for consonant in CONSONANTS {
            let base = match consonant {
                "v" => "f",
                "z" => "s",
                other => other,
            };
            let inflected = leak(format!("{vowel}{consonant}{ending}"));
            let base = leak(format!("{vowel}{vowel}{base}"));
            rules.push(rule(name, inflected, base, applies_to, gives));
        }
    }
    rules.push(rule(
        name,
        leak(format!("v{ending}")),
        "f",
        applies_to,
        gives,
    ));
    rules.push(rule(
        name,
        leak(format!("z{ending}")),
        "s",
        applies_to,
        gives,
    ));
}

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    respelled(&mut rules, PLURAL, "en", N, N);
    for ending in ["s", "\u{2019}s", "'s", "eren"] {
        rules.push(rule(PLURAL, ending, "", N, N));
    }
    for ending in ["je", "tje", "pje", "etje", "jes", "tjes", "pjes", "etjes"] {
        rules.push(rule(DIMINUTIVE, ending, "", N, N));
    }
    respelled(&mut rules, DECLENSION, "e", ADJ, ADJ);
    respelled(&mut rules, COMPARATIVE, "er", ADJ, ADJ);
    rules.push(rule(COMPARATIVE, "der", "", ADJ, ADJ));
    for ending in ["st", "ste"] {
        rules.push(rule(SUPERLATIVE, ending, "", ADJ, ADJ));
    }
    // Verb forms give the stem.
    rules.push(rule(PRESENT, "", "", V, STEM));
    rules.push(rule(PRESENT, "t", "", V, STEM));
    for ending in ["te", "ten", "de", "den"] {
        rules.push(rule(PAST, ending, "", V, STEM));
    }
    for ending in ["t", "d"] {
        rules.push(affix(PAST_PARTICIPLE, "ge", "", ending, "", V, STEM));
    }
    // The stem takes -en, its spelling restored: zit: zitten, loop: lopen, leef: leven.
    rules.push(rule("", "", "en", STEM, V));
    for consonant in CONSONANTS {
        rules.push(rule(
            "",
            consonant,
            leak(format!("{consonant}{consonant}en")),
            STEM,
            V,
        ));
    }
    for vowel in LONG_VOWELS {
        for consonant in CONSONANTS {
            let written = match consonant {
                "f" => "v",
                "s" => "z",
                other => other,
            };
            let stem = leak(format!("{vowel}{vowel}{consonant}"));
            rules.push(rule("", stem, leak(format!("{vowel}{written}en")), STEM, V));
        }
    }
    rules.push(rule("", "f", "ven", STEM, V));
    rules.push(rule("", "s", "zen", STEM, V));
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// Dutch respells a syllable several ways, so it keeps more candidates than most languages.
const MAX_CANDIDATES: usize = 128;

/// The forms `text` may be an inflection of (see `deinflect_bounded`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finds(text: &str, base: &str, class: u32) -> bool {
        deinflect(text)
            .iter()
            .any(|candidate| candidate.text == base && candidate.classes & class != 0)
    }

    #[test]
    fn dutch_words_lose_their_endings_with_their_spelling_restored() {
        for (text, base, class) in [
            ("boeken", "boek", N),
            ("katten", "kat", N),
            ("bomen", "boom", N),
            ("huizen", "huis", N),
            ("brieven", "brief", N),
            ("auto's", "auto", N),
            ("kinderen", "kind", N),
            ("huisje", "huis", N),
            ("grote", "groot", ADJ),
            ("dikke", "dik", ADJ),
            ("groter", "groot", ADJ),
            ("mooiste", "mooi", ADJ),
            ("werkt", "werken", V),
            ("werkte", "werken", V),
            ("woonden", "wonen", V),
            ("gewerkt", "werken", V),
            ("loopt", "lopen", V),
            ("leeft", "leven", V),
            ("leest", "lezen", V),
            ("zit", "zitten", V),
        ] {
            assert!(finds(text, base, class), "{text}: {:?}", deinflect(text));
        }
    }
}
