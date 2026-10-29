//! Komori's Portuguese deinflection rules, for Brazilian and European spelling alike: the simple
//! tenses, gerund and participle of regular -ar, -er and -ir verbs with their spelling changes
//! (fiquei → ficar, conheço → conhecer), enclitic pronouns (fazê-lo → fazer, lembrou-se →
//! lembrou), noun and adjective plurals, feminines, diminutives, superlatives and adverbs in
//! -mente. Irregular verbs (ser, ir, ter) are left to the dictionaries' own form entries.

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
const PRETERITE: &str = "preterite";
const IMPERFECT: &str = "imperfect";
const PLUPERFECT: &str = "pluperfect";
const FUTURE: &str = "future";
const CONDITIONAL: &str = "conditional";
const PRESENT_SUBJUNCTIVE: &str = "present subjunctive";
const IMPERFECT_SUBJUNCTIVE: &str = "imperfect subjunctive";
const FUTURE_SUBJUNCTIVE: &str = "future subjunctive";
const IMPERATIVE: &str = "imperative";
const GERUND: &str = "gerund";
const PAST_PARTICIPLE: &str = "past participle";
const PRONOUN: &str = "pronoun";
const PLURAL: &str = "plural";
const FEMININE: &str = "feminine";
const DIMINUTIVE: &str = "diminutive";
const SUPERLATIVE: &str = "superlative";
const ADVERB: &str = "adverb";

/// Each tense's endings after a regular verb's stem, for -ar, -er and -ir verbs.
const TENSES: &[(&str, [&[&str]; 3])] = &[
    (
        PRESENT,
        [
            &["o", "as", "a", "amos", "ais", "am"],
            &["o", "es", "e", "emos", "eis", "em"],
            &["o", "es", "e", "imos", "is", "em"],
        ],
    ),
    (
        PRETERITE,
        [
            &["ei", "aste", "ou", "amos", "astes", "aram"],
            &["i", "este", "eu", "emos", "estes", "eram"],
            &["i", "iste", "iu", "imos", "istes", "iram"],
        ],
    ),
    (
        IMPERFECT,
        [
            &["ava", "avas", "ávamos", "áveis", "avam"],
            &["ia", "ias", "íamos", "íeis", "iam"],
            &["ia", "ias", "íamos", "íeis", "iam"],
        ],
    ),
    (
        PLUPERFECT,
        [
            &["ara", "aras", "áramos", "áreis", "aram"],
            &["era", "eras", "êramos", "êreis", "eram"],
            &["ira", "iras", "íramos", "íreis", "iram"],
        ],
    ),
    (
        FUTURE,
        [
            &["arei", "arás", "ará", "aremos", "areis", "arão"],
            &["erei", "erás", "erá", "eremos", "ereis", "erão"],
            &["irei", "irás", "irá", "iremos", "ireis", "irão"],
        ],
    ),
    (
        CONDITIONAL,
        [
            &["aria", "arias", "aríamos", "aríeis", "ariam"],
            &["eria", "erias", "eríamos", "eríeis", "eriam"],
            &["iria", "irias", "iríamos", "iríeis", "iriam"],
        ],
    ),
    (
        PRESENT_SUBJUNCTIVE,
        [
            &["e", "es", "emos", "eis", "em"],
            &["a", "as", "amos", "ais", "am"],
            &["a", "as", "amos", "ais", "am"],
        ],
    ),
    (
        IMPERFECT_SUBJUNCTIVE,
        [
            &["asse", "asses", "ássemos", "ásseis", "assem"],
            &["esse", "esses", "êssemos", "êsseis", "essem"],
            &["isse", "isses", "íssemos", "ísseis", "issem"],
        ],
    ),
    // Also the personal infinitive's endings.
    (
        FUTURE_SUBJUNCTIVE,
        [
            &["ares", "armos", "ardes", "arem"],
            &["eres", "ermos", "erdes", "erem"],
            &["ires", "irmos", "irdes", "irem"],
        ],
    ),
    (IMPERATIVE, [&["ai"], &["ei"], &["i"]]),
    (GERUND, [&["ando"], &["endo"], &["indo"]]),
    (
        PAST_PARTICIPLE,
        [
            &["ado", "ada", "ados", "adas"],
            &["ido", "ida", "idos", "idas"],
            &["ido", "ida", "idos", "idas"],
        ],
    ),
];

/// Endings before which a stem's last consonant changes its spelling (fiquei, cheguei, comecei).
const BEFORE_E: &[&str] = &["ei", "e", "es", "emos", "eis", "em"];
/// Endings before which a stem's last consonant changes its spelling (conheço, protejo).
const BEFORE_A_O: &[&str] = &["o", "a", "as", "amos", "ais", "am"];
/// Pronouns joined to a verb by a hyphen.
const ENCLITICS: &[&str] = &[
    "-me", "-te", "-se", "-nos", "-vos", "-lhe", "-lhes", "-o", "-a", "-os", "-as", "-no", "-na",
    "-nas",
];

