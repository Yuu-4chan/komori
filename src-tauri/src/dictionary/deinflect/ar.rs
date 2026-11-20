// Arabic deinflection rules adapted from Yomitan.
// Copyright (C) 2025-2026 Yomitan Authors (ext/js/language/ar/arabic-transforms.js,
// https://github.com/yomidevs/yomitan at commit d3c54c1).
// Copyright (C) 2026 Yuu-4chan (the Rust translation and changes below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! The Arabic deinflection rules: Yomitan's Arabic transforms translated to Rust. Nouns lose the
//! particles joined before them (و ف ب ك ل and the article ال) and their suffixes (possessive
//! pronouns, the feminine ة, duals and sound plurals); perfect verbs lose their person suffixes
//! and object pronouns; imperfect verbs lose their person prefix and suffix together, with the
//! particles and object pronouns joined to them; imperatives lose theirs. Rules work on the bare
//! spelling imports keep (see `language::without_arabic_marks`). Each prefix's name is the
//! prefix itself.

use std::sync::LazyLock;

use super::{affix, deinflect_bounded, named_classes, Candidate, Rule, RuleSet, MAX_STEPS};

/// Nouns (`n`).
pub(crate) const N: u32 = 1;
const N_WA: u32 = 1 << 1;
const N_BI: u32 = 1 << 2;
const N_KA: u32 = 1 << 3;
const N_LI: u32 = 1 << 4;
const N_AL: u32 = 1 << 5;
const N_BI_AL: u32 = 1 << 6;
const N_KA_AL: u32 = 1 << 7;
const N_LIL: u32 = 1 << 8;
const N_LI_AL: u32 = 1 << 9;
const N_S: u32 = 1 << 10;
/// Perfect verbs, the dictionary form of verbs (`v`).
pub(crate) const PV: u32 = 1 << 11;
const PV_P: u32 = 1 << 12;
const PV_S: u32 = 1 << 13;
const IV: u32 = 1 << 14;
const IV_P: u32 = 1 << 15;
const CV: u32 = 1 << 16;
const CV_P: u32 = 1 << 17;
const CV_S: u32 = 1 << 18;
/// A noun with a prefix only.
const N_P: u32 = N_WA | N_BI | N_KA | N_LI | N_AL | N_BI_AL | N_KA_AL | N_LIL | N_LI_AL;
const N_INDEF: u32 = N_WA | N_BI | N_KA | N_LI;
const N_NOM: u32 = N_WA | N_LI | N_AL;
const N_NOM_INDEF: u32 = N_WA | N_LI;
/// Verbs: dictionaries name perfect, imperfect and imperative forms alike `v`.
const V: u32 = PV | IV | CV;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = N | V;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("n", N), ("v", V)])
}

const POSSESSIVE: &str = "possessive";
const FEMININE: &str = "feminine";
const PLURAL: &str = "plural";
const CASE: &str = "case";
const PAST: &str = "past";
const PRESENT: &str = "present";
const IMPERATIVE: &str = "imperative";

const OBJECT_1ST: &[&str] = &["ني", "نا"];
const OBJECT_2ND: &[&str] = &["ك", "كما", "كم", "كن"];
const OBJECT_3RD: &[&str] = &["ه", "ها", "هما", "هم", "هن"];
const NON_ASSIMILATING: &[&str] = &["نا", "ك", "كما", "كم", "كن", "ه", "ها", "هما", "هم", "هن"];

fn leak(text: String) -> &'static str {
    text.leak()
}

fn objects() -> impl Iterator<Item = &'static str> {
    OBJECT_1ST
        .iter()
        .chain(OBJECT_2ND)
        .chain(OBJECT_3RD)
        .copied()
}

fn possessives() -> impl Iterator<Item = &'static str> {
    std::iter::once("ي").chain(NON_ASSIMILATING.iter().copied())
}

/// A prefix rule, named by its prefix.
fn prefixed(prefix: &'static str, base: &'static str, applies_to: u32, gives: u32) -> Rule {
    affix(
        leak(format!("{prefix}-")),
        prefix,
        base,
        "",
        "",
        applies_to,
        gives,
    )
}

fn suffixed(
    name: &'static str,
    suffix: String,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    affix(name, "", "", leak(suffix), base, applies_to, gives)
}

/// A suffix for each of `pronouns` after `before`.
fn suffixes<'a>(
    name: &'static str,
    before: &'a str,
    pronouns: impl IntoIterator<Item = &'a str>,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Vec<Rule> {
    pronouns
        .into_iter()
        .map(|pronoun| suffixed(name, format!("{before}{pronoun}"), base, applies_to, gives))
        .collect()
}

