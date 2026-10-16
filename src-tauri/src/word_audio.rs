//! Word audio: recorded pronunciations of a headword from the sources the reader chose in
//! Settings, in order. Native code owns every request: the frontend names only the headword
//! and reading, and gets back bounded audio of a recognized type, never a URL or an error.

use crate::library::CatalogState;
use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::State;

/// Sources a reader can list; each is tried in order until one has the word.
pub(crate) const MAX_SOURCES: usize = 8;
const MAX_URL: usize = 2048;
const MAX_AUDIO: usize = 4 * 1024 * 1024;
const MAX_LIST: usize = 256 * 1024;
/// Entries of an audio list response that are tried.
const MAX_LIST_ENTRIES: usize = 8;
const MAX_TERM: usize = 256;
const CACHED: usize = 16;
const JPOD101: &str = "https://assets.languagepod101.com/dictionary/japanese/audiomp3.php";
/// JapanesePod101 answers a word it has no recording of with this clip ("the audio for this
/// clip is currently not available").
const JPOD101_MISSING: &str = "ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906";
/// What `encodeURIComponent` leaves as is, as audio servers expect.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AudioSource {
    #[serde(rename = "jpod101")]
    JapanesePod101,
    /// A URL answering with the audio itself.
    Url { url: String },
    /// A URL answering with an audio list: `{"audioSources":[{"url":…}]}`.
    List { url: String },
}

impl AudioSource {
    fn template(&self) -> Option<&str> {
        match self {
            Self::JapanesePod101 => None,
            Self::Url { url } | Self::List { url } => Some(url),
        }
    }
}

/// The sources new readers start with.
pub(crate) fn default_sources() -> Vec<AudioSource> {
    vec![AudioSource::JapanesePod101]
}