static TABLE: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    for (name, groups) in TENSES {
        for (group, base) in groups.iter().zip(["ar", "er", "ir"]) {
            rules.extend(endings(name, "", group, base, VF, V));
        }
    }
    rules.extend(endings(PRETERITE, "qu", BEFORE_E, "car", VF, V));
    rules.extend(endings(PRETERITE, "gu", BEFORE_E, "gar", VF, V));
    rules.extend(endings(PRETERITE, "c", BEFORE_E, "çar", VF, V));
    rules.extend(endings(PRESENT, "ç", BEFORE_A_O, "cer", VF, V));
    rules.extend(endings(PRESENT, "j", BEFORE_A_O, "ger", VF, V));
    rules.extend(endings(PRESENT, "j", BEFORE_A_O, "gir", VF, V));
    rules.extend(endings(PRESENT, "g", BEFORE_A_O, "guir", VF, V));
    rules.extend(endings(
        PRESENT,
        "ei",
        &["o", "as", "a", "am", "e", "es", "em"],
        "ear",
        VF,
        V,
    ));
    for (accented, base) in [("á", "ar"), ("ê", "er"), ("i", "ir")] {
        rules.extend(endings(
            PRONOUN,
            accented,
            &["-lo", "-la", "-los", "-las"],
            base,
            0,
            V,
        ));
    }
    rules.extend(endings(PRONOUN, "", ENCLITICS, "", 0, V | VF));
    rules.extend([
        rule(PLURAL, "s", "", N | ADJ, N | ADJ),
        rule(PLURAL, "es", "", N | ADJ, N | ADJ),
        rule(PLURAL, "ões", "ão", N | ADJ, N | ADJ),
        rule(PLURAL, "ães", "ão", N | ADJ, N | ADJ),
        rule(PLURAL, "ãos", "ão", N | ADJ, N | ADJ),
        rule(PLURAL, "ais", "al", N | ADJ, N | ADJ),
        rule(PLURAL, "éis", "el", N | ADJ, N | ADJ),
        rule(PLURAL, "eis", "il", N | ADJ, N | ADJ),
        rule(PLURAL, "óis", "ol", N | ADJ, N | ADJ),
        rule(PLURAL, "uis", "ul", N | ADJ, N | ADJ),
        rule(PLURAL, "is", "il", N | ADJ, N | ADJ),
        rule(PLURAL, "ns", "m", N | ADJ, N | ADJ),
        rule(FEMININE, "a", "o", N | ADJ, N | ADJ),
        rule(FEMININE, "ora", "or", N | ADJ, N | ADJ),
        rule(FEMININE, "esa", "ês", N | ADJ, N | ADJ),
        rule(FEMININE, "ã", "ão", N | ADJ, N | ADJ),
        rule(FEMININE, "ona", "ão", N | ADJ, N | ADJ),
        rule(FEMININE, "eia", "eu", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "inho", "o", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "inha", "a", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "zinho", "", N | ADJ, N | ADJ),
        rule(DIMINUTIVE, "zinha", "", N | ADJ, N | ADJ),
        rule(SUPERLATIVE, "íssimo", "o", ADJ, ADJ),
        rule(SUPERLATIVE, "íssima", "a", ADJ, ADJ),
        rule(ADVERB, "mente", "", ADV, ADJ),
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
            ("falo", "falar", &[PRESENT]),
            ("falamos", "falar", &[PRESENT]),
            ("comem", "comer", &[PRESENT]),
            ("partimos", "partir", &[PRESENT]),
            ("falei", "falar", &[PRETERITE]),
            ("comeu", "comer", &[PRETERITE]),
            ("partiram", "partir", &[PRETERITE]),
            ("falávamos", "falar", &[IMPERFECT]),
            ("comia", "comer", &[IMPERFECT]),
            ("falaremos", "falar", &[FUTURE]),
            ("partirão", "partir", &[FUTURE]),
            ("comeria", "comer", &[CONDITIONAL]),
            ("fale", "falar", &[PRESENT_SUBJUNCTIVE]),
            ("comêssemos", "comer", &[IMPERFECT_SUBJUNCTIVE]),
            ("falarem", "falar", &[FUTURE_SUBJUNCTIVE]),
            ("falando", "falar", &[GERUND]),
            ("partidas", "partir", &[PAST_PARTICIPLE]),
            ("fiquei", "ficar", &[PRETERITE]),
            ("cheguei", "chegar", &[PRETERITE]),
            ("comecei", "começar", &[PRETERITE]),
            ("conheço", "conhecer", &[PRESENT]),
            ("protejo", "proteger", &[PRESENT]),
            ("passeio", "passear", &[PRESENT]),
            ("fazê-lo", "fazer", &[PRONOUN]),
            ("comprá-las", "comprar", &[PRONOUN]),
            ("falando-lhe", "falar", &[GERUND, PRONOUN]),
            ("lembrou-se", "lembrar", &[PRETERITE, PRONOUN]),
            ("casas", "casa", &[PLURAL]),
            ("flores", "flor", &[PLURAL]),
            ("canções", "canção", &[PLURAL]),
            ("animais", "animal", &[PLURAL]),
            ("papéis", "papel", &[PLURAL]),
            ("fáceis", "fácil", &[PLURAL]),
            ("homens", "homem", &[PLURAL]),
            ("bonitas", "bonito", &[FEMININE, PLURAL]),
            ("portuguesa", "português", &[FEMININE]),
            ("casinha", "casa", &[DIMINUTIVE]),
            ("lindíssimo", "lindo", &[SUPERLATIVE]),
            ("felizmente", "feliz", &[ADVERB]),
        ]);
    }

    #[test]
    fn rules_name_word_classes_by_whole_name() {
        assert_eq!(word_classes("v"), V);
        assert_eq!(word_classes(" n  adj "), N | ADJ);
        assert_eq!(word_classes("vt"), 0);
    }
}
