//! The Turkish deinflection rules, Komori's own (Yomitan has none). Nouns and adjectives lose
//! their plural, possessive and case suffixes in any order (evlerimizden → ev), with a final
//! consonant softened before a vowel restored (kitabı → kitap, ağacı → ağaç). Verbs lose a tense
//! with its person ending, a participle or a converb, then the negative, ability, passive and
//! causative suffixes, and take the infinitive's -mek or -mak (geliyorum, gelmedi, gideceğim,
//! yapılacak → gelmek, gitmek, yapmak). Suffixes are written once with their harmony letters:
//! `I` is ı i u ü, `A` a e, `D` d t and `C` c ç. A tense is named by its suffix (-iyor, -di).

use std::sync::LazyLock;

use super::{deinflect_bounded, harmony, named_classes, rule, Candidate, Rule, RuleSet, MAX_STEPS};

/// Nouns and adjectives, which take the same suffixes (`n`, `adj`).
pub(crate) const N: u32 = 1;
/// Verbs, in the infinitive (`v`).
pub(crate) const V: u32 = 1 << 1;
/// A noun before a vowel suffix, whose last consonant may be softened.
const NV: u32 = 1 << 2;
/// A verb stem, without the infinitive's -mek.
const VS: u32 = 1 << 3;
/// A verb stem before a vowel suffix.
const VV: u32 = 1 << 4;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = N | V;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("n", N), ("adj", N), ("adv", N), ("v", V)])
}

const PLURAL: &str = "plural";
const POSSESSIVE: &str = "possessive";
const CASE: &str = "case";
const NEGATIVE: &str = "negative";
const PAST: &str = "past";
const IMPERATIVE: &str = "imperative";
const PARTICIPLE: &str = "participle";
const GERUND: &str = "gerund";
const POTENTIAL: &str = "potential";
const PASSIVE: &str = "passive";
const CAUSATIVE: &str = "causative";

const PLACEHOLDERS: &[(char, &[&str])] = &[
    ('I', &["ı", "i", "u", "ü"]),
    ('A', &["a", "e"]),
    ('D', &["d", "t"]),
    ('C', &["c", "ç"]),
];

const VOWELS: [char; 8] = ['a', 'e', 'ı', 'i', 'o', 'ö', 'u', 'ü'];

/// Person endings after -miş, the aorist and the necessitative's stem.
const PERSONS: &[&str] = &["Im", "sIn", "", "Iz", "sInIz", "lAr"];
/// Person endings after -di and -se.
const SHORT_PERSONS: &[&str] = &["m", "n", "", "k", "nIz", "lAr"];
const POSSESSIVES: &[&str] = &[
    "Im", "m", "In", "n", "I", "sI", "ImIz", "mIz", "InIz", "nIz", "lArI",
];

