//! Every XML document Komori reads from an EPUB goes through `parse`. roxmltree checks each new
//! attribute against all earlier ones on its element, so a small file with tens of thousands of
//! attributes on one element costs seconds of work. A linear scan refuses such an element before
//! roxmltree sees it.

use roxmltree::{Document, ParsingOptions};

/// The most attributes (namespace declarations included) one element may carry.
const MAX_ELEMENT_ATTRIBUTES: usize = 1024;

#[derive(Debug)]
pub(crate) enum XmlError {
    /// An element carries more than `MAX_ELEMENT_ATTRIBUTES` attributes.
    TooManyAttributes,
    Parse(roxmltree::Error),
}

pub(crate) fn parse<'input>(
    text: &'input str,
    options: ParsingOptions<'input>,
) -> Result<Document<'input>, XmlError> {
    if most_attributes(text.as_bytes(), attribute_limit()) > attribute_limit() {
        return Err(XmlError::TooManyAttributes);
    }
    Document::parse_with_options(text, options).map_err(XmlError::Parse)
}

#[cfg(not(test))]
fn attribute_limit() -> usize {
    MAX_ELEMENT_ATTRIBUTES
}

#[cfg(test)]
thread_local! {
    static TEST_LIMIT: std::cell::Cell<usize> = const { std::cell::Cell::new(MAX_ELEMENT_ATTRIBUTES) };
}

#[cfg(test)]
fn attribute_limit() -> usize {
    TEST_LIMIT.with(std::cell::Cell::get)
}

/// Runs `body` with a smaller attribute limit on this thread.
#[cfg(test)]
pub(crate) fn with_attribute_limit<T>(limit: usize, body: impl FnOnce() -> T) -> T {
    let previous = TEST_LIMIT.with(|cell| cell.replace(limit));
    let result = body();
    TEST_LIMIT.with(|cell| cell.set(previous));
    result
}

/// The largest number of attributes counted on one start tag, stopping as soon as one exceeds
/// `limit`. Comments, CDATA sections, processing instructions, the DOCTYPE (internal subset
/// included) and quoted values are skipped, so markup inside them is never counted. Malformed
/// markup ends the scan; roxmltree then refuses the document at or before that point.
fn most_attributes(text: &[u8], limit: usize) -> usize {
    let mut most = 0;
    let mut at = 0;
    while let Some(offset) = find(text, at, b"<") {
        at = offset + 1;
        let rest = &text[at..];
        let skipped = if rest.starts_with(b"!--") {
            find(text, at + 3, b"-->").map(|end| end + 3)
        } else if rest.starts_with(b"![CDATA[") {
            find(text, at + 8, b"]]>").map(|end| end + 3)
        } else if rest.starts_with(b"?") {
            find(text, at + 1, b"?>").map(|end| end + 2)
        } else if rest.starts_with(b"!") {
            doctype_end(text, at + 1)
        } else if rest.starts_with(b"/") {
            find(text, at, b">").map(|end| end + 1)
        } else {
            let (count, end) = start_tag(text, at, limit);
            most = most.max(count);
            if most > limit {
                return most;
            }
            end
        };
        match skipped {
            Some(end) => at = end,
            None => break,
        }
    }
    most
}

