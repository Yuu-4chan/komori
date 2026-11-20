//! The Finnish deinflection rules, Komori's own (Yomitan has none): the clitics (-kin, -kaan,
//! -ko, -han, -pa, -s) and then a possessive suffix (-ni, -si, -mme, -nne, -nsa, or a lengthened
//! vowel and n) come off a word. Cases, plurals and verb forms are left to the dictionaries' own
//! form entries, which Finnish Wiktionary dictionaries list for nearly every word, so
//! talossanikin is talossa, a form of talo.

use std::sync::LazyLock;

use super::{
    deinflect_bounded, harmony, rule, Candidate, Rule, RuleSet, MAX_CANDIDATES, MAX_STEPS,
};

/// A word as dictionaries list it, or one of their form entries.
pub(crate) const W: u32 = 1;
/// A word whose clitics are off, which may still have a possessive suffix.
const CLITIC: u32 = 1 << 1;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = W;

/// The word classes a term's space-separated rules name: Finnish dictionaries name none Komori
/// tells apart.
pub(crate) fn word_classes(_rules: &str) -> u32 {
    0
}

const POSSESSIVE: &str = "possessive";

const PLACEHOLDERS: &[(char, &[&str])] = &[('A', &["a", "ä"]), ('O', &["o", "ö"])];

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    for (name, pattern) in [
        ("-kin", "kin"),
        ("-kaan", "kAAn"),
        ("-ko", "kO"),
        ("-han", "hAn"),
        ("-pa", "pA"),
        ("-s", "s"),
    ] {
        for suffix in harmony(pattern, PLACEHOLDERS) {
            rules.push(rule(name, suffix.leak(), "", CLITIC, CLITIC | W));
        }
    }
    for pattern in ["ni", "si", "mme", "nne", "nsA"] {
        for suffix in harmony(pattern, PLACEHOLDERS) {
            let suffix: &'static str = suffix.leak();
            rules.push(rule(POSSESSIVE, suffix, "", CLITIC, W));
            // A nominative plural's or genitive's final t or n gives way to the suffix.
            rules.push(rule(POSSESSIVE, suffix, "t", CLITIC, W));
            rules.push(rule(POSSESSIVE, suffix, "n", CLITIC, W));
        }
    }
    // The third person after a case ending's vowel: talossaan, taloaan.
    for vowel in ["a", "ä", "e", "i", "o", "u", "y", "ö"] {
        let suffix: &'static str = format!("{vowel}{vowel}n").leak();
        rules.push(rule(POSSESSIVE, suffix, vowel, CLITIC, W));
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

    fn finds(text: &str, base: &str) -> bool {
        deinflect(text)
            .iter()
            .any(|candidate| candidate.text == base)
    }

    #[test]
    fn clitics_then_a_possessive_come_off() {
        for (text, base) in [
            ("talossanikin", "talossa"),
            ("talossaan", "talossa"),
            ("taloni", "talo"),
            ("talonsa", "talo"),
            ("kirjasikin", "kirja"),
            ("onko", "on"),
            ("tämäkään", "tämä"),
            ("ystävämme", "ystävä"),
            ("autotkin", "autot"),
        ] {
            assert!(finds(text, base), "{text}: {:?}", deinflect(text));
        }
        // Only one possessive comes off: talonsa's talo is not read as ta + lo + nsa.
        assert!(!finds("talonsani", "talo"));
    }
}
