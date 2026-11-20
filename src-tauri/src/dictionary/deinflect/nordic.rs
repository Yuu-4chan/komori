//! The Swedish, Norwegian and Danish deinflection rule, Komori's own: a genitive's -s comes off
//! (husets → huset, flickornas → flickorna), and the dictionaries' own form entries lead on from
//! there (huset, a form of hus). Their other inflections are those form entries' job.

use std::sync::LazyLock;

use super::{affix, deinflect_bounded, Candidate, Rule, RuleSet, MAX_CANDIDATES, MAX_STEPS};

/// A word as dictionaries list it, or one of their form entries.
pub(crate) const W: u32 = 1;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = W;

/// The word classes a term's space-separated rules name: these dictionaries name none Komori
/// tells apart.
pub(crate) fn word_classes(_rules: &str) -> u32 {
    0
}

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    // A word ending in s, x or z takes no genitive -s of its own.
    vec![affix("possessive", "", "", "s", "", W, W).guarded("", "sxz")]
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// The forms `text` may be an inflection of (see `deinflect_bounded`).
pub(crate) fn deinflect(text: &str) -> Vec<Candidate> {
    deinflect_bounded(text, &RULES, MAX_STEPS, MAX_CANDIDATES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_genitive_s_comes_off_once() {
        let texts = |text: &str| -> Vec<String> {
            deinflect(text)
                .into_iter()
                .map(|candidate| candidate.text)
                .collect()
        };
        assert_eq!(texts("husets"), ["huset"]);
        assert_eq!(texts("flickornas"), ["flickorna"]);
        // A stem ending in s takes no -s: glass is not a genitive.
        assert!(texts("glass").is_empty());
    }
}
