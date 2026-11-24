//! Wikipedia summaries for text chosen in the Reader: the introduction of the page the text names
//! in the book's language, when that page exists. Komori asks only for the page the reader
//! chose; nothing is kept.

use std::time::Duration;

use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;
use serde_json::Value;

/// Longer text is a passage, not a page title.
const MAX_QUERY_CHARS: usize = 120;
const MAX_EXTRACT_CHARS: usize = 1200;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// Punctuation a selection often carries around a name.
const WRAPPING: &str = "\"'“”‘’「」『』【】（）()《》〈〉[]{}<>、。，．,.!?！？:;：；…・";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum WikipediaSummary {
    #[serde(rename_all = "camelCase")]
    Found {
        title: String,
        description: Option<String>,
        extract: String,
        url: String,
    },
    /// The text names no page in that language's Wikipedia.
    Missing,
    /// Wikipedia could not be reached or answered something unexpected.
    Failed,
}

/// The summary of the page `text` names, in the Wikipedia of `language` (a tag such as `ja`,
/// `zh-Hant` or `pt-BR`; English when it has none).
#[tauri::command]
pub async fn wikipedia_summary(
    text: String,
    language: Option<String>,
) -> Result<WikipediaSummary, String> {
    let Some(query) = page_query(&text) else {
        return Ok(WikipediaSummary::Missing);
    };
    let wiki = language
        .as_deref()
        .and_then(wiki_language)
        .unwrap_or_else(|| Wiki {
            host: "en.wikipedia.org".to_owned(),
            variant: None,
        });
    let Some(client) = client() else {
        return Ok(WikipediaSummary::Failed);
    };
    // The title itself, then a title matching it in another case.
    for search in [false, true] {
        let Some(response) = fetch(&client, &wiki, &query, search).await else {
            return Ok(WikipediaSummary::Failed);
        };
        match summary(&response, &wiki) {
            WikipediaSummary::Missing => continue,
            found => return Ok(found),
        }
    }
    Ok(WikipediaSummary::Missing)
}

/// The text as a page title: one line, without wrapping punctuation, short enough to be a name.
fn page_query(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = joined.trim_matches(|c: char| WRAPPING.contains(c) || c.is_whitespace());
    let length = trimmed.chars().count();
    (length > 0 && length <= MAX_QUERY_CHARS).then(|| trimmed.to_owned())
}

#[derive(Debug, PartialEq, Eq)]
struct Wiki {
    host: String,
    /// The script Chinese text is shown in.
    variant: Option<&'static str>,
}

/// The Wikipedia for a language tag: its primary language, and Chinese's script.
fn wiki_language(tag: &str) -> Option<Wiki> {
    let mut parts = tag.split(['-', '_']);
    let primary = parts.next()?.to_ascii_lowercase();
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let rest: Vec<String> = parts.map(str::to_ascii_lowercase).collect();
    let variant = (primary == "zh").then(|| {
        if rest
            .iter()
            .any(|part| matches!(part.as_str(), "hant" | "tw" | "hk" | "mo"))
        {
            "zh-tw"
        } else {
            "zh-cn"
        }
    });
    Some(Wiki {
        host: format!("{primary}.wikipedia.org"),
        variant: variant.filter(|_| !rest.is_empty()),
    })
}

fn client() -> Option<Client> {
    crate::http::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()
        .ok()
}

fn request_url(wiki: &Wiki, query: &str, search: bool) -> Option<Url> {
    let mut url = Url::parse(&format!("https://{}/w/api.php", wiki.host)).ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("action", "query")
            .append_pair("format", "json")
            .append_pair("formatversion", "2")
            .append_pair("redirects", "1")
            .append_pair("prop", "extracts|description|info")
            .append_pair("exintro", "1")
            .append_pair("explaintext", "1")
            .append_pair("inprop", "url");
        if search {
            pairs
                .append_pair("generator", "search")
                .append_pair("gsrsearch", query)
                .append_pair("gsrwhat", "nearmatch")
                .append_pair("gsrlimit", "1");
        } else {
            pairs.append_pair("titles", query);
        }
        if let Some(variant) = wiki.variant {
            pairs.append_pair("variant", variant);
        }
    }
    Some(url)
}

