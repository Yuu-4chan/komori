//! The Hindi deinflection rules, Komori's own (Yomitan has none), for words a dictionary does not
//! list as form entries: nouns' plural and oblique endings (किताबें, लड़कों, लड़कियाँ),
//! adjectives' agreement (अच्छी, अच्छे) and verbs' habitual, perfect, future, subjunctive,
//! imperative and conjunctive forms, which give the stem and then the infinitive's -ना (पढ़ता,
//! खाया, जाओगे, पढ़कर → पढ़ना, खाना, जाना). Endings with a chandrabindu are also matched with an
//! anusvara, as they are often written.

use std::sync::LazyLock;

use super::{
    deinflect_bounded, named_classes, rule, whole_word, Candidate, Rule, RuleSet, MAX_STEPS,
};

/// Verbs, in the infinitive.
pub(crate) const V: u32 = 1;
/// Nouns, in the direct singular.
pub(crate) const N: u32 = 1 << 1;
/// Adjectives, in the masculine direct singular.
pub(crate) const ADJ: u32 = 1 << 2;
/// A verb's stem, before -ना.
const STEM: u32 = 1 << 3;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("v", V), ("n", N), ("adj", ADJ)])
}

const PLURAL: &str = "plural";
const CASE: &str = "case";
const FEMININE: &str = "feminine";
const DECLENSION: &str = "declension";
const PRESENT: &str = "present";
const PAST: &str = "past";
const IMPERATIVE: &str = "imperative";
const GERUND: &str = "gerund";
const FUTURE: &str = "-गा";

/// Rules for `ending` and, when it has a chandrabindu, its spelling with an anusvara.
fn endings(
    rules: &mut Vec<Rule>,
    name: &'static str,
    list: &[&str],
    base: &'static str,
    applies_to: u32,
    gives: u32,
) {
    for ending in list {
        rules.push(rule(
            name,
            ending.to_string().leak(),
            base,
            applies_to,
            gives,
        ));
        if ending.contains('ँ') {
            let anusvara = ending.replace('ँ', "ं").leak();
            rules.push(rule(name, anusvara, base, applies_to, gives));
        }
    }
}

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    // Nouns: किताबें, किताबों; लड़के, लड़कों; लड़कियाँ, लड़कियों; माताएँ, माताओं.
    endings(&mut rules, PLURAL, &["ें", "एँ"], "", N, N);
    endings(&mut rules, CASE, &["ों", "ओं"], "", N, N);
    endings(&mut rules, PLURAL, &["े"], "ा", N, N);
    endings(&mut rules, CASE, &["ों"], "ा", N, N);
    endings(&mut rules, PLURAL, &["ियाँ"], "ी", N, N);
    endings(&mut rules, CASE, &["ियों"], "ी", N, N);
    // Adjectives agreeing with their noun: अच्छी, अच्छे.
    endings(&mut rules, FEMININE, &["ी", "ीं"], "ा", ADJ, ADJ);
    endings(&mut rules, DECLENSION, &["े"], "ा", ADJ, ADJ);
    // Verb forms give the stem.
    endings(&mut rules, PRESENT, &["ता", "ती", "ते", "तीं"], "", V, STEM);
    endings(
        &mut rules,
        PAST,
        &["ा", "ी", "े", "ीं", "या", "यी", "ये", "यीं", "ई", "ए", "ईं"],
        "",
        V,
        STEM,
    );
    endings(&mut rules, PAST, &["ुआ", "ुई", "ुए", "ुईं"], "ो", V, STEM);
    endings(
        &mut rules,
        FUTURE,
        &[
            "ूँगा",
            "ूँगी",
            "ेगा",
            "ेगी",
            "ेंगे",
            "ेंगी",
            "ोगे",
            "ोगी",
            "ऊँगा",
            "ऊँगी",
            "एगा",
            "एगी",
            "एँगे",
            "एँगी",
            "ओगे",
            "ओगी",
            "येगा",
            "येगी",
            "येंगे",
            "येंगी",
        ],
        "",
        V,
        STEM,
    );
    endings(&mut rules, "", &["ूँ", "ऊँ", "ें", "एँ"], "", V, STEM);
    endings(
        &mut rules,
        IMPERATIVE,
        &["ो", "ओ", "िए", "िये", "इए", "इये", "िएगा", "इएगा"],
        "",
        V,
        STEM,
    );
    endings(&mut rules, GERUND, &["कर", "के"], "", V, STEM);
    // The infinitive's oblique and feminine forms: पढ़ने, पढ़नी.
    endings(&mut rules, DECLENSION, &["ने"], "ना", V, V);
    endings(&mut rules, FEMININE, &["नी"], "ना", V, V);
    // Perfects not built on their stem.
    for (form, infinitive) in [
        ("किया", "करना"),
        ("की", "करना"),
        ("किए", "करना"),
        ("किये", "करना"),
        ("कीं", "करना"),
        ("गया", "जाना"),
        ("गई", "जाना"),
        ("गयी", "जाना"),
        ("गए", "जाना"),
        ("गये", "जाना"),
        ("गईं", "जाना"),
        ("दिया", "देना"),
        ("दी", "देना"),
        ("दिए", "देना"),
        ("दिये", "देना"),
        ("लिया", "लेना"),
        ("ली", "लेना"),
        ("लिए", "लेना"),
        ("लिये", "लेना"),
    ] {
        rules.push(whole_word(PAST, form, infinitive, V, V));
    }
    // The stem takes the infinitive's -ना.
    rules.push(rule("", "", "ना", STEM, V));
    rules
});

static RULES: LazyLock<RuleSet<'static>> = LazyLock::new(|| RuleSet::new(&RULES_LIST, &[]));

/// Hindi's short endings match many words, so it keeps more candidates than most languages.
const MAX_CANDIDATES: usize = 128;

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
    fn hindi_words_lose_their_endings() {
        for (text, base, class) in [
            ("किताबें", "किताब", N),
            ("किताबों", "किताब", N),
            ("लड़के", "लड़का", N),
            ("लड़कों", "लड़का", N),
            ("लड़कियाँ", "लड़की", N),
            ("लड़कियां", "लड़की", N),
            ("माताएँ", "माता", N),
            ("अच्छी", "अच्छा", ADJ),
            ("अच्छे", "अच्छा", ADJ),
            ("पढ़ता", "पढ़ना", V),
            ("पढ़ी", "पढ़ना", V),
            ("खाया", "खाना", V),
            ("हुआ", "होना", V),
            ("किया", "करना", V),
            ("पढ़ूँगा", "पढ़ना", V),
            ("पढ़ूंगा", "पढ़ना", V),
            ("खाएगा", "खाना", V),
            ("जाओगे", "जाना", V),
            ("पढ़कर", "पढ़ना", V),
            ("पढ़ने", "पढ़ना", V),
            ("खाइए", "खाना", V),
            ("बोलिए", "बोलना", V),
        ] {
            assert!(finds(text, base, class), "{text}: {:?}", deinflect(text));
        }
    }
}
