//! The Indonesian deinflection rules, Komori's own: the particles and pronouns joined after a
//! word (-nya, -lah, -kah, -pun, -tah, -ku, -mu), then the suffixes -kan, -i and -an, then a
//! prefix (meN- and peN- with the stem's first letter restored: membaca → baca, menulis →
//! tulis, mengirim → kirim, menyapu → sapu; di-, ter-, ber-, ke-, per-, se-), or a prefix and
//! suffix together (ke-…-an, peN-…-an, per-…-an). Each affix's name is the affix itself.

use std::sync::LazyLock;

use super::{affix, deinflect_bounded, Candidate, Rule, RuleSet, MAX_STEPS};

/// A word as dictionaries list it.
pub(crate) const W: u32 = 1;
/// A word whose particles are off.
const PARTICLE: u32 = 1 << 1;
/// A word whose suffix is off, which may still have a prefix.
const SUFFIX: u32 = 1 << 2;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = W;

/// The word classes a term's space-separated rules name: Indonesian dictionaries name none
/// Komori tells apart.
pub(crate) fn word_classes(_rules: &str) -> u32 {
    0
}

/// The nasal prefixes' spellings and the letter each one replaced at the stem's start.
const NASAL: &[(&str, &[&str])] = &[
    ("m", &["", "p"]),
    ("n", &["", "t"]),
    ("ng", &["", "k"]),
    ("ny", &["s"]),
    ("", &[""]),
    ("nge", &[""]),
];

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    for particle in ["nya", "lah", "kah", "pun", "tah", "ku", "mu"] {
        let name: &'static str = format!("-{particle}").leak();
        rules.push(affix(name, "", "", particle, "", PARTICLE, PARTICLE | W));
    }
    for suffix in ["kan", "i", "an"] {
        let name: &'static str = format!("-{suffix}").leak();
        rules.push(affix(name, "", "", suffix, "", PARTICLE, SUFFIX | W));
    }
    let prefixes = PARTICLE | SUFFIX;
    for (nasal, restored) in NASAL {
        for &letter in *restored {
            for (start, name) in [("me", "meN-"), ("pe", "peN-"), ("memper", "memper-")] {
                if start == "memper" && !nasal.is_empty() {
                    continue;
                }
                let prefix: &'static str = format!("{start}{nasal}").leak();
                rules.push(affix(name, prefix, letter, "", "", prefixes, W));
                if start == "pe" {
                    // peN-…-an: pembacaan, penulisan.
                    rules.push(affix("peN-an", prefix, letter, "an", "", PARTICLE, W));
                }
            }
        }
    }
    for prefix in ["di", "ter", "ber", "be", "bel", "ke", "per", "se", "diper"] {
        let name: &'static str = format!("{prefix}-").leak();
        rules.push(affix(name, prefix, "", "", "", prefixes, W));
    }
    for prefix in ["ke", "per", "ber"] {
        let name: &'static str = format!("{prefix}-an").leak();
        rules.push(affix(name, prefix, "", "an", "", PARTICLE, W));
    }
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// Indonesian stacks a particle, a suffix and a prefix, and its nasal prefixes each restore one
/// of several letters, so it keeps more candidates than most languages.
const MAX_CANDIDATES: usize = 128;

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
            .any(|candidate| candidate.text == base && candidate.classes & W != 0)
    }

    #[test]
    fn particles_suffixes_and_prefixes_come_off() {
        for (text, base) in [
            ("bukunya", "buku"),
            ("bacalah", "baca"),
            ("membaca", "baca"),
            ("memukul", "pukul"),
            ("menulis", "tulis"),
            ("mendengar", "dengar"),
            ("mengambil", "ambil"),
            ("mengirim", "kirim"),
            ("menyapu", "sapu"),
            ("melihat", "lihat"),
            ("mengecat", "cat"),
            ("mengajarkan", "ajar"),
            ("dibacanya", "baca"),
            ("berjalan", "jalan"),
            ("belajar", "ajar"),
            ("kebersihan", "bersih"),
            ("pembacaan", "baca"),
            ("makanan", "makan"),
            ("memperbaiki", "baik"),
        ] {
            assert!(finds(text, base), "{text}: {:?}", deinflect(text));
        }
    }
}
