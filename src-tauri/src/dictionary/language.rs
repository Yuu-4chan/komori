//! The lookup language and what it decides about a lookup: its deinflection rules and word
//! classes, the variants of a text it also looks up, whether a lookup's starts must end at a word
//! boundary, and whether the Japanese-only behaviors apply (the kana ranking, する nouns, the
//! trailing-particle reorder and the kanji lookup). Each dictionary belongs to one language, and a
//! lookup uses only that language's dictionaries. Every language but Japanese, Chinese and Thai
//! spaces its words.
//! Adding a language is adding a variant here and its rule table in `deinflect`.

use serde::{Deserialize, Serialize};

use super::deinflect::{self, Candidate};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum Language {
    #[default]
    #[serde(rename = "ja")]
    Japanese,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "fr")]
    French,
    #[serde(rename = "pt")]
    Portuguese,
    #[serde(rename = "it")]
    Italian,
    #[serde(rename = "es")]
    Spanish,
    #[serde(rename = "ko")]
    Korean,
    /// Chinese in either script: its dictionaries list traditional and simplified headwords.
    #[serde(rename = "zh")]
    Chinese,
    #[serde(rename = "de")]
    German,
    #[serde(rename = "ru")]
    Russian,
    #[serde(rename = "nl")]
    Dutch,
    #[serde(rename = "pl")]
    Polish,
    #[serde(rename = "sv")]
    Swedish,
    /// Norwegian Bokmål.
    #[serde(rename = "nb")]
    Norwegian,
    #[serde(rename = "da")]
    Danish,
    #[serde(rename = "fi")]
    Finnish,
    #[serde(rename = "el")]
    Greek,
    #[serde(rename = "tr")]
    Turkish,
    #[serde(rename = "ar")]
    Arabic,
    #[serde(rename = "hi")]
    Hindi,
    #[serde(rename = "th")]
    Thai,
    #[serde(rename = "vi")]
    Vietnamese,
    #[serde(rename = "id")]
    Indonesian,
}

impl Language {
    const ALL: [Self; 23] = [
        Self::Japanese,
        Self::English,
        Self::French,
        Self::Portuguese,
        Self::Italian,
        Self::Spanish,
        Self::Korean,
        Self::Chinese,
        Self::German,
        Self::Russian,
        Self::Dutch,
        Self::Polish,
        Self::Swedish,
        Self::Norwegian,
        Self::Danish,
        Self::Finnish,
        Self::Greek,
        Self::Turkish,
        Self::Arabic,
        Self::Hindi,
        Self::Thai,
        Self::Vietnamese,
        Self::Indonesian,
    ];

