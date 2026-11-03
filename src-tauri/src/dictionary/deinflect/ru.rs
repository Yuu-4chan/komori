//! The Russian deinflection rules, Komori's own (Yomitan has none): noun cases and plurals of
//! the regular declensions, adjective endings with their short, comparative and superlative
//! forms and adverbs in -о, and regular verbs' present and past tenses, imperatives, gerunds and
//! participles, with -ся removed first (class `VF`, a verb form, never a dictionary form).
//! Irregular forms come from the dictionaries' own form entries.

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
/// A verb form without its -ся.
const VF: u32 = 1 << 3;
/// The word classes a term's rules can name.
pub(crate) const DICTIONARY_FORMS: u32 = V | N | ADJ;

/// The word classes a term's space-separated rules name.
pub(crate) fn word_classes(rules: &str) -> u32 {
    named_classes(rules, &[("v", V), ("n", N), ("adj", ADJ)])
}

const CASE: &str = "case";
const DECLENSION: &str = "declension";
const SHORT: &str = "short form";
const COMPARATIVE: &str = "comparative";
const SUPERLATIVE: &str = "superlative";
const ADVERB: &str = "adverb";
const REFLEXIVE: &str = "reflexive";
const PRESENT: &str = "present";
const PAST: &str = "past";
const IMPERATIVE: &str = "imperative";
const GERUND: &str = "gerund";
const PARTICIPLE: &str = "participle";

/// A noun's endings and the dictionary form they come from.
const NOUNS: &[(&[&str], &str)] = &[
    (&["а", "у", "ом", "е", "ы", "ов", "ам", "ами", "ах"], ""),
    (&["я", "ю", "ем", "ём", "и", "ев", "ям", "ями", "ях"], "й"),
    (&["я", "ю", "ем", "ём", "и", "ей", "ям", "ями", "ях"], "ь"),
    (
        &["ы", "и", "е", "у", "ой", "ою", "ам", "ами", "ах", ""],
        "а",
    ),
    (&["и", "е", "ю", "ей", "ёй", "ям", "ями", "ях"], "я"),
    (&["и", "ью", "ей", "ям", "ями", "ам", "ами", "ах"], "ь"),
    (&["а", "у", "ом", "е", "ам", "ами", "ах", ""], "о"),
    (&["я", "ю", "ем", "ей", "ям", "ями", "ях"], "е"),
    (&["ия", "ию", "ием", "ии", "ий", "иям", "иями", "иях"], "ие"),
];

/// An adjective's endings and the dictionary form they come from.
const ADJECTIVES: &[(&[&str], &str)] = &[
    (
        &[
            "ая", "ое", "ые", "ого", "ому", "ым", "ом", "ой", "ую", "ых", "ыми", "ою",
        ],
        "ый",
    ),
    (
        &[
            "яя", "ее", "ие", "его", "ему", "им", "ем", "ей", "юю", "их", "ими",
        ],
        "ий",
    ),
    (
        &[
            "ая", "ое", "ие", "ого", "ому", "им", "ом", "ой", "ую", "их", "ими",
        ],
        "ий",
    ),
    (
        &[
            "ая", "ое", "ые", "ие", "ого", "ому", "ым", "им", "ом", "ую", "ых", "их", "ыми", "ими",
        ],
        "ой",
    ),
];

/// A regular verb's present endings and the infinitive ending they come from.
const PRESENTS: &[(&[&str], &str)] = &[
    (&["ю", "ешь", "ет", "ем", "ете", "ют"], "ть"),
    (&["ю", "у", "ишь", "ит", "им", "ите", "ят", "ат"], "ить"),
    (&["лю"], "ить"),
    (&["ю", "ишь", "ит", "им", "ите", "ят"], "еть"),
    (&["ую", "уешь", "ует", "уем", "уете", "уют"], "овать"),
    (&["ую", "уешь", "ует", "уем", "уете", "уют"], "евать"),
    (&["у", "ешь", "ет", "ем", "ете", "ут"], "уть"),
];

