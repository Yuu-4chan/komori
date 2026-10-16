//! Legacy original-glossary renderer retained for interrupted request replay.
//! Structured dictionary content is data, never caller-provided HTML or executable CSS.
use super::{escaped, valid_text};
use serde_json::Value;

pub(super) fn valid(value: &Value) -> bool {
    fn bounded(value: &Value, depth: usize, remaining: &mut usize) -> bool {
        if depth > 32 || *remaining == 0 {
            return false;
        }
        *remaining -= 1;
        match value {
            Value::String(s) => valid_text(s, 256 * 1024),
            Value::Array(items) => items.iter().all(|v| bounded(v, depth + 1, remaining)),
            Value::Object(items) => items
                .iter()
                .all(|(k, v)| valid_text(k, 256) && bounded(v, depth + 1, remaining)),
            _ => true,
        }
    }
    serde_json::to_vec(value).is_ok_and(|v| v.len() <= 256 * 1024) && bounded(value, 0, &mut 8192)
}

pub(super) fn html(value: &Value) -> String {
    match value {
        Value::Array(entries) if entries.len() > 1 => {
            let senses = entries
                .iter()
                .map(render)
                .filter(|s| !s.is_empty())
                .map(|s| format!("<li>{s}</li>"))
                .collect::<String>();
            format!("<ol>{senses}</ol>")
        }
        _ => render(value),
    }
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => escaped(text),
        Value::Array(items) => items.iter().map(render).collect(),
        Value::Object(item) => {
            if item.get("type").is_some_and(|t| t != "structured-content") {
                return String::new();
            }
            let tag = item.get("tag").and_then(Value::as_str).unwrap_or("");
            if matches!(
                tag,
                "img"
                    | "image"
                    | "audio"
                    | "video"
                    | "svg"
                    | "source"
                    | "picture"
                    | "iframe"
                    | "script"
                    | "style"
                    | "link"
                    | "meta"
                    | "object"
            ) {
                return String::new();
            }
            if tag == "br" {
                return "<br>".into();
            }
            let content = item
                .get("content")
                .or_else(|| item.get("text"))
                .map(render)
                .unwrap_or_default();
            if content.is_empty() {
                return content;
            }
            if tag.is_empty() {
                return content;
            }
            // Links keep their original label/formatting without navigation or resource access.
            let tag = if matches!(
                tag,
                "div"
                    | "p"
                    | "span"
                    | "ol"
                    | "ul"
                    | "li"
                    | "ruby"
                    | "rt"
                    | "rp"
                    | "table"
                    | "thead"
                    | "tbody"
                    | "tfoot"
                    | "tr"
                    | "td"
                    | "th"
                    | "details"
                    | "summary"
                    | "b"
                    | "strong"
                    | "i"
                    | "em"
                    | "small"
                    | "sup"
                    | "sub"
            ) {
                tag
            } else {
                "span"
            };
            let mut attrs = String::new();
            if let Some(style) = item.get("style").and_then(Value::as_object) {
                let css = style
                    .iter()
                    .filter_map(|(key, value)| style_property(key, value))
                    .collect::<String>();
                if !css.is_empty() {
                    attrs.push_str(&format!(" style=\"{}\"", escaped(&css)));
                }
            }
            if let Some(data) = item.get("data").and_then(Value::as_object) {
                for (key, value) in data {
                    if key.len() <= 64
                        && !key.is_empty()
                        && key
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                    {
                        if let Some(text) = value.as_str().filter(|s| valid_text(s, 1024)) {
                            attrs.push_str(&format!(" data-sc-{key}=\"{}\"", escaped(text)));
                        }
                    }
                }
            }
            if matches!(tag, "td" | "th") {
                for (key, attr) in [("colSpan", "colspan"), ("rowSpan", "rowspan")] {
                    if let Some(n) = item
                        .get(key)
                        .and_then(Value::as_u64)
                        .filter(|n| (1..=128).contains(n))
                    {
                        attrs.push_str(&format!(" {attr}=\"{n}\""));
                    }
                }
            }
            if tag == "details" && item.get("open") == Some(&Value::Bool(true)) {
                attrs.push_str(" open");
            }
            if let Some(title) = item
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| valid_text(s, 1024))
            {
                attrs.push_str(&format!(" title=\"{}\"", escaped(title)));
            }
            format!("<{tag}{attrs}>{content}</{tag}>")
        }
        _ => String::new(),
    }
}