fn find(text: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    text.get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

/// The end of a `<!…>` declaration starting after `<!`: its closing `>` outside quotes,
/// comments and the `[…]` internal subset.
fn doctype_end(text: &[u8], mut at: usize) -> Option<usize> {
    let mut depth = 0usize;
    while let Some(&byte) = text.get(at) {
        match byte {
            b'"' | b'\'' => at = find(text, at + 1, &[byte])?,
            b'<' if text[at..].starts_with(b"<!--") => at = find(text, at + 4, b"-->")? + 2,
            b'[' => depth += 1,
            b']' => depth = depth.saturating_sub(1),
            b'>' if depth == 0 => return Some(at + 1),
            _ => {}
        }
        at += 1;
    }
    None
}

/// Counts the attributes of the start tag whose name begins at `at`, stopping past `limit`.
/// Returns the count and where scanning continues (`None` when the tag is malformed or unclosed).
fn start_tag(text: &[u8], mut at: usize, limit: usize) -> (usize, Option<usize>) {
    let mut count = 0;
    at = skip_name(text, at);
    loop {
        at = skip_space(text, at);
        match text.get(at) {
            Some(b'>') => return (count, Some(at + 1)),
            Some(b'/') if text.get(at + 1) == Some(&b'>') => return (count, Some(at + 2)),
            Some(_) => {}
            None => return (count, None),
        }
        let name_end = skip_name(text, at);
        if name_end == at {
            return (count, None);
        }
        at = skip_space(text, name_end);
        if text.get(at) != Some(&b'=') {
            return (count, None);
        }
        at = skip_space(text, at + 1);
        let Some(&quote @ (b'"' | b'\'')) = text.get(at) else {
            return (count, None);
        };
        let Some(close) = find(text, at + 1, &[quote]) else {
            return (count, None);
        };
        count += 1;
        if count > limit {
            return (count, None);
        }
        at = close + 1;
    }
}

fn skip_space(text: &[u8], mut at: usize) -> usize {
    while text.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

fn skip_name(text: &[u8], mut at: usize) -> usize {
    while text
        .get(at)
        .is_some_and(|&byte| !byte.is_ascii_whitespace() && !b"=/>\"'<".contains(&byte))
    {
        at += 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attributes(count: usize) -> String {
        (0..count).map(|n| format!(" a{n}=\"x\"")).collect()
    }

    #[test]
    fn counts_attributes_per_start_tag_outside_comments_cdata_pis_doctype_and_values() {
        let text = r#"<?xml version="1.0" a="1" b="2" c="3"?><!DOCTYPE html [<!ENTITY e "<x a='1' b='2' c='3'>"> <!-- <y a="1" b="2" c="3"> -->]><root xmlns="urn:x" xmlns:o="urn:o" o:k='v'><!-- <z a="1" b="2" c="3" d="4"> --><![CDATA[<w a="1" b="2" c="3" d="4">]]><e v="a > b" w="<c d='e'>"/></root>"#;
        assert_eq!(most_attributes(text.as_bytes(), 1024), 3);
        assert_eq!(
            most_attributes(
                format!("<a{}/><b{}></b>", attributes(4), attributes(6)).as_bytes(),
                1024
            ),
            6
        );
    }

    #[test]
    fn refuses_an_element_past_the_limit_before_parsing() {
        let wide = format!("<package{}/>", attributes(50_000));
        assert!(wide.len() < 600 * 1024);
        let started = std::time::Instant::now();
        assert!(matches!(
            parse(&wide, ParsingOptions::default()),
            Err(XmlError::TooManyAttributes)
        ));
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
        let at_limit = format!("<package{}/>", attributes(MAX_ELEMENT_ATTRIBUTES));
        assert!(parse(&at_limit, ParsingOptions::default()).is_ok());
        let over = format!("<package{}/>", attributes(MAX_ELEMENT_ATTRIBUTES + 1));
        assert!(matches!(
            parse(&over, ParsingOptions::default()),
            Err(XmlError::TooManyAttributes)
        ));
        with_attribute_limit(2, || {
            assert!(parse(r#"<a b="1" c="2"/>"#, ParsingOptions::default()).is_ok());
            assert!(matches!(
                parse(r#"<a b="1" c="2" d="3"/>"#, ParsingOptions::default()),
                Err(XmlError::TooManyAttributes)
            ));
        });
    }

    #[test]
    fn malformed_markup_is_left_to_the_parser() {
        for text in [r#"<a b=1/>"#, r#"<a b="1"#, "<a", "<!-- open", "<a b c/>"] {
            assert!(matches!(
                parse(text, ParsingOptions::default()),
                Err(XmlError::Parse(_))
            ));
        }
    }
}