/// A source URL is http(s), bounded, and may use `{term}`, `{reading}` and `{language}`.
fn valid_template(template: &str) -> bool {
    template.len() <= MAX_URL
        && !template.chars().any(char::is_control)
        && Url::parse(&expand(template, "x", "x"))
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

pub(crate) fn valid_sources(sources: &[AudioSource]) -> bool {
    sources.len() <= MAX_SOURCES
        && sources
            .iter()
            .enumerate()
            .all(|(index, source)| !sources[..index].contains(source))
        && sources
            .iter()
            .filter_map(AudioSource::template)
            .all(valid_template)
}

fn expand(template: &str, term: &str, reading: &str) -> String {
    let encode = |text: &str| utf8_percent_encode(text, COMPONENT).to_string();
    template
        .replace("{term}", &encode(term))
        .replace("{reading}", &encode(reading))
        .replace("{language}", "ja")
}

fn kana(text: &str) -> bool {
    text.chars()
        .all(|c| matches!(c, '\u{3041}'..='\u{3096}' | '\u{309d}'..='\u{309f}' | '\u{30a1}'..='\u{30fa}' | '\u{30fc}'..='\u{30ff}'))
}

fn jpod101_url(term: &str, reading: &str) -> Url {
    let mut url = Url::parse(JPOD101).expect("JapanesePod101 URL");
    {
        let mut query = url.query_pairs_mut();
        // A kana-only word is asked for by its kana alone.
        if !(term == reading && kana(term)) {
            query.append_pair("kanji", term);
        }
        if !reading.is_empty() {
            query.append_pair("kana", reading);
        }
    }
    url
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Audio {
    pub mime: &'static str,
    pub extension: &'static str,
    pub bytes: Vec<u8>,
}

impl Audio {
    /// A media file name that is the same for the same recording.
    pub(crate) fn file_name(&self) -> String {
        format!(
            "komori_audio_{:x}.{}",
            Sha256::digest(&self.bytes),
            self.extension
        )
    }
}

/// The audio type, by content rather than by what the server claims.
fn audio_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    if starts(b"ID3") || (bytes.len() > 1 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0) {
        // MPEG audio; AAC in ADTS also starts 0xFFF and plays as audio/aac.
        if bytes.len() > 1 && bytes[0] == 0xff && bytes[1] & 0xf6 == 0xf0 {
            return Some(("audio/aac", "aac"));
        }
        return Some(("audio/mpeg", "mp3"));
    }
    if starts(b"OggS") {
        return Some(("audio/ogg", "ogg"));
    }
    if starts(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        return Some(("audio/wav", "wav"));
    }
    if starts(b"fLaC") {
        return Some(("audio/flac", "flac"));
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return Some(("audio/mp4", "m4a"));
    }
    if starts(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some(("audio/webm", "webm"));
    }
    None
}

fn client() -> Option<Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(Policy::limited(4))
        .user_agent(concat!("Komori/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

/// The body of a successful response, refused past `limit` bytes.
async fn body(client: &Client, url: &str, limit: usize) -> Option<Vec<u8>> {
    let url = Url::parse(url)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))?;
    let mut response = client.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > limit as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > limit {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

async fn audio_at(client: &Client, url: &str) -> Option<Audio> {
    let bytes = body(client, url, MAX_AUDIO).await?;
    let (mime, extension) = audio_type(&bytes)?;
    Some(Audio {
        mime,
        extension,
        bytes,
    })
}

/// The http(s) URLs of an audio list response, in order.
fn list_urls(bytes: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    value
        .get("audioSources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("url").and_then(Value::as_str))
        .filter(|url| url.len() <= MAX_URL)
        .take(MAX_LIST_ENTRIES)
        .map(str::to_owned)
        .collect()
}

async fn from_source(
    client: &Client,
    source: &AudioSource,
    term: &str,
    reading: &str,
) -> Option<Audio> {
    match source {
        AudioSource::JapanesePod101 => {
            let audio = audio_at(client, jpod101_url(term, reading).as_str()).await?;
            (format!("{:x}", Sha256::digest(&audio.bytes)) != JPOD101_MISSING).then_some(audio)
        }
        AudioSource::Url { url } => audio_at(client, &expand(url, term, reading)).await,
        AudioSource::List { url } => {
            let list = body(client, &expand(url, term, reading), MAX_LIST).await?;
            for url in list_urls(&list) {
                if let Some(audio) = audio_at(client, &url).await {
                    return Some(audio);
                }
            }
            None
        }
    }
}

type Key = (Vec<AudioSource>, String, String);
static CACHE: Mutex<VecDeque<(Key, Arc<Audio>)>> = Mutex::new(VecDeque::new());

fn valid_term(text: &str) -> bool {
    text.chars().count() <= MAX_TERM && !text.chars().any(char::is_control)
}

/// The first recording of `term` the sources have, or none. Recent recordings are kept in
/// memory so playing a word and then adding its card fetches it once.
pub(crate) async fn find(sources: &[AudioSource], term: &str, reading: &str) -> Option<Arc<Audio>> {
    let term = term.trim();
    let reading = reading.trim();
    if term.is_empty() || !valid_term(term) || !valid_term(reading) || !valid_sources(sources) {
        return None;
    }
    let key = (sources.to_vec(), term.to_owned(), reading.to_owned());
    if let Some(audio) = CACHE.lock().ok().and_then(|cache| {
        cache
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, a)| a.clone())
    }) {
        return Some(audio);
    }
    let client = client()?;
    for source in sources {
        if let Some(audio) = from_source(&client, source, term, reading).await {
            let audio = Arc::new(audio);
            if let Ok(mut cache) = CACHE.lock() {
                if cache.len() >= CACHED {
                    cache.pop_front();
                }
                cache.push_back((key, audio.clone()));
            }
            return Some(audio);
        }
    }
    None
}

/// The reader's saved sources, or the default ones.
pub(crate) fn saved_sources(database: &Path) -> Vec<AudioSource> {
    crate::appearance_preferences::word_audio_sources(database).unwrap_or_else(default_sources)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordAudio {
    mime: &'static str,
    /// Base64 audio.
    data: String,
}

#[tauri::command]
pub async fn get_word_audio(
    catalog: State<'_, CatalogState>,
    term: String,
    reading: String,
) -> Result<Option<WordAudio>, String> {
    let database = catalog.database.clone();
    let sources = tauri::async_runtime::spawn_blocking(move || saved_sources(&database))
        .await
        .map_err(|error| error.to_string())?;
    Ok(find(&sources, &term, &reading)
        .await
        .map(|audio| WordAudio {
            mime: audio.mime,
            data: STANDARD.encode(&audio.bytes),
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    /// A local server answering each request with the response for its path.
    fn serve(responses: Vec<(&'static str, Vec<u8>, &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                let found = responses
                    .iter()
                    .find(|(prefix, _, _)| path.starts_with(prefix));
                let (status, body) = match found {
                    Some((_, body, status)) => (*status, body.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}")
    }

    fn mp3(tag: u8) -> Vec<u8> {
        let mut bytes = b"ID3\x04\x00".to_vec();
        bytes.extend([tag; 64]);
        bytes
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn sources_validate_urls_placeholders_duplicates_and_count() {
        let url = |url: &str| AudioSource::Url { url: url.into() };
        assert!(valid_sources(&default_sources()));
        assert!(valid_sources(&[
            url("http://localhost:5050/?term={term}&reading={reading}"),
            AudioSource::List {
                url: "https://example.com/{language}/{term}.json".into()
            },
        ]));
        for bad in [
            "file:///C:/audio/{term}.mp3",
            "ftp://example.com/{term}",
            "{term}",
            "https://",
        ] {
            assert!(!valid_sources(&[url(bad)]), "{bad}");
        }
        assert!(!valid_sources(&[url(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_URL)
        ))]));
        assert!(!valid_sources(&[url("https://example.com/\n{term}")]));
        assert!(!valid_sources(&[
            AudioSource::JapanesePod101,
            AudioSource::JapanesePod101
        ]));
        assert!(!valid_sources(
            &(0..=MAX_SOURCES)
                .map(|n| url(&format!("https://example.com/{n}/{{term}}")))
                .collect::<Vec<_>>()
        ));
        assert_eq!(
            serde_json::to_value(default_sources()).unwrap(),
            serde_json::json!([{"kind": "jpod101"}])
        );
        assert!(serde_json::from_value::<AudioSource>(serde_json::json!({"kind": "url"})).is_err());
    }

    #[test]
    fn urls_encode_the_word_as_audio_servers_expect() {
        assert_eq!(
            expand(
                "http://h/?t={term}&r={reading}&l={language}",
                "読む",
                "よむ"
            ),
            "http://h/?t=%E8%AA%AD%E3%82%80&r=%E3%82%88%E3%82%80&l=ja"
        );
        assert_eq!(
            expand("http://h/{term}", "a&b c/d", ""),
            "http://h/a%26b%20c%2Fd"
        );
        assert_eq!(
            jpod101_url("読む", "よむ").as_str(),
            "https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=%E8%AA%AD%E3%82%80&kana=%E3%82%88%E3%82%80"
        );
        // A kana word is asked for by its kana alone.
        assert_eq!(
            jpod101_url("ねこ", "ねこ").query(),
            Some("kana=%E3%81%AD%E3%81%93")
        );
        assert_eq!(
            jpod101_url("ネコ", "ネコ").query(),
            Some("kana=%E3%83%8D%E3%82%B3")
        );
    }

    #[test]
    fn audio_is_recognized_by_content() {
        assert_eq!(audio_type(&mp3(0)), Some(("audio/mpeg", "mp3")));
        assert_eq!(
            audio_type(&[0xff, 0xfb, 0x90, 0xc4]),
            Some(("audio/mpeg", "mp3"))
        );
        assert_eq!(
            audio_type(&[0xff, 0xf1, 0x50, 0x80]),
            Some(("audio/aac", "aac"))
        );
        assert_eq!(audio_type(b"OggS\0\x02"), Some(("audio/ogg", "ogg")));
        assert_eq!(
            audio_type(b"RIFF\0\0\0\0WAVEfmt "),
            Some(("audio/wav", "wav"))
        );
        assert_eq!(audio_type(b"fLaC\0"), Some(("audio/flac", "flac")));
        assert_eq!(
            audio_type(b"\0\0\0\x20ftypM4A "),
            Some(("audio/mp4", "m4a"))
        );
        assert_eq!(
            audio_type(&[0x1a, 0x45, 0xdf, 0xa3, 0]),
            Some(("audio/webm", "webm"))
        );
        for other in [
            &b"<html>"[..],
            b"{\"audioSources\":[]}",
            b"",
            b"RIFF\0\0\0\0AVI ",
        ] {
            assert_eq!(audio_type(other), None);
        }
        let audio = Audio {
            mime: "audio/mpeg",
            extension: "mp3",
            bytes: mp3(1),
        };
        assert!(
            audio.file_name().starts_with("komori_audio_") && audio.file_name().ends_with(".mp3")
        );
        assert_eq!(audio.file_name().len(), "komori_audio_".len() + 64 + 4);
    }

    #[test]
    fn sources_are_tried_in_order_and_only_bounded_audio_is_returned() {
        let server = serve(vec![
            ("/page", b"<html>not audio</html>".to_vec(), "200 OK"),
            ("/missing", mp3(9), "404 Not Found"),
            ("/large", vec![0xff; MAX_AUDIO + 1], "200 OK"),
            ("/word-a", mp3(1), "200 OK"),
            ("/word-b", mp3(2), "200 OK"),
        ]);
        // The list names the server; rewrite its placeholder now the address is known.
        let list_server = serve(vec![(
            "/list",
            format!(
                "{{\"type\":\"audioSourceList\",\"audioSources\":[{{\"name\":\"a\",\"url\":\"file:///C:/x.mp3\"}},{{\"url\":\"{server}/page\"}},{{\"url\":\"{server}/word-b\"}}]}}"
            )
            .into_bytes(),
            "200 OK",
        )]);
        let url = |path: &str| AudioSource::Url {
            url: format!("{server}{path}"),
        };
        let found = |sources: Vec<AudioSource>, term: &str| run(find(&sources, term, "よむ"));

        assert_eq!(
            found(vec![url("/word-a?t={term}")], "読む-1")
                .unwrap()
                .bytes,
            mp3(1)
        );
        assert_eq!(
            found(
                vec![url("/page"), url("/missing"), url("/large"), url("/word-b")],
                "読む-2"
            )
            .unwrap()
            .bytes,
            mp3(2)
        );
        assert_eq!(
            found(
                vec![AudioSource::List {
                    url: format!("{list_server}/list?t={{term}}")
                }],
                "読む-3"
            )
            .unwrap()
            .bytes,
            mp3(2)
        );
        assert!(found(vec![url("/page"), url("/missing"), url("/large")], "読む-4").is_none());
        assert!(found(vec![url("/word-a")], "").is_none());
        assert!(found(vec![url("/word-a")], "読\u{7}む").is_none());
        assert!(found(
            vec![AudioSource::Url {
                url: "file:///C:/a.mp3".into()
            }],
            "読む-5"
        )
        .is_none());
        assert!(found(Vec::new(), "読む-6").is_none());
    }

    #[test]
    fn a_found_recording_is_reused_for_the_same_word_and_sources() {
        let server = serve(vec![("/word", mp3(3), "200 OK")]);
        let sources = vec![AudioSource::Url {
            url: format!("{server}/word?t={{term}}"),
        }];
        let first = run(find(&sources, "キャッシュ", "きゃっしゅ")).unwrap();
        let again = run(find(&sources, "キャッシュ", "きゃっしゅ")).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        let other = run(find(&sources, "キャッシュ", "")).unwrap();
        assert!(!Arc::ptr_eq(&first, &other));
    }

    /// Run with `--ignored`: asks the real JapanesePod101 for a word it has and one it does not.
    #[test]
    #[ignore]
    fn real_jpod101_has_common_words_and_its_missing_clip_is_refused() {
        let sources = default_sources();
        let audio = run(find(&sources, "読む", "よむ")).expect("a recording of 読む");
        assert_eq!(audio.mime, "audio/mpeg");
        assert!(run(find(&sources, "ほげほげ無", "ほげ")).is_none());
    }

    #[test]
    fn audio_lists_keep_only_bounded_urls() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL));
        let list = serde_json::json!({"audioSources": [
            {"url": "https://a.example/1.mp3"}, {"name": "no url"}, {"url": long}, {"url": 3},
        ]});
        assert_eq!(
            list_urls(list.to_string().as_bytes()),
            vec!["https://a.example/1.mp3"]
        );
        assert!(list_urls(b"not json").is_empty());
        let many = serde_json::json!({"audioSources": (0..20).map(|n| serde_json::json!({"url": format!("https://a.example/{n}")})).collect::<Vec<_>>()});
        assert_eq!(
            list_urls(many.to_string().as_bytes()).len(),
            MAX_LIST_ENTRIES
        );
    }
}
