// Deinflection adapted from Yomitan.
// Copyright (C) 2024-2026 Yomitan Authors (ext/js/language/language-transformer.js and
// ext/js/language/language-transforms.js, https://github.com/yomidevs/yomitan at commits 67db60d
// and d3c54c1).
// Copyright (C) 2026 Yuu-4chan (the Rust translation, Komori's ordering and changes below).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY;
// see the LICENSE file at the repository root.

//! A table-driven deinflector adapted from Yomitan's language transformer, shared by every lookup
//! language; each language's rule table and word classes are in its own module. Each rule
//! replaces an inflected form with a shorter one, applies only to text whose word classes it
//! inflects (the searched text takes any rule), and gives the result the word classes that form
//! can have. Only candidates whose classes include one of the language's dictionary forms can
//! match a term, and then only a term whose rules name one of them.

pub(crate) mod en;
pub(crate) mod es;
pub(crate) mod fr;
pub(crate) mod it;
pub(crate) mod ja;
pub(crate) mod pt;

#[cfg(test)]
pub(crate) use ja::{ADJ_I, V1, V5, VK, VS, VZ};

use std::collections::{HashMap, HashSet};

/// The most rules chained to reach one candidate; the longest listed chains take six
/// (読まされていました → 読まされています → 読まされている → 読まされて → 読まされる → 読ます
/// → 読む: short causative, passive, -te, progressive, polite, past).
pub(crate) const MAX_STEPS: usize = 6;
/// The most candidates generated for one text; none of the format's test texts generate more than
/// 25 within six steps.
pub(crate) const MAX_CANDIDATES: usize = 64;

/// Where a rule's inflected form is in the text.
#[derive(Clone, Copy)]
enum Kind {
    /// The text's ending.
    Suffix,
    /// The whole text (いらっしゃいます).
    WholeWord,
    /// The text's beginning (unhappy, will go).
    Prefix,
    /// The ending of the text's first word, when the next word is one of these (looked up).
    FirstWordBefore(&'static [&'static str]),
    /// The words between the first word and the next of `particles`, none of them one of `words`;
    /// the rule removes them (look it up → look up). Its inflected and base forms are empty.
    InterposedWords {
        words: &'static [&'static str],
        particles: &'static [&'static str],
    },
    /// A stem's vowel change before an ending (piensan → pensar): the text must end in one of
    /// `endings` after a `from` followed only by lowercase ASCII letters; its first `from` becomes
    /// `to`, then the longest of `strip` ending it becomes the base. A text must begin with
    /// `starts` and must not begin with `not_starts`, where they are not empty.
    StemChange {
        from: &'static str,
        to: &'static str,
        endings: &'static [&'static str],
        strip: &'static [&'static str],
        starts: &'static str,
        not_starts: &'static str,
    },
}

#[derive(Clone, Copy)]
struct Rule {
    /// The inflection's name, as the Dictionary page shows it.
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    /// The classes of text this rule applies to, besides the text as searched; 0 means only it.
    applies_to: u32,
    /// The classes of the result.
    gives: u32,
    kind: Kind,
}

const fn rule(
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        name,
        inflected,
        base,
        applies_to,
        gives,
        kind: Kind::Suffix,
    }
}

/// A rule whose inflected form is a whole word (いらっしゃいます), not an ending.
const fn whole_word(
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        kind: Kind::WholeWord,
        ..rule(name, inflected, base, applies_to, gives)
    }
}

/// A rule whose inflected form begins the text (unhappy, will go).
const fn prefix(
    name: &'static str,
    inflected: &'static str,
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        kind: Kind::Prefix,
        ..rule(name, inflected, base, applies_to, gives)
    }
}

/// `suffix` with its inflected form ending the first word, when one of `next` follows it.
const fn first_word_before(suffix: Rule, next: &'static [&'static str], gives: u32) -> Rule {
    Rule {
        gives,
        kind: Kind::FirstWordBefore(next),
        ..suffix
    }
}

