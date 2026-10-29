// English deinflection rules adapted from Yomitan.
// Copyright (C) 2024-2026 Yomitan Authors (ext/js/language/en/english-transforms.js,
// https://github.com/yomidevs/yomitan at commit d3c54c1).
// Copyright (C) 2026 Yuu-4chan (the Rust translation and changes below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! The English deinflection rules adapted from Yomitan's English transforms: its rule table and
//! word classes, translated to Rust. Suffix rules replace an ending (walked → walk), prefix rules
//! a beginning (unhappy → happy, will go → go), and a phrasal verb's past, -ing and third person
//! rules the ending of its first word when a particle or preposition follows it (looked up → look
//! up); the interposed object rule removes the words between a verb and its particle (look it up →
//! look up). Irregular forms (went, children) are left to the dictionaries' own form entries.
//!
//! Komori's table differs from Yomitan's in one way: a phrasal rule's next word and an interposed
//! object's particle must be whole words (gave to, not gave tom).

use std::sync::LazyLock;

use super::{
    deinflect_bounded, first_word_before, interposed_words, prefix, rule, Candidate, Rule, RuleSet,
    MAX_CANDIDATES, MAX_STEPS,
};

/// Verbs (`v`) and phrasal verbs (`v_phr`), which share their class as in Yomitan, where a phrasal
/// verb is a verb's only subclass.
pub(crate) const V: u32 = 1;
/// Plural nouns (`np`).
pub(crate) const NP: u32 = 1 << 1;
/// Singular nouns (`ns`).
pub(crate) const NS: u32 = 1 << 2;
/// Nouns (`n`).
pub(crate) const N: u32 = NP | NS;
/// Adjectives (`adj`).
pub(crate) const ADJ: u32 = 1 << 3;
/// Adverbs (`adv`).
pub(crate) const ADV: u32 = 1 << 4;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ | ADV;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    rules
        .split_whitespace()
        .map(|rule| match rule {
            "v" | "v_phr" => V,
            "n" => N,
            "np" => NP,
            "ns" => NS,
            "adj" => ADJ,
            "adv" => ADV,
            _ => 0,
        })
        .fold(0, |classes, class| classes | class)
}

const PLURAL: &str = "plural";
const POSSESSIVE: &str = "possessive";
const PAST: &str = "past";
const ING: &str = "-ing";
const THIRD_PERSON: &str = "third person singular";
const INTERPOSED_OBJECT: &str = "interposed object";
const ARCHAIC: &str = "archaic";
const ADVERB: &str = "adverb";
const COMPARATIVE: &str = "comparative";
const SUPERLATIVE: &str = "superlative";
const DROPPED_G: &str = "dropped g";
const Y: &str = "-y";
const UN: &str = "un-";
const GOING_TO: &str = "going-to future";
const WILL: &str = "will future";
const NEGATIVE_IMPERATIVE: &str = "negative imperative";
const ABLE: &str = "-able";

/// Particles that can end a phrasal verb.
const PARTICLES: &[&str] = &[
    "aboard",
    "about",
    "above",
    "across",
    "ahead",
    "alongside",
    "apart",
    "around",
    "aside",
    "astray",
    "away",
    "back",
    "before",
    "behind",
    "below",
    "beneath",
    "besides",
    "between",
    "beyond",
    "by",
    "close",
    "down",
    "east",
    "west",
    "north",
    "south",
    "eastward",
    "westward",
    "northward",
    "southward",
    "forward",
    "backward",
    "backwards",
    "forwards",
    "home",
    "in",
    "inside",
    "instead",
    "near",
    "off",
    "on",
    "opposite",
    "out",
    "outside",
    "over",
    "overhead",
    "past",
    "round",
    "since",
    "through",
    "throughout",
    "together",
    "under",
    "underneath",
    "up",
    "within",
    "without",
];

