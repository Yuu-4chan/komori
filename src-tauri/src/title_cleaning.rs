//! Catalog-only title presentation. Source EPUB metadata is never rewritten.

const TAGS: &str = include_str!("../../docs/title-cleaning-list.txt");

/// Remove every exact, case-sensitive listed substring, then trim outer Unicode whitespace.
/// Keep unrelated text, punctuation and internal whitespace. Repeat to a fixed point so
/// removing an embedded tag cannot leave another listed tag for the next catalog refresh.
/// A title containing only tags/whitespace becomes the existing missing-title fallback.
pub(crate) fn clean(title: &str) -> Option<String> {
    let mut cleaned = title.to_owned();
    loop {
        let before = cleaned.len();
        for tag in TAGS.lines().map(str::trim) {
            if !tag.is_empty() && !tag.starts_with('#') {
                cleaned = cleaned.replace(tag, "");
            }
        }
        if cleaned.len() == before {
            break;
        }
    }
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_tag_is_removed_in_any_position_and_repeated_cleaning_is_stable() {
        for tag in TAGS.lines().map(str::trim) {
            if tag.is_empty() || tag.starts_with('#') {
                continue;
            }
            let cleaned = clean(&format!("\u{3000}{tag}本：第２巻{tag}！{tag} \t"));
            assert_eq!(cleaned.as_deref(), Some("本：第２巻！"), "{tag}");
            assert_eq!(clean(cleaned.as_deref().unwrap()), cleaned);
            assert_eq!(clean(&format!(" {tag}{tag}\u{3000}")), None, "{tag}");
        }
    }

    #[test]
    fn unrelated_text_punctuation_case_and_internal_whitespace_are_preserved() {
        assert_eq!(
            clean(" \t題名  ～続編～\n(別の文庫) (ga文庫)【電子版】\u{3000}"),
            Some("題名  ～続編～\n(別の文庫) (ga文庫)".into())
        );
        assert_eq!(clean("前 (GA文庫) 後"), Some("前  後".into()));
        assert_eq!(clean("VG文庫題名"), Some("題名".into()));
        assert_eq!(clean("題名(ＧＡ文庫)"), Some("題名(ＧＡ文庫)".into()));
        assert_eq!(clean(""), None);
        assert_eq!(clean("\t\n\u{3000}"), None);
        assert_eq!(clean("題名(GA【電子版】文庫)"), Some("題名".into()));
    }
}