async fn fetch(client: &Client, wiki: &Wiki, query: &str, search: bool) -> Option<Value> {
    let url = request_url(wiki, query, search)?;
    let mut request = client.get(url);
    if let Some(variant) = wiki.variant {
        request = request.header(reqwest::header::ACCEPT_LANGUAGE, variant);
    }
    let mut response = request.send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

/// The page an API answer describes; a page whose address is not on that Wikipedia is refused.
fn summary(response: &Value, wiki: &Wiki) -> WikipediaSummary {
    let Some(query) = response.get("query") else {
        // A search with no match has no `query` at all; anything else is unexpected.
        return if response.get("batchcomplete").is_some() {
            WikipediaSummary::Missing
        } else {
            WikipediaSummary::Failed
        };
    };
    let Some(page) = query
        .get("pages")
        .and_then(Value::as_array)
        .and_then(|pages| pages.first())
    else {
        return WikipediaSummary::Missing;
    };
    if page.get("missing").is_some() || page.get("invalid").is_some() {
        return WikipediaSummary::Missing;
    }
    let text = |key: &str| {
        page.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let (Some(title), Some(url)) = (text("title"), text("fullurl")) else {
        return WikipediaSummary::Failed;
    };
    if !url.starts_with(&format!("https://{}/", wiki.host)) {
        return WikipediaSummary::Failed;
    }
    WikipediaSummary::Found {
        title,
        description: text("description"),
        extract: shortened(&text("extract").unwrap_or_default()),
        url,
    }
}

/// The introduction's first paragraphs, cut at a sentence or word near the limit.
fn shortened(extract: &str) -> String {
    if extract.chars().count() <= MAX_EXTRACT_CHARS {
        return extract.to_owned();
    }
    let cut: String = extract.chars().take(MAX_EXTRACT_CHARS).collect();
    let sentence = cut
        .char_indices()
        .rfind(|(_, c)| matches!(c, '.' | '。' | '!' | '?' | '！' | '？'))
        .map(|(index, c)| index + c.len_utf8())
        .filter(|end| *end > cut.len() / 2);
    match sentence {
        Some(end) => cut[..end].to_owned(),
        None => {
            let end = cut
                .rfind(char::is_whitespace)
                .filter(|end| *end > cut.len() / 2)
                .unwrap_or(cut.len());
            format!("{}…", cut[..end].trim_end())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wiki(host: &str) -> Wiki {
        Wiki {
            host: host.to_owned(),
            variant: None,
        }
    }

    #[test]
    fn selections_become_page_titles() {
        assert_eq!(page_query("  「東京」 ").as_deref(), Some("東京"));
        assert_eq!(page_query("New\n  York,").as_deref(), Some("New York"));
        assert_eq!(
            page_query("“Ada Lovelace.”").as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(page_query(" 。、 "), None);
        assert_eq!(page_query(&"a".repeat(MAX_QUERY_CHARS + 1)), None);
        assert_eq!(
            page_query(&"字".repeat(MAX_QUERY_CHARS)).map(|q| q.chars().count()),
            Some(MAX_QUERY_CHARS)
        );
    }

    #[test]
    fn languages_choose_their_wikipedia() {
        assert_eq!(wiki_language("ja"), Some(wiki("ja.wikipedia.org")));
        assert_eq!(wiki_language("pt-BR"), Some(wiki("pt.wikipedia.org")));
        assert_eq!(
            wiki_language("zh-Hant"),
            Some(Wiki {
                host: "zh.wikipedia.org".into(),
                variant: Some("zh-tw")
            })
        );
        assert_eq!(
            wiki_language("zh-Hans"),
            Some(Wiki {
                host: "zh.wikipedia.org".into(),
                variant: Some("zh-cn")
            })
        );
        assert_eq!(wiki_language("zh"), Some(wiki("zh.wikipedia.org")));
        for bad in ["", "x", "abcd", "e1", "evil.com/", "../en"] {
            assert_eq!(wiki_language(bad), None, "{bad}");
        }
    }

    #[test]
    fn requests_name_only_the_title_on_that_wikipedia() {
        let url = request_url(&wiki("ja.wikipedia.org"), "東京 & 大阪", false).unwrap();
        assert_eq!(url.host_str(), Some("ja.wikipedia.org"));
        assert_eq!(url.scheme(), "https");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("titles".into(), "東京 & 大阪".into())));
        assert!(!pairs.iter().any(|(key, _)| key == "gsrsearch"));
        let search = request_url(&wiki("en.wikipedia.org"), "new york", true).unwrap();
        let pairs: Vec<(String, String)> = search.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("gsrsearch".into(), "new york".into())));
        assert!(pairs.contains(&("gsrwhat".into(), "nearmatch".into())));
    }

    #[test]
    fn answers_read_as_found_missing_or_failed() {
        let en = wiki("en.wikipedia.org");
        let found = json!({"batchcomplete": true, "query": {"pages": [{
            "title": "Tokyo", "description": "Capital of Japan",
            "extract": "Tokyo is the capital of Japan.",
            "fullurl": "https://en.wikipedia.org/wiki/Tokyo"
        }]}});
        assert_eq!(
            summary(&found, &en),
            WikipediaSummary::Found {
                title: "Tokyo".into(),
                description: Some("Capital of Japan".into()),
                extract: "Tokyo is the capital of Japan.".into(),
                url: "https://en.wikipedia.org/wiki/Tokyo".into(),
            }
        );
        let missing =
            json!({"batchcomplete": true, "query": {"pages": [{"title": "Xq", "missing": true}]}});
        assert_eq!(summary(&missing, &en), WikipediaSummary::Missing);
        assert_eq!(
            summary(&json!({"batchcomplete": true}), &en),
            WikipediaSummary::Missing
        );
        assert_eq!(
            summary(&json!({"error": {"code": "x"}}), &en),
            WikipediaSummary::Failed
        );
        // An address elsewhere is never handed to the Reader.
        let elsewhere = json!({"query": {"pages": [{
            "title": "Tokyo", "extract": "x", "fullurl": "https://evil.example/wiki/Tokyo"
        }]}});
        assert_eq!(summary(&elsewhere, &en), WikipediaSummary::Failed);
    }

    #[test]
    fn long_introductions_end_at_a_sentence_or_word() {
        let sentence = "A short sentence. ".repeat(100);
        let cut = shortened(&sentence);
        assert!(cut.ends_with('.') && cut.chars().count() <= MAX_EXTRACT_CHARS);
        let words = "word ".repeat(400);
        let cut = shortened(&words);
        assert!(cut.ends_with("word…") && cut.chars().count() <= MAX_EXTRACT_CHARS + 1);
        let japanese = "東京は日本の首都である。".repeat(200);
        assert!(shortened(&japanese).ends_with('。'));
        assert_eq!(shortened("Short."), "Short.");
    }
}