fn lengths(value: &str) -> bool {
    let pieces: Vec<_> = value.split_whitespace().collect();
    !pieces.is_empty()
        && pieces.len() <= 4
        && pieces.iter().all(|part| {
            let number = ["rem", "em", "px", "%"]
                .iter()
                .find_map(|unit| part.strip_suffix(unit))
                .unwrap_or(part);
            number
                .parse::<f64>()
                .is_ok_and(|n| n.is_finite() && n.abs() <= 1000.0)
        })
}
fn color(value: &str) -> bool {
    (!value.is_empty() && value.bytes().all(|c| c.is_ascii_alphabetic()))
        || (value.starts_with('#')
            && matches!(value.len(), 4 | 5 | 7 | 9)
            && value[1..].bytes().all(|c| c.is_ascii_hexdigit()))
        || (["rgb(", "rgba("]
            .iter()
            .any(|prefix| value.starts_with(prefix))
            && value.ends_with(')')
            && value[value.find('(').unwrap() + 1..value.len() - 1]
                .bytes()
                .all(|c| c.is_ascii_digit() || b".,% ".contains(&c)))
}
fn style_property(key: &str, value: &Value) -> Option<String> {
    let value = match value {
        Value::String(s) => s.clone(),
        Value::Number(n)
            if matches!(
                key,
                "marginTop" | "marginBottom" | "marginLeft" | "marginRight"
            ) =>
        {
            format!("{n}em")
        }
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if value.len() > 128 {
        return None;
    }
    let (property, allowed) = match key {
        "fontStyle" => ("font-style", matches!(value.as_str(), "normal" | "italic")),
        "fontWeight" => ("font-weight", matches!(value.as_str(), "normal" | "bold")),
        "fontSize" => (
            "font-size",
            lengths(&value)
                || matches!(
                    value.as_str(),
                    "xx-small"
                        | "x-small"
                        | "small"
                        | "medium"
                        | "large"
                        | "x-large"
                        | "xx-large"
                        | "smaller"
                        | "larger"
                ),
        ),
        "color" => ("color", color(&value)),
        "background" | "backgroundColor" => ("background-color", color(&value)),
        "borderColor" => ("border-color", color(&value)),
        "borderStyle" => (
            "border-style",
            matches!(
                value.as_str(),
                "none" | "solid" | "dashed" | "dotted" | "double"
            ),
        ),
        "borderWidth" => ("border-width", lengths(&value)),
        "borderRadius" => ("border-radius", lengths(&value)),
        "margin" => ("margin", lengths(&value)),
        "marginTop" => ("margin-top", lengths(&value)),
        "marginBottom" => ("margin-bottom", lengths(&value)),
        "marginLeft" => ("margin-left", lengths(&value)),
        "marginRight" => ("margin-right", lengths(&value)),
        "padding" => ("padding", lengths(&value)),
        "paddingTop" => ("padding-top", lengths(&value)),
        "paddingBottom" => ("padding-bottom", lengths(&value)),
        "paddingLeft" => ("padding-left", lengths(&value)),
        "paddingRight" => ("padding-right", lengths(&value)),
        "textAlign" => (
            "text-align",
            matches!(
                value.as_str(),
                "start" | "end" | "left" | "right" | "center" | "justify"
            ),
        ),
        "verticalAlign" => (
            "vertical-align",
            matches!(
                value.as_str(),
                "baseline"
                    | "sub"
                    | "super"
                    | "text-top"
                    | "text-bottom"
                    | "middle"
                    | "top"
                    | "bottom"
            ),
        ),
        "whiteSpace" => (
            "white-space",
            matches!(
                value.as_str(),
                "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line" | "break-spaces"
            ),
        ),
        "wordBreak" => (
            "word-break",
            matches!(value.as_str(), "normal" | "break-all" | "keep-all"),
        ),
        "listStyleType" => (
            "list-style-type",
            matches!(
                value.as_str(),
                "none"
                    | "disc"
                    | "circle"
                    | "square"
                    | "decimal"
                    | "lower-alpha"
                    | "upper-alpha"
                    | "lower-roman"
                    | "upper-roman"
            ),
        ),
        "textDecorationLine" => (
            "text-decoration-line",
            matches!(
                value.as_str(),
                "none" | "underline" | "overline" | "line-through"
            ),
        ),
        "textDecorationStyle" => (
            "text-decoration-style",
            matches!(
                value.as_str(),
                "solid" | "double" | "dotted" | "dashed" | "wavy"
            ),
        ),
        "textDecorationColor" => ("text-decoration-color", color(&value)),
        _ => return None,
    };
    allowed.then(|| format!("{property}:{value};"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn original_structure_and_styles_survive_without_active_content() {
        let entry = json!([{"type":"structured-content","content":{"tag":"div","data":{"content":"sense"},"style":{"fontSize":"0.8em","marginTop":0.5,"background":"url(private)","position":"fixed"},"content":[{"tag":"ruby","content":["読",{"tag":"rt","content":"よ"}]},{"tag":"ul","content":{"tag":"li","content":"read <script>${x}`"}},{"tag":"a","href":"https://private","content":"label"},{"tag":"script","content":"bad"},{"tag":"img","path":"private"},{"tag":"details","open":true,"content":[{"tag":"summary","content":"Example"},"Original"]}]}}]);
        assert!(valid(&entry));
        let html = html(&entry);
        assert!(html.contains("<ruby>読<rt>よ</rt></ruby>"));
        assert!(html.contains("<ul><li>read &lt;script&gt;&#36;{x}&#96;</li></ul>"));
        assert!(html.contains("font-size:0.8em;margin-top:0.5em;"));
        assert!(html.contains("data-sc-content=\"sense\""));
        assert!(html.contains("<details open><summary>Example</summary>Original</details>"));
        for forbidden in [
            "url(", "private", "href", "<script", "bad", "position", "<img",
        ] {
            assert!(!html.contains(forbidden));
        }
        assert_eq!(
            super::html(&json!(["one", "two"])),
            "<ol><li>one</li><li>two</li></ol>"
        );
    }
    #[test]
    fn bounds_and_css_rejection() {
        assert!(!valid(&json!("x".repeat(256 * 1024))));
        let mut deep = json!("text");
        for _ in 0..33 {
            deep = json!([deep]);
        }
        assert!(!valid(&deep));
        assert!(style_property("color", &json!("red;display:none")).is_none());
        assert!(style_property("margin", &json!("calc(1px)")).is_none());
        assert!(style_property("fontSize", &json!("99999em")).is_none());
    }
}