/// The particles and the prepositions that can follow a phrasal verb's verb.
const PHRASAL_WORDS: &[&str] = &[
    "aboard",
    "about",
    "above",
    "across",
    "ahead",
    "alongside",
    "apart",
    "around",
    "aside",
    "astray",
    "away",
    "back",
    "before",
    "behind",
    "below",
    "beneath",
    "besides",
    "between",
    "beyond",
    "by",
    "close",
    "down",
    "east",
    "west",
    "north",
    "south",
    "eastward",
    "westward",
    "northward",
    "southward",
    "forward",
    "backward",
    "backwards",
    "forwards",
    "home",
    "in",
    "inside",
    "instead",
    "near",
    "off",
    "on",
    "opposite",
    "out",
    "outside",
    "over",
    "overhead",
    "past",
    "round",
    "since",
    "through",
    "throughout",
    "together",
    "under",
    "underneath",
    "up",
    "within",
    "without",
    "aback",
    "after",
    "against",
    "along",
    "among",
    "as",
    "at",
    "even",
    "for",
    "forth",
    "from",
    "into",
    "of",
    "onto",
    "open",
    "to",
    "toward",
    "towards",
    "upon",
    "way",
    "with",
];

/// The rules doubling each of `consonants` before `suffix` (stopped → stop).
fn doubled(
    name: &'static str,
    consonants: &str,
    suffix: &str,
    applies_to: u32,
    gives: u32,
) -> Vec<Rule> {
    consonants
        .chars()
        .map(|consonant| {
            let inflected: &'static str = format!("{consonant}{consonant}{suffix}").leak();
            let base: &'static str = consonant.to_string().leak();
            rule(name, inflected, base, applies_to, gives)
        })
        .collect()
}

fn past() -> Vec<Rule> {
    let mut rules = vec![
        rule(PAST, "ed", "", V, V),
        rule(PAST, "ed", "e", V, V),
        rule(PAST, "ied", "y", V, V),
        rule(PAST, "cked", "c", V, V),
    ];
    rules.extend(doubled(PAST, "bdgklmnprstz", "ed", V, V));
    rules.extend([
        rule(PAST, "laid", "lay", V, V),
        rule(PAST, "paid", "pay", V, V),
        rule(PAST, "said", "say", V, V),
    ]);
    rules
}

fn ing() -> Vec<Rule> {
    let mut rules = vec![
        rule(ING, "ing", "", V, V),
        rule(ING, "ing", "e", V, V),
        rule(ING, "ying", "ie", V, V),
        rule(ING, "cking", "c", V, V),
    ];
    rules.extend(doubled(ING, "bdgklmnprstz", "ing", V, V));
    rules
}

fn third_person() -> Vec<Rule> {
    vec![
        rule(THIRD_PERSON, "s", "", V, V),
        rule(THIRD_PERSON, "es", "", V, V),
        rule(THIRD_PERSON, "ies", "y", V, V),
    ]
}

/// `suffixes` followed by their phrasal verb forms (looked up → look up).
fn with_phrasal(suffixes: Vec<Rule>) -> Vec<Rule> {
    let phrasal: Vec<Rule> = suffixes
        .iter()
        .map(|&suffix| first_word_before(suffix, PHRASAL_WORDS, V))
        .collect();
    suffixes.into_iter().chain(phrasal).collect()
}

