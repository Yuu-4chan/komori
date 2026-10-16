// Japanese deinflection rules adapted from Yomitan.
// Copyright (C) 2024-2026 Yomitan Authors (ext/js/language/ja/japanese-transforms.js,
// https://github.com/yomidevs/yomitan at commit 67db60d).
// Copyright (C) 2026 Yuu-4chan (the Rust translation, Komori's ordering and changes below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! A table-driven Japanese deinflector adapted from Yomitan's Japanese transforms: its rule
//! table, word-class model and intermediate classes, translated to Rust. Each rule replaces an
//! inflected suffix with a shorter form's suffix, applies only to text whose word classes it
//! inflects (the searched text takes any rule), and gives the result the word classes that form
//! can have. Besides the dictionary forms (`v1`, `v5`, `vk`, `vs`, `vz`,
//! `adj-i`), the classes include intermediate forms: a polite ます or ません form, a て,
//! た, ば, ゃ, ん, なさい, or adverbial く form, the ichidan dictionary form apart from a
//! progressive's contracted てる/でる, and the godan dictionary form apart from a short causative
//! ending in さす (which takes no passive) or in another す. Only candidates whose classes include
//! a dictionary form can match a term, and then only a term whose rules name one of them.
//!
//! Komori's table differs from Yomitan's in a few ways that keep its earlier results: an
//! i-adjective's くて takes only the searched text (and the Kansai-ben adjective て form), so the
//! progressive, completive, and preparatory do not reach an adjective; a rule whose result is a
//! polite ます or ません form or a negative ん form, which Yomitan writes with an empty ending,
//! keeps the ending that form's own rules need (ますれば, ますまい, ませんでした, んかった); the
//! contracted completive keeps its own 行っちゃう/いっちゃう rules before the general っちゃう;
//! and it adds the plain negative imperative な (読むな), which Yomitan leaves to its scanner.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Ichidan verbs in their dictionary form, apart from a progressive's contracted てる/でる.
const V1D: u32 = 1;
/// A progressive's contracted てる/でる, inflecting like an ichidan verb.
const V1P: u32 = 1 << 1;
/// Ichidan verbs (`v1`).
pub(crate) const V1: u32 = V1D | V1P;
/// Godan verbs in their dictionary form, apart from a short causative.
const V5D: u32 = 1 << 2;
/// A short causative ending in さす, which takes no passive.
const V5SS: u32 = 1 << 3;
/// A short causative ending in another す, which takes the passive.
const V5SP: u32 = 1 << 4;
/// Short causatives.
const V5S: u32 = V5SS | V5SP;
/// Godan verbs (`v5`).
pub(crate) const V5: u32 = V5D | V5S;
/// 来る (`vk`).
pub(crate) const VK: u32 = 1 << 5;
/// する and suru verbs (`vs`).
pub(crate) const VS: u32 = 1 << 6;
/// ずる verbs (`vz`).
pub(crate) const VZ: u32 = 1 << 7;
/// i-adjectives (`adj-i`).
pub(crate) const ADJ_I: u32 = 1 << 8;
/// A verb's polite ます form: not a dictionary form.
const MASU: u32 = 1 << 9;
/// A verb's polite negative ません form: not a dictionary form.
const MASEN: u32 = 1 << 10;
/// A verb's て form left by the progressive ている, the completive てしまう, or the preparatory
/// ておく: not a dictionary form.
const TE_FORM: u32 = 1 << 11;
/// A past た form left by the Kansai-ben past: not a dictionary form.
const TA_FORM: u32 = 1 << 12;
/// A verb's or i-adjective's conditional ば form: not a dictionary form.
const BA_FORM: u32 = 1 << 13;
/// A ば form's contracted ゃ form: not a dictionary form.
const YA_FORM: u32 = 1 << 14;
/// A verb's negative ん form: not a dictionary form.
const N_FORM: u32 = 1 << 15;
/// A verb's なさい form: not a dictionary form.
const NASAI_FORM: u32 = 1 << 16;
/// An i-adjective's adverbial く form: not a dictionary form.
const KU_FORM: u32 = 1 << 17;
/// An i-adjective's くて form left by the Kansai-ben adjective て: not a dictionary form.
const KUTE_FORM: u32 = 1 << 18;
/// Verbs of any class.
const VERB: u32 = V1 | V5 | VK | VS | VZ;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = VERB | ADJ_I;

/// The most rules chained to reach one candidate; the longest listed chains take six
/// (読まされていました → 読まされています → 読まされている → 読まされて → 読まされる → 読ます
/// → 読む: short causative, passive, -te, progressive, polite, past).
pub(crate) const MAX_STEPS: usize = 6;
/// The most candidates generated for one text; none of the format's test texts generate more than
/// 25 within six steps.
pub(crate) const MAX_CANDIDATES: usize = 64;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    rules
        .split_whitespace()
        .map(|rule| match rule {
            "v1" => V1,
            "v5" => V5,
            "vk" => VK,
            "vs" => VS,
            "vz" => VZ,
            "adj-i" => ADJ_I,
            _ => 0,
        })
        .fold(0, |classes, class| classes | class)
}

#[derive(Clone, Copy)]
struct Rule {
    /// The inflection's name, as the Dictionary page shows it.
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    /// The classes of text this rule applies to, besides the text as searched; 0 means only it.
    applies_to: u32,
    /// The classes of the result.
    gives: u32,
    /// Whether the inflected form must be the whole text, not only its ending.
    whole_word: bool,
}

const fn rule(
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        name,
        inflected,
        base,
        applies_to,
        gives,
        whole_word: false,
    }
}

/// A rule whose inflected form is a whole word (いらっしゃいます), not an ending.
const fn whole_word(
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        whole_word: true,
        ..rule(name, inflected, base, applies_to, gives)
    }
}

const PAST: &str = "past";
const TE: &str = "-te";
const NEGATIVE: &str = "negative";
const POLITE: &str = "polite";
const VOLITIONAL: &str = "volitional";
const PROGRESSIVE: &str = "progressive";
const COMPLETIVE: &str = "completive";
const PREPARATORY: &str = "preparatory";
const CHA: &str = "-cha";
const CONDITIONAL: &str = "conditional";
const CONTRACTED: &str = "contracted";
const TARA: &str = "-tara";
const TARI: &str = "-tari";
const ZU: &str = "-zu";
const NU: &str = "-nu";
const NEGATIVE_N: &str = "-n";
const ZARU: &str = "-zaru";
const NEBA: &str = "-neba";
const NBAKARI: &str = "-nbakari";
const NTOSURU: &str = "-ntosuru";
const NEGATIVE_VOLITIONAL: &str = "negative volitional";
const DESIDERATIVE: &str = "desiderative";
const SOU: &str = "-sou";
const SUGIRU: &str = "-sugiru";
const NASAI: &str = "-nasai";
const GARU: &str = "-garu";
const YAGARU: &str = "-yagaru";
const GE: &str = "-ge";
const SA: &str = "-sa";
const ADVERBIAL: &str = "adverbial";
const CAUSATIVE: &str = "causative";
const SHORT_CAUSATIVE: &str = "short causative";
const PASSIVE: &str = "passive";
const POTENTIAL: &str = "potential";
const POTENTIAL_OR_PASSIVE: &str = "potential or passive";
const IMPERATIVE: &str = "imperative";
const NEGATIVE_IMPERATIVE: &str = "negative imperative";
const VOLITIONAL_SLANG: &str = "volitional slang";
const CONTINUATIVE: &str = "continuative";
const MU: &str = "-mu";
const FU: &str = "-fu";
const ATTRIBUTIVE: &str = "attributive";
const E_SLANG: &str = "-e";
const N_SLANG: &str = "n-slang";
const NEGATIVE_IMPERATIVE_SLANG: &str = "negative imperative slang";
const KANSAI_BEN: &str = "kansai-ben";

/// The endings Komori covered first. Within a step, candidates reached through these rules alone
/// come before the others, in the order they always had. Tried in order; a more specific ending
/// comes before a general one it also matches.
const FIRST_RULES: &[Rule] = &[
    // Past た/だ.
    rule(PAST, "ませんでした", "ません", TA_FORM, MASEN),
    rule(PAST, "ました", "ます", TA_FORM, MASU),
    rule(PAST, "かった", "い", TA_FORM, ADJ_I),
    rule(PAST, "来た", "来る", TA_FORM, VK),
    rule(PAST, "きた", "くる", TA_FORM, VK),
    rule(PAST, "した", "する", TA_FORM, VS),
    rule(PAST, "行った", "行く", TA_FORM, V5),
    rule(PAST, "いった", "いく", TA_FORM, V5),
    rule(PAST, "いた", "く", TA_FORM, V5),
    rule(PAST, "いだ", "ぐ", TA_FORM, V5),
    rule(PAST, "した", "す", TA_FORM, V5),
    rule(PAST, "った", "う", TA_FORM, V5),
    rule(PAST, "った", "つ", TA_FORM, V5),
    rule(PAST, "った", "る", TA_FORM, V5),
    rule(PAST, "んだ", "む", TA_FORM, V5),
    rule(PAST, "んだ", "ぶ", TA_FORM, V5),
    rule(PAST, "んだ", "ぬ", TA_FORM, V5),
    rule(PAST, "た", "る", TA_FORM, V1),
    // て/で forms; a verb's also when the progressive, completive, or preparatory leaves it.
    rule(TE, "まして", "ます", 0, MASU),
    rule(TE, "くて", "い", KUTE_FORM, ADJ_I),
    rule(TE, "来て", "来る", TE_FORM, VK),
    rule(TE, "きて", "くる", TE_FORM, VK),
    rule(TE, "して", "する", TE_FORM, VS),
    rule(TE, "行って", "行く", TE_FORM, V5),
    rule(TE, "いって", "いく", TE_FORM, V5),
    rule(TE, "いて", "く", TE_FORM, V5),
    rule(TE, "いで", "ぐ", TE_FORM, V5),
    rule(TE, "して", "す", TE_FORM, V5),
    rule(TE, "って", "う", TE_FORM, V5),
    rule(TE, "って", "つ", TE_FORM, V5),
    rule(TE, "って", "る", TE_FORM, V5),
    rule(TE, "んで", "む", TE_FORM, V5),
    rule(TE, "んで", "ぶ", TE_FORM, V5),
    rule(TE, "んで", "ぬ", TE_FORM, V5),
    rule(TE, "て", "る", TE_FORM, V1),
    // Negative ない (itself an i-adjective, so it can be past: 読まなかった) and ません.
    rule(NEGATIVE, "ません", "ます", MASEN, MASU),
    rule(NEGATIVE, "くない", "い", ADJ_I, ADJ_I),
    rule(NEGATIVE, "来ない", "来る", ADJ_I, VK),
    rule(NEGATIVE, "こない", "くる", ADJ_I, VK),
    rule(NEGATIVE, "しない", "する", ADJ_I, VS),
    rule(NEGATIVE, "わない", "う", ADJ_I, V5),
    rule(NEGATIVE, "かない", "く", ADJ_I, V5),
    rule(NEGATIVE, "がない", "ぐ", ADJ_I, V5),
    rule(NEGATIVE, "さない", "す", ADJ_I, V5),
    rule(NEGATIVE, "たない", "つ", ADJ_I, V5),
    rule(NEGATIVE, "なない", "ぬ", ADJ_I, V5),
    rule(NEGATIVE, "ばない", "ぶ", ADJ_I, V5),
    rule(NEGATIVE, "まない", "む", ADJ_I, V5),
    rule(NEGATIVE, "らない", "る", ADJ_I, V5),
    rule(NEGATIVE, "ない", "る", ADJ_I, V1),
    rule(VOLITIONAL, "ましょう", "ます", 0, MASU),
    // Polite ます.
    rule(POLITE, "来ます", "来る", MASU, VK),
    rule(POLITE, "きます", "くる", MASU, VK),
    rule(POLITE, "します", "する", MASU, VS),
    rule(POLITE, "います", "う", MASU, V5D),
    rule(POLITE, "きます", "く", MASU, V5D),
    rule(POLITE, "ぎます", "ぐ", MASU, V5D),
    rule(POLITE, "します", "す", MASU, V5D | V5S),
    rule(POLITE, "ちます", "つ", MASU, V5D),
    rule(POLITE, "にます", "ぬ", MASU, V5D),
    rule(POLITE, "びます", "ぶ", MASU, V5D),
    rule(POLITE, "みます", "む", MASU, V5D),
    rule(POLITE, "ります", "る", MASU, V5D),
    rule(POLITE, "ます", "る", MASU, V1),
    // Progressive ている/でいる and their contracted てる/でる, inflecting like the ichidan いる
    // (読んでいた, 読んでいます), leave the verb's て form.
    rule(PROGRESSIVE, "ている", "て", V1, TE_FORM),
    rule(PROGRESSIVE, "でいる", "で", V1, TE_FORM),
    rule(PROGRESSIVE, "てる", "て", V1P, TE_FORM),
    rule(PROGRESSIVE, "でる", "で", V1P, TE_FORM),
    // Completive てしまう/でしまう, inflecting like the godan しまう (読んでしまった, 読んでしまいます),
    // leave the verb's て form; the contracted ちゃう/じゃう, inflecting like a godan verb too
    // (食べちゃった), reach the dictionary form directly.
    rule(COMPLETIVE, "てしまう", "て", V5, TE_FORM),
    rule(COMPLETIVE, "でしまう", "で", V5, TE_FORM),
    rule(COMPLETIVE, "来ちゃう", "来る", V5, VK),
    rule(COMPLETIVE, "きちゃう", "くる", V5, VK),
    rule(COMPLETIVE, "しちゃう", "する", V5, VS),
    rule(COMPLETIVE, "行っちゃう", "行く", V5, V5),
    rule(COMPLETIVE, "いっちゃう", "いく", V5, V5),
    rule(COMPLETIVE, "いちゃう", "く", V5, V5),
    rule(COMPLETIVE, "いじゃう", "ぐ", V5, V5),
    rule(COMPLETIVE, "しちゃう", "す", V5, V5),
    rule(COMPLETIVE, "っちゃう", "う", V5, V5),
    rule(COMPLETIVE, "っちゃう", "つ", V5, V5),
    rule(COMPLETIVE, "っちゃう", "る", V5, V5),
    rule(COMPLETIVE, "んじゃう", "む", V5, V5),
    rule(COMPLETIVE, "んじゃう", "ぶ", V5, V5),
    rule(COMPLETIVE, "んじゃう", "ぬ", V5, V5),
    rule(COMPLETIVE, "ちゃう", "る", V5, V1),
    // Preparatory ておく/でおく and their contracted とく/どく, inflecting like the godan おく
    // (読んでおいた, 書いといた), leave the verb's て form.
    rule(PREPARATORY, "ておく", "て", V5, TE_FORM),
    rule(PREPARATORY, "でおく", "で", V5, TE_FORM),
    rule(PREPARATORY, "とく", "て", V5, TE_FORM),
    rule(PREPARATORY, "どく", "で", V5, TE_FORM),
];