    /// The language's ISO 639-1 code, as word audio sources and dictionaries name it.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::English => "en",
            Self::French => "fr",
            Self::Portuguese => "pt",
            Self::Italian => "it",
            Self::Spanish => "es",
            Self::Korean => "ko",
            Self::Chinese => "zh",
            Self::German => "de",
            Self::Russian => "ru",
            Self::Dutch => "nl",
            Self::Polish => "pl",
            Self::Swedish => "sv",
            Self::Norwegian => "nb",
            Self::Danish => "da",
            Self::Finnish => "fi",
            Self::Greek => "el",
            Self::Turkish => "tr",
            Self::Arabic => "ar",
            Self::Hindi => "hi",
            Self::Thai => "th",
            Self::Vietnamese => "vi",
            Self::Indonesian => "id",
        }
    }

    /// The language a code names, as preferences and the dictionary store save it.
    pub(crate) fn from_code(code: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|language| language.code() == code)
    }

    /// The language a dictionary's declared source language names, if it is one of these: a tag
    /// matches by its primary subtag, in either case, as a two- or three-letter code (`en-US`,
    /// `EN`, `eng`).
    pub(crate) fn declared(tag: Option<&str>) -> Option<Self> {
        let primary = tag?
            .trim()
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        Self::ALL.into_iter().find(|language| {
            let three: &[&str] = match language {
                Self::Japanese => &["jpn"],
                Self::English => &["eng"],
                Self::French => &["fra", "fre"],
                Self::Portuguese => &["por"],
                Self::Italian => &["ita"],
                Self::Spanish => &["spa"],
                Self::Korean => &["kor"],
                Self::Chinese => &["zho", "chi", "cmn", "yue"],
                Self::German => &["deu", "ger"],
                Self::Russian => &["rus"],
                Self::Dutch => &["nld", "dut"],
                Self::Polish => &["pol"],
                Self::Swedish => &["swe"],
                Self::Norwegian => &["nob", "nor", "no"],
                Self::Danish => &["dan"],
                Self::Finnish => &["fin"],
                Self::Greek => &["ell", "gre"],
                Self::Turkish => &["tur"],
                Self::Arabic => &["ara", "arb"],
                Self::Hindi => &["hin"],
                Self::Thai => &["tha"],
                Self::Vietnamese => &["vie"],
                Self::Indonesian => &["ind"],
            };
            primary == language.code() || three.contains(&primary.as_str())
        })
    }

    /// The forms `text` may be an inflection of in this language.
    pub(crate) fn deinflect(self, text: &str) -> Vec<Candidate> {
        match self {
            Self::Japanese => deinflect::ja::deinflect(text),
            Self::English => deinflect::en::deinflect(text),
            Self::French => deinflect::fr::deinflect(text),
            Self::Portuguese => deinflect::pt::deinflect(text),
            Self::Italian => deinflect::it::deinflect(text),
            Self::Spanish => deinflect::es::deinflect(text),
            Self::Korean => deinflect::ko::deinflect(text),
            // Chinese does not inflect.
            Self::Chinese => Vec::new(),
            Self::German => deinflect::de::deinflect(text),
            Self::Russian => deinflect::ru::deinflect(text),
            Self::Arabic => deinflect::ar::deinflect(text),
            Self::Dutch => deinflect::nl::deinflect(text),
            Self::Danish => deinflect::nordic::deinflect(text),
            Self::Norwegian => deinflect::nordic::deinflect(text),
            Self::Swedish => deinflect::nordic::deinflect(text),
            Self::Indonesian => deinflect::id::deinflect(text),
            Self::Greek => deinflect::el::deinflect(text),
            Self::Polish => deinflect::pl::deinflect(text),
            Self::Finnish => deinflect::fi::deinflect(text),
            Self::Turkish => deinflect::tr::deinflect(text),
            // Thai and Vietnamese do not inflect; Hindi dictionaries list their inflected forms as
            // form entries.
            Self::Hindi | Self::Thai | Self::Vietnamese => Vec::new(),
        }
    }

    /// The word classes a term's space-separated rules name.
    pub(crate) fn word_classes(self, rules: &str) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::word_classes(rules),
            Self::English => deinflect::en::word_classes(rules),
            Self::French => deinflect::fr::word_classes(rules),
            Self::Portuguese => deinflect::pt::word_classes(rules),
            Self::Italian => deinflect::it::word_classes(rules),
            Self::Spanish => deinflect::es::word_classes(rules),
            Self::Korean => deinflect::ko::word_classes(rules),
            Self::Chinese => 0,
            Self::German => deinflect::de::word_classes(rules),
            Self::Russian => deinflect::ru::word_classes(rules),
            Self::Arabic => deinflect::ar::word_classes(rules),
            Self::Dutch => deinflect::nl::word_classes(rules),
            Self::Danish => deinflect::nordic::word_classes(rules),
            Self::Norwegian => deinflect::nordic::word_classes(rules),
            Self::Swedish => deinflect::nordic::word_classes(rules),
            Self::Indonesian => deinflect::id::word_classes(rules),
            Self::Greek => deinflect::el::word_classes(rules),
            Self::Polish => deinflect::pl::word_classes(rules),
            Self::Finnish => deinflect::fi::word_classes(rules),
            Self::Turkish => deinflect::tr::word_classes(rules),
            Self::Hindi | Self::Thai | Self::Vietnamese => 0,
        }
    }

    /// Whether a term with these rules can be a dictionary form of one of `classes`. Japanese
    /// dictionaries name every inflecting word's class, so a term must name one. Other languages'
    /// dictionaries often name none, or none Komori knows (`idiom`), which says nothing against it.
    pub(crate) fn rules_allow(self, rules: &str, classes: u32) -> bool {
        if self.is_japanese() {
            return self.word_classes(rules) & classes != 0;
        }
        let named = self.word_classes(&common_class_names(rules));
        named == 0 || named & classes != 0
    }

    /// The word classes a term's rules can name.
    pub(crate) fn dictionary_forms(self) -> u32 {
        match self {
            Self::Japanese => deinflect::ja::DICTIONARY_FORMS,
            Self::English => deinflect::en::DICTIONARY_FORMS,
            Self::French => deinflect::fr::DICTIONARY_FORMS,
            Self::Portuguese => deinflect::pt::DICTIONARY_FORMS,
            Self::Italian => deinflect::it::DICTIONARY_FORMS,
            Self::Spanish => deinflect::es::DICTIONARY_FORMS,
            Self::Korean => deinflect::ko::DICTIONARY_FORMS,
            Self::Chinese => 0,
            Self::German => deinflect::de::DICTIONARY_FORMS,
            Self::Russian => deinflect::ru::DICTIONARY_FORMS,
            Self::Arabic => deinflect::ar::DICTIONARY_FORMS,
            Self::Dutch => deinflect::nl::DICTIONARY_FORMS,
            Self::Danish => deinflect::nordic::DICTIONARY_FORMS,
            Self::Norwegian => deinflect::nordic::DICTIONARY_FORMS,
            Self::Swedish => deinflect::nordic::DICTIONARY_FORMS,
            Self::Indonesian => deinflect::id::DICTIONARY_FORMS,
            Self::Greek => deinflect::el::DICTIONARY_FORMS,
            Self::Polish => deinflect::pl::DICTIONARY_FORMS,
            Self::Finnish => deinflect::fi::DICTIONARY_FORMS,
            Self::Turkish => deinflect::tr::DICTIONARY_FORMS,
            Self::Hindi | Self::Thai | Self::Vietnamese => 0,
        }
    }

    /// `text` and the other spellings a lookup also tries, each once: in a language that spaces
    /// its words, with its typographic apostrophes as ASCII ones, then also lowercased, with its
    /// first letter capitalized, and lowercased with its first letter capitalized (Running:
    /// running; london: London; NASA: nasa, Nasa); in French, Italian and Portuguese, then also all
    /// of those for the text without the elided word that begins it (l'homme: homme; dell'Italia:
    /// Italia; d'água: água).
    /// Russian then also tries each without its stress marks, with ё as е, and with each one е as ё (a word has one ё).
    /// Arabic also tries each without short vowels and tatweel, and without the article al- and
    /// the wa-, fa-, bi- or ka- joined before it (li- with it is لل), and with a hamza on a bare alif,
    /// ى as ي or ه as ة at the end; Greek also without a second accent (πρόσωπό); Vietnamese also with its
    /// tone marks placed by the older and newer rules (hòa, hoà); Turkish also tries its own lowercase and
    /// capitalized forms (I: ı, İ: i). Thai, like Japanese and Chinese, does not space its words.
    /// Japanese and Chinese try only the text.
    pub(crate) fn variants(self, text: &str) -> Vec<String> {
        let mut variants = vec![text.to_owned()];
        if !self.spaces_words() {
            return variants;
        }
        let elided = self.without_elision(text);
        for text in std::iter::once(text).chain(elided.as_deref()) {
            let ascii = text.replace('\u{2019}', "'");
            let lower = ascii.to_lowercase();
            let capitalized_ascii = capitalized(&ascii);
            let capitalized_lower = capitalized(&lower);
            for variant in [
                text.to_owned(),
                ascii,
                lower,
                capitalized_ascii,
                capitalized_lower,
            ] {
                if !variants.contains(&variant) {
                    variants.push(variant);
                }
            }
        }
        if self == Self::Russian {
            for variant in variants.clone() {
                let plain = variant.replace('\u{301}', "");
                let with_e = plain.replace('ё', "е").replace('Ё', "Е");
                let with_yo = plain
                    .char_indices()
                    .filter_map(|(at, letter)| {
                        let yo = match letter {
                            'е' => "ё",
                            'Е' => "Ё",
                            _ => return None,
                        };
                        Some(format!(
                            "{}{yo}{}",
                            &plain[..at],
                            &plain[at + letter.len_utf8()..]
                        ))
                    })
                    .collect::<Vec<_>>();
                for respelled in [plain, with_e].into_iter().chain(with_yo) {
                    if !variants.contains(&respelled) {
                        variants.push(respelled);
                    }
                }
            }
        }
        let respellings: Vec<String> = match self {
            // Imports keep Arabic headwords' bare spelling (see `without_arabic_marks`); the
            // article al- and the and/so/with/as/for joined before it are dropped as well.
            Self::Arabic => {
                let bare: Vec<String> = variants
                    .iter()
                    .filter_map(|variant| without_arabic_marks(variant))
                    .collect();
                let mut respelled = bare.clone();
                for word in variants.iter().chain(&bare) {
                    if let Some(noun) = without_arabic_article(word) {
                        respelled.push(noun);
                    }
                }
                // Spellings books simplify: a hamza left off an alif (اكبر: أكبر, اسلام: إسلام),
                // a final ى for ي, a final ه for ة.
                let simplified: Vec<String> = variants
                    .iter()
                    .chain(&respelled)
                    .flat_map(|word| arabic_spellings(word))
                    .collect();
                respelled.extend(simplified);
                respelled
            }
            // Vietnamese writes a tone mark on one of two vowels by older or newer rules (hòa or
            // hoà, thủy or thuỷ); dictionaries keep one or the other.
            Self::Vietnamese => [false, true]
                .into_iter()
                .map(|newer| vietnamese_tones(text, newer))
                .collect(),
            // A word before an enclitic takes a second accent (το πρόσωπό μου): dictionaries have
            // one.
            Self::Greek => variants
                .iter()
                .filter_map(|variant| without_second_greek_accent(variant))
                .collect(),
            // Turkish pairs I with ı and İ with i.
            Self::Turkish => {
                let lower = text.replace('I', "ı").replace('İ', "i").to_lowercase();
                let mut letters = lower.chars();
                let capitalized = letters.next().map_or_else(String::new, |first| {
                    let first: String = match first {
                        'i' => "İ".to_owned(),
                        'ı' => "I".to_owned(),
                        other => other.to_uppercase().collect(),
                    };
                    first + letters.as_str()
                });
                vec![lower, capitalized]
            }
            _ => Vec::new(),
        };
        for respelled in respellings {
            if !variants.contains(&respelled) {
                variants.push(respelled);
            }
        }
        variants
    }

    /// `text` without the elided word that begins it (l', d', qu'; dell', un'; d', n'), when more
    /// follows it.
    fn without_elision(self, text: &str) -> Option<String> {
        let words: &[&str] = match self {
            Self::French => &[
                "l", "d", "j", "m", "n", "s", "t", "c", "ç", "qu", "jusqu", "lorsqu", "puisqu",
                "quoiqu", "presqu",
            ],
            Self::Italian => &[
                "l", "dell", "all", "dall", "nell", "sull", "coll", "un", "quest", "quell", "c",
                "n", "d", "s", "m", "t", "v",
            ],
            Self::Portuguese => &["d", "n"],
            _ => return None,
        };
        let (word, rest) = text.split_once(['\'', '\u{2019}'])?;
        (words.contains(&word.to_lowercase().as_str()) && !rest.is_empty()).then(|| rest.to_owned())
    }

    /// Whether a lookup's starts end only at word boundaries, as in languages that space their
    /// words: `looked` is not also looked up as `look` or `lo`.
    pub(crate) fn spaces_words(self) -> bool {
        !matches!(self, Self::Japanese | Self::Chinese | Self::Thai)
    }

    /// Whether the Japanese-only lookup behaviors apply: the kana ranking, する nouns, the
    /// trailing-particle reorder and the kanji lookup.
    pub(crate) fn is_japanese(self) -> bool {
        self == Self::Japanese
    }
}