/// A rule for each spelling of each pattern after each of `after`; a suffix starting with a
/// vowel also gives `before_vowel`.
#[allow(clippy::too_many_arguments)]
fn suffixes(
    rules: &mut Vec<Rule>,
    name: &'static str,
    patterns: &[&str],
    after: &[&str],
    base: &'static str,
    applies_to: u32,
    gives: u32,
    before_vowel: u32,
) {
    for pattern in patterns {
        for ending in after {
            for suffix in harmony(&format!("{pattern}{ending}"), PLACEHOLDERS) {
                let vowel = suffix.starts_with(VOWELS);
                let gives = if vowel { gives | before_vowel } else { gives };
                rules.push(rule(name, suffix.leak(), base, applies_to, gives));
            }
        }
    }
}

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    let noun = |rules: &mut Vec<Rule>, name, patterns: &[&str]| {
        suffixes(rules, name, patterns, &[""], "", N, N, NV);
    };
    noun(&mut rules, PLURAL, &["lAr"]);
    noun(&mut rules, POSSESSIVE, POSSESSIVES);
    noun(
        &mut rules,
        CASE,
        &[
            "I", "yI", "nI", "A", "yA", "nA", "DA", "nDA", "DAn", "nDAn", "In", "nIn", "lA", "ylA",
            "ki", "DIr", "CA",
        ],
    );
    // The copula after a noun or adjective (güzeldi, öğrenciyim).
    suffixes(
        &mut rules,
        PAST,
        &["DI", "ydI"],
        SHORT_PERSONS,
        "",
        N,
        N,
        NV,
    );
    suffixes(&mut rules, "-miş", &["mIş", "ymIş"], PERSONS, "", N, N, NV);
    suffixes(
        &mut rules,
        "-se",
        &["sA", "ysA"],
        SHORT_PERSONS,
        "",
        N,
        N,
        NV,
    );
    suffixes(
        &mut rules,
        "",
        &["yIm", "yIz", "sIn", "sInIz", "DIrlAr"],
        &[""],
        "",
        N,
        N,
        NV,
    );
    // A proper noun's suffixes follow an apostrophe (İstanbul'da).
    rules.push(rule("", "'", "", N, N));
    rules.push(rule("", "\u{2019}", "", N, N));
    // A final p, ç, t or k softened before a vowel.
    for (soft, hard) in [("b", "p"), ("c", "ç"), ("d", "t"), ("ğ", "k"), ("g", "k")] {
        rules.push(rule("", soft, hard, NV, N));
    }
    // Tenses with their person endings, participles and converbs, applying to the searched
    // word or a noun form of it (geldiğimde: geldiğim).
    let verb = |rules: &mut Vec<Rule>, name, patterns: &[&str], after: &[&str], base| {
        suffixes(rules, name, patterns, after, base, N, VS, VV);
    };
    for base in ["", "a", "e"] {
        verb(
            &mut rules,
            "-iyor",
            &["Iyor"],
            &["um", "sun", "", "uz", "sunuz", "lar"],
            base,
        );
        verb(
            &mut rules,
            "-iyor",
            &["Iyordu"],
            &["m", "n", "", "k", "nuz", "lar"],
            base,
        );
    }
    verb(
        &mut rules,
        "-iyor",
        &["yor"],
        &["um", "sun", "", "uz", "sunuz", "lar"],
        "",
    );
    verb(&mut rules, "-di", &["DI"], SHORT_PERSONS, "");
    verb(&mut rules, "-miş", &["mIş"], PERSONS, "");
    verb(
        &mut rules,
        "-ecek",
        &["yAcA", "AcA"],
        &["ğIm", "ksIn", "k", "ğIz", "ksInIz", "klAr"],
        "",
    );
    verb(&mut rules, "-ir", &["r", "Ir", "Ar"], PERSONS, "");
    verb(
        &mut rules,
        NEGATIVE,
        &["mAz"],
        &["sIn", "", "sInIz", "lAr"],
        "",
    );
    verb(&mut rules, NEGATIVE, &["mAm", "mAyIz"], &[""], "");
    verb(&mut rules, "-se", &["sA"], SHORT_PERSONS, "");
    verb(
        &mut rules,
        "-meli",
        &["mAlI"],
        &["yIm", "sIn", "", "yIz", "sInIz", "lAr"],
        "",
    );
    verb(
        &mut rules,
        IMPERATIVE,
        &[
            "In", "InIz", "yIn", "yInIz", "sIn", "sInlAr", "AyIm", "yAyIm", "AlIm", "yAlIm",
        ],
        &[""],
        "",
    );
    verb(&mut rules, PARTICIPLE, &["An", "yAn", "DIk"], &[""], "");
    verb(
        &mut rules,
        PARTICIPLE,
        &["DIğ"],
        &["Im", "In", "I", "ImIz", "InIz", "lArI"],
        "",
    );
    verb(
        &mut rules,
        GERUND,
        &[
            "Ip", "yIp", "ArAk", "yArAk", "IncA", "yIncA", "ken", "mAdAn",
        ],
        &[""],
        "",
    );
    // Suffixes between the stem and the tense, from the outside in.
    let stem = |rules: &mut Vec<Rule>, name, patterns: &[&str]| {
        suffixes(rules, name, patterns, &[""], "", VS, VS, VV);
    };
    stem(&mut rules, NEGATIVE, &["mA"]);
    stem(&mut rules, POTENTIAL, &["Abil", "yAbil", "AmA", "yAmA"]);
    stem(&mut rules, PASSIVE, &["Il"]);
    stem(&mut rules, CAUSATIVE, &["DIr"]);
    // gidiyor: git.
    rules.push(rule("", "d", "t", VV, VS));
    for infinitive in ["mak", "mek"] {
        rules.push(rule("", "", infinitive, VS, V));
    }
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// Turkish stacks many suffixes on one word, so it keeps more candidates than most languages.
const MAX_CANDIDATES: usize = 256;

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
    fn nouns_lose_their_plural_possessive_and_case_suffixes() {
        for (text, base) in [
            ("evlerimizden", "ev"),
            ("evde", "ev"),
            ("kitaplar", "kitap"),
            ("kitabı", "kitap"),
            ("ağacın", "ağaç"),
            ("köpeğim", "köpek"),
            ("arabayla", "araba"),
            ("okulda", "okul"),
            ("İstanbul'da", "İstanbul"),
            ("güzeldi", "güzel"),
            ("öğrenciyim", "öğrenci"),
        ] {
            assert!(finds(text, base, N), "{text}: {:?}", deinflect(text));
        }
    }

    #[test]
    fn verbs_lose_their_tense_person_and_stem_suffixes() {
        for (text, base) in [
            ("geliyorum", "gelmek"),
            ("geldim", "gelmek"),
            ("gelmedi", "gelmek"),
            ("gelmiyor", "gelmek"),
            ("gelecekler", "gelmek"),
            ("gideceğim", "gitmek"),
            ("gidiyor", "gitmek"),
            ("bekliyor", "beklemek"),
            ("okuyor", "okumak"),
            ("yapılacak", "yapmak"),
            ("gelebilir", "gelmek"),
            ("geldiğimde", "gelmek"),
            ("gelmez", "gelmek"),
            ("yazmış", "yazmak"),
        ] {
            assert!(finds(text, base, V), "{text}: {:?}", deinflect(text));
        }
        let names = deinflect("gideceğim")
            .into_iter()
            .find(|candidate| candidate.text == "gitmek")
            .unwrap()
            .inflections;
        assert_eq!(names, ["-ecek"]);
    }
}
