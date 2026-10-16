//! Safe popup presentation supplied as inert nodes. All HTML is native-owned: tags come from a
//! closed set, imported `data` becomes escaped `data-sc-*` attributes (the shape Lapis's
//! dictionary-specific CSS selects on), imported styles pass only an allowlist checked here
//! again, and only http(s) links keep an address.
use super::{escaped, valid_text};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Node {
    Text {
        value: String,
    },
    Break,
    Link {
        children: Vec<Node>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    Element {
        tag: Tag,
        children: Vec<Node>,
        #[serde(default, skip_serializing_if = "is_false")]
        reading: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        #[serde(default, rename = "colSpan", skip_serializing_if = "Option::is_none")]
        col_span: Option<u8>,
        #[serde(default, rename = "rowSpan", skip_serializing_if = "Option::is_none")]
        row_span: Option<u8>,
        #[serde(default, skip_serializing_if = "is_false")]
        open: bool,
    },
}
fn is_false(value: &bool) -> bool {
    !value
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Tag {
    Div,
    P,
    Span,
    Ul,
    Ol,
    Li,
    Ruby,
    Rt,
    Rp,
    Table,
    Thead,
    Tbody,
    Tfoot,
    Tr,
    Td,
    Th,
    Details,
    Summary,
}
impl Tag {
    fn name(self) -> &'static str {
        match self {
            Self::Div => "div",
            Self::P => "p",
            Self::Span => "span",
            Self::Ul => "ul",
            Self::Ol => "ol",
            Self::Li => "li",
            Self::Ruby => "ruby",
            Self::Rt => "rt",
            Self::Rp => "rp",
            Self::Table => "table",
            Self::Thead => "thead",
            Self::Tbody => "tbody",
            Self::Tfoot => "tfoot",
            Self::Tr => "tr",
            Self::Td => "td",
            Self::Th => "th",
            Self::Details => "details",
            Self::Summary => "summary",
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Role {
    ExampleGroup,
    ExampleSentence,
    ExampleTranslation,
    NoteGroup,
    NoteLabel,
    NoteContent,
    XrefGroup,
    XrefLabel,
    XrefGlossary,
    Attribution,
    AttributionFootnote,
    PartOfSpeech,
}
pub(super) fn valid(sections: &[Vec<Node>]) -> bool {
    fn small_map(map: &Option<BTreeMap<String, String>>) -> bool {
        map.as_ref().is_none_or(|map| {
            map.len() <= 32
                && map
                    .iter()
                    .all(|(key, value)| valid_text(key, 256) && valid_text(value, 1024))
        })
    }
    fn bounded(nodes: &[Node], depth: usize, left: &mut usize) -> bool {
        if depth > 32 {
            return false;
        }
        nodes.iter().all(|node| {
            if *left == 0 {
                return false;
            }
            *left -= 1;
            match node {
                Node::Text { value } => valid_text(value, 256 * 1024),
                Node::Break => true,
                Node::Link { children, url } => {
                    url.as_ref().is_none_or(|url| valid_text(url, 4096))
                        && bounded(children, depth + 1, left)
                }
                Node::Element {
                    children,
                    style,
                    data,
                    title,
                    lang,
                    ..
                } => {
                    small_map(style)
                        && small_map(data)
                        && title.as_ref().is_none_or(|t| valid_text(t, 1024))
                        && lang.as_ref().is_none_or(|l| valid_text(l, 64))
                        && bounded(children, depth + 1, left)
                }
            }
        })
    }
    let mut left = 8192;
    sections.len() <= 128
        && sections.iter().all(|s| bounded(s, 0, &mut left))
        && serde_json::to_vec(sections).is_ok_and(|v| v.len() <= 256 * 1024)
}

/// One dictionary entry's glossary as card templates such as Lapis expect it: a single glossary
/// item as it is, several as a list.
pub(super) fn html(sections: &[Vec<Node>]) -> String {
    match sections {
        [] => String::new(),
        [only] => render(only),
        many => format!(
            "<ul>{}</ul>",
            many.iter()
                .map(|nodes| format!("<li>{}</li>", render(nodes)))
                .collect::<String>()
        ),
    }
}

fn render(nodes: &[Node]) -> String {
    nodes.iter().map(render_node).collect()
}

fn render_node(node: &Node) -> String {
    match node {
        Node::Text { value } => escaped(value),
        Node::Break => "<br>".into(),
        Node::Link { children, url } => match url.as_deref().and_then(web_address) {
            Some(url) => format!("<a href=\"{}\">{}</a>", escaped(url), render(children)),
            None => format!("<a>{}</a>", render(children)),
        },
        Node::Element {
            tag,
            children,
            reading,
            presentation,
            style,
            data,
            title,
            lang,
            col_span,
            row_span,
            open,
        } => {
            let mut attributes = String::new();
            for (key, value) in data.iter().flatten() {
                if let Some(name) = data_attribute(key) {
                    attributes.push_str(&format!(" {name}=\"{}\"", escaped(value)));
                }
            }
            if let Some(title) = title {
                attributes.push_str(&format!(" title=\"{}\"", escaped(title)));
            }
            if let Some(lang) = lang.as_deref().filter(|lang| {
                lang.len() <= 32 && lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            }) {
                attributes.push_str(&format!(" lang=\"{lang}\""));
            }
            if matches!(tag, Tag::Td | Tag::Th) {
                for (name, span) in [("colspan", col_span), ("rowspan", row_span)] {
                    if let Some(span) = span.filter(|span| (2..=32).contains(span)) {
                        attributes.push_str(&format!(" {name}=\"{span}\""));
                    }
                }
            }
            if *open && *tag == Tag::Details {
                attributes.push_str(" open");
            }
            let mut css = String::new();
            // Small presentation defaults that never decide display or list markers, so a note
            // type's own rules (Lapis hides Jitendex sections with `display:none`) still apply.
            match tag {
                Tag::Table => css.push_str("border-collapse:collapse;"),
                Tag::Td | Tag::Th => {
                    css.push_str("border:1px solid rgba(127,127,127,.4);padding:.1em .35em;")
                }
                Tag::Rt => css.push_str("opacity:.65;"),
                _ => {}
            }
            if *reading && !matches!(tag, Tag::Rt | Tag::Rp) {
                css.push_str("padding-inline:.12em;font-size:.78em;opacity:.65;");
            }
            if !reading {
                css.push_str(match presentation {
                    Some(Role::ExampleGroup) => "padding-inline-start:.75em;border-inline-start:1px solid currentColor;",
                    Some(Role::ExampleTranslation | Role::XrefGlossary) => "opacity:.8;font-size:.875em;",
                    Some(Role::NoteGroup | Role::XrefLabel) => "opacity:.8;font-size:.875em;",
                    Some(Role::XrefGroup) => "padding:.25em .5em;background:rgba(127,127,127,.08);border-radius:.25em;",
                    Some(Role::Attribution) => "opacity:.65;font-size:.875em;",
                    Some(Role::AttributionFootnote) => "opacity:.65;font-size:.8em;vertical-align:super;line-height:0;",
                    Some(Role::PartOfSpeech) => "padding:.08em .4em;margin-inline-end:.25em;background:rgba(127,127,127,.12);border-radius:.25em;font-size:.875em;font-weight:650;white-space:nowrap;",
                    _ => "",
                });
            }
            for (property, value) in style.iter().flatten() {
                if let Some(declaration) = style_declaration(property, value) {
                    css.push_str(&declaration);
                }
            }
            if !css.is_empty() {
                attributes.push_str(&format!(" style=\"{}\"", escaped(&css)));
            }
            let name = tag.name();
            format!("<{name}{attributes}>{}</{name}>", render(children))
        }
    }
}

/// `data-sc-*` as a browser's dataset names `sc` + the key: `content` → `data-sc-content`,
/// `用例囲み-g` → `data-sc用例囲み-g`. Keys that could leave the attribute are dropped.
fn data_attribute(key: &str) -> Option<String> {
    if key.is_empty()
        || key.chars().count() > 64
        || key
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\"'<>/=`&".contains(c))
    {
        return None;
    }
    let mut name = String::from("data-sc");
    for (index, c) in key.chars().enumerate() {
        if c.is_ascii_uppercase() || (index == 0 && c.is_ascii_lowercase()) {
            name.push('-');
            name.push(c.to_ascii_lowercase());
        } else {
            name.push(c);
        }
    }
    Some(name)
}

/// An http(s) address with a host and no user info, as `external_link` also requires.
fn web_address(url: &str) -> Option<&str> {
    let lower = url.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    (url.len() <= 2048
        && !authority.is_empty()
        && !authority.contains('@')
        && !url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "\"'<>`\\".contains(c)))
    .then_some(url)
}

const KEYWORDS: &[(&str, &[&str])] = &[
    ("fontStyle", &["normal", "italic", "oblique"]),
    (
        "fontWeight",
        &[
            "normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700",
            "800", "900",
        ],
    ),
    (
        "textDecorationLine",
        &["none", "underline", "overline", "line-through"],
    ),
    (
        "textDecorationStyle",
        &["solid", "double", "dotted", "dashed", "wavy"],
    ),
    (
        "textAlign",
        &["start", "end", "left", "right", "center", "justify"],
    ),
    (
        "whiteSpace",
        &[
            "normal",
            "nowrap",
            "pre",
            "pre-wrap",
            "pre-line",
            "break-spaces",
        ],
    ),
    (
        "wordBreak",
        &["normal", "break-all", "keep-all", "break-word"],
    ),
    (
        "borderStyle",
        &["none", "solid", "dashed", "dotted", "double", "hidden"],
    ),
];

/// One checked `property:value;` declaration, or None. Mirrors `glossaryStyle.ts`.
fn style_declaration(property: &str, value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 {
        return None;
    }
    let tokens: Vec<&str> = value.split_whitespace().collect();
    let accepted = if let Some((_, allowed)) = KEYWORDS.iter().find(|(name, _)| *name == property) {
        tokens.len() <= 4 && tokens.iter().all(|token| allowed.contains(token))
    } else {
        match property {
            "color" | "backgroundColor" | "borderColor" => color(value),
            "fontSize" => {
                matches!(
                    value,
                    "xx-small"
                        | "x-small"
                        | "small"
                        | "medium"
                        | "large"
                        | "x-large"
                        | "smaller"
                        | "larger"
                ) || length(value, false).is_some_and(|(amount, unit)| {
                    amount
                        <= if unit == "%" {
                            250.0
                        } else if unit == "px" {
                            40.0
                        } else {
                            2.5
                        }
                })
            }
            "verticalAlign" => {
                matches!(
                    value,
                    "baseline"
                        | "sub"
                        | "super"
                        | "text-top"
                        | "text-bottom"
                        | "middle"
                        | "top"
                        | "bottom"
                ) || length(value, true).is_some()
            }
            "listStyleType" => list_marker(value),
            "borderWidth" => {
                matches!(value, "thin" | "medium" | "thick") || lengths(&tokens, false, false)
            }
            "borderRadius" | "padding" | "paddingTop" | "paddingRight" | "paddingBottom"
            | "paddingLeft" => lengths(&tokens, false, false),
            "margin" | "marginTop" | "marginRight" | "marginBottom" | "marginLeft" => {
                lengths(&tokens, true, true)
            }
            _ => false,
        }
    };
    if !accepted {
        return None;
    }
    let mut name = String::new();
    for c in property.chars() {
        if c.is_ascii_uppercase() {
            name.push('-');
            name.push(c.to_ascii_lowercase());
        } else {
            name.push(c);
        }
    }
    Some(format!("{name}:{value};"))
}

/// A number with an optional unit, within the bounds that keep boxes inside a card.
fn length(token: &str, negative: bool) -> Option<(f64, &str)> {
    if token == "0" {
        return Some((0.0, ""));
    }
    let split = token
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(token.len());
    let (number, unit) = token.split_at(split);
    let limit = match unit {
        "em" | "rem" | "" => 8.0,
        "ex" | "ch" => 16.0,
        "px" => 96.0,
        "%" => 400.0,
        _ => return None,
    };
    let amount: f64 = number.parse().ok()?;
    (amount.is_finite()
        && (negative || amount >= 0.0)
        && amount.abs() <= limit
        && !number.starts_with("--"))
    .then_some((amount.abs(), unit))
}

fn lengths(tokens: &[&str], negative: bool, auto: bool) -> bool {
    (1..=4).contains(&tokens.len())
        && tokens
            .iter()
            .all(|token| (auto && *token == "auto") || length(token, negative).is_some())
}

fn list_marker(value: &str) -> bool {
    let quoted = value.len() >= 2
        && (value.starts_with('\'') && value.ends_with('\'')
            || value.starts_with('"') && value.ends_with('"'));
    if quoted {
        let inner = &value[1..value.len() - 1];
        return (1..=8).contains(&inner.chars().count())
            && !inner
                .chars()
                .any(|c| "'\"\\<>".contains(c) || c.is_control());
    }
    (1..=32).contains(&value.len()) && value.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// Colors as dictionaries write them: hex, names, and nested rgb/hsl/var/color-mix calls, with
/// no other punctuation (so no url or string can appear).
fn color(value: &str) -> bool {
    if value.len() > 160
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "#%.,-() ".contains(c))
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("url") || lower.contains("image") || lower.contains("expression") {
        return false;
    }
    let mut depth = 0i32;
    let mut word = String::new();
    for c in lower.chars() {
        match c {
            '(' => {
                if !matches!(
                    word.as_str(),
                    "rgb" | "rgba" | "hsl" | "hsla" | "var" | "color-mix"
                ) {
                    return false;
                }
                depth += 1;
                word.clear();
            }
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
                word.clear();
            }
            c if c.is_ascii_alphanumeric() || c == '-' => word.push(c),
            _ => word.clear(),
        }
    }
    depth == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn styles_pass_only_their_allowlist() {
        for (property, value, expected) in [
            ("fontWeight", "bold", Some("font-weight:bold;")),
            ("fontSize", "0.85em", Some("font-size:0.85em;")),
            ("fontSize", "70%", Some("font-size:70%;")),
            ("fontSize", "9em", None),
            (
                "verticalAlign",
                "text-bottom",
                Some("vertical-align:text-bottom;"),
            ),
            ("marginTop", "-0.4em", Some("margin-top:-0.4em;")),
            (
                "padding",
                "0.1em 0.25em 0em 0.2em",
                Some("padding:0.1em 0.25em 0em 0.2em;"),
            ),
            ("padding", "-1em", None),
            (
                "borderStyle",
                "none none none solid",
                Some("border-style:none none none solid;"),
            ),
            ("listStyleType", "'◆'", Some("list-style-type:'◆';")),
            ("listStyleType", "\"①\"", Some("list-style-type:\"①\";")),
            ("listStyleType", "'a\";x'", None),
            ("color", "red", Some("color:red;")),
            ("color", "#e5007f", Some("color:#e5007f;")),
            (
                "color",
                "color-mix(in srgb, lime, var(--text-color, var(--fg, #333)))",
                Some("color:color-mix(in srgb, lime, var(--text-color, var(--fg, #333)));"),
            ),
            ("backgroundColor", "url(http://x)", None),
            ("backgroundColor", "red;display:none", None),
            ("color", "attr(x)", None),
            ("display", "none", None),
            ("cursor", "pointer", None),
            ("position", "fixed", None),
        ] {
            assert_eq!(
                style_declaration(property, value).as_deref(),
                expected,
                "{property}: {value}"
            );
        }
    }

    #[test]
    fn data_attributes_follow_dataset_names_and_drop_unsafe_keys() {
        assert_eq!(
            data_attribute("content").as_deref(),
            Some("data-sc-content")
        );
        assert_eq!(
            data_attribute("senseNumber").as_deref(),
            Some("data-sc-sense-number")
        );
        assert_eq!(
            data_attribute("audio_play_button").as_deref(),
            Some("data-sc-audio_play_button")
        );
        assert_eq!(
            data_attribute("用例囲み-g").as_deref(),
            Some("data-sc用例囲み-g")
        );
        for key in ["", "a b", "x\"y", "on>", "a=b", "a/b"] {
            assert_eq!(data_attribute(key), None, "{key:?}");
        }
    }

    #[test]
    fn card_markup_keeps_data_styles_and_web_links_only() {
        let nodes: Vec<Vec<Node>> = serde_json::from_value(serde_json::json!([[
            {"kind": "element", "tag": "ul", "data": {"content": "glossary"}, "children": [
                {"kind": "element", "tag": "li", "children": [{"kind": "text", "value": "who"}]}
            ]},
            {"kind": "link", "url": "https://www.google.com/search?q=%E8%AA%B0", "children": [{"kind": "text", "value": "Google"}]},
            {"kind": "link", "url": "javascript:alert(1)", "children": [{"kind": "text", "value": "bad"}]},
            {"kind": "link", "children": [{"kind": "text", "value": "誰"}]},
            {"kind": "element", "tag": "span", "style": {"fontWeight": "bold", "position": "fixed", "color": "url(x)"}, "data": {"x\"": "1", "code": "n"}, "title": "noun \"common\"", "children": [{"kind": "text", "value": "n"}]},
            {"kind": "element", "tag": "table", "children": [
                {"kind": "element", "tag": "tr", "children": [
                    {"kind": "element", "tag": "td", "rowSpan": 2, "colSpan": 99, "children": [{"kind": "text", "value": "<b>"}]}
                ]}
            ]}
        ]]))
        .unwrap();
        assert!(valid(&nodes));
        assert_eq!(
            html(&nodes),
            "<ul data-sc-content=\"glossary\"><li>who</li></ul>\
             <a href=\"https://www.google.com/search?q=%E8%AA%B0\">Google</a>\
             <a>bad</a><a>誰</a>\
             <span data-sc-code=\"n\" title=\"noun &quot;common&quot;\" style=\"font-weight:bold;\">n</span>\
             <table style=\"border-collapse:collapse;\"><tr><td rowspan=\"2\" style=\"border:1px solid rgba(127,127,127,.4);padding:.1em .35em;\">&lt;b&gt;</td></tr></table>"
        );
    }
}