static RULES_LIST: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = vec![
        rule(REFLEXIVE, "ся", "", 0, V | VF),
        rule(REFLEXIVE, "сь", "", 0, V | VF),
    ];
    for &(list, base) in NOUNS {
        rules.extend(endings(CASE, "", list, base, 0, N));
    }
    for &(list, base) in ADJECTIVES {
        rules.extend(endings(DECLENSION, "", list, base, 0, ADJ));
    }
    // Before the short forms, so быстро reads as the adverb its neuter short form is spelled as.
    rules.push(rule(ADVERB, "о", "ый", 0, ADJ));
    rules.extend(endings(SHORT, "", &["а", "о", "ы", ""], "ый", 0, ADJ));
    rules.extend(endings(COMPARATIVE, "", &["ее", "ей"], "ый", 0, ADJ));
    rules.extend(endings(
        SUPERLATIVE,
        "",
        &["ейший", "айший"],
        "ый",
        ADJ,
        ADJ,
    ));
    for &(list, base) in PRESENTS {
        rules.extend(endings(PRESENT, "", list, base, VF, V));
    }
    // A reflexive verb's own forms, since dictionaries list it with its -ся (учусь: учиться).
    for &(list, base) in PRESENTS {
        let base: &'static str = format!("{base}ся").leak();
        for ending in list {
            let reflexive = if ending.ends_with(['у', 'ю', 'е']) {
                "сь"
            } else {
                "ся"
            };
            let form: &'static str = format!("{ending}{reflexive}").leak();
            rules.push(rule(PRESENT, form, base, 0, V));
        }
    }
    rules.extend(endings(IMPERATIVE, "", &["йся", "йтесь"], "ться", 0, V));
    rules.extend(endings(IMPERATIVE, "", &["ись", "итесь"], "иться", 0, V));
    rules.extend(endings(GERUND, "", &["ясь", "вшись"], "ться", 0, V));
    rules.extend(endings(GERUND, "", &["ясь", "ась"], "иться", 0, V));
    rules.extend(endings(PAST, "л", &["", "а", "о", "и"], "ть", VF, V));
    rules.extend(endings(
        PAST,
        "л",
        &["ся", "ась", "ось", "ись"],
        "ться",
        0,
        V,
    ));
    rules.extend(endings(IMPERATIVE, "", &["й", "йте"], "ть", VF, V));
    rules.extend(endings(IMPERATIVE, "", &["и", "ите"], "ить", VF, V));
    rules.extend(endings(GERUND, "", &["я", "в", "вши"], "ть", VF, V));
    rules.extend(endings(GERUND, "", &["я", "а"], "ить", VF, V));
    rules.extend(endings(
        PARTICIPLE,
        "",
        &["ющий", "вший", "нный", "емый"],
        "ть",
        ADJ,
        V,
    ));
    rules.extend(endings(
        PARTICIPLE,
        "",
        &["ящий", "ащий", "енный", "имый"],
        "ить",
        ADJ,
        V,
    ));
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
            ("столами", "стол", &[CASE]),
            ("книгу", "книга", &[CASE]),
            ("книг", "книга", &[CASE]),
            ("недели", "неделя", &[CASE]),
            ("ночью", "ночь", &[CASE]),
            ("окна", "окно", &[CASE]),
            ("зданиях", "здание", &[CASE]),
            ("музеем", "музей", &[CASE]),
            ("красивая", "красивый", &[DECLENSION]),
            ("синего", "синий", &[DECLENSION]),
            ("русская", "русский", &[DECLENSION]),
            ("большие", "большой", &[DECLENSION]),
            ("красива", "красивый", &[SHORT]),
            ("красивее", "красивый", &[COMPARATIVE]),
            ("красивейшая", "красивый", &[SUPERLATIVE, DECLENSION]),
            ("быстро", "быстрый", &[ADVERB]),
            ("читаю", "читать", &[PRESENT]),
            ("говоришь", "говорить", &[PRESENT]),
            ("люблю", "любить", &[PRESENT]),
            ("смотрят", "смотреть", &[PRESENT]),
            ("рисуют", "рисовать", &[PRESENT]),
            ("читала", "читать", &[PAST]),
            ("училась", "учиться", &[PAST]),
            ("учусь", "учить", &[PRESENT, REFLEXIVE]),
            ("учусь", "учиться", &[PRESENT]),
            ("улыбается", "улыбаться", &[PRESENT]),
            ("улыбайся", "улыбаться", &[IMPERATIVE]),
            ("смеялся", "смеяться", &[PAST]),
            ("читай", "читать", &[IMPERATIVE]),
            ("говори", "говорить", &[IMPERATIVE]),
            ("прочитав", "прочитать", &[GERUND]),
            ("читающая", "читать", &[PARTICIPLE, DECLENSION]),
            ("прочитанный", "прочитать", &[PARTICIPLE]),
        ]);
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v"), V);
        assert_eq!(word_classes("n adj"), N | ADJ);
        assert_eq!(word_classes("vf"), 0);
    }
}