/// The rules in Yomitan's transform order.
static TABLE: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = vec![
        rule(PLURAL, "s", "", NP, NS),
        rule(PLURAL, "es", "", NP, NS),
        rule(PLURAL, "ies", "y", NP, NS),
        rule(PLURAL, "ves", "fe", NP, NS),
        rule(PLURAL, "ves", "f", NP, NS),
        rule(POSSESSIVE, "'s", "", N, N),
        rule(POSSESSIVE, "s'", "s", N, N),
    ];
    rules.extend(with_phrasal(past()));
    rules.extend(with_phrasal(ing()));
    rules.extend(with_phrasal(third_person()));
    rules.extend([
        interposed_words(INTERPOSED_OBJECT, PHRASAL_WORDS, PARTICLES, 0, V),
        rule(ARCHAIC, "'d", "ed", V, V),
        rule(ADVERB, "ly", "", ADV, ADJ),
        rule(ADVERB, "ily", "y", ADV, ADJ),
        rule(ADVERB, "ly", "le", ADV, ADJ),
        rule(COMPARATIVE, "er", "", ADJ, ADJ),
        rule(COMPARATIVE, "er", "e", ADJ, ADJ),
        rule(COMPARATIVE, "ier", "y", ADJ, ADJ),
    ]);
    rules.extend(doubled(COMPARATIVE, "bdgmnt", "er", ADJ, ADJ));
    rules.extend([
        rule(SUPERLATIVE, "est", "", ADJ, ADJ),
        rule(SUPERLATIVE, "est", "e", ADJ, ADJ),
        rule(SUPERLATIVE, "iest", "y", ADJ, ADJ),
    ]);
    rules.extend(doubled(SUPERLATIVE, "bdgmnt", "est", ADJ, ADJ));
    rules.extend([
        rule(DROPPED_G, "in'", "ing", V, V),
        rule(Y, "y", "", ADJ, N | V),
        rule(Y, "y", "e", ADJ, N | V),
    ]);
    rules.extend(doubled(Y, "glmnprst", "y", 0, N | V));
    rules.extend([
        prefix(UN, "un", "", ADJ | ADV | V, ADJ | ADV | V),
        prefix(GOING_TO, "going to ", "", V, V),
        prefix(WILL, "will ", "", V, V),
        prefix(NEGATIVE_IMPERATIVE, "don't ", "", V, V),
        prefix(NEGATIVE_IMPERATIVE, "do not ", "", V, V),
        rule(ABLE, "able", "", ADJ, V),
        rule(ABLE, "able", "e", ADJ, V),
        rule(ABLE, "iable", "y", ADJ, V),
    ]);
    rules.extend(doubled(ABLE, "bdgklmnprstz", "able", ADJ, V));
    rules
});

/// The English rules, all of them first rules.
static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&TABLE, &[]));

