//! The Polish deinflection rules, Komori's own (Yomitan has none): a verb's past and conditional
//! forms (czytałem, napisała, zrobiłbym), its regular present endings, and an adjective's case
//! endings with naj- for the superlative (najlepszego → lepszy). Nouns, and the forms these leave
//! out, are the dictionaries' own form entries' job.

use std::sync::LazyLock;

use super::{deinflect_bounded, prefix, rule, Candidate, Rule, RuleSet, MAX_CANDIDATES, MAX_STEPS};

/// Verbs, in the infinitive.
pub(crate) const V: u32 = 1;
/// Adjectives, in the masculine nominative.
pub(crate) const ADJ: u32 = 1 << 1;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    super::named_classes(rules, &[("v", V), ("adj", ADJ)])
}

const PAST: &str = "past";
const CONDITIONAL: &str = "conditional";
const PRESENT: &str = "present";
const DECLENSION: &str = "declension";
const SUPERLATIVE: &str = "superlative";

/// The past tense's endings after the stem, by gender and person; -li is the masculine
/// personal plural.
const PAST_ENDINGS: &[&str] = &[
    "łem", "łeś", "ł", "łam", "łaś", "ła", "ło", "liśmy", "liście", "li", "łyśmy", "łyście", "ły",
];
/// The past forms the conditional's -by and its person endings follow.
const CONDITIONAL_STEMS: &[&str] = &["ł", "ła", "ło", "li", "ły"];
const CONDITIONAL_ENDINGS: &[&str] = &["bym", "byś", "by", "byśmy", "byście"];

/// Regular present endings and the infinitive ending they come from.
const PRESENTS: &[(&[&str], &str)] = &[
    (&["am", "asz", "a", "amy", "acie", "ają"], "ać"),
    (&["em", "esz", "e", "emy", "ecie", "eją"], "eć"),
    (&["ię", "isz", "i", "imy", "icie", "ią"], "ić"),
    (&["ę", "ysz", "y", "ymy", "ycie", "ą"], "yć"),
    (&["uję", "ujesz", "uje", "ujemy", "ujecie", "ują"], "ować"),
];

/// Adjective endings and the masculine nominative ending they come from.
const ADJECTIVES: &[(&[&str], &str)] = &[
    (
        &["a", "e", "ego", "emu", "ym", "ej", "ą", "ych", "ymi"],
        "y",
    ),
    (
        &["ia", "ie", "iego", "iemu", "im", "iej", "ią", "ich", "imi"],
        "i",
    ),
];

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    let mut push = |name, inflected: String, base, applies_to, gives| {
        rules.push(rule(name, inflected.leak(), base, applies_to, gives));
    };
    // The stem's vowel before ł: czytał (czytać), miał (mieć), wziął and wzięła (wziąć).
    for (before, base) in [("", "ć"), ("a", "eć"), ("ę", "ąć")] {
        for ending in PAST_ENDINGS {
            push(PAST, format!("{before}{ending}"), base, V, V);
        }
        for stem in CONDITIONAL_STEMS {
            for ending in CONDITIONAL_ENDINGS {
                push(CONDITIONAL, format!("{before}{stem}{ending}"), base, V, V);
            }
        }
    }
    for &(endings, base) in PRESENTS {
        for ending in endings {
            push(PRESENT, (*ending).to_owned(), base, V, V);
        }
    }
    for &(endings, base) in ADJECTIVES {
        for ending in endings {
            push(DECLENSION, (*ending).to_owned(), base, ADJ, ADJ);
        }
    }
    rules.push(prefix(SUPERLATIVE, "naj", "", ADJ, ADJ));
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
    fn verbs_lose_their_past_conditional_and_present_endings() {
        for (text, base) in [
            ("czytałem", "czytać"),
            ("napisała", "napisać"),
            ("zrobiłam", "zrobić"),
            ("zrobiłbym", "zrobić"),
            ("czytaliśmy", "czytać"),
            ("mieli", "mieć"),
            ("miałem", "mieć"),
            ("wzięła", "wziąć"),
            ("czytają", "czytać"),
            ("robię", "robić"),
            ("pracujemy", "pracować"),
        ] {
            assert!(finds(text, base, V), "{text}: {:?}", deinflect(text));
        }
    }

    #[test]
    fn adjectives_lose_their_case_endings_and_naj() {
        for (text, base) in [
            ("dobrego", "dobry"),
            ("najlepszego", "lepszy"),
            ("polskiej", "polski"),
            ("nowymi", "nowy"),
        ] {
            assert!(finds(text, base, ADJ), "{text}: {:?}", deinflect(text));
        }
    }
}
