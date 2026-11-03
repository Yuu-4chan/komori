//! Komori's Italian deinflection rules: the simple tenses, gerund and participles of regular
//! -are, -ere and -ire verbs (with -isc- verbs and the spelling of -care, -gare, -ciare, -giare and
//! -iare verbs), pronouns joined to an infinitive, gerund or imperative (parlarmi, dandolo,
//! parlami), noun and adjective plurals, feminines, diminutives, superlatives and adverbs in
//! -mente. Irregular verbs (essere, avere, fare) are left to the dictionaries' own form entries.

use std::sync::LazyLock;

use super::{
    deinflect_bounded, endings, named_classes, rule, Candidate, Rule, RuleSet, MAX_CANDIDATES,
    MAX_STEPS,
};

/// Verbs (`v`).
pub(crate) const V: u32 = 1;
/// Nouns (`n`).
pub(crate) const N: u32 = 1 << 1;
/// Adjectives (`adj`).
pub(crate) const ADJ: u32 = 1 << 2;
/// Adverbs (`adv`).
pub(crate) const ADV: u32 = 1 << 3;
/// A verb form with a pronoun removed from it, which a tense rule still applies to (parla in
/// parlami); a dictionary form's rules never name it.
pub(crate) const VF: u32 = 1 << 4;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ | ADV;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("v", V), ("n", N), ("adj", ADJ), ("adv", ADV)])
}

const PRESENT: &str = "present indicative";
const IMPERFECT: &str = "imperfect";
const PRETERITE: &str = "preterite";
const FUTURE: &str = "future";
const CONDITIONAL: &str = "conditional";
const PRESENT_SUBJUNCTIVE: &str = "present subjunctive";
const IMPERFECT_SUBJUNCTIVE: &str = "imperfect subjunctive";
const GERUND: &str = "gerund";
const PAST_PARTICIPLE: &str = "past participle";
const PRESENT_PARTICIPLE: &str = "present participle";
const PRONOUN: &str = "pronoun";
const PLURAL: &str = "plural";
const FEMININE: &str = "feminine";
const DIMINUTIVE: &str = "diminutive";
const SUPERLATIVE: &str = "superlative";
const ADVERB: &str = "adverb";

/// Each tense's endings after a regular verb's stem, for -are, -ere and -ire verbs.
const TENSES: &[(&str, [&[&str]; 3])] = &[
    (
        PRESENT,
        [
            &["o", "i", "a", "iamo", "ate", "ano"],
            &["o", "i", "e", "iamo", "ete", "ono"],
            &["o", "i", "e", "iamo", "ite", "ono"],
        ],
    ),
    (
        IMPERFECT,
        [
            &["avo", "avi", "ava", "avamo", "avate", "avano"],
            &["evo", "evi", "eva", "evamo", "evate", "evano"],
            &["ivo", "ivi", "iva", "ivamo", "ivate", "ivano"],
        ],
    ),
    (
        PRETERITE,
        [
            &["ai", "asti", "ò", "ammo", "aste", "arono"],
            &[
                "ei", "etti", "esti", "é", "ette", "emmo", "este", "erono", "ettero",
            ],
            &["ii", "isti", "ì", "immo", "iste", "irono"],
        ],
    ),
    (
        FUTURE,
        [
            &["erò", "erai", "erà", "eremo", "erete", "eranno"],
            &["erò", "erai", "erà", "eremo", "erete", "eranno"],
            &["irò", "irai", "irà", "iremo", "irete", "iranno"],
        ],
    ),
    (
        CONDITIONAL,
        [
            &["erei", "eresti", "erebbe", "eremmo", "ereste", "erebbero"],
            &["erei", "eresti", "erebbe", "eremmo", "ereste", "erebbero"],
            &["irei", "iresti", "irebbe", "iremmo", "ireste", "irebbero"],
        ],
    ),
    (
        PRESENT_SUBJUNCTIVE,
        [
            &["i", "iamo", "iate", "ino"],
            &["a", "iamo", "iate", "ano"],
            &["a", "iamo", "iate", "ano"],
        ],
    ),
    (
        IMPERFECT_SUBJUNCTIVE,
        [
            &["assi", "asse", "assimo", "aste", "assero"],
            &["essi", "esse", "essimo", "este", "essero"],
            &["issi", "isse", "issimo", "iste", "issero"],
        ],
    ),
    (GERUND, [&["ando"], &["endo"], &["endo"]]),
    (
        PAST_PARTICIPLE,
        [
            &["ato", "ata", "ati", "ate"],
            &["uto", "uta", "uti", "ute"],
            &["ito", "ita", "iti", "ite"],
        ],
    ),
    (
        PRESENT_PARTICIPLE,
        [&["ante", "anti"], &["ente", "enti"], &["ente", "enti"]],
    ),
];

