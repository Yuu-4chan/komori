// German deinflection rules adapted from Yomitan.
// Copyright (C) 2024-2026 Yomitan Authors (ext/js/language/de/german-transforms.js,
// https://github.com/yomidevs/yomitan at commit d3c54c1).
// Copyright (C) 2026 Yuu-4chan (the Rust translation and changes below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! The German deinflection rules: Yomitan's German transforms (nominalizations in -ung, -bar and
//! un- adjectives, past participles, zu-infinitives and nouns in -heit/-keit), translated to
//! Rust, followed by Komori's own regular verb tenses, present participles, adjective endings,
//! comparatives and superlatives, and noun plurals. A past participle's ge- and its ending are
//! two steps (`GE` between them, never a dictionary form). Yomitan's separated prefixes (fange …
//! an → anfangen) span words and are left out.

use std::sync::LazyLock;

use super::{
    deinflect_bounded, endings, named_classes, prefix, rule, Candidate, Rule, RuleSet,
    MAX_CANDIDATES, MAX_STEPS,
};

/// Weak verbs (`vw`).
pub(crate) const VW: u32 = 1;
/// Strong verbs (`vst`).
pub(crate) const VST: u32 = 1 << 1;
/// Verbs (`v`).
pub(crate) const V: u32 = VW | VST;
/// Nouns (`n`).
pub(crate) const N: u32 = 1 << 2;
/// Adjectives (`adj`).
pub(crate) const ADJ: u32 = 1 << 3;
/// A past participle with its ending replaced, before its ge- is removed (gemacht → gemachen →
/// machen), so a verb's own -t is never taken for a participle's.
const GE: u32 = 1 << 4;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(
        rules,
        &[("v", V), ("vw", VW), ("vst", VST), ("n", N), ("adj", ADJ)],
    )
}

const NOMINALIZATION: &str = "nominalization";
const BAR: &str = "-bar";
const NEGATIVE: &str = "negative";
const PAST_PARTICIPLE: &str = "past participle";
const ZU_INFINITIVE: &str = "zu-infinitive";
const HEIT: &str = "-heit";
const PRESENT: &str = "present";
const PAST: &str = "past";
const IMPERATIVE: &str = "imperative";
const PRESENT_PARTICIPLE: &str = "present participle";
const DECLENSION: &str = "declension";
const COMPARATIVE: &str = "comparative";
const SUPERLATIVE: &str = "superlative";
const PLURAL: &str = "plural";

/// The prefixes a verb separates from its stem (anfangen: fange … an).
const SEPARABLE_PREFIXES: &[&str] = &[
    "ab",
    "an",
    "auf",
    "aus",
    "auseinander",
    "bei",
    "da",
    "dabei",
    "dar",
    "daran",
    "dazwischen",
    "durch",
    "ein",
    "empor",
    "entgegen",
    "entlang",
    "entzwei",
    "fehl",
    "fern",
    "fest",
    "fort",
    "frei",
    "gegenüber",
    "gleich",
    "heim",
    "her",
    "herab",
    "heran",
    "herauf",
    "heraus",
    "herbei",
    "herein",
    "herüber",
    "herum",
    "herunter",
    "hervor",
    "hin",
    "hinab",
    "hinauf",
    "hinaus",
    "hinein",
    "hinterher",
    "hinunter",
    "hinweg",
    "hinzu",
    "hoch",
    "los",
    "mit",
    "nach",
    "nebenher",
    "nieder",
    "statt",
    "um",
    "vor",
    "voran",
    "voraus",
    "vorbei",
    "vorüber",
    "vorweg",
    "weg",
    "weiter",
    "wieder",
    "zu",
    "zurecht",
    "zurück",
    "zusammen",
];

/// Yomitan's rules, in its transform order.
static YOMITAN: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = vec![
        rule(NOMINALIZATION, "ung", "en", 0, V),
        rule(NOMINALIZATION, "lung", "eln", 0, V),
        rule(NOMINALIZATION, "rung", "rn", 0, V),
        rule(BAR, "bar", "en", ADJ, V),
        rule(BAR, "bar", "n", ADJ, V),
        prefix(NEGATIVE, "un", "", 0, ADJ),
        rule(PAST_PARTICIPLE, "t", "n", 0, GE),
        rule(PAST_PARTICIPLE, "t", "en", 0, GE),
        // Komori's: a strong verb's participle keeps -en (gesehen).
        rule(PAST_PARTICIPLE, "en", "en", 0, GE),
        prefix(PAST_PARTICIPLE, "ge", "", GE, V),
    ];
    for &separable in SEPARABLE_PREFIXES {
        let participle: &'static str = format!("{separable}ge").leak();
        rules.push(prefix(PAST_PARTICIPLE, participle, separable, GE, V));
    }
    for &separable in SEPARABLE_PREFIXES {
        let zu: &'static str = format!("{separable}zu").leak();
        rules.push(prefix(ZU_INFINITIVE, zu, separable, 0, V));
    }
    rules.extend([
        rule(HEIT, "heit", "", N, ADJ | N),
        rule(HEIT, "keit", "", N, ADJ | N),
    ]);
    rules
});

