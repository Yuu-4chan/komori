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
//! of verbs in -ω, -ώ/-άω and -ομαι. Regular past tenses come off in `past_tenses`, which moves the
//! accent back: the imperfect and aorist of -ω verbs with their augment (έγραφα, έγραψα, διάβασα,
//! έπαιξα, πλήρωσα → γράφω, διαβάζω, παίζω, πληρώνω), of -ώ verbs (αγαπούσα, αγάπησα, μπόρεσα →
//! αγαπώ, μπορώ) and of -ομαι verbs (ερχόμουν → έρχομαι). Irregular past tenses, passive aorists
//! and nouns' other declensions are left to the dictionaries' own form entries.

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

/// The forms `text` may be an inflection of (see `deinflect_bounded`), then the verbs it may be
/// a past tense of, directly or after ξανα- (`past_tenses`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    let mut candidates = deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES);
    let mut sources = vec![(text.to_owned(), Vec::new())];
    sources.extend(
        candidates
            .iter()
            .filter(|candidate| candidate.inflections == [AGAIN])
            .map(|candidate| (candidate.text.clone(), candidate.inflections.clone())),
    );
    for (source, outer) in sources {
        for verb in past_tenses(&source) {
            if candidates
                .iter()
                .any(|candidate| candidate.text == verb && candidate.classes == V)
            {
                continue;
            }
            let mut inflections = vec![PAST];
            inflections.extend(outer.iter().copied());
            candidates.push(Candidate {
                text: verb,
                classes: V,
                inflections,
            });
        }
    }
    candidates
}

const PAST: &str = "past";

/// Past endings, unaccented, and the verb ending each comes from: the active imperfect and
/// aorist, the -ώ verbs' imperfect in -ούσα, and the -ομαι verbs' imperfect.
const PAST_ENDINGS: &[(&[&str], &str)] = &[
    (&["α", "ες", "ε", "αμε", "ατε", "αν", "ανε"], "ω"),
    (
        &[
            "ουσα",
            "ουσες",
            "ουσε",
            "ουσαμε",
            "ουσατε",
            "ουσαν",
            "ουσανε",
        ],
        "ώ",
    ),
    (
        &[
            "ομουν",
            "ομουνα",
            "οσουν",
            "οσουνα",
            "οταν",
            "οτανε",
            "ομασταν",
            "οσασταν",
            "οσαστε",
            "ονταν",
            "οντουσαν",
        ],
        "ομαι",
    ),
];

/// An aorist stem's last letters and the present stem's they may come from (έγραψα: γράφω).
const AORIST_STEMS: &[(&str, &[&str])] = &[
    ("ψ", &["φ", "π", "β", "πτ", "φτ", "φν", "υ"]),
    ("ξ", &["κ", "γ", "χ", "σσ", "ζ", "χν", "γγ"]),
    ("σ", &["ζ", "θ", "δ", "ν", ""]),
];

/// A letter without its accent (a dialytika with an accent keeps the dialytika).
fn unaccented(letter: char) -> char {
    match letter {
        'ά' => 'α',
        'έ' => 'ε',
        'ή' => 'η',
        'ί' => 'ι',
        'ό' => 'ο',
        'ύ' => 'υ',
        'ώ' => 'ω',
        'ΐ' => 'ϊ',
        'ΰ' => 'ϋ',
        other => other,
    }
}

/// `stem` with an accent on its last vowel, or None without one.
fn accented_last_vowel(stem: &str) -> Option<String> {
    let mut letters: Vec<char> = stem.chars().collect();
    let last = letters
        .iter()
        .rposition(|letter| "αεηιουω".contains(*letter))?;
    letters[last] = match letters[last] {
        'α' => 'ά',
        'ε' => 'έ',
        'η' => 'ή',
        'ι' => 'ί',
        'ο' => 'ό',
        'υ' => 'ύ',
        _ => 'ώ',
    };
    Some(letters.into_iter().collect())
}

/// The verbs `text` may be a regular past tense of. Accents are ignored and the verb's is put
/// back on its stem's last vowel (γράφω, διαβάζω, έρχομαι) or its contracted ending (αγαπώ); an
/// augment ε- or η- may be dropped (έγραφα, ήθελα), and an aorist's stem gives the present stems
/// it may come from, including -ώ verbs' -ησ-, -εσ- and -ασ- (αγάπησα, μπόρεσα, γέλασα).
fn past_tenses(text: &str) -> Vec<String> {
    let word: String = text.chars().map(unaccented).collect();
    let mut verbs: Vec<String> = Vec::new();
    let mut add = |verb: String| {
        if !verbs.contains(&verb) {
            verbs.push(verb);
        }
    };
    for &(endings, base) in PAST_ENDINGS {
        for ending in endings {
            let Some(stem) = word.strip_suffix(ending) else {
                continue;
            };
            if stem.chars().count() < 2 {
                continue;
            }
            let mut stems = vec![stem.to_owned()];
            for augment in ['ε', 'η'] {
                if let Some(rest) = stem.strip_prefix(augment) {
                    if rest.chars().count() >= 2 {
                        stems.push(rest.to_owned());
                    }
                }
            }
            for stem in stems {
                if base == "ώ" {
                    contracted(&stem, &mut add);
                    continue;
                }
                let mut presents = vec![stem.clone()];
                if base == "ω" {
                    for &(aorist, present_endings) in AORIST_STEMS {
                        if let Some(root) = stem.strip_suffix(aorist) {
                            for present in present_endings {
                                presents.push(format!("{root}{present}"));
                            }
                        }
                    }
                    // αγάπησα: αγαπώ, αγαπάω; μπόρεσα: μπορώ; γέλασα: γελώ, γελάω.
                    for vowel in ["ησ", "εσ", "ασ"] {
                        if let Some(root) = stem.strip_suffix(vowel) {
                            if root.chars().count() >= 2 {
                                contracted(root, &mut add);
                            }
                        }
                    }
                }
                for present in presents {
                    if let Some(verb) = accented_last_vowel(&present) {
                        add(format!("{verb}{base}"));
                    }
                }
            }
        }
    }
    verbs
}

/// A contracted verb's two dictionary forms from its stem: αγαπ gives αγαπώ and αγαπάω.
fn contracted(stem: &str, add: &mut impl FnMut(String)) {
    add(format!("{stem}ώ"));
    add(format!("{stem}άω"));
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

    #[test]
    fn regular_past_tenses_give_their_verb_with_its_accent_moved_back() {
        for (text, base) in [
            ("έγραφα", "γράφω"),
            ("έγραψα", "γράφω"),
            ("γράψαμε", "γράφω"),
            ("διάβασα", "διαβάζω"),
            ("διαβάζαμε", "διαβάζω"),
            ("έπαιξε", "παίζω"),
            ("άκουσα", "ακούω"),
            ("πλήρωσαν", "πληρώνω"),
            ("ήθελα", "θέλω"),
            ("αγαπούσα", "αγαπώ"),
            ("αγάπησες", "αγαπώ"),
            ("αγάπησε", "αγαπάω"),
            ("μπόρεσα", "μπορώ"),
            ("ερχόμουν", "έρχομαι"),
            ("ξανάγραψα", "γράφω"),
            ("δούλεψα", "δουλεύω"),
        ] {
            assert!(finds(text, base, V), "{text}: {:?}", deinflect(text));
        }
        let names = deinflect("ξανάγραψα")
            .into_iter()
            .find(|candidate| candidate.text == "γράφω")
            .unwrap()
            .inflections;
        assert_eq!(names, [PAST, AGAIN]);
    }
}