/// The forms `text` may be an inflection of (see `deinflect_bounded`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dictionary-form candidates as (text, classes, inflections).
    fn forms(text: &str) -> Vec<(String, u32, Vec<&'static str>)> {
        deinflect(text)
            .into_iter()
            .filter(|candidate| candidate.classes & DICTIONARY_FORMS != 0)
            .map(|candidate| (candidate.text, candidate.classes, candidate.inflections))
            .collect()
    }

    fn has(text: &str, form: &str, classes: u32, inflections: &[&str]) -> bool {
        forms(text).contains(&(form.to_owned(), classes, inflections.to_vec()))
    }

    #[test]
    fn each_suffix_reaches_its_dictionary_form() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            ("cats", "cat", NS, &[PLURAL]),
            ("boxes", "box", NS, &[PLURAL]),
            ("cities", "city", NS, &[PLURAL]),
            ("knives", "knife", NS, &[PLURAL]),
            ("wolves", "wolf", NS, &[PLURAL]),
            ("cat's", "cat", N, &[POSSESSIVE]),
            ("cats'", "cats", N, &[POSSESSIVE]),
            ("cats'", "cat", NS, &[PLURAL, POSSESSIVE]),
            ("walked", "walk", V, &[PAST]),
            ("hoped", "hope", V, &[PAST]),
            ("tried", "try", V, &[PAST]),
            ("frolicked", "frolic", V, &[PAST]),
            ("stopped", "stop", V, &[PAST]),
            ("laid", "lay", V, &[PAST]),
            ("paid", "pay", V, &[PAST]),
            ("said", "say", V, &[PAST]),
            ("walking", "walk", V, &[ING]),
            ("driving", "drive", V, &[ING]),
            ("lying", "lie", V, &[ING]),
            ("panicking", "panic", V, &[ING]),
            ("running", "run", V, &[ING]),
            ("walks", "walk", V, &[THIRD_PERSON]),
            ("teaches", "teach", V, &[THIRD_PERSON]),
            ("studies", "study", V, &[THIRD_PERSON]),
            ("call'd", "call", V, &[PAST, ARCHAIC]),
            ("quickly", "quick", ADJ, &[ADVERB]),
            ("happily", "happy", ADJ, &[ADVERB]),
            ("humbly", "humble", ADJ, &[ADVERB]),
            ("faster", "fast", ADJ, &[COMPARATIVE]),
            ("nicer", "nice", ADJ, &[COMPARATIVE]),
            ("happier", "happy", ADJ, &[COMPARATIVE]),
            ("bigger", "big", ADJ, &[COMPARATIVE]),
            ("fastest", "fast", ADJ, &[SUPERLATIVE]),
            ("nicest", "nice", ADJ, &[SUPERLATIVE]),
            ("happiest", "happy", ADJ, &[SUPERLATIVE]),
            ("biggest", "big", ADJ, &[SUPERLATIVE]),
            ("walkin'", "walk", V, &[ING, DROPPED_G]),
            ("dirty", "dirt", N | V, &[Y]),
            ("hazy", "haze", N | V, &[Y]),
            ("baggy", "bag", N | V, &[Y]),
            ("readable", "read", V, &[ABLE]),
            ("usable", "use", V, &[ABLE]),
            ("reliable", "rely", V, &[ABLE]),
            ("forgettable", "forget", V, &[ABLE]),
        ];
        for &(text, form, classes, inflections) in cases {
            assert!(
                has(text, form, classes, inflections),
                "{text} → {form}: {:?}",
                forms(text)
            );
        }
    }

    #[test]
    fn prefixes_reach_their_dictionary_forms() {
        assert!(has("unhappy", "happy", ADJ | ADV | V, &[UN]));
        assert!(has("will go", "go", V, &[WILL]));
        assert!(has("going to go", "go", V, &[GOING_TO]));
        assert!(has("don't go", "go", V, &[NEGATIVE_IMPERATIVE]));
        assert!(has("do not go", "go", V, &[NEGATIVE_IMPERATIVE]));
        // A prefix chains with a suffix, either way round.
        assert!(has("unlocked", "lock", V, &[PAST, UN]));
        assert!(has("unlocked", "lock", ADJ | ADV | V, &[UN, PAST]));
    }

    #[test]
    fn phrasal_verbs_reach_their_dictionary_forms() {
        assert!(has("looked up", "look up", V, &[PAST]));
        assert!(has("giving up", "give up", V, &[ING]));
        assert!(has("gets by", "get by", V, &[THIRD_PERSON]));
        assert!(has("tried on", "try on", V, &[PAST]));
        // The next word must be a particle or preposition, and a whole word.
        assert!(!forms("looked tom")
            .iter()
            .any(|(text, ..)| text == "look tom"));
        assert!(!forms("looked upper")
            .iter()
            .any(|(text, ..)| text == "look upper"));
        // The rest of the text stays.
        assert!(has("looked up words", "look up words", V, &[PAST]));
    }

    #[test]
    fn an_interposed_object_leaves_the_phrasal_verb() {
        assert!(has("look it up", "look up", V, &[INTERPOSED_OBJECT]));
        assert!(has(
            "looked it up",
            "look up",
            V,
            &[PAST, INTERPOSED_OBJECT]
        ));
        assert!(has(
            "turn the lights off",
            "turn off",
            V,
            &[INTERPOSED_OBJECT]
        ));
        // Only the searched text takes it, and only before a particle with words between.
        assert!(!forms("look up")
            .iter()
            .any(|(_, _, names)| names.contains(&INTERPOSED_OBJECT)));
        assert!(!forms("look it to")
            .iter()
            .any(|(text, ..)| text == "look to"));
        // A preposition among the words ends them: no particle follows the verb directly.
        assert!(!forms("look at it up")
            .iter()
            .any(|(text, ..)| text == "look up"));
    }

    #[test]
    fn rules_apply_only_to_their_word_classes() {
        // A comparative's base is an adjective, never a verb, and a possessive noun is never past.
        assert!(has("walker", "walk", ADJ, &[COMPARATIVE]));
        assert!(!forms("walker")
            .iter()
            .any(|(text, classes, _)| text == "walk" && classes & V != 0));
        assert!(!forms("walked's").iter().any(|(text, ..)| text == "walk"));
        // A possessive plural is still a plural, and an adverb's adjective takes the comparative.
        assert!(has("cats's", "cat", NS, &[PLURAL, POSSESSIVE]));
        assert!(has("happierly", "happy", ADJ, &[COMPARATIVE, ADVERB]));
        assert!(forms("").is_empty());
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v"), V);
        assert_eq!(word_classes("v_phr"), V);
        assert_eq!(word_classes("n"), NP | NS);
        assert_eq!(word_classes(" adj  adv "), ADJ | ADV);
        assert_eq!(word_classes("np"), NP);
        assert_eq!(word_classes("vt prep"), 0);
        assert_eq!(word_classes(""), 0);
    }
}