/// Komori's rules after Yomitan's.
static KOMORI: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = endings(
        PRESENT,
        "",
        &["e", "st", "t", "en", "est", "et"],
        "en",
        0,
        V,
    );
    rules.extend(endings(PRESENT, "", &["le", "elst", "elt"], "eln", 0, V));
    rules.extend(endings(PRESENT, "", &["re", "erst", "ert"], "ern", 0, V));
    rules.extend(endings(
        PAST,
        "",
        &["te", "test", "ten", "tet", "ete", "etest", "eten", "etet"],
        "en",
        0,
        V,
    ));
    rules.extend(endings(
        PAST,
        "",
        &["elte", "eltest", "elten", "eltet"],
        "eln",
        0,
        V,
    ));
    rules.extend(endings(
        PAST,
        "",
        &["erte", "ertest", "erten", "ertet"],
        "ern",
        0,
        V,
    ));
    rules.push(rule(IMPERATIVE, "", "en", 0, V));
    rules.extend(endings(
        PRESENT_PARTICIPLE,
        "end",
        &["", "e", "er", "es", "en", "em"],
        "en",
        0,
        V,
    ));
    rules.extend(endings(
        DECLENSION,
        "",
        &["e", "er", "es", "en", "em"],
        "",
        0,
        ADJ,
    ));
    rules.push(rule(COMPARATIVE, "er", "", ADJ, ADJ));
    rules.extend(endings(SUPERLATIVE, "", &["st", "est"], "", ADJ, ADJ));
    rules.extend(endings(PLURAL, "", &["e", "en", "n", "er", "s"], "", 0, N));
    rules.push(rule(PLURAL, "nen", "", 0, N));
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&YOMITAN, &KOMORI));

/// The forms `text` may be an inflection of (see `deinflect_bounded`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(cases: &[(&str, &str, &[&str])]) {
        for &(text, form, inflections) in cases {
            let candidates = deinflect(text);
            assert!(
                candidates
                    .iter()
                    .any(|candidate| candidate.text == form && candidate.inflections == inflections),
                "{text} → {form}: {:?}",
                candidates
                    .into_iter()
                    .map(|candidate| (candidate.text, candidate.inflections))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn inflected_forms_reach_their_dictionary_forms() {
        check(&[
            ("gemacht", "machen", &[PAST_PARTICIPLE, PAST_PARTICIPLE]),
            (
                "aufgemacht",
                "aufmachen",
                &[PAST_PARTICIPLE, PAST_PARTICIPLE],
            ),
            ("gesehen", "sehen", &[PAST_PARTICIPLE]),
            ("anzufangen", "anfangen", &[ZU_INFINITIVE]),
            ("Bildung", "Bilden", &[NOMINALIZATION]),
            ("machbar", "machen", &[BAR]),
            ("unklar", "klar", &[NEGATIVE]),
            ("Freiheit", "Frei", &[HEIT]),
            ("machst", "machen", &[PRESENT]),
            ("arbeitet", "arbeiten", &[PRESENT]),
            ("sammle", "sammeln", &[PRESENT]),
            ("machten", "machen", &[PAST]),
            ("arbeitete", "arbeiten", &[PAST]),
            ("mach", "machen", &[IMPERATIVE]),
            ("lachende", "lachen", &[PRESENT_PARTICIPLE]),
            ("schönes", "schön", &[DECLENSION]),
            ("schnellsten", "schnell", &[SUPERLATIVE, DECLENSION]),
            ("Kinder", "Kind", &[PLURAL]),
            ("Lehrerinnen", "Lehrerin", &[PLURAL]),
        ]);
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v"), V);
        assert_eq!(word_classes("vw n"), VW | N);
        assert_eq!(word_classes("verb"), 0);
    }
}