/// The present endings of -are verbs that begin with i, after which -care and -gare verbs add an
/// h (cerchiamo).
const PRESENT_I_ENDINGS: &[&str] = &["i", "iamo", "iate", "ino"];
/// The future endings of -are verbs, which -care and -gare verbs spell with an h (cercherò) and
/// -ciare and -giare verbs without their i (comincerò).
const FUTURE_ENDINGS: &[&str] = &["erò", "erai", "erà", "eremo", "erete", "eranno"];
/// The conditional endings of -are verbs, spelled as the future ones are.
const CONDITIONAL_ENDINGS: &[&str] = &["erei", "eresti", "erebbe", "eremmo", "ereste", "erebbero"];
/// Pronouns joined to the end of a verb, alone or combined.
const CLITICS: &[&str] = &[
    "mi", "ti", "si", "ci", "vi", "lo", "la", "li", "le", "ne", "gli", "glielo", "gliela",
    "glieli", "gliele", "gliene", "melo", "mela", "telo", "tela", "selo", "sela", "celo", "cela",
    "velo", "vela", "mene", "tene", "sene", "cene",
];

static TABLE: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    for (name, groups) in TENSES {
        for (group, base) in groups.iter().zip(["are", "ere", "ire"]) {
            rules.extend(endings(name, "", group, base, VF, V));
        }
    }
    rules.extend(endings(
        PRESENT,
        "",
        &["isco", "isci", "isce", "iscono"],
        "ire",
        VF,
        V,
    ));
    rules.extend(endings(
        PRESENT_SUBJUNCTIVE,
        "",
        &["isca", "iscano"],
        "ire",
        VF,
        V,
    ));
    rules.extend(endings(PRESENT, "", PRESENT_I_ENDINGS, "iare", VF, V));
    for (name, list) in [
        (PRESENT, PRESENT_I_ENDINGS),
        (FUTURE, FUTURE_ENDINGS),
        (CONDITIONAL, CONDITIONAL_ENDINGS),
    ] {
        rules.extend(endings(name, "ch", list, "care", VF, V));
        rules.extend(endings(name, "gh", list, "gare", VF, V));
    }
    for (name, list) in [(FUTURE, FUTURE_ENDINGS), (CONDITIONAL, CONDITIONAL_ENDINGS)] {
        rules.extend(endings(name, "c", list, "ciare", VF, V));
        rules.extend(endings(name, "g", list, "giare", VF, V));
    }
    for clitic in CLITICS {
        let after = |stem: &str| -> &'static str { format!("{stem}{clitic}").leak() };
        rules.extend([
            rule(PRONOUN, after("r"), "re", 0, V),
            rule(PRONOUN, after("ndo"), "ndo", 0, V | VF),
            rule(PRONOUN, after("a"), "a", 0, V | VF),
            rule(PRONOUN, after("ate"), "ate", 0, V | VF),
            rule(PRONOUN, after("ite"), "ite", 0, V | VF),
            rule(PRONOUN, after("ete"), "ete", 0, V | VF),
        ]);
    }
    rules.extend([
        rule(PLURAL, "i", "o", N | ADJ, N | ADJ),
        rule(PLURAL, "i", "e", N | ADJ, N | ADJ),
        rule(PLURAL, "e", "a", N | ADJ, N | ADJ),
        rule(PLURAL, "chi", "co", N | ADJ, N | ADJ),
        rule(PLURAL, "ghi", "go", N | ADJ, N | ADJ),
        rule(PLURAL, "che", "ca", N | ADJ, N | ADJ),
        rule(PLURAL, "ghe", "ga", N | ADJ, N | ADJ),
        rule(PLURAL, "ci", "cio", N | ADJ, N | ADJ),
        rule(PLURAL, "gi", "gio", N | ADJ, N | ADJ),
        rule(PLURAL, "ie", "ia", N | ADJ, N | ADJ),
        rule(PLURAL, "ce", "cia", N | ADJ, N | ADJ),
        rule(PLURAL, "ge", "gia", N | ADJ, N | ADJ),
        rule(FEMININE, "a", "o", N | ADJ, N | ADJ),
        rule(FEMININE, "essa", "e", N | ADJ, N | ADJ),
        rule(FEMININE, "trice", "tore", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "ino", "o", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "ina", "a", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "etto", "o", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "etta", "a", N | ADJ, N | ADJ),
        rule(SUPERLATIVE, "issimo", "o", ADJ, ADJ),
        rule(SUPERLATIVE, "issima", "a", ADJ, ADJ),
        rule(SUPERLATIVE, "issimi", "i", ADJ, ADJ),
        rule(SUPERLATIVE, "issime", "e", ADJ, ADJ),
        rule(ADVERB, "mente", "", ADV, ADJ),
        rule(ADVERB, "lmente", "le", ADV, ADJ),
        rule(ADVERB, "rmente", "re", ADV, ADJ),
    ]);
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&TABLE, &[]));

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
            ("parlo", "parlare", &[PRESENT]),
            ("parliamo", "parlare", &[PRESENT]),
            ("credono", "credere", &[PRESENT]),
            ("dormite", "dormire", &[PRESENT]),
            ("finisco", "finire", &[PRESENT]),
            ("parlavano", "parlare", &[IMPERFECT]),
            ("parlò", "parlare", &[PRETERITE]),
            ("credette", "credere", &[PRETERITE]),
            ("dormì", "dormire", &[PRETERITE]),
            ("parlerò", "parlare", &[FUTURE]),
            ("dormiranno", "dormire", &[FUTURE]),
            ("crederebbe", "credere", &[CONDITIONAL]),
            ("parlino", "parlare", &[PRESENT_SUBJUNCTIVE]),
            ("dormissimo", "dormire", &[IMPERFECT_SUBJUNCTIVE]),
            ("parlando", "parlare", &[GERUND]),
            ("creduto", "credere", &[PAST_PARTICIPLE]),
            ("partiti", "partire", &[PAST_PARTICIPLE]),
            ("cerchiamo", "cercare", &[PRESENT]),
            ("pagherò", "pagare", &[FUTURE]),
            ("comincerò", "cominciare", &[FUTURE]),
            ("mangerei", "mangiare", &[CONDITIONAL]),
            ("studiamo", "studiare", &[PRESENT]),
            ("parlarmi", "parlare", &[PRONOUN]),
            ("vederlo", "vedere", &[PRONOUN]),
            ("parlandogli", "parlare", &[GERUND, PRONOUN]),
            ("parlami", "parlare", &[PRESENT, PRONOUN]),
            ("libri", "libro", &[PLURAL]),
            ("case", "casa", &[PLURAL]),
            ("amiche", "amica", &[PLURAL]),
            ("parchi", "parco", &[PLURAL]),
            ("belle", "bello", &[FEMININE, PLURAL]),
            ("attrice", "attore", &[FEMININE]),
            ("gattino", "gatto", &[DIMINUTIVE]),
            ("bellissimo", "bello", &[SUPERLATIVE]),
            ("velocemente", "veloce", &[ADVERB]),
            ("facilmente", "facile", &[ADVERB]),
        ]);
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v"), V);
        assert_eq!(word_classes(" n  adj "), N | ADJ);
        assert_eq!(word_classes("vt"), 0);
    }
}