/// The rest of the Japanese transforms, tried after the first rules in each step. Tried in
/// order; a more specific ending comes before a general one it also matches.
const MORE_RULES: &[Rule] = &[
    // The existing transforms' remaining word classes and special cases: ずる verbs, the 為る
    // and 來る spellings, 行く's other spellings, godan う verbs whose past is うた (問うた), and
    // honorific verbs whose ます stem ends in い (いらっしゃいます).
    rule(COMPLETIVE, "っちゃう", "く", V5, V5),
    rule(COMPLETIVE, "じちゃう", "ずる", V5, VZ),
    rule(COMPLETIVE, "為ちゃう", "為る", V5, VS),
    rule(COMPLETIVE, "來ちゃう", "來る", V5, VK),
    rule(TE, "じて", "ずる", TE_FORM, VZ),
    rule(TE, "為て", "為る", TE_FORM, VS),
    rule(TE, "來て", "來る", TE_FORM, VK),
    rule(TE, "逝って", "逝く", TE_FORM, V5),
    rule(TE, "往って", "往く", TE_FORM, V5),
    rule(TE, "こうて", "こう", TE_FORM, V5),
    rule(TE, "とうて", "とう", TE_FORM, V5),
    rule(TE, "請うて", "請う", TE_FORM, V5),
    rule(TE, "乞うて", "乞う", TE_FORM, V5),
    rule(TE, "恋うて", "恋う", TE_FORM, V5),
    rule(TE, "問うて", "問う", TE_FORM, V5),
    rule(TE, "訪うて", "訪う", TE_FORM, V5),
    rule(TE, "宣うて", "宣う", TE_FORM, V5),
    rule(TE, "曰うて", "曰う", TE_FORM, V5),
    rule(TE, "給うて", "給う", TE_FORM, V5),
    rule(TE, "賜うて", "賜う", TE_FORM, V5),
    rule(TE, "揺蕩うて", "揺蕩う", TE_FORM, V5),
    rule(TE, "のたもうて", "のたまう", TE_FORM, V5),
    rule(TE, "たもうて", "たまう", TE_FORM, V5),
    rule(TE, "たゆとうて", "たゆたう", TE_FORM, V5),
    rule(NEGATIVE, "はない", "う", ADJ_I, V5),
    rule(NEGATIVE, "じない", "ずる", ADJ_I, VZ),
    rule(NEGATIVE, "為ない", "為る", ADJ_I, VS),
    rule(NEGATIVE, "來ない", "來る", ADJ_I, VK),
    rule(PAST, "じた", "ずる", TA_FORM, VZ),
    rule(PAST, "為た", "為る", TA_FORM, VS),
    rule(PAST, "來た", "來る", TA_FORM, VK),
    rule(PAST, "逝った", "逝く", TA_FORM, V5),
    rule(PAST, "往った", "往く", TA_FORM, V5),
    rule(PAST, "こうた", "こう", TA_FORM, V5),
    rule(PAST, "とうた", "とう", TA_FORM, V5),
    rule(PAST, "請うた", "請う", TA_FORM, V5),
    rule(PAST, "乞うた", "乞う", TA_FORM, V5),
    rule(PAST, "恋うた", "恋う", TA_FORM, V5),
    rule(PAST, "問うた", "問う", TA_FORM, V5),
    rule(PAST, "訪うた", "訪う", TA_FORM, V5),
    rule(PAST, "宣うた", "宣う", TA_FORM, V5),
    rule(PAST, "曰うた", "曰う", TA_FORM, V5),
    rule(PAST, "給うた", "給う", TA_FORM, V5),
    rule(PAST, "賜うた", "賜う", TA_FORM, V5),
    rule(PAST, "揺蕩うた", "揺蕩う", TA_FORM, V5),
    rule(PAST, "のたもうた", "のたまう", TA_FORM, V5),
    rule(PAST, "たもうた", "たまう", TA_FORM, V5),
    rule(PAST, "たゆとうた", "たゆたう", TA_FORM, V5),
    whole_word(POLITE, "いらっしゃいます", "いらっしゃる", MASU, V5D),
    whole_word(POLITE, "ございます", "ござる", MASU, V5D),
    whole_word(POLITE, "なさいます", "なさる", MASU, V5D),
    whole_word(POLITE, "くださいます", "くださる", MASU, V5D),
    whole_word(POLITE, "下さいます", "下さる", MASU, V5D),
    whole_word(POLITE, "おっしゃいます", "おっしゃる", MASU, V5D),
    whole_word(POLITE, "仰います", "仰る", MASU, V5D),
    whole_word(POLITE, "仰有います", "仰有る", MASU, V5D),
    rule(POLITE, "ひます", "う", MASU, V5D),
    rule(POLITE, "じます", "ずる", MASU, VZ),
    rule(POLITE, "為ます", "為る", MASU, VS),
    rule(POLITE, "來ます", "來る", MASU, VK),
    rule(POLITE, "くあります", "い", MASU, ADJ_I),
    // The contracted completive ちまう/じまう, inflecting like a godan verb, directly.
    rule(COMPLETIVE, "ちまう", "る", V5, V1),
    rule(COMPLETIVE, "いじまう", "ぐ", V5, V5),
    rule(COMPLETIVE, "いちまう", "く", V5, V5),
    rule(COMPLETIVE, "しちまう", "す", V5, V5),
    rule(COMPLETIVE, "っちまう", "う", V5, V5),
    rule(COMPLETIVE, "っちまう", "く", V5, V5),
    rule(COMPLETIVE, "っちまう", "つ", V5, V5),
    rule(COMPLETIVE, "っちまう", "る", V5, V5),
    rule(COMPLETIVE, "んじまう", "ぬ", V5, V5),
    rule(COMPLETIVE, "んじまう", "ぶ", V5, V5),
    rule(COMPLETIVE, "んじまう", "む", V5, V5),
    rule(COMPLETIVE, "じちまう", "ずる", V5, VZ),
    rule(COMPLETIVE, "しちまう", "する", V5, VS),
    rule(COMPLETIVE, "為ちまう", "為る", V5, VS),
    rule(COMPLETIVE, "きちまう", "くる", V5, VK),
    rule(COMPLETIVE, "来ちまう", "来る", V5, VK),
    rule(COMPLETIVE, "來ちまう", "來る", V5, VK),
    // ちゃ/じゃ, the contracted ては, directly.
    rule(CHA, "ちゃ", "る", V5, V1),
    rule(CHA, "いじゃ", "ぐ", V5, V5),
    rule(CHA, "いちゃ", "く", V5, V5),
    rule(CHA, "しちゃ", "す", V5, V5),
    rule(CHA, "っちゃ", "う", V5, V5),
    rule(CHA, "っちゃ", "く", V5, V5),
    rule(CHA, "っちゃ", "つ", V5, V5),
    rule(CHA, "っちゃ", "る", V5, V5),
    rule(CHA, "んじゃ", "ぬ", V5, V5),
    rule(CHA, "んじゃ", "ぶ", V5, V5),
    rule(CHA, "んじゃ", "む", V5, V5),
    rule(CHA, "じちゃ", "ずる", V5, VZ),
    rule(CHA, "しちゃ", "する", V5, VS),
    rule(CHA, "為ちゃ", "為る", V5, VS),
    rule(CHA, "きちゃ", "くる", V5, VK),
    rule(CHA, "来ちゃ", "来る", V5, VK),
    rule(CHA, "來ちゃ", "來る", V5, VK),
    // The negative ないでおく/ないどく and ないでいる/ないでゐる reach the negative ない; the progressive
    // てゐる/でゐる and ておる/でおる and its contracted とる leave the verb's て form.
    rule(PREPARATORY, "ないでおく", "ない", V5, ADJ_I),
    rule(PREPARATORY, "ないどく", "ない", V5, ADJ_I),
    rule(PROGRESSIVE, "てゐる", "て", V1, TE_FORM),
    rule(PROGRESSIVE, "ておる", "て", V5, TE_FORM),
    rule(PROGRESSIVE, "でゐる", "で", V1, TE_FORM),
    rule(PROGRESSIVE, "でおる", "で", V5, TE_FORM),
    rule(PROGRESSIVE, "とる", "て", V5, TE_FORM),
    rule(PROGRESSIVE, "ないでいる", "ない", V1, ADJ_I),
    rule(PROGRESSIVE, "ないでゐる", "ない", V1, ADJ_I),
    // The conditional ば, reaching the dictionary form (the ます form's ますれば its ます form), and
    // its contraction ゃ, reaching the ば form (読みゃ → 読めば → 読む).
    rule(CONDITIONAL, "ければ", "い", BA_FORM, ADJ_I),
    rule(CONDITIONAL, "えば", "う", BA_FORM, V5),
    rule(CONDITIONAL, "へば", "う", BA_FORM, V5),
    rule(CONDITIONAL, "けば", "く", BA_FORM, V5),
    rule(CONDITIONAL, "げば", "ぐ", BA_FORM, V5),
    rule(CONDITIONAL, "せば", "す", BA_FORM, V5),
    rule(CONDITIONAL, "てば", "つ", BA_FORM, V5),
    rule(CONDITIONAL, "ねば", "ぬ", BA_FORM, V5),
    rule(CONDITIONAL, "べば", "ぶ", BA_FORM, V5),
    rule(CONDITIONAL, "めば", "む", BA_FORM, V5),
    rule(CONDITIONAL, "れば", "る", BA_FORM, VERB),
    rule(CONDITIONAL, "ますれば", "ます", BA_FORM, MASU),
    rule(CONTRACTED, "けりゃ", "ければ", YA_FORM, BA_FORM),
    rule(CONTRACTED, "きゃ", "ければ", YA_FORM, BA_FORM),
    rule(CONTRACTED, "や", "えば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "きゃ", "けば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "ぎゃ", "げば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "しゃ", "せば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "ちゃ", "てば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "にゃ", "ねば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "びゃ", "べば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "みゃ", "めば", YA_FORM, BA_FORM),
    rule(CONTRACTED, "りゃ", "れば", YA_FORM, BA_FORM),
    // たら and たり, like the past.
    rule(TARA, "かったら", "い", 0, ADJ_I),
    rule(TARA, "たら", "る", 0, V1),
    rule(TARA, "いたら", "く", 0, V5),
    rule(TARA, "いだら", "ぐ", 0, V5),
    rule(TARA, "したら", "す", 0, V5),
    rule(TARA, "ったら", "う", 0, V5),
    rule(TARA, "ったら", "つ", 0, V5),
    rule(TARA, "ったら", "る", 0, V5),
    rule(TARA, "んだら", "ぬ", 0, V5),
    rule(TARA, "んだら", "ぶ", 0, V5),
    rule(TARA, "んだら", "む", 0, V5),
    rule(TARA, "じたら", "ずる", 0, VZ),
    rule(TARA, "したら", "する", 0, VS),
    rule(TARA, "為たら", "為る", 0, VS),
    rule(TARA, "きたら", "くる", 0, VK),
    rule(TARA, "来たら", "来る", 0, VK),
    rule(TARA, "來たら", "來る", 0, VK),
    rule(TARA, "いったら", "いく", 0, V5),
    rule(TARA, "行ったら", "行く", 0, V5),
    rule(TARA, "逝ったら", "逝く", 0, V5),
    rule(TARA, "往ったら", "往く", 0, V5),
    rule(TARA, "こうたら", "こう", 0, V5),
    rule(TARA, "とうたら", "とう", 0, V5),
    rule(TARA, "請うたら", "請う", 0, V5),
    rule(TARA, "乞うたら", "乞う", 0, V5),
    rule(TARA, "恋うたら", "恋う", 0, V5),
    rule(TARA, "問うたら", "問う", 0, V5),
    rule(TARA, "訪うたら", "訪う", 0, V5),
    rule(TARA, "宣うたら", "宣う", 0, V5),
    rule(TARA, "曰うたら", "曰う", 0, V5),
    rule(TARA, "給うたら", "給う", 0, V5),
    rule(TARA, "賜うたら", "賜う", 0, V5),
    rule(TARA, "揺蕩うたら", "揺蕩う", 0, V5),
    rule(TARA, "のたもうたら", "のたまう", 0, V5),
    rule(TARA, "たもうたら", "たまう", 0, V5),
    rule(TARA, "たゆとうたら", "たゆたう", 0, V5),
    rule(TARA, "ましたら", "ます", 0, MASU),
    rule(TARI, "かったり", "い", 0, ADJ_I),
    rule(TARI, "たり", "る", 0, V1),
    rule(TARI, "いたり", "く", 0, V5),
    rule(TARI, "いだり", "ぐ", 0, V5),
    rule(TARI, "したり", "す", 0, V5),
    rule(TARI, "ったり", "う", 0, V5),
    rule(TARI, "ったり", "つ", 0, V5),
    rule(TARI, "ったり", "る", 0, V5),
    rule(TARI, "んだり", "ぬ", 0, V5),
    rule(TARI, "んだり", "ぶ", 0, V5),
    rule(TARI, "んだり", "む", 0, V5),
    rule(TARI, "じたり", "ずる", 0, VZ),
    rule(TARI, "したり", "する", 0, VS),
    rule(TARI, "為たり", "為る", 0, VS),
    rule(TARI, "きたり", "くる", 0, VK),
    rule(TARI, "来たり", "来る", 0, VK),
    rule(TARI, "來たり", "來る", 0, VK),
    rule(TARI, "いったり", "いく", 0, V5),
    rule(TARI, "行ったり", "行く", 0, V5),
    rule(TARI, "逝ったり", "逝く", 0, V5),
    rule(TARI, "往ったり", "往く", 0, V5),
    rule(TARI, "こうたり", "こう", 0, V5),
    rule(TARI, "とうたり", "とう", 0, V5),
    rule(TARI, "請うたり", "請う", 0, V5),
    rule(TARI, "乞うたり", "乞う", 0, V5),
    rule(TARI, "恋うたり", "恋う", 0, V5),
    rule(TARI, "問うたり", "問う", 0, V5),
    rule(TARI, "訪うたり", "訪う", 0, V5),
    rule(TARI, "宣うたり", "宣う", 0, V5),
    rule(TARI, "曰うたり", "曰う", 0, V5),
    rule(TARI, "給うたり", "給う", 0, V5),
    rule(TARI, "賜うたり", "賜う", 0, V5),
    rule(TARI, "揺蕩うたり", "揺蕩う", 0, V5),
    rule(TARI, "のたもうたり", "のたまう", 0, V5),
    rule(TARI, "たもうたり", "たまう", 0, V5),
    rule(TARI, "たゆとうたり", "たゆたう", 0, V5),
    // The negatives ず, ぬ, and ん (with the past of ん and ません, 知らんかった), ざる, and ねば, and
    // んばかり and んとする.
    rule(ZU, "ず", "る", 0, V1),
    rule(ZU, "かず", "く", 0, V5),
    rule(ZU, "がず", "ぐ", 0, V5),
    rule(ZU, "さず", "す", 0, V5),
    rule(ZU, "たず", "つ", 0, V5),
    rule(ZU, "なず", "ぬ", 0, V5),
    rule(ZU, "ばず", "ぶ", 0, V5),
    rule(ZU, "まず", "む", 0, V5),
    rule(ZU, "らず", "る", 0, V5),
    rule(ZU, "わず", "う", 0, V5),
    rule(ZU, "はず", "う", 0, V5),
    rule(ZU, "ぜず", "ずる", 0, VZ),
    rule(ZU, "せず", "する", 0, VS),
    rule(ZU, "為ず", "為る", 0, VS),
    rule(ZU, "こず", "くる", 0, VK),
    rule(ZU, "来ず", "来る", 0, VK),
    rule(ZU, "來ず", "來る", 0, VK),
    rule(NU, "ぬ", "る", 0, V1),
    rule(NU, "かぬ", "く", 0, V5),
    rule(NU, "がぬ", "ぐ", 0, V5),
    rule(NU, "さぬ", "す", 0, V5),
    rule(NU, "たぬ", "つ", 0, V5),
    rule(NU, "なぬ", "ぬ", 0, V5),
    rule(NU, "ばぬ", "ぶ", 0, V5),
    rule(NU, "まぬ", "む", 0, V5),
    rule(NU, "らぬ", "る", 0, V5),
    rule(NU, "わぬ", "う", 0, V5),
    rule(NU, "はぬ", "う", 0, V5),
    rule(NU, "ぜぬ", "ずる", 0, VZ),
    rule(NU, "せぬ", "する", 0, VS),
    rule(NU, "為ぬ", "為る", 0, VS),
    rule(NU, "こぬ", "くる", 0, VK),
    rule(NU, "来ぬ", "来る", 0, VK),
    rule(NU, "來ぬ", "來る", 0, VK),
    rule(NEGATIVE_N, "ん", "る", N_FORM, V1),
    rule(NEGATIVE_N, "かん", "く", N_FORM, V5),
    rule(NEGATIVE_N, "がん", "ぐ", N_FORM, V5),
    rule(NEGATIVE_N, "さん", "す", N_FORM, V5),
    rule(NEGATIVE_N, "たん", "つ", N_FORM, V5),
    rule(NEGATIVE_N, "なん", "ぬ", N_FORM, V5),
    rule(NEGATIVE_N, "ばん", "ぶ", N_FORM, V5),
    rule(NEGATIVE_N, "まん", "む", N_FORM, V5),
    rule(NEGATIVE_N, "らん", "る", N_FORM, V5),
    rule(NEGATIVE_N, "わん", "う", N_FORM, V5),
    rule(NEGATIVE_N, "はん", "う", N_FORM, V5),
    rule(NEGATIVE_N, "ぜん", "ずる", N_FORM, VZ),
    rule(NEGATIVE_N, "せん", "する", N_FORM, VS),
    rule(NEGATIVE_N, "為ん", "為る", N_FORM, VS),
    rule(NEGATIVE_N, "こん", "くる", N_FORM, VK),
    rule(NEGATIVE_N, "来ん", "来る", N_FORM, VK),
    rule(NEGATIVE_N, "來ん", "來る", N_FORM, VK),
    rule(NBAKARI, "んばかり", "る", 0, V1),
    rule(NBAKARI, "かんばかり", "く", 0, V5),
    rule(NBAKARI, "がんばかり", "ぐ", 0, V5),
    rule(NBAKARI, "さんばかり", "す", 0, V5),
    rule(NBAKARI, "たんばかり", "つ", 0, V5),
    rule(NBAKARI, "なんばかり", "ぬ", 0, V5),
    rule(NBAKARI, "ばんばかり", "ぶ", 0, V5),
    rule(NBAKARI, "まんばかり", "む", 0, V5),
    rule(NBAKARI, "らんばかり", "る", 0, V5),
    rule(NBAKARI, "わんばかり", "う", 0, V5),
    rule(NBAKARI, "はんばかり", "う", 0, V5),
    rule(NBAKARI, "ぜんばかり", "ずる", 0, VZ),
    rule(NBAKARI, "せんばかり", "する", 0, VS),
    rule(NBAKARI, "為んばかり", "為る", 0, VS),
    rule(NBAKARI, "こんばかり", "くる", 0, VK),
    rule(NBAKARI, "来んばかり", "来る", 0, VK),
    rule(NBAKARI, "來んばかり", "來る", 0, VK),
    rule(NTOSURU, "んとする", "る", VS, V1),
    rule(NTOSURU, "かんとする", "く", VS, V5),
    rule(NTOSURU, "がんとする", "ぐ", VS, V5),
    rule(NTOSURU, "さんとする", "す", VS, V5),
    rule(NTOSURU, "たんとする", "つ", VS, V5),
    rule(NTOSURU, "なんとする", "ぬ", VS, V5),
    rule(NTOSURU, "ばんとする", "ぶ", VS, V5),
    rule(NTOSURU, "まんとする", "む", VS, V5),
    rule(NTOSURU, "らんとする", "る", VS, V5),
    rule(NTOSURU, "わんとする", "う", VS, V5),
    rule(NTOSURU, "はんとする", "う", VS, V5),
    rule(NTOSURU, "ぜんとする", "ずる", VS, VZ),
    rule(NTOSURU, "せんとする", "する", VS, VS),
    rule(NTOSURU, "為んとする", "為る", VS, VS),
    rule(NTOSURU, "こんとする", "くる", VS, VK),
    rule(NTOSURU, "来んとする", "来る", VS, VK),
    rule(NTOSURU, "來んとする", "來る", VS, VK),
    rule(ZARU, "ざる", "る", 0, V1),
    rule(ZARU, "かざる", "く", 0, V5),
    rule(ZARU, "がざる", "ぐ", 0, V5),
    rule(ZARU, "さざる", "す", 0, V5),
    rule(ZARU, "たざる", "つ", 0, V5),
    rule(ZARU, "なざる", "ぬ", 0, V5),
    rule(ZARU, "ばざる", "ぶ", 0, V5),
    rule(ZARU, "まざる", "む", 0, V5),
    rule(ZARU, "らざる", "る", 0, V5),
    rule(ZARU, "わざる", "う", 0, V5),
    rule(ZARU, "はざる", "う", 0, V5),
    rule(ZARU, "ぜざる", "ずる", 0, VZ),
    rule(ZARU, "せざる", "する", 0, VS),
    rule(ZARU, "為ざる", "為る", 0, VS),
    rule(ZARU, "こざる", "くる", 0, VK),
    rule(ZARU, "来ざる", "来る", 0, VK),
    rule(ZARU, "來ざる", "來る", 0, VK),
    rule(NEBA, "ねば", "る", BA_FORM, V1),
    rule(NEBA, "かねば", "く", BA_FORM, V5),
    rule(NEBA, "がねば", "ぐ", BA_FORM, V5),
    rule(NEBA, "さねば", "す", BA_FORM, V5),
    rule(NEBA, "たねば", "つ", BA_FORM, V5),
    rule(NEBA, "なねば", "ぬ", BA_FORM, V5),
    rule(NEBA, "ばねば", "ぶ", BA_FORM, V5),
    rule(NEBA, "まねば", "む", BA_FORM, V5),
    rule(NEBA, "らねば", "る", BA_FORM, V5),
    rule(NEBA, "わねば", "う", BA_FORM, V5),
    rule(NEBA, "はねば", "う", BA_FORM, V5),
    rule(NEBA, "ぜねば", "ずる", BA_FORM, VZ),
    rule(NEBA, "せねば", "する", BA_FORM, VS),
    rule(NEBA, "為ねば", "為る", BA_FORM, VS),
    rule(NEBA, "こねば", "くる", BA_FORM, VK),
    rule(NEBA, "来ねば", "来る", BA_FORM, VK),
    rule(NEBA, "來ねば", "來る", BA_FORM, VK),
    rule(PAST, "んかった", "ん", TA_FORM, MASEN | N_FORM),
    // The negative volitional まい, after a verb's dictionary form or an ichidan, する, or 来る stem.
    rule(NEGATIVE_VOLITIONAL, "まい", "", 0, VERB),
    rule(NEGATIVE_VOLITIONAL, "まい", "る", 0, V1),
    rule(NEGATIVE_VOLITIONAL, "じまい", "ずる", 0, VZ),
    rule(NEGATIVE_VOLITIONAL, "しまい", "する", 0, VS),
    rule(NEGATIVE_VOLITIONAL, "為まい", "為る", 0, VS),
    rule(NEGATIVE_VOLITIONAL, "こまい", "くる", 0, VK),
    rule(NEGATIVE_VOLITIONAL, "来まい", "来る", 0, VK),
    rule(NEGATIVE_VOLITIONAL, "來まい", "來る", 0, VK),
    rule(NEGATIVE_VOLITIONAL, "ますまい", "ます", 0, MASU),
    // The desiderative たい, itself an i-adjective (食べたかった).
    rule(DESIDERATIVE, "たい", "る", ADJ_I, V1),
    rule(DESIDERATIVE, "いたい", "う", ADJ_I, V5),
    rule(DESIDERATIVE, "きたい", "く", ADJ_I, V5),
    rule(DESIDERATIVE, "ぎたい", "ぐ", ADJ_I, V5),
    rule(DESIDERATIVE, "したい", "す", ADJ_I, V5),
    rule(DESIDERATIVE, "ちたい", "つ", ADJ_I, V5),
    rule(DESIDERATIVE, "にたい", "ぬ", ADJ_I, V5),
    rule(DESIDERATIVE, "びたい", "ぶ", ADJ_I, V5),
    rule(DESIDERATIVE, "みたい", "む", ADJ_I, V5),
    rule(DESIDERATIVE, "りたい", "る", ADJ_I, V5),
    rule(DESIDERATIVE, "じたい", "ずる", ADJ_I, VZ),
    rule(DESIDERATIVE, "したい", "する", ADJ_I, VS),
    rule(DESIDERATIVE, "為たい", "為る", ADJ_I, VS),
    rule(DESIDERATIVE, "きたい", "くる", ADJ_I, VK),
    rule(DESIDERATIVE, "来たい", "来る", ADJ_I, VK),
    rule(DESIDERATIVE, "來たい", "來る", ADJ_I, VK),
    // そう after a verb's ます stem or an i-adjective's stem, and すぎる/過ぎる, itself an ichidan verb.
    rule(SOU, "そう", "い", 0, ADJ_I),
    rule(SOU, "さう", "い", 0, ADJ_I),
    rule(SOU, "そう", "る", 0, V1),
    rule(SOU, "さう", "る", 0, V1),
    rule(SOU, "いそう", "う", 0, V5),
    rule(SOU, "ひさう", "う", 0, V5),
    rule(SOU, "きそう", "く", 0, V5),
    rule(SOU, "きさう", "く", 0, V5),
    rule(SOU, "ぎそう", "ぐ", 0, V5),
    rule(SOU, "ぎさう", "ぐ", 0, V5),
    rule(SOU, "しそう", "す", 0, V5),
    rule(SOU, "しさう", "す", 0, V5),
    rule(SOU, "ちそう", "つ", 0, V5),
    rule(SOU, "ちさう", "つ", 0, V5),
    rule(SOU, "にそう", "ぬ", 0, V5),
    rule(SOU, "にさう", "ぬ", 0, V5),
    rule(SOU, "びそう", "ぶ", 0, V5),
    rule(SOU, "びさう", "ぶ", 0, V5),
    rule(SOU, "みそう", "む", 0, V5),
    rule(SOU, "みさう", "む", 0, V5),
    rule(SOU, "りそう", "る", 0, V5),
    rule(SOU, "りさう", "る", 0, V5),
    rule(SOU, "じそう", "ずる", 0, VZ),
    rule(SOU, "じさう", "ずる", 0, VZ),
    rule(SOU, "しそう", "する", 0, VS),
    rule(SOU, "しさう", "する", 0, VS),
    rule(SOU, "為そう", "為る", 0, VS),
    rule(SOU, "為さう", "為る", 0, VS),
    rule(SOU, "きそう", "くる", 0, VK),
    rule(SOU, "きさう", "くる", 0, VK),
    rule(SOU, "来そう", "来る", 0, VK),
    rule(SOU, "来さう", "来る", 0, VK),
    rule(SOU, "來そう", "來る", 0, VK),
    rule(SOU, "來さう", "來る", 0, VK),
    rule(SUGIRU, "すぎる", "い", V1, ADJ_I),
    rule(SUGIRU, "すぎる", "る", V1, V1),
    rule(SUGIRU, "いすぎる", "う", V1, V5),
    rule(SUGIRU, "きすぎる", "く", V1, V5),
    rule(SUGIRU, "ぎすぎる", "ぐ", V1, V5),
    rule(SUGIRU, "しすぎる", "す", V1, V5),
    rule(SUGIRU, "ちすぎる", "つ", V1, V5),
    rule(SUGIRU, "にすぎる", "ぬ", V1, V5),
    rule(SUGIRU, "びすぎる", "ぶ", V1, V5),
    rule(SUGIRU, "みすぎる", "む", V1, V5),
    rule(SUGIRU, "りすぎる", "る", V1, V5),
    rule(SUGIRU, "じすぎる", "ずる", V1, VZ),
    rule(SUGIRU, "しすぎる", "する", V1, VS),
    rule(SUGIRU, "為すぎる", "為る", V1, VS),
    rule(SUGIRU, "きすぎる", "くる", V1, VK),
    rule(SUGIRU, "来すぎる", "来る", V1, VK),
    rule(SUGIRU, "來すぎる", "來る", V1, VK),
    rule(SUGIRU, "過ぎる", "い", V1, ADJ_I),
    rule(SUGIRU, "過ぎる", "る", V1, V1),
    rule(SUGIRU, "い過ぎる", "う", V1, V5),
    rule(SUGIRU, "き過ぎる", "く", V1, V5),
    rule(SUGIRU, "ぎ過ぎる", "ぐ", V1, V5),
    rule(SUGIRU, "し過ぎる", "す", V1, V5),
    rule(SUGIRU, "ち過ぎる", "つ", V1, V5),
    rule(SUGIRU, "に過ぎる", "ぬ", V1, V5),
    rule(SUGIRU, "び過ぎる", "ぶ", V1, V5),
    rule(SUGIRU, "み過ぎる", "む", V1, V5),
    rule(SUGIRU, "り過ぎる", "る", V1, V5),
    rule(SUGIRU, "じ過ぎる", "ずる", V1, VZ),
    rule(SUGIRU, "し過ぎる", "する", V1, VS),
    rule(SUGIRU, "為過ぎる", "為る", V1, VS),
    rule(SUGIRU, "き過ぎる", "くる", V1, VK),
    rule(SUGIRU, "来過ぎる", "来る", V1, VK),
    rule(SUGIRU, "來過ぎる", "來る", V1, VK),
    // The polite imperative なさい.
    rule(NASAI, "なさい", "る", NASAI_FORM, V1),
    rule(NASAI, "いなさい", "う", NASAI_FORM, V5),
    rule(NASAI, "きなさい", "く", NASAI_FORM, V5),
    rule(NASAI, "ぎなさい", "ぐ", NASAI_FORM, V5),
    rule(NASAI, "しなさい", "す", NASAI_FORM, V5),
    rule(NASAI, "ちなさい", "つ", NASAI_FORM, V5),
    rule(NASAI, "になさい", "ぬ", NASAI_FORM, V5),
    rule(NASAI, "びなさい", "ぶ", NASAI_FORM, V5),
    rule(NASAI, "みなさい", "む", NASAI_FORM, V5),
    rule(NASAI, "りなさい", "る", NASAI_FORM, V5),
    rule(NASAI, "じなさい", "ずる", NASAI_FORM, VZ),
    rule(NASAI, "しなさい", "する", NASAI_FORM, VS),
    rule(NASAI, "為なさい", "為る", NASAI_FORM, VS),
    rule(NASAI, "きなさい", "くる", NASAI_FORM, VK),
    rule(NASAI, "来なさい", "来る", NASAI_FORM, VK),
    rule(NASAI, "來なさい", "來る", NASAI_FORM, VK),
    // がる, itself a godan verb, and やがる, げ, the noun さ, and the adverbial く.
    rule(ADVERBIAL, "く", "い", KU_FORM, ADJ_I),
    rule(SA, "さ", "い", 0, ADJ_I),
    rule(GE, "げ", "い", 0, ADJ_I),
    rule(GE, "気", "い", 0, ADJ_I),
    rule(GARU, "がる", "い", V5, ADJ_I),
    rule(YAGARU, "やがる", "る", V5, V1),
    rule(YAGARU, "いやがる", "う", V5, V5),
    rule(YAGARU, "きやがる", "く", V5, V5),
    rule(YAGARU, "ぎやがる", "ぐ", V5, V5),
    rule(YAGARU, "しやがる", "す", V5, V5),
    rule(YAGARU, "ちやがる", "つ", V5, V5),
    rule(YAGARU, "にやがる", "ぬ", V5, V5),
    rule(YAGARU, "びやがる", "ぶ", V5, V5),
    rule(YAGARU, "みやがる", "む", V5, V5),
    rule(YAGARU, "りやがる", "る", V5, V5),
    rule(YAGARU, "じやがる", "ずる", V5, VZ),
    rule(YAGARU, "しやがる", "する", V5, VS),
    rule(YAGARU, "為やがる", "為る", V5, VS),
    rule(YAGARU, "きやがる", "くる", V5, VK),
    rule(YAGARU, "来やがる", "来る", V5, VK),
    rule(YAGARU, "來やがる", "來る", V5, VK),
    // The causative させる/せる, itself an ichidan verb, and the short causative す/さす, itself a godan
    // verb that takes the passive only when it does not end in さす.
    rule(CAUSATIVE, "させる", "る", V1, V1),
    rule(CAUSATIVE, "かせる", "く", V1, V5),
    rule(CAUSATIVE, "がせる", "ぐ", V1, V5),
    rule(CAUSATIVE, "させる", "す", V1, V5),
    rule(CAUSATIVE, "たせる", "つ", V1, V5),
    rule(CAUSATIVE, "なせる", "ぬ", V1, V5),
    rule(CAUSATIVE, "ばせる", "ぶ", V1, V5),
    rule(CAUSATIVE, "ませる", "む", V1, V5),
    rule(CAUSATIVE, "らせる", "る", V1, V5),
    rule(CAUSATIVE, "わせる", "う", V1, V5),
    rule(CAUSATIVE, "はせる", "う", V1, V5),
    rule(CAUSATIVE, "じさせる", "ずる", V1, VZ),
    rule(CAUSATIVE, "ぜさせる", "ずる", V1, VZ),
    rule(CAUSATIVE, "させる", "する", V1, VS),
    rule(CAUSATIVE, "為せる", "為る", V1, VS),
    rule(CAUSATIVE, "せさせる", "する", V1, VS),
    rule(CAUSATIVE, "為させる", "為る", V1, VS),
    rule(CAUSATIVE, "こさせる", "くる", V1, VK),
    rule(CAUSATIVE, "来させる", "来る", V1, VK),
    rule(CAUSATIVE, "來させる", "來る", V1, VK),
    rule(SHORT_CAUSATIVE, "さす", "る", V5SS, V1),
    rule(SHORT_CAUSATIVE, "かす", "く", V5SP, V5),
    rule(SHORT_CAUSATIVE, "がす", "ぐ", V5SP, V5),
    rule(SHORT_CAUSATIVE, "さす", "す", V5SS, V5),
    rule(SHORT_CAUSATIVE, "たす", "つ", V5SP, V5),
    rule(SHORT_CAUSATIVE, "なす", "ぬ", V5SP, V5),
    rule(SHORT_CAUSATIVE, "ばす", "ぶ", V5SP, V5),
    rule(SHORT_CAUSATIVE, "ます", "む", V5SP, V5),
    rule(SHORT_CAUSATIVE, "らす", "る", V5SP, V5),
    rule(SHORT_CAUSATIVE, "わす", "う", V5SP, V5),
    rule(SHORT_CAUSATIVE, "はす", "う", V5SP, V5),
    rule(SHORT_CAUSATIVE, "じさす", "ずる", V5SS, VZ),
    rule(SHORT_CAUSATIVE, "ぜさす", "ずる", V5SS, VZ),
    rule(SHORT_CAUSATIVE, "さす", "する", V5SS, VS),
    rule(SHORT_CAUSATIVE, "為す", "為る", V5SS, VS),
    rule(SHORT_CAUSATIVE, "こさす", "くる", V5SS, VK),
    rule(SHORT_CAUSATIVE, "来さす", "来る", V5SS, VK),
    rule(SHORT_CAUSATIVE, "來さす", "來る", V5SS, VK),
    // The potential or passive られる, the potential, and the passive れる, reaching a godan verb (or a
    // short causative not ending in さす), each itself an ichidan verb. The potential or passive comes
    // first, so 来られる is 来る (potential or passive) rather than its passive.
    rule(POTENTIAL_OR_PASSIVE, "られる", "る", V1, V1),
    rule(POTENTIAL_OR_PASSIVE, "ざれる", "ずる", V1, VZ),
    rule(POTENTIAL_OR_PASSIVE, "ぜられる", "ずる", V1, VZ),
    rule(POTENTIAL_OR_PASSIVE, "せられる", "する", V1, VS),
    rule(POTENTIAL_OR_PASSIVE, "為られる", "為る", V1, VS),
    rule(POTENTIAL_OR_PASSIVE, "こられる", "くる", V1, VK),
    rule(POTENTIAL_OR_PASSIVE, "来られる", "来る", V1, VK),
    rule(POTENTIAL_OR_PASSIVE, "來られる", "來る", V1, VK),
    rule(POTENTIAL, "れる", "る", V1, V1 | V5D),
    rule(POTENTIAL, "える", "う", V1, V5D),
    rule(POTENTIAL, "ける", "く", V1, V5D),
    rule(POTENTIAL, "げる", "ぐ", V1, V5D),
    rule(POTENTIAL, "せる", "す", V1, V5D),
    rule(POTENTIAL, "てる", "つ", V1, V5D),
    rule(POTENTIAL, "ねる", "ぬ", V1, V5D),
    rule(POTENTIAL, "べる", "ぶ", V1, V5D),
    rule(POTENTIAL, "める", "む", V1, V5D),
    rule(POTENTIAL, "できる", "する", V1, VS),
    rule(POTENTIAL, "出来る", "する", V1, VS),
    rule(POTENTIAL, "これる", "くる", V1, VK),
    rule(POTENTIAL, "来れる", "来る", V1, VK),
    rule(POTENTIAL, "來れる", "來る", V1, VK),
    rule(PASSIVE, "かれる", "く", V1, V5),
    rule(PASSIVE, "がれる", "ぐ", V1, V5),
    rule(PASSIVE, "される", "す", V1, V5D | V5SP),
    rule(PASSIVE, "たれる", "つ", V1, V5),
    rule(PASSIVE, "なれる", "ぬ", V1, V5),
    rule(PASSIVE, "ばれる", "ぶ", V1, V5),
    rule(PASSIVE, "まれる", "む", V1, V5),
    rule(PASSIVE, "われる", "う", V1, V5),
    rule(PASSIVE, "はれる", "う", V1, V5),
    rule(PASSIVE, "られる", "る", V1, V5),
    rule(PASSIVE, "じされる", "ずる", V1, VZ),
    rule(PASSIVE, "ぜされる", "ずる", V1, VZ),
    rule(PASSIVE, "される", "する", V1, VS),
    rule(PASSIVE, "為れる", "為る", V1, VS),
    rule(PASSIVE, "こられる", "くる", V1, VK),
    rule(PASSIVE, "来られる", "来る", V1, VK),
    rule(PASSIVE, "來られる", "來る", V1, VK),
    // The imperative, and the negative imperative な after a dictionary form.
    rule(IMPERATIVE, "ろ", "る", 0, V1),
    rule(IMPERATIVE, "よ", "る", 0, V1),
    rule(IMPERATIVE, "え", "う", 0, V5),
    rule(IMPERATIVE, "へ", "う", 0, V5),
    rule(IMPERATIVE, "け", "く", 0, V5),
    rule(IMPERATIVE, "げ", "ぐ", 0, V5),
    rule(IMPERATIVE, "せ", "す", 0, V5),
    rule(IMPERATIVE, "て", "つ", 0, V5),
    rule(IMPERATIVE, "ね", "ぬ", 0, V5),
    rule(IMPERATIVE, "べ", "ぶ", 0, V5),
    rule(IMPERATIVE, "め", "む", 0, V5),
    rule(IMPERATIVE, "れ", "る", 0, V5),
    rule(IMPERATIVE, "じろ", "ずる", 0, VZ),
    rule(IMPERATIVE, "ぜよ", "ずる", 0, VZ),
    rule(IMPERATIVE, "しろ", "する", 0, VS),
    rule(IMPERATIVE, "せよ", "する", 0, VS),
    rule(IMPERATIVE, "為ろ", "為る", 0, VS),
    rule(IMPERATIVE, "為よ", "為る", 0, VS),
    rule(IMPERATIVE, "こい", "くる", 0, VK),
    rule(IMPERATIVE, "来い", "来る", 0, VK),
    rule(IMPERATIVE, "來い", "來る", 0, VK),
    rule(NEGATIVE_IMPERATIVE, "うな", "う", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "くな", "く", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "ぐな", "ぐ", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "すな", "す", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "つな", "つ", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "ぬな", "ぬ", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "ぶな", "ぶ", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "むな", "む", 0, V5),
    rule(NEGATIVE_IMPERATIVE, "るな", "る", 0, VERB),
    // The plain volitional う/よう and its slang っか.
    rule(VOLITIONAL, "よう", "る", 0, V1),
    rule(VOLITIONAL, "やう", "る", 0, V1),
    rule(VOLITIONAL, "おう", "う", 0, V5),
    rule(VOLITIONAL, "はう", "う", 0, V5),
    rule(VOLITIONAL, "こう", "く", 0, V5),
    rule(VOLITIONAL, "かう", "く", 0, V5),
    rule(VOLITIONAL, "ごう", "ぐ", 0, V5),
    rule(VOLITIONAL, "がう", "ぐ", 0, V5),
    rule(VOLITIONAL, "そう", "す", 0, V5),
    rule(VOLITIONAL, "さう", "す", 0, V5),
    rule(VOLITIONAL, "とう", "つ", 0, V5),
    rule(VOLITIONAL, "たう", "つ", 0, V5),
    rule(VOLITIONAL, "のう", "ぬ", 0, V5),
    rule(VOLITIONAL, "なう", "ぬ", 0, V5),
    rule(VOLITIONAL, "ぼう", "ぶ", 0, V5),
    rule(VOLITIONAL, "ばう", "ぶ", 0, V5),
    rule(VOLITIONAL, "もう", "む", 0, V5),
    rule(VOLITIONAL, "まう", "む", 0, V5),
    rule(VOLITIONAL, "ろう", "る", 0, V5),
    rule(VOLITIONAL, "らう", "る", 0, V5),
    rule(VOLITIONAL, "じよう", "ずる", 0, VZ),
    rule(VOLITIONAL, "じやう", "ずる", 0, VZ),
    rule(VOLITIONAL, "しよう", "する", 0, VS),
    rule(VOLITIONAL, "しやう", "する", 0, VS),
    rule(VOLITIONAL, "為よう", "為る", 0, VS),
    rule(VOLITIONAL, "為やう", "為る", 0, VS),
    rule(VOLITIONAL, "こよう", "くる", 0, VK),
    rule(VOLITIONAL, "こやう", "くる", 0, VK),
    rule(VOLITIONAL, "来よう", "来る", 0, VK),
    rule(VOLITIONAL, "来やう", "来る", 0, VK),
    rule(VOLITIONAL, "來よう", "來る", 0, VK),
    rule(VOLITIONAL, "來やう", "來る", 0, VK),
    rule(VOLITIONAL, "ませう", "ます", 0, MASU),
    rule(VOLITIONAL, "かろう", "い", 0, ADJ_I),
    rule(VOLITIONAL, "からう", "い", 0, ADJ_I),
    rule(VOLITIONAL_SLANG, "よっか", "る", 0, V1),
    rule(VOLITIONAL_SLANG, "おっか", "う", 0, V5),
    rule(VOLITIONAL_SLANG, "こっか", "く", 0, V5),
    rule(VOLITIONAL_SLANG, "ごっか", "ぐ", 0, V5),
    rule(VOLITIONAL_SLANG, "そっか", "す", 0, V5),
    rule(VOLITIONAL_SLANG, "とっか", "つ", 0, V5),
    rule(VOLITIONAL_SLANG, "のっか", "ぬ", 0, V5),
    rule(VOLITIONAL_SLANG, "ぼっか", "ぶ", 0, V5),
    rule(VOLITIONAL_SLANG, "もっか", "む", 0, V5),
    rule(VOLITIONAL_SLANG, "ろっか", "る", 0, V5),
    rule(VOLITIONAL_SLANG, "じよっか", "ずる", 0, VZ),
    rule(VOLITIONAL_SLANG, "しよっか", "する", 0, VS),
    rule(VOLITIONAL_SLANG, "為よっか", "為る", 0, VS),
    rule(VOLITIONAL_SLANG, "こよっか", "くる", 0, VK),
    rule(VOLITIONAL_SLANG, "来よっか", "来る", 0, VK),
    rule(VOLITIONAL_SLANG, "來よっか", "來る", 0, VK),
    rule(VOLITIONAL_SLANG, "ましょっか", "ます", 0, MASU),
    // The continuative (ます stem): an ichidan verb's is its dictionary form without る, so it gives
    // the ichidan dictionary form apart from the progressive's contracted てる/でる.
    rule(CONTINUATIVE, "い", "いる", 0, V1D),
    rule(CONTINUATIVE, "え", "える", 0, V1D),
    rule(CONTINUATIVE, "き", "きる", 0, V1D),
    rule(CONTINUATIVE, "ぎ", "ぎる", 0, V1D),
    rule(CONTINUATIVE, "け", "ける", 0, V1D),
    rule(CONTINUATIVE, "げ", "げる", 0, V1D),
    rule(CONTINUATIVE, "じ", "じる", 0, V1D),
    rule(CONTINUATIVE, "せ", "せる", 0, V1D),
    rule(CONTINUATIVE, "ぜ", "ぜる", 0, V1D),
    rule(CONTINUATIVE, "ち", "ちる", 0, V1D),
    rule(CONTINUATIVE, "て", "てる", 0, V1D),
    rule(CONTINUATIVE, "で", "でる", 0, V1D),
    rule(CONTINUATIVE, "に", "にる", 0, V1D),
    rule(CONTINUATIVE, "ね", "ねる", 0, V1D),
    rule(CONTINUATIVE, "ひ", "ひる", 0, V1D),
    rule(CONTINUATIVE, "び", "びる", 0, V1D),
    rule(CONTINUATIVE, "へ", "へる", 0, V1D),
    rule(CONTINUATIVE, "べ", "べる", 0, V1D),
    rule(CONTINUATIVE, "み", "みる", 0, V1D),
    rule(CONTINUATIVE, "め", "める", 0, V1D),
    rule(CONTINUATIVE, "り", "りる", 0, V1D),
    rule(CONTINUATIVE, "れ", "れる", 0, V1D),
    rule(CONTINUATIVE, "い", "う", 0, V5),
    rule(CONTINUATIVE, "ひ", "う", 0, V5),
    rule(CONTINUATIVE, "き", "く", 0, V5),
    rule(CONTINUATIVE, "ぎ", "ぐ", 0, V5),
    rule(CONTINUATIVE, "し", "す", 0, V5),
    rule(CONTINUATIVE, "ち", "つ", 0, V5),
    rule(CONTINUATIVE, "に", "ぬ", 0, V5),
    rule(CONTINUATIVE, "び", "ぶ", 0, V5),
    rule(CONTINUATIVE, "み", "む", 0, V5),
    rule(CONTINUATIVE, "り", "る", 0, V5),
    rule(CONTINUATIVE, "き", "くる", 0, VK),
    rule(CONTINUATIVE, "し", "する", 0, VS),
    rule(CONTINUATIVE, "来", "来る", 0, VK),
    rule(CONTINUATIVE, "來", "來る", 0, VK),
    // The archaic む, the historical ふ spelling of a dictionary form in う, and an i-adjective's
    // attributive き.
    rule(MU, "む", "る", 0, V1),
    rule(MU, "かむ", "く", 0, V5),
    rule(MU, "がむ", "ぐ", 0, V5),
    rule(MU, "さむ", "す", 0, V5),
    rule(MU, "たむ", "つ", 0, V5),
    rule(MU, "なむ", "ぬ", 0, V5),
    rule(MU, "ばむ", "ぶ", 0, V5),
    rule(MU, "まむ", "む", 0, V5),
    rule(MU, "らむ", "る", 0, V5),
    rule(MU, "わむ", "う", 0, V5),
    rule(MU, "はむ", "う", 0, V5),
    rule(MU, "ぜむ", "ずる", 0, VZ),
    rule(MU, "せむ", "する", 0, VS),
    rule(MU, "為む", "為る", 0, VS),
    rule(MU, "こむ", "くる", 0, VK),
    rule(MU, "来む", "来る", 0, VK),
    rule(MU, "來む", "來る", 0, VK),
    rule(FU, "ふ", "う", 0, V5),
    rule(ATTRIBUTIVE, "き", "い", 0, ADJ_I),
    // Slang: an i-adjective's sound change え (すげえ), r-column syllables before n (やんなきゃ), and
    // the negative imperative んな.
    rule(E_SLANG, "ねえ", "ない", 0, ADJ_I),
    rule(E_SLANG, "めえ", "むい", 0, ADJ_I),
    rule(E_SLANG, "みい", "むい", 0, ADJ_I),
    rule(E_SLANG, "ちぇえ", "つい", 0, ADJ_I),
    rule(E_SLANG, "ちい", "つい", 0, ADJ_I),
    rule(E_SLANG, "せえ", "すい", 0, ADJ_I),
    rule(E_SLANG, "ええ", "いい", 0, ADJ_I),
    rule(E_SLANG, "ええ", "わい", 0, ADJ_I),
    rule(E_SLANG, "ええ", "よい", 0, ADJ_I),
    rule(E_SLANG, "いぇえ", "よい", 0, ADJ_I),
    rule(E_SLANG, "うぇえ", "わい", 0, ADJ_I),
    rule(E_SLANG, "けえ", "かい", 0, ADJ_I),
    rule(E_SLANG, "げえ", "がい", 0, ADJ_I),
    rule(E_SLANG, "げえ", "ごい", 0, ADJ_I),
    rule(E_SLANG, "せえ", "さい", 0, ADJ_I),
    rule(E_SLANG, "めえ", "まい", 0, ADJ_I),
    rule(E_SLANG, "ぜえ", "ずい", 0, ADJ_I),
    rule(E_SLANG, "っぜえ", "ずい", 0, ADJ_I),
    rule(E_SLANG, "れえ", "らい", 0, ADJ_I),
    rule(E_SLANG, "ちぇえ", "ちゃい", 0, ADJ_I),
    rule(E_SLANG, "でえ", "どい", 0, ADJ_I),
    rule(E_SLANG, "れえ", "れい", 0, ADJ_I),
    rule(E_SLANG, "べえ", "ばい", 0, ADJ_I),
    rule(E_SLANG, "てえ", "たい", 0, ADJ_I),
    rule(E_SLANG, "ねぇ", "ない", 0, ADJ_I),
    rule(E_SLANG, "めぇ", "むい", 0, ADJ_I),
    rule(E_SLANG, "みぃ", "むい", 0, ADJ_I),
    rule(E_SLANG, "ちぃ", "つい", 0, ADJ_I),
    rule(E_SLANG, "せぇ", "すい", 0, ADJ_I),
    rule(E_SLANG, "けぇ", "かい", 0, ADJ_I),
    rule(E_SLANG, "げぇ", "がい", 0, ADJ_I),
    rule(E_SLANG, "げぇ", "ごい", 0, ADJ_I),
    rule(E_SLANG, "せぇ", "さい", 0, ADJ_I),
    rule(E_SLANG, "めぇ", "まい", 0, ADJ_I),
    rule(E_SLANG, "ぜぇ", "ずい", 0, ADJ_I),
    rule(E_SLANG, "っぜぇ", "ずい", 0, ADJ_I),
    rule(E_SLANG, "れぇ", "らい", 0, ADJ_I),
    rule(E_SLANG, "でぇ", "どい", 0, ADJ_I),
    rule(E_SLANG, "れぇ", "れい", 0, ADJ_I),
    rule(E_SLANG, "べぇ", "ばい", 0, ADJ_I),
    rule(E_SLANG, "てぇ", "たい", 0, ADJ_I),
    rule(N_SLANG, "んなさい", "りなさい", 0, NASAI_FORM),
    rule(N_SLANG, "らんない", "られない", ADJ_I, ADJ_I),
    rule(N_SLANG, "んない", "らない", ADJ_I, ADJ_I),
    rule(N_SLANG, "んなきゃ", "らなきゃ", 0, YA_FORM),
    rule(N_SLANG, "んなきゃ", "れなきゃ", 0, YA_FORM),
    rule(NEGATIVE_IMPERATIVE_SLANG, "んな", "る", 0, VERB),
    // Kansai-ben: the negative へん/ひん, the verb て, た, たら, and たり forms (買うた), and an
    // i-adjective's く, て, and negative forms (よう, 高うて); its adjective て form is the only one
    // besides the searched text that an i-adjective's くて takes.
    rule(KANSAI_BEN, "へん", "ない", 0, ADJ_I),
    rule(KANSAI_BEN, "ひん", "ない", 0, ADJ_I),
    rule(KANSAI_BEN, "せえへん", "しない", 0, ADJ_I),
    rule(KANSAI_BEN, "へんかった", "なかった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ひんかった", "なかった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "うてへん", "ってない", 0, ADJ_I),
    rule(KANSAI_BEN, "うて", "って", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "おうて", "あって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "こうて", "かって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ごうて", "がって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "そうて", "さって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ぞうて", "ざって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "とうて", "たって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "どうて", "だって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "のうて", "なって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ほうて", "はって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ぼうて", "ばって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "もうて", "まって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ろうて", "らって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ようて", "やって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "ゆうて", "いって", TE_FORM, TE_FORM),
    rule(KANSAI_BEN, "うた", "った", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "おうた", "あった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "こうた", "かった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ごうた", "がった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "そうた", "さった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ぞうた", "ざった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "とうた", "たった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "どうた", "だった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "のうた", "なった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ほうた", "はった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ぼうた", "ばった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "もうた", "まった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ろうた", "らった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ようた", "やった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "ゆうた", "いった", TA_FORM, TA_FORM),
    rule(KANSAI_BEN, "うたら", "ったら", 0, 0),
    rule(KANSAI_BEN, "おうたら", "あったら", 0, 0),
    rule(KANSAI_BEN, "こうたら", "かったら", 0, 0),
    rule(KANSAI_BEN, "ごうたら", "がったら", 0, 0),
    rule(KANSAI_BEN, "そうたら", "さったら", 0, 0),
    rule(KANSAI_BEN, "ぞうたら", "ざったら", 0, 0),
    rule(KANSAI_BEN, "とうたら", "たったら", 0, 0),
    rule(KANSAI_BEN, "どうたら", "だったら", 0, 0),
    rule(KANSAI_BEN, "のうたら", "なったら", 0, 0),
    rule(KANSAI_BEN, "ほうたら", "はったら", 0, 0),
    rule(KANSAI_BEN, "ぼうたら", "ばったら", 0, 0),
    rule(KANSAI_BEN, "もうたら", "まったら", 0, 0),
    rule(KANSAI_BEN, "ろうたら", "らったら", 0, 0),
    rule(KANSAI_BEN, "ようたら", "やったら", 0, 0),
    rule(KANSAI_BEN, "ゆうたら", "いったら", 0, 0),
    rule(KANSAI_BEN, "うたり", "ったり", 0, 0),
    rule(KANSAI_BEN, "おうたり", "あったり", 0, 0),
    rule(KANSAI_BEN, "こうたり", "かったり", 0, 0),
    rule(KANSAI_BEN, "ごうたり", "がったり", 0, 0),
    rule(KANSAI_BEN, "そうたり", "さったり", 0, 0),
    rule(KANSAI_BEN, "ぞうたり", "ざったり", 0, 0),
    rule(KANSAI_BEN, "とうたり", "たったり", 0, 0),
    rule(KANSAI_BEN, "どうたり", "だったり", 0, 0),
    rule(KANSAI_BEN, "のうたり", "なったり", 0, 0),
    rule(KANSAI_BEN, "ほうたり", "はったり", 0, 0),
    rule(KANSAI_BEN, "ぼうたり", "ばったり", 0, 0),
    rule(KANSAI_BEN, "もうたり", "まったり", 0, 0),
    rule(KANSAI_BEN, "ろうたり", "らったり", 0, 0),
    rule(KANSAI_BEN, "ようたり", "やったり", 0, 0),
    rule(KANSAI_BEN, "ゆうたり", "いったり", 0, 0),
    rule(KANSAI_BEN, "う", "く", 0, KU_FORM),
    rule(KANSAI_BEN, "こう", "かく", 0, KU_FORM),
    rule(KANSAI_BEN, "ごう", "がく", 0, KU_FORM),
    rule(KANSAI_BEN, "そう", "さく", 0, KU_FORM),
    rule(KANSAI_BEN, "とう", "たく", 0, KU_FORM),
    rule(KANSAI_BEN, "のう", "なく", 0, KU_FORM),
    rule(KANSAI_BEN, "ぼう", "ばく", 0, KU_FORM),
    rule(KANSAI_BEN, "もう", "まく", 0, KU_FORM),
    rule(KANSAI_BEN, "ろう", "らく", 0, KU_FORM),
    rule(KANSAI_BEN, "よう", "よく", 0, KU_FORM),
    rule(KANSAI_BEN, "しゅう", "しく", 0, KU_FORM),
    rule(KANSAI_BEN, "うて", "くて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "こうて", "かくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "ごうて", "がくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "そうて", "さくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "とうて", "たくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "のうて", "なくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "ぼうて", "ばくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "もうて", "まくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "ろうて", "らくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "ようて", "よくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "しゅうて", "しくて", TE_FORM, KUTE_FORM),
    rule(KANSAI_BEN, "うない", "くない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "こうない", "かくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "ごうない", "がくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "そうない", "さくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "とうない", "たくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "のうない", "なくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "ぼうない", "ばくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "もうない", "まくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "ろうない", "らくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "ようない", "よくない", ADJ_I, ADJ_I),
    rule(KANSAI_BEN, "しゅうない", "しくない", ADJ_I, ADJ_I),
];

/// The rules by the last character of their inflected form, each list in table order with the
/// first rules before the others, marking which are first rules.
struct RuleSet<'a> {
    by_last: HashMap<char, Vec<(bool, &'a Rule)>>,
}

impl<'a> RuleSet<'a> {
    fn new(first: &'a [Rule], more: &'a [Rule]) -> Self {
        let mut by_last: HashMap<char, Vec<(bool, &'a Rule)>> = HashMap::new();
        let tagged = first
            .iter()
            .map(|rule| (true, rule))
            .chain(more.iter().map(|rule| (false, rule)));
        for (is_first, rule) in tagged {
            let last = rule
                .inflected
                .chars()
                .next_back()
                .expect("an inflected form");
            by_last.entry(last).or_default().push((is_first, rule));
        }
        Self { by_last }
    }
}

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(FIRST_RULES, MORE_RULES));

/// A form the searched text may be an inflection of.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) text: String,
    /// The word classes it can have; only `DICTIONARY_FORMS` can match a term.
    pub(crate) classes: u32,
    /// The inflections applied, from the candidate outward to the searched text.
    pub(crate) inflections: Vec<&'static str>,
}

/// The forms `text` may be an inflection of, at most `MAX_CANDIDATES` of them, each at most
/// `MAX_STEPS` rules away: fewest steps first; within a step, those reached through the first
/// rules alone, then the others, each in the order of the texts they came from and then in rule
/// order. A form reached again with the same classes is listed once, the first way. The text
/// itself is not one.
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

fn deinflect_bounded(
    text: &str,
    rules: &RuleSet,
    max_steps: usize,
    max_candidates: usize,
) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<(String, u32)> = HashSet::new();
    // Each text to deinflect further, and whether only first rules reached it.
    let mut frontier = vec![(
        Candidate {
            text: text.to_owned(),
            classes: 0,
            inflections: Vec::new(),
        },
        true,
    )];
    for _ in 0..max_steps {
        let mut next = Vec::new();
        for first_pass in [true, false] {
            for (current, current_first) in &frontier {
                if first_pass && !current_first {
                    continue;
                }
                let Some(last) = current.text.chars().next_back() else {
                    continue;
                };
                let Some(matching) = rules.by_last.get(&last) else {
                    continue;
                };
                for &(rule_first, rule) in matching {
                    if (*current_first && rule_first) != first_pass
                        || (current.classes & rule.applies_to == 0 && current.classes != 0)
                    {
                        continue;
                    }
                    let Some(stem) = current.text.strip_suffix(rule.inflected) else {
                        continue;
                    };
                    if rule.whole_word && !stem.is_empty() {
                        continue;
                    }
                    let text = format!("{stem}{}", rule.base);
                    if !seen.insert((text.clone(), rule.gives)) {
                        continue;
                    }
                    let mut inflections = vec![rule.name];
                    inflections.extend(&current.inflections);
                    let candidate = Candidate {
                        text,
                        classes: rule.gives,
                        inflections,
                    };
                    candidates.push(candidate.clone());
                    if candidates.len() == max_candidates {
                        return candidates;
                    }
                    next.push((candidate, first_pass));
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    candidates
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

    /// The dictionary-form texts reached through the first rules alone, in candidate order.
    fn first_forms(text: &str) -> Vec<String> {
        let first = deinflect_bounded(
            text,
            &RuleSet::new(FIRST_RULES, &[]),
            MAX_STEPS,
            MAX_CANDIDATES,
        );
        deinflect(text)
            .into_iter()
            .filter(|candidate| {
                candidate.classes & DICTIONARY_FORMS != 0 && first.contains(candidate)
            })
            .map(|candidate| candidate.text)
            .collect()
    }

    #[test]
    fn each_supported_ending_reaches_its_dictionary_form() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            ("読んだ", "読む", V5, &[PAST]),
            ("遊んだ", "遊ぶ", V5, &[PAST]),
            ("死んだ", "死ぬ", V5, &[PAST]),
            ("書いた", "書く", V5, &[PAST]),
            ("泳いだ", "泳ぐ", V5, &[PAST]),
            ("話した", "話す", V5, &[PAST]),
            ("買った", "買う", V5, &[PAST]),
            ("待った", "待つ", V5, &[PAST]),
            ("取った", "取る", V5, &[PAST]),
            ("行った", "行く", V5, &[PAST]),
            ("いった", "いく", V5, &[PAST]),
            ("食べた", "食べる", V1, &[PAST]),
            ("来た", "来る", VK, &[PAST]),
            ("きた", "くる", VK, &[PAST]),
            ("勉強した", "勉強する", VS, &[PAST]),
            ("読んで", "読む", V5, &[TE]),
            ("書いて", "書く", V5, &[TE]),
            ("泳いで", "泳ぐ", V5, &[TE]),
            ("話して", "話す", V5, &[TE]),
            ("待って", "待つ", V5, &[TE]),
            ("行って", "行く", V5, &[TE]),
            ("いって", "いく", V5, &[TE]),
            ("食べて", "食べる", V1, &[TE]),
            ("来て", "来る", VK, &[TE]),
            ("して", "する", VS, &[TE]),
            ("読まない", "読む", V5, &[NEGATIVE]),
            ("買わない", "買う", V5, &[NEGATIVE]),
            ("書かない", "書く", V5, &[NEGATIVE]),
            ("泳がない", "泳ぐ", V5, &[NEGATIVE]),
            ("話さない", "話す", V5, &[NEGATIVE]),
            ("待たない", "待つ", V5, &[NEGATIVE]),
            ("死なない", "死ぬ", V5, &[NEGATIVE]),
            ("遊ばない", "遊ぶ", V5, &[NEGATIVE]),
            ("取らない", "取る", V5, &[NEGATIVE]),
            ("食べない", "食べる", V1, &[NEGATIVE]),
            ("来ない", "来る", VK, &[NEGATIVE]),
            ("こない", "くる", VK, &[NEGATIVE]),
            ("しない", "する", VS, &[NEGATIVE]),
            ("読みます", "読む", V5D, &[POLITE]),
            ("書きます", "書く", V5D, &[POLITE]),
            ("泳ぎます", "泳ぐ", V5D, &[POLITE]),
            ("話します", "話す", V5D | V5S, &[POLITE]),
            ("買います", "買う", V5D, &[POLITE]),
            ("待ちます", "待つ", V5D, &[POLITE]),
            ("死にます", "死ぬ", V5D, &[POLITE]),
            ("遊びます", "遊ぶ", V5D, &[POLITE]),
            ("取ります", "取る", V5D, &[POLITE]),
            ("食べます", "食べる", V1, &[POLITE]),
            ("来ます", "来る", VK, &[POLITE]),
            ("きます", "くる", VK, &[POLITE]),
            ("勉強します", "勉強する", VS, &[POLITE]),
            ("読みました", "読む", V5D, &[POLITE, PAST]),
            ("読みません", "読む", V5D, &[POLITE, NEGATIVE]),
            ("読みませんでした", "読む", V5D, &[POLITE, NEGATIVE, PAST]),
            ("読みましょう", "読む", V5D, &[POLITE, VOLITIONAL]),
            ("読みまして", "読む", V5D, &[POLITE, TE]),
            ("高かった", "高い", ADJ_I, &[PAST]),
            ("高くない", "高い", ADJ_I, &[NEGATIVE]),
            ("高くて", "高い", ADJ_I, &[TE]),
            ("高くなかった", "高い", ADJ_I, &[NEGATIVE, PAST]),
            ("読まなかった", "読む", V5, &[NEGATIVE, PAST]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
    }

    #[test]
    fn the_progressive_reaches_the_verbs_dictionary_form_through_its_te_form() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            ("読んでいる", "読む", V5, &[TE, PROGRESSIVE]),
            ("書いている", "書く", V5, &[TE, PROGRESSIVE]),
            ("泳いでいる", "泳ぐ", V5, &[TE, PROGRESSIVE]),
            ("待っている", "待つ", V5, &[TE, PROGRESSIVE]),
            ("行っている", "行く", V5, &[TE, PROGRESSIVE]),
            ("食べている", "食べる", V1, &[TE, PROGRESSIVE]),
            ("来ている", "来る", VK, &[TE, PROGRESSIVE]),
            ("きている", "くる", VK, &[TE, PROGRESSIVE]),
            ("している", "する", VS, &[TE, PROGRESSIVE]),
            ("勉強している", "勉強する", VS, &[TE, PROGRESSIVE]),
            // Contracted てる/でる.
            ("読んでる", "読む", V5, &[TE, PROGRESSIVE]),
            ("食べてる", "食べる", V1, &[TE, PROGRESSIVE]),
            ("勉強してる", "勉強する", VS, &[TE, PROGRESSIVE]),
            // Inflecting like the ichidan いる, through the polite, past, and negative rules.
            ("読んでいた", "読む", V5, &[TE, PROGRESSIVE, PAST]),
            ("読んでた", "読む", V5, &[TE, PROGRESSIVE, PAST]),
            ("食べています", "食べる", V1, &[TE, PROGRESSIVE, POLITE]),
            ("読んでます", "読む", V5, &[TE, PROGRESSIVE, POLITE]),
            ("読んでいない", "読む", V5, &[TE, PROGRESSIVE, NEGATIVE]),
            (
                "読んでいました",
                "読む",
                V5,
                &[TE, PROGRESSIVE, POLITE, PAST],
            ),
            (
                "読んでいません",
                "読む",
                V5,
                &[TE, PROGRESSIVE, POLITE, NEGATIVE],
            ),
            (
                "読んでいなかった",
                "読む",
                V5,
                &[TE, PROGRESSIVE, NEGATIVE, PAST],
            ),
            (
                "勉強していました",
                "勉強する",
                VS,
                &[TE, PROGRESSIVE, POLITE, PAST],
            ),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        // The て form it leaves is not a dictionary form, and only a verb's て rules take it
        // further, in rule order: an i-adjective's くて and the polite まして are not.
        assert_eq!(
            deinflect("読んでいる")[0],
            Candidate {
                text: "読んで".into(),
                classes: TE_FORM,
                inflections: vec![PROGRESSIVE],
            }
        );
        assert_eq!(first_forms("読んでいる"), ["読む", "読ぶ", "読ぬ"]);
        assert_eq!(first_forms("きている"), ["くる", "きる"]);
        assert!(!forms("高くている").iter().any(|(text, ..)| text == "高い"));
        assert!(!forms("読みましている")
            .iter()
            .any(|(text, ..)| text == "読む"));
        // Five and six steps are followed, seven are not.
        assert!(has(
            "読んでいませんでした",
            "読む",
            V5,
            &[TE, PROGRESSIVE, POLITE, NEGATIVE, PAST]
        ));
        assert!(!forms("読んでしまっていませんでした")
            .iter()
            .any(|(text, ..)| text == "読む"));
    }

    #[test]
    fn the_completive_reaches_the_verbs_dictionary_form() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // てしまう/でしまう, through the verb's て form.
            ("読んでしまう", "読む", V5, &[TE, COMPLETIVE]),
            ("書いてしまう", "書く", V5, &[TE, COMPLETIVE]),
            ("泳いでしまう", "泳ぐ", V5, &[TE, COMPLETIVE]),
            ("忘れてしまう", "忘れる", V1, &[TE, COMPLETIVE]),
            ("来てしまう", "来る", VK, &[TE, COMPLETIVE]),
            ("きてしまう", "くる", VK, &[TE, COMPLETIVE]),
            ("してしまう", "する", VS, &[TE, COMPLETIVE]),
            ("勉強してしまう", "勉強する", VS, &[TE, COMPLETIVE]),
            // Inflecting like the godan しまう, through the past, polite, and negative rules.
            ("読んでしまった", "読む", V5, &[TE, COMPLETIVE, PAST]),
            ("食べてしまいます", "食べる", V1, &[TE, COMPLETIVE, POLITE]),
            ("読んでしまわない", "読む", V5, &[TE, COMPLETIVE, NEGATIVE]),
            (
                "読んでしまいました",
                "読む",
                V5,
                &[TE, COMPLETIVE, POLITE, PAST],
            ),
            (
                "読んでしまわなかった",
                "読む",
                V5,
                &[TE, COMPLETIVE, NEGATIVE, PAST],
            ),
            (
                "勉強してしまいました",
                "勉強する",
                VS,
                &[TE, COMPLETIVE, POLITE, PAST],
            ),
            // Contracted ちゃう/じゃう, directly.
            ("読んじゃう", "読む", V5, &[COMPLETIVE]),
            ("遊んじゃう", "遊ぶ", V5, &[COMPLETIVE]),
            ("死んじゃう", "死ぬ", V5, &[COMPLETIVE]),
            ("書いちゃう", "書く", V5, &[COMPLETIVE]),
            ("泳いじゃう", "泳ぐ", V5, &[COMPLETIVE]),
            ("話しちゃう", "話す", V5, &[COMPLETIVE]),
            ("買っちゃう", "買う", V5, &[COMPLETIVE]),
            ("待っちゃう", "待つ", V5, &[COMPLETIVE]),
            ("取っちゃう", "取る", V5, &[COMPLETIVE]),
            ("行っちゃう", "行く", V5, &[COMPLETIVE]),
            ("いっちゃう", "いく", V5, &[COMPLETIVE]),
            ("食べちゃう", "食べる", V1, &[COMPLETIVE]),
            ("来ちゃう", "来る", VK, &[COMPLETIVE]),
            ("きちゃう", "くる", VK, &[COMPLETIVE]),
            ("しちゃう", "する", VS, &[COMPLETIVE]),
            ("勉強しちゃう", "勉強する", VS, &[COMPLETIVE]),
            ("忘れちゃった", "忘れる", V1, &[COMPLETIVE, PAST]),
            ("読んじゃった", "読む", V5, &[COMPLETIVE, PAST]),
            ("食べちゃいます", "食べる", V1, &[COMPLETIVE, POLITE]),
            ("食べちゃわない", "食べる", V1, &[COMPLETIVE, NEGATIVE]),
            (
                "勉強しちゃいました",
                "勉強する",
                VS,
                &[COMPLETIVE, POLITE, PAST],
            ),
            // With the progressive: its て form is the godan しまう's.
            (
                "読んでしまっている",
                "読む",
                V5,
                &[TE, COMPLETIVE, TE, PROGRESSIVE],
            ),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        // てしまう leaves the て form, which is not a dictionary form, and the verb て rules take
        // it further in rule order.
        assert_eq!(
            deinflect("読んでしまう")[0],
            Candidate {
                text: "読んで".into(),
                classes: TE_FORM,
                inflections: vec![COMPLETIVE],
            }
        );
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        assert_eq!(first_forms("読んでしまう"), ["読む", "読ぶ", "読ぬ"]);
        assert_eq!(first_forms("きてしまう"), ["くる", "きる"]);
        // Past forms come before the completive they chain through; the contracted forms follow
        // the て rules' order.
        assert_eq!(
            first_forms("読んでしまった"),
            [
                "読んでしまう",
                "読んでしまつ",
                "読んでしまる",
                "読んでしまっる",
                "読む",
                "読ぶ",
                "読ぬ"
            ]
        );
        assert_eq!(first_forms("読んじゃう"), ["読む", "読ぶ", "読ぬ"]);
        assert_eq!(
            first_forms("行っちゃう"),
            ["行く", "行う", "行つ", "行る", "行っる"]
        );
        assert_eq!(first_forms("きちゃう"), ["くる", "きる"]);
        assert_eq!(first_forms("しちゃう"), ["する", "す", "しる"]);
        // Not an i-adjective's くて or the polite まして, and not without a verb's て.
        assert!(!texts("高くてしまう").contains(&"高い".to_owned()));
        assert!(!texts("読みましてしまう").contains(&"読む".to_owned()));
        assert!(deinflect("しまう")
            .iter()
            .all(|candidate| !candidate.inflections.contains(&COMPLETIVE)));
        // Five steps are followed, seven are not.
        assert!(has(
            "読んでしまいませんでした",
            "読む",
            V5,
            &[TE, COMPLETIVE, POLITE, NEGATIVE, PAST]
        ));
        assert!(!texts("読んでしまっていませんでした").contains(&"読む".to_owned()));
    }

    #[test]
    fn the_preparatory_reaches_the_verbs_dictionary_form_through_its_te_form() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // ておく/でおく.
            ("読んでおく", "読む", V5, &[TE, PREPARATORY]),
            ("書いておく", "書く", V5, &[TE, PREPARATORY]),
            ("泳いでおく", "泳ぐ", V5, &[TE, PREPARATORY]),
            ("買っておく", "買う", V5, &[TE, PREPARATORY]),
            ("行っておく", "行く", V5, &[TE, PREPARATORY]),
            ("食べておく", "食べる", V1, &[TE, PREPARATORY]),
            ("来ておく", "来る", VK, &[TE, PREPARATORY]),
            ("きておく", "くる", VK, &[TE, PREPARATORY]),
            ("しておく", "する", VS, &[TE, PREPARATORY]),
            ("勉強しておく", "勉強する", VS, &[TE, PREPARATORY]),
            // Inflecting like the godan おく, through the past, polite, and negative rules.
            ("買っておいた", "買う", V5, &[TE, PREPARATORY, PAST]),
            ("読んでおきます", "読む", V5, &[TE, PREPARATORY, POLITE]),
            ("読んでおかない", "読む", V5, &[TE, PREPARATORY, NEGATIVE]),
            (
                "読んでおきました",
                "読む",
                V5,
                &[TE, PREPARATORY, POLITE, PAST],
            ),
            (
                "読んでおかなかった",
                "読む",
                V5,
                &[TE, PREPARATORY, NEGATIVE, PAST],
            ),
            (
                "勉強しておきます",
                "勉強する",
                VS,
                &[TE, PREPARATORY, POLITE],
            ),
            // Contracted とく/どく, through the verb's て form too.
            ("書いとく", "書く", V5, &[TE, PREPARATORY]),
            ("読んどく", "読む", V5, &[TE, PREPARATORY]),
            ("遊んどく", "遊ぶ", V5, &[TE, PREPARATORY]),
            ("泳いどく", "泳ぐ", V5, &[TE, PREPARATORY]),
            ("話しとく", "話す", V5, &[TE, PREPARATORY]),
            ("待っとく", "待つ", V5, &[TE, PREPARATORY]),
            ("行っとく", "行く", V5, &[TE, PREPARATORY]),
            ("置いとく", "置く", V5, &[TE, PREPARATORY]),
            ("食べとく", "食べる", V1, &[TE, PREPARATORY]),
            ("来とく", "来る", VK, &[TE, PREPARATORY]),
            ("きとく", "くる", VK, &[TE, PREPARATORY]),
            ("しとく", "する", VS, &[TE, PREPARATORY]),
            ("勉強しとく", "勉強する", VS, &[TE, PREPARATORY]),
            ("書いといた", "書く", V5, &[TE, PREPARATORY, PAST]),
            ("読んどいた", "読む", V5, &[TE, PREPARATORY, PAST]),
            ("書いときます", "書く", V5, &[TE, PREPARATORY, POLITE]),
            ("書いとかない", "書く", V5, &[TE, PREPARATORY, NEGATIVE]),
            // Through its own て form, with the progressive and the completive.
            ("書いといて", "書く", V5, &[TE, PREPARATORY, TE]),
            (
                "読んでおいている",
                "読む",
                V5,
                &[TE, PREPARATORY, TE, PROGRESSIVE],
            ),
            (
                "読んでおいてしまう",
                "読む",
                V5,
                &[TE, PREPARATORY, TE, COMPLETIVE],
            ),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        // Both leave the て form, which is not a dictionary form, and the verb て rules take it
        // further in rule order.
        for (text, te) in [("読んでおく", "読んで"), ("書いとく", "書いて")] {
            assert_eq!(
                deinflect(text)[0],
                Candidate {
                    text: te.into(),
                    classes: TE_FORM,
                    inflections: vec![PREPARATORY],
                },
                "{text}"
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        assert_eq!(first_forms("読んでおく"), ["読む", "読ぶ", "読ぬ"]);
        assert_eq!(first_forms("読んどく"), ["読む", "読ぶ", "読ぬ"]);
        assert_eq!(first_forms("書いとく"), ["書く", "書いる"]);
        assert_eq!(first_forms("きとく"), ["くる", "きる"]);
        assert_eq!(first_forms("しとく"), ["する", "す", "しる"]);
        // Past forms come before the preparatory they chain through.
        assert_eq!(
            first_forms("買っておいた"),
            [
                "買っておく",
                "買っておいる",
                "買う",
                "買つ",
                "買る",
                "買っる"
            ]
        );
        // Not an i-adjective's くて or the polite まして, and not without a verb's て.
        assert!(!texts("高くておく").contains(&"高い".to_owned()));
        assert!(!texts("読みましておく").contains(&"読む".to_owned()));
        assert!(!texts("読みましとく").contains(&"読む".to_owned()));
        assert!(deinflect("おく")
            .iter()
            .all(|candidate| !candidate.inflections.contains(&PREPARATORY)));
        // Five steps are followed, seven are not.
        assert!(has(
            "読んでおきませんでした",
            "読む",
            V5,
            &[TE, PREPARATORY, POLITE, NEGATIVE, PAST]
        ));
        assert!(!texts("読んでおいていませんでした").contains(&"読む".to_owned()));
    }

    /// The rule set before the added transforms, as it was: its candidates and their order
    /// must be unchanged.
    #[rustfmt::skip]
    const OLD_RULES: &[Rule] = &[
        // Past た/だ: only the text as searched is a past form.
        rule(PAST, "ませんでした", "ません", 0, MASEN),
        rule(PAST, "ました", "ます", 0, MASU),
        rule(PAST, "かった", "い", 0, ADJ_I),
        rule(PAST, "来た", "来る", 0, VK),
        rule(PAST, "きた", "くる", 0, VK),
        rule(PAST, "した", "する", 0, VS),
        rule(PAST, "行った", "行く", 0, V5),
        rule(PAST, "いった", "いく", 0, V5),
        rule(PAST, "いた", "く", 0, V5),
        rule(PAST, "いだ", "ぐ", 0, V5),
        rule(PAST, "した", "す", 0, V5),
        rule(PAST, "った", "う", 0, V5),
        rule(PAST, "った", "つ", 0, V5),
        rule(PAST, "った", "る", 0, V5),
        rule(PAST, "んだ", "む", 0, V5),
        rule(PAST, "んだ", "ぶ", 0, V5),
        rule(PAST, "んだ", "ぬ", 0, V5),
        rule(PAST, "た", "る", 0, V1),
        // て/で forms; a verb's also when the progressive, completive, or preparatory leaves it.
        rule(TE, "まして", "ます", 0, MASU),
        rule(TE, "くて", "い", KUTE_FORM, ADJ_I),
        rule(TE, "来て", "来る", TE_FORM, VK),
        rule(TE, "きて", "くる", TE_FORM, VK),
        rule(TE, "して", "する", TE_FORM, VS),
        rule(TE, "行って", "行く", TE_FORM, V5),
        rule(TE, "いって", "いく", TE_FORM, V5),
        rule(TE, "いて", "く", TE_FORM, V5),
        rule(TE, "いで", "ぐ", TE_FORM, V5),
        rule(TE, "して", "す", TE_FORM, V5),
        rule(TE, "って", "う", TE_FORM, V5),
        rule(TE, "って", "つ", TE_FORM, V5),
        rule(TE, "って", "る", TE_FORM, V5),
        rule(TE, "んで", "む", TE_FORM, V5),
        rule(TE, "んで", "ぶ", TE_FORM, V5),
        rule(TE, "んで", "ぬ", TE_FORM, V5),
        rule(TE, "て", "る", TE_FORM, V1),
        // Negative ない (itself an i-adjective, so it can be past: 読まなかった) and ません.
        rule(NEGATIVE, "ません", "ます", MASEN, MASU),
        rule(NEGATIVE, "くない", "い", ADJ_I, ADJ_I),
        rule(NEGATIVE, "来ない", "来る", ADJ_I, VK),
        rule(NEGATIVE, "こない", "くる", ADJ_I, VK),
        rule(NEGATIVE, "しない", "する", ADJ_I, VS),
        rule(NEGATIVE, "わない", "う", ADJ_I, V5),
        rule(NEGATIVE, "かない", "く", ADJ_I, V5),
        rule(NEGATIVE, "がない", "ぐ", ADJ_I, V5),
        rule(NEGATIVE, "さない", "す", ADJ_I, V5),
        rule(NEGATIVE, "たない", "つ", ADJ_I, V5),
        rule(NEGATIVE, "なない", "ぬ", ADJ_I, V5),
        rule(NEGATIVE, "ばない", "ぶ", ADJ_I, V5),
        rule(NEGATIVE, "まない", "む", ADJ_I, V5),
        rule(NEGATIVE, "らない", "る", ADJ_I, V5),
        rule(NEGATIVE, "ない", "る", ADJ_I, V1),
        rule(VOLITIONAL, "ましょう", "ます", 0, MASU),
        // Polite ます.
        rule(POLITE, "来ます", "来る", MASU, VK),
        rule(POLITE, "きます", "くる", MASU, VK),
        rule(POLITE, "します", "する", MASU, VS),
        rule(POLITE, "います", "う", MASU, V5),
        rule(POLITE, "きます", "く", MASU, V5),
        rule(POLITE, "ぎます", "ぐ", MASU, V5),
        rule(POLITE, "します", "す", MASU, V5),
        rule(POLITE, "ちます", "つ", MASU, V5),
        rule(POLITE, "にます", "ぬ", MASU, V5),
        rule(POLITE, "びます", "ぶ", MASU, V5),
        rule(POLITE, "みます", "む", MASU, V5),
        rule(POLITE, "ります", "る", MASU, V5),
        rule(POLITE, "ます", "る", MASU, V1),
        // Progressive ている/でいる and their contracted てる/でる, inflecting like the ichidan いる
        // (読んでいた, 読んでいます), leave the verb's て form.
        rule(PROGRESSIVE, "ている", "て", V1, TE_FORM),
        rule(PROGRESSIVE, "でいる", "で", V1, TE_FORM),
        rule(PROGRESSIVE, "てる", "て", V1, TE_FORM),
        rule(PROGRESSIVE, "でる", "で", V1, TE_FORM),
        // Completive てしまう/でしまう, inflecting like the godan しまう (読んでしまった, 読んでしまいます),
        // leave the verb's て form; the contracted ちゃう/じゃう, inflecting like a godan verb too
        // (食べちゃった), reach the dictionary form directly.
        rule(COMPLETIVE, "てしまう", "て", V5, TE_FORM),
        rule(COMPLETIVE, "でしまう", "で", V5, TE_FORM),
        rule(COMPLETIVE, "来ちゃう", "来る", V5, VK),
        rule(COMPLETIVE, "きちゃう", "くる", V5, VK),
        rule(COMPLETIVE, "しちゃう", "する", V5, VS),
        rule(COMPLETIVE, "行っちゃう", "行く", V5, V5),
        rule(COMPLETIVE, "いっちゃう", "いく", V5, V5),
        rule(COMPLETIVE, "いちゃう", "く", V5, V5),
        rule(COMPLETIVE, "いじゃう", "ぐ", V5, V5),
        rule(COMPLETIVE, "しちゃう", "す", V5, V5),
        rule(COMPLETIVE, "っちゃう", "う", V5, V5),
        rule(COMPLETIVE, "っちゃう", "つ", V5, V5),
        rule(COMPLETIVE, "っちゃう", "る", V5, V5),
        rule(COMPLETIVE, "んじゃう", "む", V5, V5),
        rule(COMPLETIVE, "んじゃう", "ぶ", V5, V5),
        rule(COMPLETIVE, "んじゃう", "ぬ", V5, V5),
        rule(COMPLETIVE, "ちゃう", "る", V5, V1),
        // Preparatory ておく/でおく and their contracted とく/どく, inflecting like the godan おく
        // (読んでおいた, 書いといた), leave the verb's て form.
        rule(PREPARATORY, "ておく", "て", V5, TE_FORM),
        rule(PREPARATORY, "でおく", "で", V5, TE_FORM),
        rule(PREPARATORY, "とく", "て", V5, TE_FORM),
        rule(PREPARATORY, "どく", "で", V5, TE_FORM),
    ];

    /// A candidate as (text, inflections, classes), a godan class read as the old rules' `V5`,
    /// since only the polite rules now give the godan dictionary form alone.
    type Old = (String, Vec<&'static str>, u32);

    fn as_old(candidate: &Candidate) -> Old {
        let classes = if candidate.classes & V5 == 0 {
            candidate.classes
        } else {
            candidate.classes | V5
        };
        (
            candidate.text.clone(),
            candidate.inflections.clone(),
            classes,
        )
    }

    /// Every candidate the old rule set generates for `text` within its bounds.
    fn old_candidates(text: &str) -> Vec<Old> {
        deinflect_bounded(text, &RuleSet::new(OLD_RULES, &[]), 4, 32)
            .iter()
            .map(as_old)
            .collect()
    }

    /// The texts the earlier deinflection tasks listed.
    const EARLIER_TEXTS: &[&str] = &[
        "読んだ",
        "行った",
        "いった",
        "きた",
        "した",
        "読みませんでした",
        "読みましょう",
        "高くなかった",
        "高くなくなくなくない",
        "勉強しなかった",
        "読んでいる",
        "食べていた",
        "読んでいました",
        "読んでた",
        "捨てる",
        "出る",
        "でる",
        "いる",
        "読んでしまう",
        "読んでしまった",
        "読んでしまいました",
        "食べちゃった",
        "行っちゃう",
        "しちゃいました",
        "仕舞う",
        "しまう",
        "違う",
        "ちゃう",
        "読んでおく",
        "買っておいた",
        "読んでおきました",
        "書いとく",
        "読んどいた",
        "置く",
        "おく",
        "解く",
        "とく",
        "退く",
        "どく",
        "説く",
        "とかない",
        "といた",
    ];

    #[test]
    fn the_old_rule_sets_candidates_keep_their_order_ahead_of_new_ones() {
        for text in EARLIER_TEXTS {
            let old = old_candidates(text);
            let all = deinflect(text);
            // Each old candidate, in the old order.
            let kept: Vec<Old> = all
                .iter()
                .map(as_old)
                .filter(|candidate| old.contains(candidate))
                .collect();
            assert_eq!(kept, old, "{text}");
            // Ahead of every new candidate reached in as many steps.
            for (index, candidate) in all.iter().enumerate() {
                if old.contains(&as_old(candidate)) {
                    assert!(
                        all[..index].iter().all(|earlier| earlier.inflections.len()
                            < candidate.inflections.len()
                            || old.contains(&as_old(earlier))),
                        "{text}: {candidate:?} follows a new candidate of its step"
                    );
                }
            }
        }
    }

    #[test]
    fn the_other_word_classes_and_special_cases_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // ずる verbs.
            ("信じた", "信ずる", VZ, &[PAST]),
            ("信じて", "信ずる", VZ, &[TE]),
            ("信じない", "信ずる", VZ, &[NEGATIVE]),
            ("信じます", "信ずる", VZ, &[POLITE]),
            ("信じました", "信ずる", VZ, &[POLITE, PAST]),
            ("信じなかった", "信ずる", VZ, &[NEGATIVE, PAST]),
            ("信じちゃう", "信ずる", VZ, &[COMPLETIVE]),
            ("信じている", "信ずる", VZ, &[TE, PROGRESSIVE]),
            // The 為る and 來る spellings.
            ("為た", "為る", VS, &[PAST]),
            ("為て", "為る", VS, &[TE]),
            ("為ない", "為る", VS, &[NEGATIVE]),
            ("為ます", "為る", VS, &[POLITE]),
            ("為ちゃう", "為る", VS, &[COMPLETIVE]),
            ("來た", "來る", VK, &[PAST]),
            ("來て", "來る", VK, &[TE]),
            ("來ない", "來る", VK, &[NEGATIVE]),
            ("來ます", "來る", VK, &[POLITE]),
            ("來ちゃう", "來る", VK, &[COMPLETIVE]),
            // 行く's other spellings, and the general っちゃう.
            ("逝った", "逝く", V5, &[PAST]),
            ("往って", "往く", V5, &[TE]),
            ("逝っちゃう", "逝く", V5, &[COMPLETIVE]),
            // Godan う verbs whose past is うた.
            ("問うた", "問う", V5, &[PAST]),
            ("問うて", "問う", V5, &[TE]),
            ("請うた", "請う", V5, &[PAST]),
            ("こうた", "こう", V5, &[PAST]),
            ("とうて", "とう", V5, &[TE]),
            ("問うている", "問う", V5, &[TE, PROGRESSIVE]),
            ("のたもうた", "のたまう", V5, &[PAST]),
            ("たもうて", "たまう", V5, &[TE]),
            ("たゆとうた", "たゆたう", V5, &[PAST]),
            // Honorific verbs whose ます stem ends in い, as whole words.
            ("いらっしゃいます", "いらっしゃる", V5D, &[POLITE]),
            ("くださいます", "くださる", V5D, &[POLITE]),
            ("下さいました", "下さる", V5D, &[POLITE, PAST]),
            ("おっしゃいません", "おっしゃる", V5D, &[POLITE, NEGATIVE]),
            ("ございます", "ござる", V5D, &[POLITE]),
            ("なさいます", "なさる", V5D, &[POLITE]),
            ("仰います", "仰る", V5D, &[POLITE]),
            // The historical ひます and an i-adjective's くあります.
            ("思ひます", "思う", V5D, &[POLITE]),
            ("高くあります", "高い", ADJ_I, &[POLITE]),
            ("高くありません", "高い", ADJ_I, &[POLITE, NEGATIVE]),
            // And the historical はない.
            ("思はない", "思う", V5, &[NEGATIVE]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        // 信じた is also the ichidan 信じる's past, first; the ずる rule follows the old ones.
        assert_eq!(texts("信じた"), ["信じる", "信ずる"]);
        // The honorific rules take only a whole word.
        assert!(!texts("ようこそいらっしゃいます").contains(&"ようこそいらっしゃる".to_owned()));
        // After the general polite rules' candidates, as the other rules follow the first ones.
        assert_eq!(
            texts("いらっしゃいます"),
            [
                "いらっしゃう",
                "いらっしゃいる",
                "いらっしゃる",
                "いらっしゃいむ"
            ]
        );
        // 行っちゃう keeps its own rule first; the general っちゃう adds no other 行く.
        assert_eq!(
            texts("行っちゃう")[..5],
            ["行く", "行う", "行つ", "行る", "行っる"]
        );
        assert_eq!(
            texts("行っちゃう")
                .iter()
                .filter(|text| *text == "行く")
                .count(),
            1
        );
    }

    #[test]
    fn the_remaining_auxiliaries_and_contractions_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // The contracted completive ちまう/じまう, directly.
            ("読んじまう", "読む", V5, &[COMPLETIVE]),
            ("遊んじまう", "遊ぶ", V5, &[COMPLETIVE]),
            ("死んじまう", "死ぬ", V5, &[COMPLETIVE]),
            ("書いちまう", "書く", V5, &[COMPLETIVE]),
            ("泳いじまう", "泳ぐ", V5, &[COMPLETIVE]),
            ("話しちまう", "話す", V5, &[COMPLETIVE]),
            ("買っちまう", "買う", V5, &[COMPLETIVE]),
            ("待っちまう", "待つ", V5, &[COMPLETIVE]),
            ("行っちまう", "行く", V5, &[COMPLETIVE]),
            ("食べちまう", "食べる", V1, &[COMPLETIVE]),
            ("来ちまう", "来る", VK, &[COMPLETIVE]),
            ("きちまう", "くる", VK, &[COMPLETIVE]),
            ("しちまう", "する", VS, &[COMPLETIVE]),
            ("勉強しちまう", "勉強する", VS, &[COMPLETIVE]),
            ("信じちまう", "信ずる", VZ, &[COMPLETIVE]),
            ("読んじまった", "読む", V5, &[COMPLETIVE, PAST]),
            ("食べちまいます", "食べる", V1, &[COMPLETIVE, POLITE]),
            // ちゃ/じゃ, the contracted ては, directly.
            ("読んじゃ", "読む", V5, &[CHA]),
            ("遊んじゃ", "遊ぶ", V5, &[CHA]),
            ("書いちゃ", "書く", V5, &[CHA]),
            ("泳いじゃ", "泳ぐ", V5, &[CHA]),
            ("話しちゃ", "話す", V5, &[CHA]),
            ("買っちゃ", "買う", V5, &[CHA]),
            ("行っちゃ", "行く", V5, &[CHA]),
            ("食べちゃ", "食べる", V1, &[CHA]),
            ("来ちゃ", "来る", VK, &[CHA]),
            ("きちゃ", "くる", VK, &[CHA]),
            ("しちゃ", "する", VS, &[CHA]),
            ("信じちゃ", "信ずる", VZ, &[CHA]),
            // The negative preparatory and progressive, through the negative ない.
            ("読まないでおく", "読む", V5, &[NEGATIVE, PREPARATORY]),
            ("食べないどく", "食べる", V1, &[NEGATIVE, PREPARATORY]),
            ("しないでおく", "する", VS, &[NEGATIVE, PREPARATORY]),
            (
                "読まないでおいた",
                "読む",
                V5,
                &[NEGATIVE, PREPARATORY, PAST],
            ),
            ("読まないでいる", "読む", V5, &[NEGATIVE, PROGRESSIVE]),
            ("食べないでゐる", "食べる", V1, &[NEGATIVE, PROGRESSIVE]),
            (
                "読まないでいました",
                "読む",
                V5,
                &[NEGATIVE, PROGRESSIVE, POLITE, PAST],
            ),
            // The progressive's other forms, through the verb's て form.
            ("読んでゐる", "読む", V5, &[TE, PROGRESSIVE]),
            ("食べてゐる", "食べる", V1, &[TE, PROGRESSIVE]),
            ("読んでおる", "読む", V5, &[TE, PROGRESSIVE]),
            ("食べておる", "食べる", V1, &[TE, PROGRESSIVE]),
            ("書いとる", "書く", V5, &[TE, PROGRESSIVE]),
            ("来とる", "来る", VK, &[TE, PROGRESSIVE]),
            ("勉強しとる", "勉強する", VS, &[TE, PROGRESSIVE]),
            ("書いとった", "書く", V5, &[TE, PROGRESSIVE, PAST]),
            ("読んでおります", "読む", V5, &[TE, PROGRESSIVE, POLITE]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        // The progressive's other forms leave the て form first, which only the verb て rules take:
        // not an i-adjective's くて or the polite まして.
        assert_eq!(
            deinflect("読んでおる")[0],
            Candidate {
                text: "読んで".into(),
                classes: TE_FORM,
                inflections: vec![PROGRESSIVE],
            }
        );
        assert!(!texts("高くておる").contains(&"高い".to_owned()));
        assert!(!texts("高くてゐる").contains(&"高い".to_owned()));
        assert!(!texts("読みましておる").contains(&"読む".to_owned()));
        // The negative forms need the negative ない before them, and follow the old rules' て form.
        assert!(!texts("読んでおく").contains(&"読まない".to_owned()));
        assert_eq!(
            deinflect("読まないでおく")[..2],
            [
                Candidate {
                    text: "読まないで".into(),
                    classes: TE_FORM,
                    inflections: vec![PREPARATORY],
                },
                Candidate {
                    text: "読まない".into(),
                    classes: ADJ_I,
                    inflections: vec![PREPARATORY],
                },
            ]
        );
    }

    #[test]
    fn conditionals_and_connectives_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // The conditional ば.
            ("読めば", "読む", V5, &[CONDITIONAL]),
            ("書けば", "書く", V5, &[CONDITIONAL]),
            ("泳げば", "泳ぐ", V5, &[CONDITIONAL]),
            ("話せば", "話す", V5, &[CONDITIONAL]),
            ("買えば", "買う", V5, &[CONDITIONAL]),
            ("待てば", "待つ", V5, &[CONDITIONAL]),
            ("死ねば", "死ぬ", V5, &[CONDITIONAL]),
            ("遊べば", "遊ぶ", V5, &[CONDITIONAL]),
            ("取れば", "取る", VERB, &[CONDITIONAL]),
            ("食べれば", "食べる", VERB, &[CONDITIONAL]),
            ("来れば", "来る", VERB, &[CONDITIONAL]),
            ("すれば", "する", VERB, &[CONDITIONAL]),
            ("高ければ", "高い", ADJ_I, &[CONDITIONAL]),
            ("読まなければ", "読む", V5, &[NEGATIVE, CONDITIONAL]),
            ("読みますれば", "読む", V5D, &[POLITE, CONDITIONAL]),
            // Its contraction ゃ, through the ば form.
            ("読みゃ", "読む", V5, &[CONDITIONAL, CONTRACTED]),
            ("書きゃ", "書く", V5, &[CONDITIONAL, CONTRACTED]),
            ("言や", "言う", V5, &[CONDITIONAL, CONTRACTED]),
            ("食べりゃ", "食べる", VERB, &[CONDITIONAL, CONTRACTED]),
            ("高けりゃ", "高い", ADJ_I, &[CONDITIONAL, CONTRACTED]),
            ("高きゃ", "高い", ADJ_I, &[CONDITIONAL, CONTRACTED]),
            (
                "読まなきゃ",
                "読む",
                V5,
                &[NEGATIVE, CONDITIONAL, CONTRACTED],
            ),
            // たら and たり.
            ("書いたら", "書く", V5, &[TARA]),
            ("読んだら", "読む", V5, &[TARA]),
            ("泳いだら", "泳ぐ", V5, &[TARA]),
            ("話したら", "話す", V5, &[TARA]),
            ("買ったら", "買う", V5, &[TARA]),
            ("行ったら", "行く", V5, &[TARA]),
            ("問うたら", "問う", V5, &[TARA]),
            ("食べたら", "食べる", V1, &[TARA]),
            ("来たら", "来る", VK, &[TARA]),
            ("きたら", "くる", VK, &[TARA]),
            ("したら", "する", VS, &[TARA]),
            ("信じたら", "信ずる", VZ, &[TARA]),
            ("高かったら", "高い", ADJ_I, &[TARA]),
            ("読みましたら", "読む", V5D, &[POLITE, TARA]),
            ("読まなかったら", "読む", V5, &[NEGATIVE, TARA]),
            ("読んだり", "読む", V5, &[TARI]),
            ("行ったり", "行く", V5, &[TARI]),
            ("問うたり", "問う", V5, &[TARI]),
            ("食べたり", "食べる", V1, &[TARI]),
            ("したり", "する", VS, &[TARI]),
            ("高かったり", "高い", ADJ_I, &[TARI]),
            // The negatives ず, ぬ, ん, ざる, and ねば.
            ("読まず", "読む", V5, &[ZU]),
            ("買わず", "買う", V5, &[ZU]),
            ("食べず", "食べる", V1, &[ZU]),
            ("せず", "する", VS, &[ZU]),
            ("来ず", "来る", VK, &[ZU]),
            ("こず", "くる", VK, &[ZU]),
            ("信ぜず", "信ずる", VZ, &[ZU]),
            ("知らぬ", "知る", V5, &[NU]),
            ("食べぬ", "食べる", V1, &[NU]),
            ("せぬ", "する", VS, &[NU]),
            ("知らん", "知る", V5, &[NEGATIVE_N]),
            ("食べん", "食べる", V1, &[NEGATIVE_N]),
            ("せん", "する", VS, &[NEGATIVE_N]),
            ("こん", "くる", VK, &[NEGATIVE_N]),
            ("知らんかった", "知る", V5, &[NEGATIVE_N, PAST]),
            ("読みませんかった", "読む", V5D, &[POLITE, NEGATIVE, PAST]),
            ("知らざる", "知る", V5, &[ZARU]),
            ("せざる", "する", VS, &[ZARU]),
            ("行かねば", "行く", V5, &[NEBA]),
            ("食べねば", "食べる", V1, &[NEBA]),
            ("せねば", "する", VS, &[NEBA]),
            ("来ねば", "来る", VK, &[NEBA]),
            // んばかり and んとする.
            ("泣かんばかり", "泣く", V5, &[NBAKARI]),
            ("言わんばかり", "言う", V5, &[NBAKARI]),
            ("行かんとする", "行く", V5, &[NTOSURU]),
            ("言わんとした", "言う", V5, &[NTOSURU, PAST]),
            // The negative volitional まい.
            ("読むまい", "読む", VERB, &[NEGATIVE_VOLITIONAL]),
            ("食べるまい", "食べる", VERB, &[NEGATIVE_VOLITIONAL]),
            ("食べまい", "食べる", V1, &[NEGATIVE_VOLITIONAL]),
            ("しまい", "する", VS, &[NEGATIVE_VOLITIONAL]),
            ("こまい", "くる", VK, &[NEGATIVE_VOLITIONAL]),
            ("来まい", "来る", VK, &[NEGATIVE_VOLITIONAL]),
            ("読みますまい", "読む", V5D, &[POLITE, NEGATIVE_VOLITIONAL]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        // The contraction reaches a ば form, which is not a dictionary form.
        assert_eq!(
            deinflect("読みゃ")[0],
            Candidate {
                text: "読めば".into(),
                classes: BA_FORM,
                inflections: vec![CONTRACTED],
            }
        );
        // Only a ゃ form takes the contraction's rules, and only a ん form ん's.
        assert!(!texts("読めばや").contains(&"読む".to_owned()));
        assert!(!texts("読まないん").contains(&"読む".to_owned()));
        // A rule reaching a ます, ません, or ん form keeps the ending that form's rules need.
        for text in ["読めれば", "読むまい", "読んでした", "高かった"] {
            assert!(
                deinflect(text)
                    .iter()
                    .all(|candidate| candidate.classes & (MASU | MASEN | N_FORM) == 0),
                "{text}: {:?}",
                deinflect(text)
            );
        }
    }

    #[test]
    fn desire_appearance_degree_and_requests_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // The desiderative たい, itself an i-adjective.
            ("読みたい", "読む", V5, &[DESIDERATIVE]),
            ("書きたい", "書く", V5, &[DESIDERATIVE]),
            ("泳ぎたい", "泳ぐ", V5, &[DESIDERATIVE]),
            ("話したい", "話す", V5, &[DESIDERATIVE]),
            ("買いたい", "買う", V5, &[DESIDERATIVE]),
            ("待ちたい", "待つ", V5, &[DESIDERATIVE]),
            ("死にたい", "死ぬ", V5, &[DESIDERATIVE]),
            ("遊びたい", "遊ぶ", V5, &[DESIDERATIVE]),
            ("取りたい", "取る", V5, &[DESIDERATIVE]),
            ("食べたい", "食べる", V1, &[DESIDERATIVE]),
            ("来たい", "来る", VK, &[DESIDERATIVE]),
            ("きたい", "くる", VK, &[DESIDERATIVE]),
            ("したい", "する", VS, &[DESIDERATIVE]),
            ("勉強したい", "勉強する", VS, &[DESIDERATIVE]),
            ("信じたい", "信ずる", VZ, &[DESIDERATIVE]),
            ("食べたかった", "食べる", V1, &[DESIDERATIVE, PAST]),
            ("読みたくない", "読む", V5, &[DESIDERATIVE, NEGATIVE]),
            ("読みたくて", "読む", V5, &[DESIDERATIVE, TE]),
            // そう, and すぎる/過ぎる, itself an ichidan verb.
            ("読みそう", "読む", V5, &[SOU]),
            ("食べそう", "食べる", V1, &[SOU]),
            ("来そう", "来る", VK, &[SOU]),
            ("しそう", "する", VS, &[SOU]),
            ("高そう", "高い", ADJ_I, &[SOU]),
            ("高さう", "高い", ADJ_I, &[SOU]),
            ("食べすぎる", "食べる", V1, &[SUGIRU]),
            ("食べすぎた", "食べる", V1, &[SUGIRU, PAST]),
            ("読みすぎる", "読む", V5, &[SUGIRU]),
            ("飲み過ぎる", "飲む", V5, &[SUGIRU]),
            ("しすぎる", "する", VS, &[SUGIRU]),
            ("高すぎる", "高い", ADJ_I, &[SUGIRU]),
            ("高過ぎた", "高い", ADJ_I, &[SUGIRU, PAST]),
            (
                "食べすぎています",
                "食べる",
                V1,
                &[SUGIRU, TE, PROGRESSIVE, POLITE],
            ),
            // The polite imperative なさい.
            ("読みなさい", "読む", V5, &[NASAI]),
            ("書きなさい", "書く", V5, &[NASAI]),
            ("食べなさい", "食べる", V1, &[NASAI]),
            ("来なさい", "来る", VK, &[NASAI]),
            ("しなさい", "する", VS, &[NASAI]),
            ("勉強しなさい", "勉強する", VS, &[NASAI]),
            // がる, itself a godan verb, and やがる, げ, the noun さ, and the adverbial く.
            ("寒がる", "寒い", ADJ_I, &[GARU]),
            ("欲しがった", "欲しい", ADJ_I, &[GARU, PAST]),
            ("寒がっている", "寒い", ADJ_I, &[GARU, TE, PROGRESSIVE]),
            ("食べやがる", "食べる", V1, &[YAGARU]),
            ("言いやがった", "言う", V5, &[YAGARU, PAST]),
            ("しやがる", "する", VS, &[YAGARU]),
            ("寂しげ", "寂しい", ADJ_I, &[GE]),
            ("寂し気", "寂しい", ADJ_I, &[GE]),
            ("高さ", "高い", ADJ_I, &[SA]),
            ("高く", "高い", ADJ_I, &[ADVERBIAL]),
            ("早く", "早い", ADJ_I, &[ADVERBIAL]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        // たい gives an i-adjective, which is itself a candidate, before the verb.
        assert_eq!(
            deinflect("食べたかった")[0],
            Candidate {
                text: "食べたい".into(),
                classes: ADJ_I,
                inflections: vec![PAST],
            }
        );
        // The noun さ and げ take only the searched text; the adverbial く only it and its own form.
        assert!(!texts("高さた").contains(&"高い".to_owned()));
        assert!(!texts("高げない").contains(&"高い".to_owned()));
        assert!(!texts("高くた").contains(&"高い".to_owned()));
        // なさい takes only the searched text and its own form, not a past.
        assert!(!texts("読みなさった").contains(&"読む".to_owned()));
    }

    #[test]
    fn voice_and_mood_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // The causative, itself an ichidan verb.
            ("食べさせる", "食べる", V1, &[CAUSATIVE]),
            ("読ませる", "読む", V5, &[CAUSATIVE]),
            ("書かせる", "書く", V5, &[CAUSATIVE]),
            ("泳がせる", "泳ぐ", V5, &[CAUSATIVE]),
            ("話させる", "話す", V5, &[CAUSATIVE]),
            ("買わせる", "買う", V5, &[CAUSATIVE]),
            ("待たせる", "待つ", V5, &[CAUSATIVE]),
            ("死なせる", "死ぬ", V5, &[CAUSATIVE]),
            ("遊ばせる", "遊ぶ", V5, &[CAUSATIVE]),
            ("取らせる", "取る", V5, &[CAUSATIVE]),
            ("させる", "する", VS, &[CAUSATIVE]),
            ("勉強させる", "勉強する", VS, &[CAUSATIVE]),
            ("来させる", "来る", VK, &[CAUSATIVE]),
            ("こさせる", "くる", VK, &[CAUSATIVE]),
            ("信じさせる", "信ずる", VZ, &[CAUSATIVE]),
            ("食べさせた", "食べる", V1, &[CAUSATIVE, PAST]),
            (
                "食べさせられる",
                "食べる",
                V1,
                &[CAUSATIVE, POTENTIAL_OR_PASSIVE],
            ),
            // The short causative, itself a godan verb.
            ("読ます", "読む", V5, &[SHORT_CAUSATIVE]),
            ("食べさす", "食べる", V1, &[SHORT_CAUSATIVE]),
            ("話さす", "話す", V5, &[SHORT_CAUSATIVE]),
            ("読まします", "読む", V5, &[SHORT_CAUSATIVE, POLITE]),
            ("読まされる", "読む", V5, &[SHORT_CAUSATIVE, PASSIVE]),
            // The passive, the potential, and the potential or passive, each itself ichidan.
            ("読まれる", "読む", V5, &[PASSIVE]),
            ("書かれる", "書く", V5, &[PASSIVE]),
            ("言われる", "言う", V5, &[PASSIVE]),
            ("話される", "話す", V5D | V5SP, &[PASSIVE]),
            ("取られる", "取る", V5, &[PASSIVE]),
            ("される", "する", VS, &[PASSIVE]),
            ("勉強される", "勉強する", VS, &[PASSIVE]),
            ("読まれた", "読む", V5, &[PASSIVE, PAST]),
            ("読める", "読む", V5D, &[POTENTIAL]),
            ("書ける", "書く", V5D, &[POTENTIAL]),
            ("話せる", "話す", V5D, &[POTENTIAL]),
            ("買える", "買う", V5D, &[POTENTIAL]),
            ("待てる", "待つ", V5D, &[POTENTIAL]),
            ("死ねる", "死ぬ", V5D, &[POTENTIAL]),
            ("遊べる", "遊ぶ", V5D, &[POTENTIAL]),
            ("泳げる", "泳ぐ", V5D, &[POTENTIAL]),
            ("取れる", "取る", V1 | V5D, &[POTENTIAL]),
            ("できる", "する", VS, &[POTENTIAL]),
            ("出来る", "する", VS, &[POTENTIAL]),
            ("来れる", "来る", VK, &[POTENTIAL]),
            ("これる", "くる", VK, &[POTENTIAL]),
            ("読めない", "読む", V5D, &[POTENTIAL, NEGATIVE]),
            ("食べられる", "食べる", V1, &[POTENTIAL_OR_PASSIVE]),
            ("来られる", "来る", VK, &[POTENTIAL_OR_PASSIVE]),
            ("こられる", "くる", VK, &[POTENTIAL_OR_PASSIVE]),
            ("せられる", "する", VS, &[POTENTIAL_OR_PASSIVE]),
            // The imperative, and the negative imperative な.
            ("読め", "読む", V5, &[IMPERATIVE]),
            ("書け", "書く", V5, &[IMPERATIVE]),
            ("泳げ", "泳ぐ", V5, &[IMPERATIVE]),
            ("話せ", "話す", V5, &[IMPERATIVE]),
            ("買え", "買う", V5, &[IMPERATIVE]),
            ("待て", "待つ", V5, &[IMPERATIVE]),
            ("死ね", "死ぬ", V5, &[IMPERATIVE]),
            ("遊べ", "遊ぶ", V5, &[IMPERATIVE]),
            ("取れ", "取る", V5, &[IMPERATIVE]),
            ("食べろ", "食べる", V1, &[IMPERATIVE]),
            ("食べよ", "食べる", V1, &[IMPERATIVE]),
            ("しろ", "する", VS, &[IMPERATIVE]),
            ("せよ", "する", VS, &[IMPERATIVE]),
            ("来い", "来る", VK, &[IMPERATIVE]),
            ("こい", "くる", VK, &[IMPERATIVE]),
            ("信じろ", "信ずる", VZ, &[IMPERATIVE]),
            ("読むな", "読む", V5, &[NEGATIVE_IMPERATIVE]),
            ("行くな", "行く", V5, &[NEGATIVE_IMPERATIVE]),
            ("話すな", "話す", V5, &[NEGATIVE_IMPERATIVE]),
            ("食べるな", "食べる", VERB, &[NEGATIVE_IMPERATIVE]),
            ("するな", "する", VERB, &[NEGATIVE_IMPERATIVE]),
            ("来るな", "来る", VERB, &[NEGATIVE_IMPERATIVE]),
            // The plain volitional and its slang.
            ("読もう", "読む", V5, &[VOLITIONAL]),
            ("書こう", "書く", V5, &[VOLITIONAL]),
            ("泳ごう", "泳ぐ", V5, &[VOLITIONAL]),
            ("話そう", "話す", V5, &[VOLITIONAL]),
            ("買おう", "買う", V5, &[VOLITIONAL]),
            ("待とう", "待つ", V5, &[VOLITIONAL]),
            ("死のう", "死ぬ", V5, &[VOLITIONAL]),
            ("遊ぼう", "遊ぶ", V5, &[VOLITIONAL]),
            ("取ろう", "取る", V5, &[VOLITIONAL]),
            ("食べよう", "食べる", V1, &[VOLITIONAL]),
            ("しよう", "する", VS, &[VOLITIONAL]),
            ("来よう", "来る", VK, &[VOLITIONAL]),
            ("こよう", "くる", VK, &[VOLITIONAL]),
            ("高かろう", "高い", ADJ_I, &[VOLITIONAL]),
            ("食べませう", "食べる", V1, &[POLITE, VOLITIONAL]),
            ("行こっか", "行く", V5, &[VOLITIONAL_SLANG]),
            ("食べよっか", "食べる", V1, &[VOLITIONAL_SLANG]),
            ("しよっか", "する", VS, &[VOLITIONAL_SLANG]),
            ("読みましょっか", "読む", V5D, &[POLITE, VOLITIONAL_SLANG]),
            // The continuative (ます stem).
            ("読み", "読む", V5, &[CONTINUATIVE]),
            ("書き", "書く", V5, &[CONTINUATIVE]),
            ("泳ぎ", "泳ぐ", V5, &[CONTINUATIVE]),
            ("話し", "話す", V5, &[CONTINUATIVE]),
            ("買い", "買う", V5, &[CONTINUATIVE]),
            ("待ち", "待つ", V5, &[CONTINUATIVE]),
            ("死に", "死ぬ", V5, &[CONTINUATIVE]),
            ("遊び", "遊ぶ", V5, &[CONTINUATIVE]),
            ("取り", "取る", V5, &[CONTINUATIVE]),
            ("食べ", "食べる", V1D, &[CONTINUATIVE]),
            ("し", "する", VS, &[CONTINUATIVE]),
            ("来", "来る", VK, &[CONTINUATIVE]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let chains = |text: &str, form: &str| -> Vec<Vec<&'static str>> {
            forms(text)
                .into_iter()
                .filter(|(text, ..)| text == form)
                .map(|(.., inflections)| inflections)
                .collect()
        };
        // The progressive's contracted てる takes no passive, only the potential or passive.
        assert!(chains("読んでられる", "読む").contains(&vec![
            TE,
            PROGRESSIVE,
            POTENTIAL_OR_PASSIVE
        ]));
        assert!(!chains("読んでられる", "読む").contains(&vec![TE, PROGRESSIVE, PASSIVE]));
        // A short causative ending in さす takes no passive; one ending in another す does.
        assert!(!chains("話さされる", "話す").contains(&vec![SHORT_CAUSATIVE, PASSIVE]));
        assert!(!chains("食べさされる", "食べる").contains(&vec![SHORT_CAUSATIVE, PASSIVE]));
        // The continuative's ichidan form is not the progressive's contracted てる.
        assert!(!chains("食べて", "食べる").contains(&vec![TE, PROGRESSIVE, CONTINUATIVE]));
        assert!(deinflect("食べて")
            .iter()
            .all(|candidate| candidate.inflections != [PROGRESSIVE, CONTINUATIVE]));
        // The potential or passive comes before the passive, so 来られる's 来る is listed as it.
        assert_eq!(
            forms("来られる")
                .into_iter()
                .filter(|(text, classes, _)| text == "来る" && classes & VK != 0)
                .collect::<Vec<_>>(),
            [("来る".to_owned(), VK, vec![POTENTIAL_OR_PASSIVE])]
        );
        // The plain volitional and the negative imperative take only the searched text.
        assert!(chains("読もうた", "読む").is_empty());
        assert!(chains("読むなかった", "読む").is_empty());
    }

    #[test]
    fn archaic_slang_and_kansai_ben_forms_reach_their_dictionary_forms() {
        let cases: &[(&str, &str, u32, &[&str])] = &[
            // The archaic む, the historical ふ, and the attributive き.
            ("読まむ", "読む", V5, &[MU]),
            ("食べむ", "食べる", V1, &[MU]),
            ("せむ", "する", VS, &[MU]),
            ("思ふ", "思う", V5, &[FU]),
            ("思ってしまふ", "思う", V5, &[TE, COMPLETIVE, FU]),
            ("高き", "高い", ADJ_I, &[ATTRIBUTIVE]),
            ("美しき", "美しい", ADJ_I, &[ATTRIBUTIVE]),
            // Slang: an i-adjective's え, r-column syllables before n, and んな.
            ("すげえ", "すごい", ADJ_I, &[E_SLANG]),
            ("すげぇ", "すごい", ADJ_I, &[E_SLANG]),
            ("やべえ", "やばい", ADJ_I, &[E_SLANG]),
            ("うるせえ", "うるさい", ADJ_I, &[E_SLANG]),
            ("いてえ", "いたい", ADJ_I, &[E_SLANG]),
            ("知らねえ", "知る", V5, &[NEGATIVE, E_SLANG]),
            ("分かんない", "分かる", V5, &[NEGATIVE, N_SLANG]),
            (
                "食べらんない",
                "食べる",
                V1,
                &[POTENTIAL_OR_PASSIVE, NEGATIVE, N_SLANG],
            ),
            (
                "やんなきゃ",
                "やる",
                V5,
                &[NEGATIVE, N_SLANG, CONDITIONAL, CONTRACTED],
            ),
            ("やんなさい", "やる", V5, &[NASAI, N_SLANG]),
            ("食べんな", "食べる", VERB, &[NEGATIVE_IMPERATIVE_SLANG]),
            ("すんな", "する", VERB, &[NEGATIVE_IMPERATIVE_SLANG]),
            // Kansai-ben.
            ("行かへん", "行く", V5, &[NEGATIVE, KANSAI_BEN]),
            ("食べへん", "食べる", V1, &[NEGATIVE, KANSAI_BEN]),
            ("せえへん", "する", VS, &[NEGATIVE, KANSAI_BEN]),
            ("行かへんかった", "行く", V5, &[NEGATIVE, PAST, KANSAI_BEN]),
            ("買うて", "買う", V5, &[TE, KANSAI_BEN]),
            ("言うて", "言う", V5, &[TE, KANSAI_BEN]),
            ("買うた", "買う", V5, &[PAST, KANSAI_BEN]),
            ("買うたら", "買う", V5, &[TARA, KANSAI_BEN]),
            ("買うたり", "買う", V5, &[TARI, KANSAI_BEN]),
            ("よう", "よい", ADJ_I, &[ADVERBIAL, KANSAI_BEN]),
            ("宜しゅう", "宜しい", ADJ_I, &[ADVERBIAL, KANSAI_BEN]),
            ("高うて", "高い", ADJ_I, &[TE, KANSAI_BEN]),
            ("高うない", "高い", ADJ_I, &[NEGATIVE, KANSAI_BEN]),
        ];
        for (text, form, classes, inflections) in cases {
            assert!(
                has(text, form, *classes, inflections),
                "{text} should reach {form} ({inflections:?}), got {:?}",
                forms(text)
            );
        }
        let texts = |text: &str| -> Vec<String> {
            forms(text).into_iter().map(|(text, ..)| text).collect()
        };
        // An i-adjective's くて still takes no progressive, completive, or preparatory て form.
        for text in ["高くている", "高くてしまう", "高くておく"] {
            assert!(!texts(text).contains(&"高い".to_owned()), "{text}");
        }
        // Kansai-ben's た and て forms give a verb's past and て forms, not dictionary forms.
        assert!(deinflect("買うた").contains(&Candidate {
            text: "買った".into(),
            classes: TA_FORM,
            inflections: vec![KANSAI_BEN],
        }));
        // Its adverbial く form is only an adjective's.
        assert!(deinflect("よう")
            .iter()
            .filter(|candidate| candidate.classes == KU_FORM)
            .all(|candidate| candidate.text == "よく"));
    }

    #[test]
    fn candidates_come_fewest_steps_first_then_in_rule_order() {
        // 行った is 行く before the general った endings.
        assert_eq!(
            first_forms("行った"),
            ["行く", "行う", "行つ", "行る", "行っる"]
        );
        // So is its kana spelling, which is also 言う's past.
        assert_eq!(
            first_forms("いった"),
            ["いく", "いう", "いつ", "いる", "いっる"]
        );
        // Past forms are never inflected further; ます only by its polite rules.
        assert!(deinflect("読んだ")
            .iter()
            .all(|candidate| candidate.inflections == [PAST]));
        assert!(deinflect("読みます")
            .iter()
            .filter(|candidate| candidate.inflections.last() == Some(&POLITE))
            .all(|candidate| candidate.inflections == [POLITE]));
        assert!(forms("本").is_empty());
        // Within a step, the first rules' chains come before any other, even when a text earlier
        // in the step reaches the other: y's first-rule o comes before x's other-rule n.
        let first = [
            rule(PAST, "q", "x", 0, V5),
            rule(PAST, "q", "y", 0, V5),
            rule(NEGATIVE, "y", "o", V5, V1),
        ];
        let more = [rule(PASSIVE, "x", "n", V5, V1)];
        let texts: Vec<_> = deinflect_bounded("q", &RuleSet::new(&first, &more), 6, 64)
            .into_iter()
            .map(|candidate| candidate.text)
            .collect();
        assert_eq!(texts, ["x", "y", "o", "n"]);
        assert!(deinflect("").is_empty());
    }

    #[test]
    fn chains_and_candidates_are_bounded() {
        // Each くない step is one rule: five before ない need six steps, six need seven.
        let six = "高くなくなくなくなくなくない";
        assert!(has(six, "高い", ADJ_I, &[NEGATIVE; 6]));
        let seven = "高くなくなくなくなくなくなくない";
        assert!(!forms(seven).iter().any(|(text, ..)| text == "高い"));
        assert!(forms(seven)
            .iter()
            .all(|(_, _, inflections)| inflections.len() <= MAX_STEPS));
        // The longest listed chain takes six steps.
        assert!(has(
            "読まされていました",
            "読む",
            V5,
            &[SHORT_CAUSATIVE, PASSIVE, TE, PROGRESSIVE, POLITE, PAST]
        ));
        // Generation stops at the candidate bound, keeping the earliest candidates.
        let all = deinflect_bounded("読みませんでした", &RULES, MAX_STEPS, MAX_CANDIDATES);
        assert!(all.len() > 3 && all.len() <= MAX_CANDIDATES);
        assert_eq!(
            deinflect_bounded("読みませんでした", &RULES, MAX_STEPS, 3),
            all[..3]
        );
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v5"), V5);
        assert_eq!(word_classes("v1 vt"), V1);
        assert_eq!(word_classes(" vs  adj-i "), VS | ADJ_I);
        assert_eq!(word_classes("vk"), VK);
        assert_eq!(word_classes("v5k-s n adj-na"), 0);
        assert_eq!(word_classes(""), 0);
    }
}