#[derive(Clone, Copy)]
struct Imperfect {
    /// The suffix before an object pronoun, when it differs from the bare suffix.
    attached: Option<&'static str>,
    first: bool,
    second: bool,
    /// Whether the particle ل joins this form.
    li: bool,
    /// Letters the stem does not end with.
    not_last: &'static str,
}

const IMPERFECT: Imperfect = Imperfect {
    attached: None,
    first: true,
    second: true,
    li: true,
    not_last: "",
};

/// An imperfect verb's person prefix and suffix, with the particles before it and the object
/// pronouns after it; a form with no prefix left is also tried with أ and ا (forms IV and VII
/// to XV).
fn imperfect(
    rules: &mut Vec<Rule>,
    prefix: &str,
    base_prefix: &'static str,
    suffix: &'static str,
    base_suffix: &'static str,
    options: Imperfect,
) {
    let particles: &[&str] = if options.li {
        &["", "و", "ف", "س", "وس", "فس", "ل", "ول", "فل"]
    } else {
        &["", "و", "ف", "س", "وس", "فس"]
    };
    let attached = options.attached.unwrap_or(suffix);
    let pronouns = OBJECT_1ST
        .iter()
        .filter(|_| options.first)
        .chain(OBJECT_2ND.iter().filter(|_| options.second))
        .chain(OBJECT_3RD)
        .map(|pronoun| leak(format!("{attached}{pronoun}")));
    let suffixes: Vec<&'static str> = std::iter::once(suffix).chain(pronouns).collect();
    for particle in particles {
        let inflected = leak(format!("{particle}{prefix}"));
        for &ending in &suffixes {
            rules.push(
                affix(
                    PRESENT,
                    inflected,
                    base_prefix,
                    ending,
                    base_suffix,
                    IV_P,
                    IV,
                )
                .guarded("", options.not_last),
            );
        }
    }
    if base_prefix.is_empty() {
        for base in ["أ", "ا"] {
            imperfect(rules, prefix, base, suffix, base_suffix, options);
        }
    }
}

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    // Particles before a noun.
    for (class, prefixes, base) in [
        (N_WA, &["و", "ف"][..], ""),
        (N_BI, &["ب", "وب", "فب"][..], ""),
        (N_KA, &["ك", "وك", "فك"][..], ""),
        (N_LI, &["ل", "ول", "فل"][..], ""),
        (N_AL, &["ال", "وال", "فال"][..], ""),
        (N_BI_AL, &["بال", "وبال", "فبال"][..], ""),
        (N_KA_AL, &["كال", "وكال", "فكال"][..], ""),
    ] {
        for prefix in prefixes {
            rules.push(prefixed(prefix, base, class, N));
        }
    }
    for prefix in ["لل", "ولل", "فلل"] {
        // for/to + the: لل before a word not starting with ل, which assimilates it.
        rules.push(prefixed(prefix, "", N_LIL, N).guarded("ل", ""));
        rules.push(prefixed(prefix, "ل", N_LI_AL, N));
    }
    // Noun suffixes.
    let n = N_INDEF | N;
    rules.extend(suffixes(
        POSSESSIVE,
        "",
        NON_ASSIMILATING.iter().copied(),
        "",
        N_S,
        n,
    ));
    rules.push(affix(POSSESSIVE, "", "", "ي", "", N_S, n).guarded("", "ي"));
    rules.push(suffixed(FEMININE, "ة".into(), "", N_S, N_P | N));
    for base in ["", "ة"] {
        rules.extend(suffixes(POSSESSIVE, "ت", possessives(), base, N_S, n));
    }
    for suffix in ["ا", "اً", "ًا"] {
        rules.push(suffixed(CASE, suffix.into(), "", N_S, N_WA | N));
    }
    // Duals.
    rules.push(suffixed("-ان", "ان".into(), "", N_S, N_NOM | N));
    rules.push(suffixed("-ان", "آن".into(), "أ", N_S, N_NOM | N));
    rules.push(suffixed("-ا", "ا".into(), "", N_S, N_NOM_INDEF | N));
    rules.push(suffixed("-ا", "آ".into(), "أ", N_S, N_NOM_INDEF | N));
    rules.extend(suffixes("-ا", "ا", possessives(), "", N_S, N_NOM_INDEF | N));
    rules.extend(suffixes(
        "-ا",
        "آ",
        possessives(),
        "أ",
        N_S,
        N_NOM_INDEF | N,
    ));
    rules.push(suffixed("-ين", "ين".into(), "", N_S, N_P | N));
    rules.push(suffixed("-ي", "ي".into(), "", N_S, n));
    rules.extend(suffixes(
        "-ي",
        "ي",
        NON_ASSIMILATING.iter().copied(),
        "",
        N_S,
        n,
    ));
    for base in ["", "ة"] {
        rules.push(suffixed("-تان", "تان".into(), base, N_S, N_NOM | N));
        rules.push(suffixed("-تا", "تا".into(), base, N_S, N_NOM_INDEF | N));
        rules.extend(suffixes(
            "-تا",
            "تا",
            possessives(),
            base,
            N_S,
            N_NOM_INDEF | N,
        ));
        rules.push(suffixed("-تين", "تين".into(), base, N_S, N_P | N));
        rules.push(suffixed("-تي", "تي".into(), base, N_S, n));
        rules.extend(suffixes(
            "-تي",
            "تي",
            NON_ASSIMILATING.iter().copied(),
            base,
            N_S,
            n,
        ));
    }
    // Sound plurals.
    for (suffix, base) in [("ات", ""), ("ات", "ة"), ("آت", "أ"), ("آت", "أة")] {
        rules.push(suffixed(PLURAL, suffix.into(), base, N_S, N_P | N));
        rules.extend(suffixes(PLURAL, suffix, possessives(), base, N_S, n));
    }
    rules.push(suffixed(PLURAL, "ون".into(), "", N_S, N_NOM | N));
    rules.push(suffixed(PLURAL, "و".into(), "", N_S, N_NOM_INDEF | N));
    rules.extend(suffixes(
        PLURAL,
        "و",
        NON_ASSIMILATING.iter().copied(),
        "",
        N_S,
        N_NOM_INDEF | N,
    ));
    // Perfect verbs: particles, then person suffixes and object pronouns.
    for prefix in ["و", "ف", "ل"] {
        rules.push(prefixed(prefix, "", PV_P, PV_S | PV));
    }
    rules.extend(suffixes(PAST, "", objects(), "", PV_S, PV));
    for base in ["", "ن"] {
        let guard = if base.is_empty() { "ن" } else { "" };
        // A bare ن on a stem ending in ن would give the same word back.
        let bare = std::iter::once("").filter(|_| base.is_empty());
        for rule in suffixes(PAST, "ن", bare.chain(objects()), base, PV_S, PV) {
            rules.push(rule.guarded("", guard));
        }
        let pronouns = std::iter::once("").chain(OBJECT_2ND.iter().chain(OBJECT_3RD).copied());
        for rule in suffixes(PAST, "نا", pronouns, base, PV_S, PV) {
            rules.push(rule.guarded("", guard));
        }
    }
    rules.push(suffixed(PAST, "ت".into(), "", PV_S, PV));
    rules.extend(suffixes(PAST, "ت", objects(), "", PV_S, PV));
    for base in ["", "ت"] {
        let guard = if base.is_empty() { "ت" } else { "" };
        let mut more = Vec::new();
        if !base.is_empty() {
            more.extend(suffixes(PAST, "ت", objects(), base, PV_S, PV));
        }
        for (bare, attached) in [("تما", "تما"), ("تم", "تمو"), ("تن", "تن")] {
            more.push(suffixed(PAST, bare.into(), base, PV_S, PV));
            let pronouns = OBJECT_1ST.iter().chain(OBJECT_3RD).copied();
            more.extend(suffixes(PAST, attached, pronouns, base, PV_S, PV));
        }
        rules.extend(more.into_iter().map(|rule| rule.guarded("", guard)));
    }
    rules.extend(suffixes(
        PAST,
        "تا",
        std::iter::once("").chain(objects()),
        "",
        PV_S,
        PV,
    ));
    rules.extend(suffixes(
        PAST,
        "ا",
        std::iter::once("").chain(objects()),
        "",
        PV_S,
        PV,
    ));
    rules.extend(suffixes(
        PAST,
        "آ",
        std::iter::once("").chain(objects()),
        "أ",
        PV_S,
        PV,
    ));
    rules.push(suffixed(PAST, "وا".into(), "", PV_S, PV));
    rules.extend(suffixes(PAST, "و", objects(), "", PV_S, PV));
    // Imperfect verbs.
    let without_li = Imperfect {
        li: false,
        ..IMPERFECT
    };
    let not_2nd = Imperfect {
        second: false,
        ..IMPERFECT
    };
    let not_1st = Imperfect {
        first: false,
        ..IMPERFECT
    };
    let not_2nd_without_li = Imperfect {
        second: false,
        li: false,
        ..IMPERFECT
    };
    for prefix in ["ي", "ت"] {
        imperfect(&mut rules, prefix, "", "", "", IMPERFECT);
        imperfect(&mut rules, prefix, "", "ان", "", without_li);
        imperfect(&mut rules, prefix, "", "آن", "أ", without_li);
        imperfect(&mut rules, prefix, "", "ا", "", IMPERFECT);
        imperfect(&mut rules, prefix, "", "آ", "أ", IMPERFECT);
    }
    imperfect(&mut rules, "ي", "", "ون", "", without_li);
    let attached_wa = |options: Imperfect| Imperfect {
        attached: Some("و"),
        ..options
    };
    imperfect(&mut rules, "ي", "", "وا", "", attached_wa(IMPERFECT));
    let not_after_n = |options: Imperfect| Imperfect {
        not_last: "ن",
        ..options
    };
    imperfect(&mut rules, "ي", "", "ن", "", not_after_n(IMPERFECT));
    imperfect(&mut rules, "ي", "", "ن", "ن", IMPERFECT);
    imperfect(&mut rules, "ت", "", "ين", "", not_2nd_without_li);
    imperfect(&mut rules, "ت", "", "ي", "", not_2nd);
    imperfect(&mut rules, "ت", "", "ون", "", not_2nd_without_li);
    imperfect(&mut rules, "ت", "", "وا", "", attached_wa(not_2nd));
    imperfect(&mut rules, "ت", "", "ن", "", not_after_n(not_2nd));
    imperfect(&mut rules, "ت", "", "ن", "ن", not_2nd);
    imperfect(&mut rules, "أ", "", "", "", not_1st);
    imperfect(&mut rules, "آ", "أ", "", "", not_1st);
    imperfect(&mut rules, "ن", "", "", "", not_1st);
    // Imperatives.
    rules.push(prefixed("و", "", CV_P, CV_S));
    rules.push(prefixed("ف", "", CV_P, CV_S));
    for prefix in ["ا", "وا", "فا"] {
        rules.push(prefixed(prefix, "", CV_P, CV_S | CV));
    }
    for before in ["", "ي", "ا", "و", "ن"] {
        let bare = match before {
            "" => None,
            "و" => Some("وا"),
            other => Some(other),
        };
        if let Some(bare) = bare {
            rules.push(suffixed(IMPERATIVE, bare.into(), "", CV_S, CV));
        }
        let pronouns = OBJECT_1ST.iter().chain(OBJECT_3RD).copied();
        rules.extend(suffixes(IMPERATIVE, before, pronouns, "", CV_S, CV));
    }
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// Arabic stacks a particle, a person prefix, a suffix and a pronoun on one word, so it keeps more
/// candidates than the other languages.
const MAX_CANDIDATES: usize = 256;

