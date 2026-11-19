// Greek deinflection rules adapted from Yomitan.
// Copyright (C) 2024-2026 Yomitan Authors (ext/js/language/el/modern-greek-transforms.js,
// https://github.com/yomidevs/yomitan at commit d3c54c1).
// Copyright (C) 2026 Yuu-4chan (the Rust translation and the rules below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! The Greek deinflection rules: Yomitan's ξανα- (again) prefix, then Komori's own rules for an
//! adjective's or -ος noun's endings (μεγαλύτερο → μεγαλύτερος) and the regular present endings
//! of verbs in -ω, -ώ/-άω and -ομαι. Past tenses change a verb's stem and accent, and are left to
//! the dictionaries' own form entries, as are nouns' other declensions.

use std::sync::LazyLock;

use super::{deinflect_bounded, prefix, rule, Candidate, Rule, RuleSet, MAX_CANDIDATES, MAX_STEPS};

/// Verbs, in the first person singular present.
pub(crate) const V: u32 = 1;
/// Adjectives and nouns in -ος, in the masculine nominative singular.
pub(crate) const ADJ: u32 = 1 << 1;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    super::named_classes(rules, &[("v", V), ("adj", ADJ), ("n", ADJ)])
}

const AGAIN: &str = "ξανα-";
const DECLENSION: &str = "declension";
const PRESENT: &str = "present";

/// Endings of -ος words, unstressed and stressed, and the ending they come from.
const DECLENSIONS: &[(&[&str], &str)] = &[
    (
        &["ο", "η", "α", "ου", "ης", "ων", "οι", "ες", "ους", "ε"],
        "ος",
    ),
    (
        &["ό", "ή", "ά", "ού", "ής", "ών", "οί", "ές", "ούς", "έ"],
        "ός",
    ),
];

/// Present endings and the first person singular they come from.
const PRESENTS: &[(&[&str], &str)] = &[
    (&["εις", "ει", "ουμε", "ούμε", "ετε", "ουν", "ουνε"], "ω"),
    (&["άς", "άει", "άμε", "άτε", "άνε", "ούν", "ούνε"], "ώ"),
    (&["άς", "άει", "άμε", "άτε", "άνε", "ώ"], "άω"),
    (&["είς", "εί", "ούμε", "είτε", "ούν"], "ώ"),
    (
        &["εσαι", "εται", "όμαστε", "ομαστε", "εστε", "ονται"],
        "ομαι",
    ),
];

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = vec![
        // ξαναρώτησε: ρώτησε; ξανανθίζω: ανθίζω; ξανάβαλε: έβαλε; ξανάρχισε: άρχισε.
        prefix(AGAIN, "ξανάπα", "είπα", V, V),
        prefix(AGAIN, "ξανα", "", V, V),
        prefix(AGAIN, "ξανα", "α", V, V),
        prefix(AGAIN, "ξανά", "έ", V, V),
        prefix(AGAIN, "ξανά", "ά", V, V),
    ];
    for &(endings, base) in DECLENSIONS {
        for ending in endings {
            rules.push(rule(DECLENSION, ending, base, ADJ, ADJ));
        }
    }
    for &(endings, base) in PRESENTS {
        for ending in endings {
            rules.push(rule(PRESENT, ending, base, V, V));
        }
    }
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

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
    fn greek_words_lose_their_endings_and_xana() {
        for (text, base, class) in [
            ("μεγαλύτερο", "μεγαλύτερος", ADJ),
            ("καλή", "καλός", ADJ),
            ("ωραίες", "ωραίος", ADJ),
            ("γράφεις", "γράφω", V),
            ("γράφουμε", "γράφω", V),
            ("αγαπάς", "αγαπώ", V),
            ("αγαπάει", "αγαπάω", V),
            ("μπορείτε", "μπορώ", V),
            ("έρχεται", "έρχομαι", V),
            ("ξαναρώτησε", "ρώτησε", V),
            ("ξανάβαλε", "έβαλε", V),
            ("ξαναγράφεις", "γράφω", V),
        ] {
            assert!(finds(text, base, class), "{text}: {:?}", deinflect(text));
        }
    }
}