/// `rules` with dictionaries' other names for the common word classes written as the rule tables
/// name them (`vt`, `masc-n`, `名詞`: `v`, `n`, `n`).
fn common_class_names(rules: &str) -> String {
    rules
        .split_whitespace()
        .map(|rule| match rule {
            "vt" | "vi" | "vr" | "vt/vi" | "verb" | "overg" | "onoverg" | "動詞" | "동사"
            | "타동사" | "자동사" | "타∙자동사" | "자∙타동사" => "v",
            "noun" | "masc-n" | "fem-n" | "neut-n" | "pl-n" | "prop-n" | "masc/fem-n"
            | "masc/neut-n" | "npl" | "SUBST" | "znw" | "名詞" | "명사" | "의존명사" => "n",
            "adjective" | "bn" | "形容詞" | "형용사" => "adj",
            "adverb" | "bijw" | "副詞" | "부사" => "adv",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` with its first letter capitalized.
fn capitalized(text: &str) -> String {
    let mut characters = text.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(characters).collect()
    })
}

/// Arabic text without its short vowels and other marks (U+0618–U+061A, U+064B–U+065F, U+0670) and
/// tatweel, or None when it has none or is nothing else. Dictionaries mostly write Arabic headwords
/// with their vowels and books mostly without, so imports keep the bare spelling as the reading
/// lookups match.
pub(crate) fn without_arabic_marks(text: &str) -> Option<String> {
    let mark = |letter: char| matches!(letter, '\u{618}'..='\u{61A}' | '\u{64B}'..='\u{65F}' | '\u{670}' | '\u{640}');
    let bare: String = text.chars().filter(|&letter| !mark(letter)).collect();
    (bare.len() != text.len() && !bare.is_empty()).then_some(bare)
}

/// Vietnamese vowels and their five toned forms: huyền, hỏi, ngã, sắc, nặng.
const VIETNAMESE_TONES: [(char, [char; 5]); 12] = [
    ('a', ['à', 'ả', 'ã', 'á', 'ạ']),
    ('ă', ['ằ', 'ẳ', 'ẵ', 'ắ', 'ặ']),
    ('â', ['ầ', 'ẩ', 'ẫ', 'ấ', 'ậ']),
    ('e', ['è', 'ẻ', 'ẽ', 'é', 'ẹ']),
    ('ê', ['ề', 'ể', 'ễ', 'ế', 'ệ']),
    ('i', ['ì', 'ỉ', 'ĩ', 'í', 'ị']),
    ('o', ['ò', 'ỏ', 'õ', 'ó', 'ọ']),
    ('ô', ['ồ', 'ổ', 'ỗ', 'ố', 'ộ']),
    ('ơ', ['ờ', 'ở', 'ỡ', 'ớ', 'ợ']),
    ('u', ['ù', 'ủ', 'ũ', 'ú', 'ụ']),
    ('ư', ['ừ', 'ử', 'ữ', 'ứ', 'ự']),
    ('y', ['ỳ', 'ỷ', 'ỹ', 'ý', 'ỵ']),
];

/// Text with each Vietnamese syllable's tone mark where the older (hòa, thủy) or newer (hoà,
/// thuỷ) rules put it: on the vowel with a breve, circumflex or horn (the later of ươ); else in an
/// open oa, oe or uy on the first vowel by the older rules and the second by the newer; else on
/// the middle of three vowels, the second of two before a consonant, or the first of two.
fn vietnamese_tones(text: &str, newer: bool) -> String {
    let split = |letter: char| {
        let lower = letter.to_lowercase().next().unwrap_or(letter);
        let upper = lower != letter;
        VIETNAMESE_TONES.iter().find_map(|(base, toned)| {
            if *base == lower {
                Some((*base, None, upper))
            } else {
                toned
                    .iter()
                    .position(|form| *form == lower)
                    .map(|tone| (*base, Some(tone), upper))
            }
        })
    };
    let join = |base: char, tone: Option<usize>, upper: bool| {
        let letter = tone.map_or(base, |tone| {
            VIETNAMESE_TONES
                .iter()
                .find(|(vowel, _)| *vowel == base)
                .map_or(base, |(_, toned)| toned[tone])
        });
        if upper {
            letter.to_uppercase().next().unwrap_or(letter)
        } else {
            letter
        }
    };
    text.split(' ')
        .map(|syllable| {
            let letters: Vec<char> = syllable.chars().collect();
            let vowels: Vec<(usize, char, Option<usize>, bool)> = letters
                .iter()
                .enumerate()
                .filter_map(|(at, &letter)| {
                    split(letter).map(|(base, tone, upper)| (at, base, tone, upper))
                })
                .collect();
            let tones: Vec<usize> = vowels.iter().filter_map(|vowel| vowel.2).collect();
            let [tone] = tones[..] else {
                return syllable.to_owned();
            };
            // The vowels of the syllable's one run, without the u of qu or the i of gi before a vowel.
            let Some(first) = vowels.first().map(|vowel| vowel.0) else {
                return syllable.to_owned();
            };
            let mut run: Vec<_> = vowels
                .iter()
                .enumerate()
                .take_while(|(index, vowel)| vowel.0 == first + index)
                .map(|(_, vowel)| *vowel)
                .collect();
            let onset = letters[..first].iter().collect::<String>().to_lowercase();
            if run.len() > 1
                && ((onset == "q" && run[0].1 == 'u') || (onset == "g" && run[0].1 == 'i'))
            {
                run.remove(0);
            }
            let closed = run.last().is_some_and(|last| last.0 + 1 < letters.len());
            let pair: String = run.iter().map(|vowel| vowel.1).collect();
            let marked = run
                .iter()
                .rposition(|vowel| matches!(vowel.1, 'ă' | 'â' | 'ê' | 'ô' | 'ơ' | 'ư'))
                .unwrap_or(match run.len() {
                    0 | 1 => 0,
                    2 if closed || (newer && matches!(pair.as_str(), "oa" | "oe" | "uy")) => 1,
                    2 => 0,
                    _ => 1,
                });
            let Some(target) = run.get(marked).map(|vowel| vowel.0) else {
                return syllable.to_owned();
            };
            letters
                .iter()
                .enumerate()
                .map(
                    |(at, &letter)| match vowels.iter().find(|vowel| vowel.0 == at) {
                        Some(&(_, base, _, upper)) => {
                            join(base, (at == target).then_some(tone), upper)
                        }
                        None => letter,
                    },
                )
                .collect()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// An Arabic word's fuller spellings: its first bare alif with a hamza above or below, a final ى
/// as ي and a final ه as ة.
fn arabic_spellings(word: &str) -> Vec<String> {
    let mut spellings = Vec::new();
    if word.contains('ا') {
        spellings.push(word.replacen('ا', "أ", 1));
        spellings.push(word.replacen('ا', "إ", 1));
    }
    for (last, fuller) in [('ى', 'ي'), ('ه', 'ة')] {
        if let Some(stem) = word.strip_suffix(last) {
            spellings.push(format!("{stem}{fuller}"));
        }
    }
    spellings
}

/// A Greek word with a second accent (πρόσωπό) without it, or None.
fn without_second_greek_accent(word: &str) -> Option<String> {
    const ACCENTED: [(char, char); 9] = [
        ('ά', 'α'),
        ('έ', 'ε'),
        ('ή', 'η'),
        ('ί', 'ι'),
        ('ό', 'ο'),
        ('ύ', 'υ'),
        ('ώ', 'ω'),
        ('ΐ', 'ϊ'),
        ('ΰ', 'ϋ'),
    ];
    let unaccented = |letter: char| {
        ACCENTED
            .iter()
            .find(|(accented, _)| *accented == letter)
            .map(|(_, bare)| *bare)
    };
    let mut accents = 0;
    let mut changed = false;
    let respelled: String = word
        .chars()
        .map(|letter| match unaccented(letter) {
            Some(bare) => {
                accents += 1;
                if accents > 1 {
                    changed = true;
                    bare
                } else {
                    letter
                }
            }
            None => letter,
        })
        .collect();
    changed.then_some(respelled)
}

/// An Arabic word without the article al- (ال) and the conjunction or preposition joined before
/// it (wa-, fa-, bi-, ka-; li- with the article is لل), when at least two letters remain.
fn without_arabic_article(word: &str) -> Option<String> {
    ["وال", "فال", "بال", "كال", "ال", "لل"]
        .iter()
        .find_map(|prefix| word.strip_prefix(prefix))
        .filter(|rest| rest.chars().count() >= 2)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_also_tries_ascii_apostrophes_and_capitalization() {
        assert_eq!(
            Language::English.variants("Running"),
            ["Running", "running"]
        );
        assert_eq!(Language::English.variants("london"), ["london", "London"]);
        assert_eq!(
            Language::English.variants("NASA's"),
            ["NASA's", "nasa's", "Nasa's"]
        );
        assert_eq!(
            Language::English.variants("Cat\u{2019}s"),
            ["Cat\u{2019}s", "Cat's", "cat's"]
        );
        assert_eq!(
            Language::English.variants("look up"),
            ["look up", "Look up"]
        );
        assert_eq!(
            Language::French.variants("L’homme"),
            ["L’homme", "L'homme", "l'homme", "homme", "Homme"]
        );
        assert_eq!(
            Language::French.variants("qu'il"),
            ["qu'il", "Qu'il", "il", "Il"]
        );
        assert_eq!(
            Language::Italian.variants("dell'Italia"),
            [
                "dell'Italia",
                "dell'italia",
                "Dell'Italia",
                "Dell'italia",
                "Italia",
                "italia"
            ]
        );
        assert_eq!(
            Language::Portuguese.variants("d'água"),
            ["d'água", "D'água", "água", "Água"]
        );
        assert_eq!(Language::Japanese.variants("Running"), ["Running"]);
        assert_eq!(
            Language::Japanese.variants("読む\u{2019}"),
            ["読む\u{2019}"]
        );
    }

    #[test]
    fn russian_also_tries_its_text_without_stress_marks_and_with_yo_respelled() {
        assert_eq!(
            Language::Russian.variants("Ещё"),
            ["Ещё", "ещё", "Еще", "Ёщё", "еще", "ёщё"]
        );
        assert!(Language::Russian
            .variants("молоко\u{301}")
            .contains(&"молоко".to_owned()));
        assert!(Language::Russian
            .variants("еще")
            .contains(&"ещё".to_owned()));
    }

    #[test]
    fn arabic_also_tries_its_text_without_short_vowels_or_tatweel() {
        let variants = Language::Arabic.variants("كِتَابٌ");
        assert_eq!(variants[0], "كِتَابٌ");
        assert!(variants.contains(&"كتاب".to_owned()));
        assert!(Language::Arabic
            .variants("كتــاب")
            .contains(&"كتاب".to_owned()));
    }

    #[test]
    fn arabic_also_tries_its_words_without_the_article() {
        for text in ["الكتاب", "والكتاب", "بالكتاب", "الكِتَاب"] {
            assert!(
                Language::Arabic.variants(text).contains(&"كتاب".to_owned()),
                "{text}"
            );
        }
        assert!(Language::Arabic
            .variants("للبيت")
            .contains(&"بيت".to_owned()));
        // Two letters at least remain: "the" alone is not a word to look up.
        assert!(Language::Arabic
            .variants("ال")
            .iter()
            .all(|variant| variant.chars().count() == 2));
        assert_eq!(super::without_arabic_marks("كِتَابٌ").as_deref(), Some("كتاب"));
        assert_eq!(super::without_arabic_marks("كتاب"), None);
        assert_eq!(super::without_arabic_marks("ـ"), None);
    }

    #[test]
    fn arabic_also_tries_the_spellings_books_simplify() {
        for (text, spelled) in [
            ("اكبر", "أكبر"),
            ("اسلام", "إسلام"),
            ("فى", "في"),
            ("لغه", "لغة"),
            ("اللغه", "لغة"),
        ] {
            assert!(
                Language::Arabic
                    .variants(text)
                    .contains(&spelled.to_owned()),
                "{text}"
            );
        }
        assert_eq!(
            super::without_arabic_marks("\u{618}كتاب").as_deref(),
            Some("كتاب")
        );
    }

    #[test]
    fn vietnamese_also_tries_its_tone_marks_by_the_older_and_newer_rules() {
        for (text, older, newer) in [
            ("hoà", "hòa", "hoà"),
            ("hòa", "hòa", "hoà"),
            ("thuỷ", "thủy", "thuỷ"),
            ("Thủy", "Thủy", "Thuỷ"),
            ("hoè", "hòe", "hoè"),
            ("toán", "toán", "toán"),
            ("mùa", "mùa", "mùa"),
            ("người", "người", "người"),
            ("quý", "quý", "quý"),
            ("giá", "giá", "giá"),
            ("học sinh hoà", "học sinh hòa", "học sinh hoà"),
        ] {
            assert_eq!(super::vietnamese_tones(text, false), older, "{text}");
            assert_eq!(super::vietnamese_tones(text, true), newer, "{text}");
        }
        assert!(Language::Vietnamese
            .variants("hoà bình")
            .contains(&"hòa bình".to_owned()));
    }

    #[test]
    fn greek_also_tries_a_word_without_its_second_accent() {
        assert_eq!(
            Language::Greek.variants("πρόσωπό"),
            ["πρόσωπό", "Πρόσωπό", "πρόσωπο", "Πρόσωπο"]
        );
        assert!(!Language::Greek
            .variants("πρόσωπο")
            .contains(&"προσωπο".to_owned()));
    }

    #[test]
    fn turkish_pairs_dotless_and_dotted_i_in_its_case_forms() {
        let variants = Language::Turkish.variants("Istanbul");
        assert!(variants.contains(&"ıstanbul".to_owned()), "{variants:?}");
        let variants = Language::Turkish.variants("İzmir");
        assert!(variants.contains(&"izmir".to_owned()), "{variants:?}");
        let variants = Language::Turkish.variants("ilk");
        assert!(variants.contains(&"İlk".to_owned()), "{variants:?}");
    }

    #[test]
    fn thai_like_japanese_and_chinese_does_not_space_its_words() {
        for language in Language::ALL {
            assert_eq!(
                language.spaces_words(),
                !matches!(
                    language,
                    Language::Japanese | Language::Chinese | Language::Thai
                ),
                "{language:?}"
            );
        }
    }

    #[test]
    fn declared_source_languages_name_a_language_by_primary_subtag() {
        for tag in ["ja", "JA", "ja-JP", " jpn "] {
            assert_eq!(
                Language::declared(Some(tag)),
                Some(Language::Japanese),
                "{tag}"
            );
        }
        for (tag, language) in [
            ("en", Language::English),
            ("en-US", Language::English),
            ("EN_gb", Language::English),
            ("eng", Language::English),
            ("fr-CA", Language::French),
            ("fre", Language::French),
            ("fra", Language::French),
            ("pt-BR", Language::Portuguese),
            ("por", Language::Portuguese),
            ("it", Language::Italian),
            ("ita", Language::Italian),
            ("es-MX", Language::Spanish),
            ("spa", Language::Spanish),
            ("ko", Language::Korean),
            ("kor", Language::Korean),
            ("zh", Language::Chinese),
            ("zh-Hant", Language::Chinese),
            ("zh_CN", Language::Chinese),
            ("cmn", Language::Chinese),
            ("de-AT", Language::German),
            ("ger", Language::German),
            ("ru", Language::Russian),
            ("rus", Language::Russian),
            ("nl-BE", Language::Dutch),
            ("nld", Language::Dutch),
            ("dut", Language::Dutch),
            ("pol", Language::Polish),
            ("sv-SE", Language::Swedish),
            ("nb", Language::Norwegian),
            ("nob", Language::Norwegian),
            ("no", Language::Norwegian),
            ("dan", Language::Danish),
            ("fin", Language::Finnish),
            ("ell", Language::Greek),
            ("gre", Language::Greek),
            ("tur", Language::Turkish),
            ("ar-EG", Language::Arabic),
            ("arb", Language::Arabic),
            ("hin", Language::Hindi),
            ("th", Language::Thai),
            ("vie", Language::Vietnamese),
            ("ind", Language::Indonesian),
        ] {
            assert_eq!(Language::declared(Some(tag)), Some(language), "{tag}");
        }
        for tag in [
            None,
            Some(""),
            Some(" "),
            Some("nn"),
            Some("jav"),
            Some("english"),
            Some("e"),
        ] {
            assert_eq!(Language::declared(tag), None, "{tag:?}");
        }
    }

    #[test]
    fn rules_allow_a_class_they_name_or_say_nothing_against() {
        use deinflect::{en, ko, ru};
        for rules in ["vt", "imperfective verb", "타동사", "動詞", "v"] {
            assert!(Language::Russian.rules_allow(rules, ru::V), "{rules}");
            assert!(!Language::Russian.rules_allow(rules, ru::N), "{rules}");
        }
        for rules in ["masc-n", "feminine noun", "SUBST", "名詞", "명사"] {
            assert!(Language::English.rules_allow(rules, en::N), "{rules}");
            assert!(!Language::English.rules_allow(rules, en::V), "{rules}");
        }
        assert!(!Language::Korean.rules_allow("명사", ko::V));
        for rules in ["", "idiom", "abbv"] {
            assert!(Language::English.rules_allow(rules, en::V), "{rules}");
        }
        assert!(!Language::Japanese.rules_allow("", deinflect::ja::V1));
        assert!(!Language::Japanese.rules_allow("vt", deinflect::ja::V1));
        assert!(Language::Japanese.rules_allow("v1 vt", deinflect::ja::V1));
    }

    #[test]
    fn languages_round_trip_by_code() {
        for language in Language::ALL {
            let json = serde_json::to_string(&language).unwrap();
            assert_eq!(json, format!("\"{}\"", language.code()));
            assert_eq!(serde_json::from_str::<Language>(&json).unwrap(), language);
            assert_eq!(Language::from_code(language.code()), Some(language));
        }
        assert_eq!(Language::from_code("xx"), None);
        assert!(serde_json::from_str::<Language>("\"xx\"").is_err());
        assert_eq!(Language::default(), Language::Japanese);
    }
}