/// The forms `text` may be an inflection of (see `deinflect_bounded`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forms(text: &str) -> Vec<(String, u32)> {
        deinflect(text)
            .into_iter()
            .map(|candidate| (candidate.text, candidate.classes))
            .collect()
    }

    fn finds(text: &str, base: &str, class: u32) -> bool {
        forms(text)
            .iter()
            .any(|(form, classes)| form == base && classes & class != 0)
    }

    #[test]
    fn nouns_lose_their_particles_and_suffixes() {
        for (text, base) in [
            ("والكتاب", "كتاب"),
            ("بالقلم", "قلم"),
            ("للبيت", "بيت"),
            ("لليل", "ليل"),
            ("كتابه", "كتاب"),
            ("كتابي", "كتاب"),
            ("وكتابهم", "كتاب"),
            ("مدرستي", "مدرسة"),
            ("المدرسات", "مدرسة"),
            ("المعلمون", "معلم"),
            ("بالمعلمين", "معلم"),
            ("كتابان", "كتاب"),
            ("مدرستان", "مدرسة"),
            ("كتابا", "كتاب"),
        ] {
            assert!(finds(text, base, N), "{text}: {:?}", forms(text));
        }
    }

    #[test]
    fn verbs_lose_their_person_affixes_particles_and_pronouns() {
        for (text, base) in [
            ("كتبت", "كتب"),
            ("كتبوا", "كتب"),
            ("كتبناه", "كتب"),
            ("وكتبتم", "كتب"),
            ("يكتب", "كتب"),
            ("يكتبون", "كتب"),
            ("سيكتبونه", "كتب"),
            ("وتكتبين", "كتب"),
            ("نكتبها", "كتب"),
            ("يكرم", "أكرم"),
            ("يستخدمون", "استخدم"),
            ("اكتبوا", "كتب"),
        ] {
            assert!(finds(text, base, V), "{text}: {:?}", forms(text));
        }
        // A stem ending in ن merges with the suffix نا: سكنا (we lived) is سكن.
        assert!(finds("سكنا", "سكن", PV));
    }

    #[test]
    fn a_prefix_needs_a_stem_left() {
        for text in ["ال", "و", "يا"] {
            assert!(
                !forms(text).iter().any(|(form, _)| form.is_empty()),
                "{text}: {:?}",
                forms(text)
            );
        }
    }
}