/// A rule removing the words between the first word and the next of `particles`.
const fn interposed_words(
    name: &'static str,
    words: &'static [&'static str],
    particles: &'static [&'static str],
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        kind: Kind::InterposedWords { words, particles },
        ..rule(name, "", "", applies_to, gives)
    }
}

/// One rule for each of `endings`: `stem` followed by it gives `base` (fal-o, fal-amos → falar
/// with `stem` empty and `base` "ar").
fn endings(
    name: &'static str,
    stem: &str,
    endings: &[&str],
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Vec<Rule> {
    endings
        .iter()
        .map(|ending| {
            let inflected: &'static str = format!("{stem}{ending}").leak();
            rule(name, inflected, base, applies_to, gives)
        })
        .collect()
}

/// The word classes a term's space-separated rules name, each rule by `names`.
fn named_classes(rules: &str, names: &[(&str, u32)]) -> u32 {
    rules
        .split_whitespace()
        .filter_map(|rule| names.iter().find(|(name, _)| *name == rule))
        .fold(0, |classes, (_, class)| classes | class)
}

/// A rule changing a stem's vowel before one of `endings` (see `Kind::StemChange`).
const fn stem_change(
    name: &'static str,
    from: &'static str,
    to: &'static str,
    endings: &'static [&'static str],
    base: &'static str,
    applies_to: u32,
    gives: u32,
) -> Rule {
    Rule {
        kind: Kind::StemChange {
            from,
            to,
            endings,
            strip: endings,
            starts: "",
            not_starts: "",
        },
        ..rule(name, "", base, applies_to, gives)
    }
}

impl Rule {
    /// This stem change, applying only to text beginning with `starts` and replacing the longest
    /// of `strip` with its base.
    const fn only_starting(self, starts: &'static str, strip: &'static [&'static str]) -> Self {
        match self.kind {
            Kind::StemChange {
                from, to, endings, ..
            } => Self {
                kind: Kind::StemChange {
                    from,
                    to,
                    endings,
                    strip,
                    starts,
                    not_starts: "",
                },
                ..self
            },
            _ => self,
        }
    }

    /// This stem change, not applying to text beginning with `start`.
    const fn not_starting(self, start: &'static str) -> Self {
        match self.kind {
            Kind::StemChange {
                from,
                to,
                endings,
                strip,
                starts,
                ..
            } => Self {
                kind: Kind::StemChange {
                    from,
                    to,
                    endings,
                    strip,
                    starts,
                    not_starts: start,
                },
                ..self
            },
            _ => self,
        }
    }

    /// The text this rule gives `text`, when it applies to its form.
    fn apply(&self, text: &str) -> Option<String> {
        match self.kind {
            Kind::Suffix => text
                .strip_suffix(self.inflected)
                .map(|stem| format!("{stem}{}", self.base)),
            Kind::WholeWord => (text == self.inflected).then(|| self.base.to_owned()),
            Kind::Prefix => text
                .strip_prefix(self.inflected)
                .map(|rest| format!("{}{rest}", self.base)),
            Kind::FirstWordBefore(next) => {
                let (first, rest) = text.split_once(' ')?;
                let stem = first.strip_suffix(self.inflected)?;
                let following = rest.split(' ').next()?;
                (stem.chars().all(char::is_alphanumeric) && next.contains(&following))
                    .then(|| format!("{stem}{} {rest}", self.base))
            }
            Kind::InterposedWords { words, particles } => {
                let mut split = text.split(' ');
                let first = split.next()?;
                let rest: Vec<&str> = split.collect();
                let particle = rest.iter().position(|word| words.contains(word))?;
                (particle > 0
                    && !first.is_empty()
                    && first.chars().all(char::is_alphanumeric)
                    && particles.contains(&rest[particle]))
                .then(|| format!("{first} {}", rest[particle..].join(" ")))
            }
            Kind::StemChange {
                from,
                to,
                endings,
                strip,
                starts,
                not_starts,
            } => {
                if !text.starts_with(starts)
                    || (!not_starts.is_empty() && text.starts_with(not_starts))
                {
                    return None;
                }
                let inflected = endings.iter().any(|ending| {
                    text.strip_suffix(ending)
                        .and_then(|stem| stem.rfind(from).map(|at| &stem[at + from.len()..]))
                        .is_some_and(|between| {
                            between.bytes().all(|byte| byte.is_ascii_lowercase())
                        })
                });
                if !inflected {
                    return None;
                }
                let changed = text.replacen(from, to, 1);
                let ending = strip
                    .iter()
                    .filter(|ending| changed.ends_with(*ending))
                    .max_by_key(|ending| ending.len())?;
                Some(format!(
                    "{}{}",
                    &changed[..changed.len() - ending.len()],
                    self.base
                ))
            }
        }
    }
}

/// The rules matched by the last character of their inflected form, then the rules matched
/// otherwise, each list in table order with the first rules before the others, marking which are
/// first rules.
struct RuleSet<'a> {
    by_last: HashMap<char, Vec<(bool, &'a Rule)>>,
    others: Vec<(bool, &'a Rule)>,
}

impl<'a> RuleSet<'a> {
    fn new(first: &'a [Rule], more: &'a [Rule]) -> Self {
        let mut by_last: HashMap<char, Vec<(bool, &'a Rule)>> = HashMap::new();
        let mut others = Vec::new();
        let tagged = first
            .iter()
            .map(|rule| (true, rule))
            .chain(more.iter().map(|rule| (false, rule)));
        for (is_first, rule) in tagged {
            match rule.kind {
                Kind::Suffix | Kind::WholeWord => {
                    let last = rule
                        .inflected
                        .chars()
                        .next_back()
                        .expect("an inflected form");
                    by_last.entry(last).or_default().push((is_first, rule));
                }
                _ => others.push((is_first, rule)),
            }
        }
        Self { by_last, others }
    }
}

/// A form the searched text may be an inflection of.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) text: String,
    /// The word classes it can have; only the language's dictionary forms can match a term.
    pub(crate) classes: u32,
    /// The inflections applied, from the candidate outward to the searched text.
    pub(crate) inflections: Vec<&'static str>,
}

/// The forms `text` may be an inflection of under `rules`, at most `max_candidates` of them, each
/// at most `max_steps` rules away: fewest steps first; within a step, those reached through the
/// first rules alone, then the others, each in the order of the texts they came from and then in
/// rule order, the rules matched by their last character before the others. A form reached again
/// with the same classes is listed once, the first way. The text itself is not one.
fn deinflect_bounded(
    text: &str,
    rules: &RuleSet,
    max_steps: usize,
    max_candidates: usize,
) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<(String, u32)> = HashSet::new();
    // Each text to deinflect further, and whether only first rules reached it.
    let mut frontier = vec![(
        Candidate {
            text: text.to_owned(),
            classes: 0,
            inflections: Vec::new(),
        },
        true,
    )];
    for _ in 0..max_steps {
        let mut next = Vec::new();
        for first_pass in [true, false] {
            for (current, current_first) in &frontier {
                if first_pass && !current_first {
                    continue;
                }
                let matching = current
                    .text
                    .chars()
                    .next_back()
                    .and_then(|last| rules.by_last.get(&last))
                    .into_iter()
                    .flatten()
                    .chain(&rules.others);
                for &(rule_first, rule) in matching {
                    if (*current_first && rule_first) != first_pass
                        || (current.classes & rule.applies_to == 0 && current.classes != 0)
                    {
                        continue;
                    }
                    let Some(text) = rule.apply(&current.text) else {
                        continue;
                    };
                    if !seen.insert((text.clone(), rule.gives)) {
                        continue;
                    }
                    let mut inflections = vec![rule.name];
                    inflections.extend(&current.inflections);
                    let candidate = Candidate {
                        text,
                        classes: rule.gives,
                        inflections,
                    };
                    candidates.push(candidate.clone());
                    if candidates.len() == max_candidates {
                        return candidates;
                    }
                    next.push((candidate, first_pass));
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    candidates
}
