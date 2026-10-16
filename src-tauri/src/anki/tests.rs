use super::*;
use std::{
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tempfile::tempdir;

struct Service {
    port: u16,
    log: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Service {
    fn new(mut handler: impl FnMut(&Value) -> Value + Send + 'static) -> Self {
        Self::with_hold(move |request| handler(request), Duration::ZERO)
    }
    fn with_hold(
        mut handler: impl FnMut(&Value) -> Value + Send + 'static,
        hold: Duration,
    ) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let log = Arc::new(Mutex::new(vec![]));
        let stopped = stop.clone();
        let recorded = log.clone();
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                // Windows can inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut data = vec![];
                let mut buffer = [0; 8192];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    data.extend_from_slice(&buffer[..count]);
                    if let Some(split) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&data[..split]).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|s| s.strip_prefix("Content-Length: "))
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        if data.len() >= split + 4 + length {
                            break;
                        }
                    }
                }
                let split = data.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
                let request: Value = serde_json::from_slice(&data[split + 4..]).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let response = handler(&request).to_string();
                // A timeout test deliberately disconnects before this response.
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
                thread::sleep(hold);
            }
        });
        Self {
            port,
            log,
            stop,
            thread: Some(thread),
        }
    }
    fn calls(&self, action: &str) -> usize {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["action"] == action)
            .count()
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}
fn response(value: Value) -> Value {
    json!({"result":value,"error":null})
}
fn basic(request: &Value) -> Value {
    assert!(request.get("key").is_none(), "Blank keys must be omitted");
    response(match request["action"].as_str().unwrap() {
        "version" => json!(6),
        "multi" => request["params"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(basic)
            .collect(),
        "deckNamesAndIds" => json!({"Study":1,"Other":3}),
        "modelNamesAndIds" => json!({"Basic":2}),
        "modelFieldNames" => json!(["Front", "Back"]),
        "addNote" => json!(1234),
        "findCards" => json!([]),
        "removeTags" => Value::Null,
        "findNotes" => {
            if request["params"]["query"]
                .as_str()
                .unwrap()
                .starts_with("tag:")
            {
                json!([1234])
            } else {
                json!([])
            }
        }
        _ => panic!("unexpected action"),
    })
}
fn prefs(port: u16) -> Preferences {
    Preferences {
        port,
        duplicate_scope: DuplicateScope::Deck,
        deck: "Study".into(),
        deck_id: Some(1),
        model: "Basic".into(),
        mappings: BTreeMap::from([(
            "Basic".into(),
            Mapping {
                model_id: Some(2),
                tags: default_tags(),
                tag_dictionaries: vec![],
                fields: vec!["Front".into(), "Back".into()],
                templates: BTreeMap::from([
                    ("Front".into(), "{{expression}}".into()),
                    ("Back".into(), "{{definition}}\n{{source}}".into()),
                ]),
            },
        )]),
        ..Preferences::default()
    }
}
fn request(prefs: Preferences) -> NoteRequest {
    NoteRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        preferences: prefs,
        field_parts: BTreeMap::new(),
        book_id: None,
        dictionary_sources: vec![],
        reading: None,
        fields: BTreeMap::from([
            ("Front".into(), "読む".into()),
            ("Back".into(), "read <script>\n${bad}`\\".into()),
        ]),
    }
}
#[test]
fn persistence_invalid_saves_and_independent_mappings() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    assert_eq!(load(&path).unwrap(), Preferences::default());
    assert_eq!(
        load(&path).unwrap().duplicate_scope,
        DuplicateScope::Collection
    );
    let mut prefs = prefs(8765);
    prefs.mappings.get_mut("Basic").unwrap().tags =
        vec!["JaPanese".into(), "BookTag".into(), "booktag".into()];
    prefs
        .mappings
        .insert("Other".into(), prefs.mappings["Basic"].clone());
    save(&path, &prefs).unwrap();
    prefs = prefs.lowercase_tags();
    assert_eq!(load(&path).unwrap(), prefs);
    assert_eq!(load(&path).unwrap().duplicate_scope, DuplicateScope::Deck);
    let mut invalid = prefs.clone();
    invalid.port = 0;
    assert_eq!(save(&path, &invalid), Err(AnkiError::Invalid));
    invalid = prefs.clone();
    invalid
        .mappings
        .get_mut("Basic")
        .unwrap()
        .templates
        .insert("Front".into(), "{{execute}}".into());
    assert_eq!(save(&path, &invalid), Err(AnkiError::Invalid));
    assert_eq!(load(&path).unwrap(), prefs);
    prefs.model = "Other".into();
    save(&path, &prefs).unwrap();
    assert_eq!(load(&path).unwrap().mappings.len(), 2);
}
#[test]
fn templates_and_text_are_bounded_and_inert() {
    for name in PLACEHOLDERS {
        assert!(valid_template(&format!("{{{{{name}}}}}")));
    }
    for invalid in [
        "{{unknown}}",
        "{{expression}",
        "{x}",
        "{{{expression}}}",
        "{{expression}}}",
    ] {
        assert!(!valid_template(invalid));
    }
    assert!(valid_template("<script>plain</script>\n{{definition}}"));
    assert!(!valid_template(&"a".repeat(4097)));
    assert!(!valid_text("a\0b", 100));
    assert!(valid_text("a\nb\tc", 100));
    let escaped = escaped("<script>${bad}`\\\"'&\n");
    assert_eq!(
        escaped,
        "&lt;script&gt;&#36;{bad}&#96;&#92;&quot;&#39;&amp;<br>"
    );
}
#[test]
fn tags_normalize_in_storage_and_legacy_load_without_relaxing_bounds() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(8765);
    prefs.mappings.get_mut("Basic").unwrap().tags =
        vec!["BookTag".into(), "booktag".into(), "MiXeD".into()];
    save(&path, &prefs).unwrap();
    let raw: String = connection(&path)
        .unwrap()
        .query_row("SELECT value FROM preferences WHERE name='anki'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let stored: Preferences = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored.mappings["Basic"].tags, vec!["booktag", "mixed"]);
    connection(&path)
        .unwrap()
        .execute(
            "UPDATE preferences SET value=?1 WHERE name='anki'",
            [serde_json::to_string(&prefs).unwrap()],
        )
        .unwrap();
    assert_eq!(load(&path).unwrap(), stored);
    // Lowercase expansion is also bounded; rejected saves leave the old value intact.
    for tags in [
        vec!["\u{0130}".repeat(64)],
        vec!["komori_REQUEST_bad".into()],
        vec!["same".into(), "same".into()],
        (0..33).map(|i| format!("tag{i}")).collect(),
    ] {
        let mut invalid = prefs.clone();
        invalid.mappings.get_mut("Basic").unwrap().tags = tags;
        assert_eq!(save(&path, &invalid), Err(AnkiError::Invalid));
        assert_eq!(load(&path).unwrap(), stored);
    }
    assert_eq!(dictionary_tag("TiEr ONE"), "tier_one");
    assert_eq!(
        dictionary_tag("Komori_Request_Bad"),
        "dict_komori_request_bad"
    );
}
#[test]
fn lowercase_tags_survive_interrupted_creation_and_recovery_without_resending() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "addNote" => {
            let tags = request["params"]["note"]["tags"].as_array().unwrap();
            assert_eq!(
                &tags[..3],
                &[json!("japanese"), json!("booktag"), json!("tier_one")]
            );
            // The note was accepted, but the response cannot confirm it.
            response(Value::Null)
        }
        "removeTags" => {
            assert!(request["params"]["tags"]
                .as_str()
                .unwrap()
                .starts_with("komori_request_"));
            assert!(!request["params"]["tags"]
                .as_str()
                .unwrap()
                .contains("BookTag"));
            response(Value::Null)
        }
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    let mapping = prefs.mappings.get_mut("Basic").unwrap();
    mapping.tags = vec!["JaPanese".into(), "BookTag".into()];
    mapping.tag_dictionaries = vec![42];
    save(&path, &prefs).unwrap();
    let mut req = request(load(&path).unwrap());
    req.dictionary_sources = vec![DictionaryTagSource {
        id: 42,
        title: "TMW".into(),
        values: Some(vec!["Tier ONE".into(), "BookTag".into()]),
    }];
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    let payload: String = connection(&path)
        .unwrap()
        .query_row(
            "SELECT payload FROM anki_requests WHERE id=?1",
            [&req.request_id],
            |r| r.get(0),
        )
        .unwrap();
    let journaled: NoteRequest = serde_json::from_str(&payload).unwrap();
    assert_eq!(journaled.preferences, req.preferences);
    assert_eq!(
        card_tags(&journaled, &journaled.preferences.mappings["Basic"]),
        vec!["japanese", "booktag", "tier_one"]
    );
    assert_eq!(
        check_note(&path, &req.request_id).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(service.calls("addNote"), 1);
    assert_eq!(service.calls("removeTags"), 1);
}
#[test]
fn discovery_creation_replay_and_safe_html_use_real_loopback_http() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let data = discover(&prefs).unwrap();
    assert_eq!(data.fields, vec!["Front", "Back"]);
    assert_eq!(data.lapis, "missing");
    assert_eq!(service.calls("addNote"), 0);
    let request = request(prefs);
    assert_eq!(
        create_note(&path, &request).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(
        create_note(&path, &request).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(service.calls("addNote"), 1);
    assert_eq!(service.calls("removeTags"), 1);
    let log = service.log.lock().unwrap();
    let note = &log.iter().find(|v| v["action"] == "addNote").unwrap()["params"]["note"];
    assert_eq!(
        note["fields"]["Back"],
        "read &lt;script&gt;<br>&#36;{bad}&#96;&#92;"
    );
    assert_eq!(note["options"]["allowDuplicate"], false);
    assert_eq!(
        note["tags"][1],
        format!("komori_request_{}", request.request_id)
    );
    drop(log);
    let mut changed = request.clone();
    changed.fields.insert("Front".into(), "changed".into());
    assert_eq!(create_note(&path, &changed), Err(AnkiError::Invalid));
}
#[test]
fn stale_configuration_fields_and_limits_refuse_before_write() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let mut req = request(prefs.clone());
    req.preferences.deck = "Other".into();
    assert_eq!(create_note(&path, &req), Err(AnkiError::Changed));
    req = request(prefs.clone());
    req.fields.insert("Front".into(), " ".into());
    assert_eq!(create_note(&path, &req), Err(AnkiError::Invalid));
    req.fields.insert("Front".into(), "字".repeat(FIELD_LIMIT));
    assert_eq!(create_note(&path, &req), Err(AnkiError::ContentTooLarge));
    let mut changed = prefs.clone();
    changed.mappings.get_mut("Basic").unwrap().fields.reverse();
    save(&path, &changed).unwrap();
    assert_eq!(
        create_note(&path, &request(changed)),
        Err(AnkiError::Changed)
    );
    assert_eq!(service.calls("addNote"), 0);
}
#[test]
fn uncertain_requests_survive_restart_block_resubmit_and_reconcile() {
    let service = Service::new(|request| {
        if request["action"] == "addNote" {
            json!({"result":null,"error":"hook failed after insertion"})
        } else {
            basic(request)
        }
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let req = request(prefs.clone());
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    assert_eq!(
        pending_requests(&path).unwrap()[0].request_id,
        req.request_id
    );
    assert_eq!(create_note(&path, &request(prefs)), Err(AnkiError::Pending));
    assert_eq!(
        note_status(&path, &req).unwrap(),
        NoteStatus::Pending {
            request_id: req.request_id.clone()
        }
    );
    assert_eq!(service.calls("removeTags"), 0);
    assert_eq!(service.calls("addNote"), 1);
    assert_eq!(
        check_note(&path, &req.request_id).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert!(pending_requests(&path).unwrap().is_empty());
    assert_eq!(service.calls("removeTags"), 1);
}

#[test]
fn dictionary_tags_and_compact_card_content_are_safe_and_sentence_uses_surface_form() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.mappings.get_mut("Basic").unwrap().tags = vec!["Study".into()];
    prefs.mappings.get_mut("Basic").unwrap().tag_dictionaries = vec![7, 9];
    save(&path, &prefs).unwrap();
    let definition = "adverb no-adj\n\nfor the first time\n\n１６歳の時、初めてテニスをした。\n\nWhen I was sixteen, I played tennis for the first time. [1]\n\nSee also 始める\n\n<script>${literal}`";
    let sentence = "昨日読んだ。<script>読んだ</script>。";
    let mut req = request(prefs);
    req.dictionary_sources = vec![
        DictionaryTagSource {
            id: 7,
            title: "Jitendex.org [2026-08-11]".into(),
            values: None,
        },
        DictionaryTagSource {
            id: 8,
            title: "Unselected".into(),
            values: None,
        },
    ];
    req.fields
        .insert("Back".into(), format!("{definition}\n{sentence}"));
    req.field_parts = BTreeMap::from([
        (
            "Front".into(),
            vec![FieldPart::Text {
                text: "読む".into(),
            }],
        ),
        (
            "Back".into(),
            vec![
                FieldPart::Definitions {
                    entries: vec![DefinitionContent {
                        source: "Jitendex.org [2026-08-11]".into(),
                        text: definition.into(),
                        glossary: None,
                        presentation: None,
                    }],
                },
                FieldPart::Text { text: "\n".into() },
                FieldPart::Sentence {
                    text: sentence.into(),
                    expression: "読んだ".into(),
                },
            ],
        ),
    ]);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    let log = service.log.lock().unwrap();
    let note = &log.iter().find(|r| r["action"] == "addNote").unwrap()["params"]["note"];
    assert_eq!(note["tags"][0], "study");
    assert_eq!(note["tags"][1], "jitendex.org_[2026-08-11]");
    assert_eq!(note["tags"].as_array().unwrap().len(), 3); // User, matching dictionary and transient marker.
    let back = note["fields"]["Back"].as_str().unwrap();
    assert!(back.contains(
        "<li data-dictionary=\"Jitendex.org [2026-08-11]\"><i>(Jitendex.org [2026-08-11])</i> <span>adverb no-adj<br>for the first time<br>"
    ));
    assert!(!back.contains("<br><br>"));
    assert!(!back.contains("<script>"));
    assert!(back.contains("&lt;script&gt;"));
    assert_eq!(
        back.matches("class=\"komori-sentence-expression\"").count(),
        2
    );
    assert!(back.contains(">読んだ</span>"));
    assert!(!back.contains(">読む</span>"));
    let cleanup = &log.iter().find(|r| r["action"] == "removeTags").unwrap()["params"];
    assert_eq!(cleanup["notes"], json!([1234]));
    assert_eq!(
        cleanup["tags"],
        format!("komori_request_{}", req.request_id)
    );
    let fields: BTreeMap<String, String> = serde_json::from_value(note["fields"].clone()).unwrap();
    drop(log);
    assert_eq!(
        connection(&path)
            .unwrap()
            .query_row(
                "SELECT tag_cleaned FROM anki_requests WHERE id=?1",
                [&req.request_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(dictionary_tag(&"字".repeat(100)).len() <= 128);
    assert!(!dictionary_tag("komori_request_name").starts_with("komori_request_"));
    assert!(!dictionary_tag("komori request name").starts_with("komori_request_"));
    let mut invalid = req.clone();
    invalid.request_id = uuid::Uuid::new_v4().to_string();
    invalid
        .dictionary_sources
        .push(invalid.dictionary_sources[0].clone());
    assert_eq!(create_note(&path, &invalid), Err(AnkiError::Invalid));
    invalid = req;
    invalid.request_id = uuid::Uuid::new_v4().to_string();
    invalid.field_parts.get_mut("Back").unwrap()[2] = FieldPart::Sentence {
        text: sentence.into(),
        expression: "字".repeat(257),
    };
    assert_eq!(create_note(&path, &invalid), Err(AnkiError::Invalid));
    // Optional ignored evidence uses the actual native formatter, never dictionary/EPUB corpora.
    if std::env::var("KOMORI_ANKI_CARD_FIXTURE").as_deref() == Ok("1") {
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/validation");
        std::fs::create_dir_all(&evidence).unwrap();
        std::fs::write(
            evidence.join("anki-card-fields.json"),
            serde_json::to_vec_pretty(&fields).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn failed_tracking_cleanup_keeps_confirmed_outcome_and_retries_without_note_write() {
    let mut attempts = 0;
    let service = Service::new(move |r| {
        if r["action"] == "removeTags" {
            attempts += 1;
            if attempts == 1 {
                json!({"result":null,"error":"temporarily unavailable"})
            } else {
                response(Value::Null)
            }
        } else {
            basic(r)
        }
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let req = request(prefs);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(
        connection(&path)
            .unwrap()
            .query_row(
                "SELECT tag_cleaned FROM anki_requests WHERE id=?1",
                [&req.request_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        check_note(&path, &req.request_id).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(service.calls("addNote"), 1);
    assert_eq!(service.calls("removeTags"), 2);
    assert_eq!(
        connection(&path)
            .unwrap()
            .query_row(
                "SELECT tag_cleaned FROM anki_requests WHERE id=?1",
                [&req.request_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn existing_note_status_uses_saved_scope_and_cleans_legacy_confirmed_tags_only() {
    let service = Service::new(multi_aware(|r| match r["action"].as_str().unwrap() {
        "findNotes" => response(json!([1234])),
        "findCards" => response(json!([11])),
        "getDecks" => response(json!({"Study":[11]})),
        "cardsToNotes" => response(json!([1234])),
        _ => basic(r),
    }));
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let req = request(prefs.clone());
    let connection = connection(&path).unwrap();
    connection.execute_batch("CREATE TABLE anki_requests(id TEXT PRIMARY KEY,payload TEXT NOT NULL,outcome TEXT NOT NULL)").unwrap();
    let mut legacy = serde_json::to_value(&req).unwrap();
    legacy.as_object_mut().unwrap().remove("dictionarySources");
    legacy["preferences"]["mappings"]["Basic"]
        .as_object_mut()
        .unwrap()
        .remove("tagDictionaries");
    connection
        .execute(
            "INSERT INTO anki_requests VALUES(?1,?2,?3)",
            params![
                req.request_id,
                legacy.to_string(),
                serde_json::to_string(&NoteOutcome::Created { id: 1234 }).unwrap()
            ],
        )
        .unwrap();
    assert_eq!(
        note_status(&path, &req).unwrap(),
        NoteStatus::Existing { id: 1234, count: 1 }
    );
    assert_eq!(service.calls("removeTags"), 1);
    assert_eq!(
        note_status(&path, &req).unwrap(),
        NoteStatus::Existing { id: 1234, count: 1 }
    );
    assert_eq!(service.calls("removeTags"), 1);
    let mut other = prefs;
    other.deck = "Other".into();
    other.deck_id = Some(3);
    save(&path, &other).unwrap();
    assert_eq!(
        note_status(&path, &request(other.clone())).unwrap(),
        NoteStatus::Missing
    );
    other.duplicate_scope = DuplicateScope::Collection;
    save(&path, &other).unwrap();
    assert_eq!(
        note_status(&path, &request(other)).unwrap(),
        NoteStatus::Existing { id: 1234, count: 1 }
    );
    assert_eq!(service.calls("addNote"), 0);
    assert_eq!(service.calls("updateNoteFields"), 0);
}
#[test]
fn duplicates_are_confirmed_without_second_submission() {
    let service = Service::new(|request| {
        if request["action"] == "addNote" {
            json!({"result":null,"error":"cannot create note because it is a duplicate"})
        } else {
            basic(request)
        }
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let req = request(prefs);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Duplicate { id: None }
    );
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Duplicate { id: None }
    );
    assert_eq!(service.calls("addNote"), 1);
}

/// Routes the actions inside `multi` through the same handler, as AnkiConnect runs them.
fn multi_aware(handler: impl Fn(&Value) -> Value + Send + 'static) -> impl FnMut(&Value) -> Value {
    move |request| {
        if request["action"] == "multi" {
            response(json!(request["params"]["actions"]
                .as_array()
                .unwrap()
                .iter()
                .map(&handler)
                .collect::<Vec<_>>()))
        } else {
            handler(request)
        }
    }
}

#[test]
fn batched_checks_ask_anki_once_and_separate_other_readings() {
    let service = Service::new(multi_aware(|request| {
        match request["action"].as_str().unwrap() {
            "modelFieldNames" => response(json!(["Front", "Back", "Reading"])),
            "findNotes" => {
                let query = request["params"]["query"].as_str().unwrap();
                if query.starts_with("tag:") {
                    response(json!([1234]))
                } else if query.contains("誰が") {
                    response(json!([101]))
                } else {
                    response(json!([]))
                }
            }
            "notesInfo" => {
                assert_eq!(request["params"]["notes"], json!([101]));
                response(json!([{"noteId":101,"fields":{
                "Front":{"value":"誰が"},"Back":{"value":"whose"},
                "Reading":{"value":"<b>誰[ダレ]が</b>"}}}]))
            }
            _ => basic(request),
        }
    }));
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.duplicate_scope = DuplicateScope::Collection;
    let mapping = prefs.mappings.get_mut("Basic").unwrap();
    mapping.fields.push("Reading".into());
    mapping
        .templates
        .insert("Reading".into(), "{{expressionFurigana}}".into());
    save(&path, &prefs).unwrap();
    let note = |first: &str, reading: &str| StatusNote {
        first: vec![FieldPart::Text { text: first.into() }],
        reading: Some(reading.into()),
    };
    let batch = StatusBatch {
        preferences: prefs.clone(),
        notes: vec![
            note("誰が", "たが"),
            note("誰が", "だれが"),
            note("読む", "よむ"),
        ],
    };
    assert_eq!(
        note_statuses(&path, &batch).unwrap(),
        vec![
            NoteStatus::Missing,
            NoteStatus::Existing { id: 101, count: 1 },
            NoteStatus::Missing
        ]
    );
    // Configuration and all three searches in one request, then one notesInfo.
    assert_eq!(service.calls("multi"), 1);
    assert_eq!(service.calls("notesInfo"), 1);
    assert_eq!(service.calls("findNotes"), 0);
    // The other reading is added even though Anki would call its first field a duplicate.
    let mut req = request(prefs.clone());
    req.fields.insert("Reading".into(), "誰[た]が".into());
    req.fields.insert("Front".into(), "誰が".into());
    req.reading = Some("たが".into());
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    let log = service.log.lock().unwrap();
    let added = log.iter().find(|r| r["action"] == "addNote").unwrap();
    assert_eq!(added["params"]["note"]["options"]["allowDuplicate"], true);
    drop(log);
    // The same reading stays a duplicate and is never sent.
    let mut same = request(prefs.clone());
    same.fields.insert("Reading".into(), "誰[だれ]が".into());
    same.fields.insert("Front".into(), "誰が".into());
    same.reading = Some("だれが".into());
    assert_eq!(
        create_note(&path, &same).unwrap(),
        NoteOutcome::Duplicate { id: Some(101) }
    );
    assert_eq!(service.calls("addNote"), 1);
    // A changed configuration is reported for the whole batch.
    let mut stale = batch;
    stale.preferences.deck = "Other".into();
    assert_eq!(note_statuses(&path, &stale), Err(AnkiError::Changed));
}

#[test]
fn readings_are_read_from_anki_furigana_and_kana_fields() {
    assert_eq!(field_reading("誰[だれ]が"), "だれが");
    assert_eq!(field_reading(" 読[よ]み 込[こ]む"), "よみこむ");
    assert_eq!(field_reading("お 茶[ちゃ]"), "おちゃ");
    assert_eq!(field_reading("<span>カタカナ</span>"), "かたかな");
    assert_eq!(field_reading(""), "");
}

#[test]
fn deck_duplicate_scope_prevents_before_write_and_filters_children() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "findCards" => {
            assert_eq!(request["params"]["query"], "\"dupe:2,読む\" \"deck:Study\"");
            response(json!([201, 202]))
        }
        "getDecks" => response(json!({"Study::Child":[201],"Other":[202]})),
        "cardsToNotes" => {
            assert_eq!(request["params"]["cards"], json!([201]));
            response(json!([101]))
        }
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    assert_eq!(
        create_note(&path, &request(prefs.clone())).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    prefs.check_children = true;
    save(&path, &prefs).unwrap();
    assert_eq!(
        create_note(&path, &request(prefs.clone())).unwrap(),
        NoteOutcome::Duplicate { id: Some(101) }
    );
    assert_eq!(service.calls("addNote"), 1);
    assert_eq!(service.calls("updateNoteFields"), 0);
    browse_note(&path, 0).unwrap_err();
    assert_eq!(service.calls("notesInfo"), 0);
    assert_eq!(service.calls("cardsInfo"), 0);
}

#[test]
fn overwrite_preserves_scheduling_and_tags_and_verifies_fields() {
    let mut fields = json!({"Front":{"value":"読む"},"Back":{"value":"old"}});
    let service = Service::new(move |request| match request["action"].as_str().unwrap() {
        "findNotes" => response(json!([101])),
        "notesInfo" => response(json!([{"noteId":101,"cards":[201],"fields":fields}])),
        "findCards" => response(json!([201])),
        "getDecks" => response(json!({"Study":[201]})),
        "cardsToNotes" => response(json!([101])),
        "addTags" => {
            assert_eq!(request["params"]["notes"], json!([101]));
            assert!(request["params"]["tags"]
                .as_str()
                .unwrap()
                .starts_with("custom booktag tier_one komori_request_"));
            response(Value::Null)
        }
        "updateNoteFields" => {
            assert_eq!(request["params"]["note"]["id"], 101);
            assert!(request["params"]["note"].get("tags").is_none());
            fields = Value::Object(
                request["params"]["note"]["fields"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| (key.clone(), json!({"value":value})))
                    .collect(),
            );
            response(Value::Null)
        }
        "guiBrowse" => {
            assert_eq!(request["params"]["query"], "nid:101");
            response(json!([201]))
        }
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.duplicate_policy = DuplicatePolicy::Overwrite;
    prefs.mappings.get_mut("Basic").unwrap().tags = vec!["CuStom".into(), "BookTag".into()];
    prefs.mappings.get_mut("Basic").unwrap().tag_dictionaries = vec![42];
    save(&path, &prefs).unwrap();
    let mut req = request(load(&path).unwrap());
    req.dictionary_sources = vec![DictionaryTagSource {
        id: 42,
        title: "TMW".into(),
        values: Some(vec!["Tier ONE".into(), "BookTag".into()]),
    }];
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Updated { id: 101 }
    );
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Updated { id: 101 }
    );
    assert_eq!(service.calls("addNote"), 0);
    assert_eq!(service.calls("updateNoteFields"), 1);
    browse_note(&path, 101).unwrap();
    assert_eq!(service.calls("guiBrowse"), 1);
}

#[test]
fn uncertain_overwrite_tag_alone_does_not_confirm_and_multiple_matches_block() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "findNotes" => response(json!([101])),
        "notesInfo" => response(
            json!([{"noteId":101,"cards":[201],"fields":{"Front":{"value":"読む"},"Back":{"value":"unchanged"}}}]),
        ),
        "findCards" => response(json!([201])),
        "getDecks" => response(json!({"Study":[201]})),
        "cardsToNotes" => response(json!([101])),
        "addTags" => response(Value::Null),
        "updateNoteFields" => json!({"result":null,"error":"editor prevented update"}),
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.duplicate_policy = DuplicatePolicy::Overwrite;
    save(&path, &prefs).unwrap();
    let req = request(prefs.clone());
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    assert_eq!(
        check_note(&path, &req.request_id).unwrap(),
        NoteOutcome::Uncertain
    );
    assert_eq!(create_note(&path, &request(prefs)), Err(AnkiError::Pending));
    assert_eq!(service.calls("updateNoteFields"), 1);
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "findNotes" => response(json!([101, 102])),
        _ => basic(request),
    });
    let path = directory.path().join("other.sqlite3");
    let mut prefs = self::prefs(service.port);
    prefs.duplicate_scope = DuplicateScope::Collection;
    prefs.duplicate_policy = DuplicatePolicy::Overwrite;
    save(&path, &prefs).unwrap();
    assert_eq!(
        create_note(&path, &request(prefs)).unwrap(),
        NoteOutcome::Duplicate { id: Some(101) }
    );
    assert_eq!(service.calls("updateNoteFields"), 0);
    assert_eq!(service.calls("addNote"), 0);
}

#[test]
fn allow_duplicates_is_explicit_and_preferences_migrate_with_per_model_tags() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.duplicate_policy = DuplicatePolicy::Allow;
    save(&path, &prefs).unwrap();
    create_note(&path, &request(prefs.clone())).unwrap();
    assert_eq!(service.calls("findNotes"), 0);
    let log = service.log.lock().unwrap();
    let note = &log.iter().find(|r| r["action"] == "addNote").unwrap()["params"]["note"];
    assert_eq!(note["options"]["allowDuplicate"], true);
    drop(log);
    let mut legacy = serde_json::to_value(&prefs).unwrap();
    for key in ["duplicatePolicy", "duplicateScope", "checkChildren"] {
        legacy.as_object_mut().unwrap().remove(key);
    }
    legacy["mappings"]["Basic"]
        .as_object_mut()
        .unwrap()
        .remove("tags");
    let migrated: Preferences = serde_json::from_value(legacy).unwrap();
    assert_eq!(migrated.duplicate_policy, DuplicatePolicy::Prevent);
    assert_eq!(migrated.duplicate_scope, DuplicateScope::Collection);
    assert_eq!(migrated.mappings["Basic"].tags, default_tags());
    prefs.mappings.get_mut("Basic").unwrap().tags = vec!["komori_request_bad".into()];
    assert_eq!(save(&path, &prefs), Err(AnkiError::Invalid));
}

#[test]
fn legacy_request_journal_migration_preserves_pending_payloads() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let connection = connection(&path).unwrap();
    connection.execute_batch("CREATE TABLE anki_requests (id TEXT PRIMARY KEY,payload TEXT NOT NULL,outcome TEXT NOT NULL)").unwrap();
    let mut req = serde_json::to_value(request(prefs(8765))).unwrap();
    req.as_object_mut().unwrap().remove("fieldParts");
    req.as_object_mut().unwrap().remove("bookId");
    req["preferences"]["mappings"]["Basic"]
        .as_object_mut()
        .unwrap()
        .remove("tags");
    let id = req["requestId"].as_str().unwrap();
    connection
        .execute(
            "INSERT INTO anki_requests VALUES (?1,?2,?3)",
            params![
                id,
                req.to_string(),
                serde_json::to_string(&NoteOutcome::Uncertain).unwrap()
            ],
        )
        .unwrap();
    journal(&connection).unwrap();
    journal(&connection).unwrap();
    assert_eq!(pending_requests(&path).unwrap()[0].request_id, id);
    assert!(valid_template(
        "{{dictionary:7}} {{glossary}} {{picture}} {{expressionFurigana}}"
    ));
    for invalid in [
        "{{dictionary:0}}",
        "{{dictionary:01}}",
        "{{dictionary:9007199254740992}}",
    ] {
        assert!(!valid_template(invalid));
    }
}

#[test]
fn structured_definitions_and_cached_cover_export_are_inert_and_catalog_scoped() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "storeMediaFile" => {
            assert!(request["params"].get("path").is_none());
            assert!(request["params"].get("url").is_none());
            assert_eq!(
                STANDARD
                    .decode(request["params"]["data"].as_str().unwrap())
                    .unwrap(),
                b"derived cover"
            );
            response(request["params"]["filename"].clone())
        }
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let book_id = uuid::Uuid::new_v4().to_string();
    let source = directory.path().join("source.epub");
    std::fs::write(&source, b"source remains read only").unwrap();
    let connection = connection(&path).unwrap();
    connection.execute("INSERT INTO books (id,source_path,file_name,cover_mime,cover_bytes) VALUES (?1,?2,'source.epub','image/png',?3)",params![book_id,source.to_str().unwrap(),b"derived cover".as_slice()]).unwrap();
    let mut req = request(prefs);
    req.book_id = Some(book_id);
    req.fields
        .insert("Back".into(), "<script>literal</script>".into());
    req.field_parts = BTreeMap::from([
        (
            "Front".into(),
            vec![FieldPart::Text {
                text: "読む".into(),
            }],
        ),
        (
            "Back".into(),
            vec![
                FieldPart::Definitions {
                    entries: vec![DefinitionContent {
                        source: "Dict\"${bad}`".into(),
                        text: "<script>literal</script>".into(),
                        glossary: None,
                        presentation: None,
                    }],
                },
                FieldPart::Cover,
            ],
        ),
    ]);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(std::fs::read(source).unwrap(), b"source remains read only");
    let log = service.log.lock().unwrap();
    let back = log.iter().find(|r| r["action"] == "addNote").unwrap()["params"]["note"]["fields"]
        ["Back"]
        .as_str()
        .unwrap();
    assert!(back.contains("class=\"yomitan-glossary\""));
    assert!(back.contains("&lt;script&gt;literal&lt;/script&gt;"));
    assert!(!back.contains("<script>"));
    assert!(back.contains("<img src=\"komori_cover_"));
    assert!(!back.contains("source.epub"));
    drop(log);
    let mut invalid = req.clone();
    invalid.request_id = uuid::Uuid::new_v4().to_string();
    invalid.book_id = Some("private/path".into());
    assert_eq!(create_note(&path, &invalid), Err(AnkiError::Invalid));
    assert_eq!(service.calls("storeMediaFile"), 1);
    invalid = req;
    invalid.request_id = uuid::Uuid::new_v4().to_string();
    invalid.fields.insert("Back".into(), "mismatch".into());
    assert_eq!(create_note(&path, &invalid), Err(AnkiError::Invalid));
}
#[test]
fn word_audio_is_stored_as_media_only_for_written_cards_and_missing_audio_leaves_the_field_empty() {
    let recording = b"ID3 recorded word".to_vec();
    let expected = recording.clone();
    let service = Service::new(move |request| match request["action"].as_str().unwrap() {
        "storeMediaFile" => {
            assert!(request["params"].get("url").is_none());
            assert_eq!(
                STANDARD
                    .decode(request["params"]["data"].as_str().unwrap())
                    .unwrap(),
                expected
            );
            response(request["params"]["filename"].clone())
        }
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.mappings.get_mut("Basic").unwrap().templates = BTreeMap::from([
        ("Front".into(), "{{expression}}".into()),
        ("Back".into(), "{{audio}}".into()),
    ]);
    assert_eq!(prefs.validate(), Ok(()));
    save(&path, &prefs).unwrap();
    let card = |term: &str, reading: &str| {
        let mut req = request(prefs.clone());
        req.fields = BTreeMap::from([
            ("Front".into(), term.into()),
            ("Back".into(), String::new()),
        ]);
        req.field_parts = BTreeMap::from([
            ("Front".into(), vec![FieldPart::Text { text: term.into() }]),
            (
                "Back".into(),
                vec![FieldPart::Audio {
                    term: term.into(),
                    reading: reading.into(),
                }],
            ),
        ]);
        req
    };
    let asked = Mutex::new(Vec::new());
    let audio = |bytes: Vec<u8>| word_audio::Audio {
        mime: "audio/mpeg",
        extension: "mp3",
        bytes,
    };
    let found = |sources: &[word_audio::AudioSource], term: &str, reading: &str| {
        assert_eq!(sources, word_audio::default_sources().as_slice());
        asked
            .lock()
            .unwrap()
            .push((term.to_owned(), reading.to_owned()));
        (term == "読む").then(|| Arc::new(audio(recording.clone())))
    };
    let back = |index: usize| {
        let log = service.log.lock().unwrap();
        log.iter()
            .filter(|r| r["action"] == "addNote")
            .nth(index)
            .unwrap()["params"]["note"]["fields"]["Back"]
            .as_str()
            .unwrap()
            .to_owned()
    };

    assert_eq!(
        create_note_with(&path, &card("読む", "よむ"), &found).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    let name = audio(b"ID3 recorded word".to_vec()).file_name();
    assert_eq!(back(0), format!("[sound:{name}]"));
    assert_eq!(service.calls("storeMediaFile"), 1);

    // No source has the word: the card is still added, with the field empty.
    assert_eq!(
        create_note_with(&path, &card("無音", "むおん"), &found).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    assert_eq!(back(1), "");
    assert_eq!(service.calls("storeMediaFile"), 1);

    // An invalid word is refused before any source is asked.
    assert_eq!(
        create_note_with(&path, &card("読\u{7}む", "よむ"), &found),
        Err(AnkiError::Invalid)
    );
    assert_eq!(
        *asked.lock().unwrap(),
        vec![
            ("読む".to_owned(), "よむ".to_owned()),
            ("無音".to_owned(), "むおん".to_owned())
        ]
    );
    // Replaying a written request neither asks again nor stores the media twice.
    let replay = card("読む", "よむ");
    create_note_with(&path, &replay, &found).unwrap();
    create_note_with(&path, &replay, &found).unwrap();
    assert_eq!(asked.lock().unwrap().len(), 3);
    assert_eq!(service.calls("storeMediaFile"), 2);
}
#[test]
fn lapis_creation_uses_pinned_definition_and_never_overwrites_or_imports_notes() {
    let mut exists = false;
    let service = Service::new(move |request| match request["action"].as_str().unwrap() {
        "modelNamesAndIds" => response(if exists {
            json!({"Lapis":4})
        } else {
            json!({})
        }),
        "modelFieldNames" => response(json!(lapis_fields())),
        "createModel" => {
            assert_eq!(request["params"]["cardTemplates"][0]["Name"], "Mining");
            assert_eq!(
                request["params"]["cardTemplates"][0]["Front"],
                include_str!("../../vendor/lapis/front.html")
            );
            assert_eq!(
                request["params"]["css"],
                include_str!("../../vendor/lapis/styling.css")
            );
            exists = true;
            response(json!({"name":"Lapis"}))
        }
        _ => basic(request),
    });
    let prefs = Preferences {
        port: service.port,
        ..Preferences::default()
    };
    assert_eq!(create_lapis(&prefs).unwrap(), "created");
    assert_eq!(create_lapis(&prefs).unwrap(), "existing");
    assert_eq!(service.calls("createModel"), 1);
    assert_eq!(service.calls("addNote"), 0);
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "modelNamesAndIds" => response(json!({"Lapis":4})),
        "modelFieldNames" => response(json!(["Customized"])),
        _ => basic(request),
    });
    assert_eq!(
        create_lapis(&Preferences {
            port: service.port,
            ..Preferences::default()
        }),
        Err(AnkiError::Incompatible)
    );
    assert_eq!(service.calls("createModel"), 0);
}
#[test]
fn malformed_transport_is_safe_and_unavailable_service_is_typed() {
    for bytes in [
        b"bad".as_slice(),
        b"HTTP/1.1 302 Redirect\r\n\r\n{}",
        b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}",
    ] {
        assert_eq!(parse_response(bytes), Err(AnkiError::Protocol));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    assert_eq!(
        discover(&Preferences {
            port,
            ..Preferences::default()
        })
        .unwrap_err(),
        AnkiError::Unavailable
    );
}

#[test]
fn timeouts_are_uncertain_and_empty_reconciliation_never_resubmits() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "addNote" => {
            thread::sleep(Duration::from_millis(5200));
            response(json!(1234))
        }
        "findNotes" => response(json!([])),
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let req = request(prefs);
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    assert_eq!(
        check_note(&path, &req.request_id).unwrap(),
        NoteOutcome::Uncertain
    );
    assert_eq!(create_note(&path, &req).unwrap(), NoteOutcome::Uncertain);
    assert_eq!(service.calls("addNote"), 1);
}

#[test]
fn failed_lapis_creation_requires_discovery_and_retry_preserves_existing() {
    let mut exists = false;
    let service = Service::new(move |request| match request["action"].as_str().unwrap() {
        "modelNamesAndIds" => response(if exists {
            json!({"Lapis":4})
        } else {
            json!({})
        }),
        "modelFieldNames" => response(json!(lapis_fields())),
        "createModel" => {
            exists = true;
            json!({"result":null,"error":"interrupted after creation"})
        }
        _ => basic(request),
    });
    let prefs = Preferences {
        port: service.port,
        ..Preferences::default()
    };
    assert_eq!(create_lapis(&prefs).unwrap(), "uncertain");
    assert_eq!(create_lapis(&prefs).unwrap(), "existing");
    assert_eq!(service.calls("createModel"), 1);
}

#[test]
#[ignore = "Requires an explicitly configured local AnkiConnect; read-only discovery"]
fn real_local_anki_discovery() {
    let port = std::env::var("KOMORI_ANKI_TEST_PORT")
        .expect("Set an explicit loopback port")
        .parse()
        .unwrap();
    let discovery = discover(&Preferences {
        port,
        ..Preferences::default()
    })
    .unwrap();
    println!(
        "Real native discovery: {} decks, {} note types; Lapis {}",
        discovery.decks.len(),
        discovery.models.len(),
        discovery.lapis
    );
}

#[test]
fn same_name_replacements_are_rejected_before_creation() {
    let service = Service::new(|request| match request["action"].as_str().unwrap() {
        "deckNamesAndIds" => response(json!({"Study":10})),
        "modelNamesAndIds" => response(json!({"Basic":20})),
        _ => basic(request),
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    assert_eq!(create_note(&path, &request(prefs)), Err(AnkiError::Changed));
    assert_eq!(service.calls("addNote"), 0);
}

#[test]
fn configured_api_key_is_sent_only_to_loopback() {
    let service = Service::new(|request| {
        assert_eq!(request["key"], "test-key");
        response(json!(6))
    });
    assert_eq!(
        call(
            &Preferences {
                port: service.port,
                key: "test-key".into(),
                ..Preferences::default()
            },
            "version",
            json!({})
        )
        .unwrap(),
        json!(6)
    );
}

#[test]
fn batched_checks_authenticate_every_nested_action() {
    let service = Service::new(|request| {
        assert_eq!(request["key"], "test-key");
        let mut clean = request.clone();
        clean.as_object_mut().unwrap().remove("key");
        if clean["action"] == "multi" {
            let results = clean["params"]["actions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|action| {
                    assert_eq!(action["key"], "test-key");
                    let mut action = action.clone();
                    action.as_object_mut().unwrap().remove("key");
                    basic(&action)
                })
                .collect::<Vec<_>>();
            response(json!(results))
        } else {
            basic(&clean)
        }
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.key = "test-key".into();
    save(&path, &prefs).unwrap();
    assert_eq!(note_status(&path, &request(prefs)), Ok(NoteStatus::Missing));
    assert_eq!(service.calls("multi"), 1);
}

#[test]
fn concurrent_checks_initialize_the_journal_without_schema_races() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    connection(&path).unwrap();
    let gate = Arc::new(std::sync::Barrier::new(8));
    let workers = (0..8)
        .map(|_| {
            let path = path.clone();
            let gate = gate.clone();
            thread::spawn(move || {
                let connection = connection(&path).unwrap();
                gate.wait();
                journal(&connection)
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        assert_eq!(worker.join().unwrap(), Ok(()));
    }
    journal(&connection(&path).unwrap()).unwrap();
}

#[test]
fn frequency_tiers_are_card_tags_and_original_glossaries_reach_anki() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.mappings.get_mut("Basic").unwrap().tags = vec!["MiXeD".into(), "Tier_1".into()];
    prefs.mappings.get_mut("Basic").unwrap().tag_dictionaries = vec![42];
    save(&path, &prefs).unwrap();
    let mut req = request(load(&path).unwrap());
    req.dictionary_sources = vec![
        DictionaryTagSource {
            id: 42,
            title: "TMW".into(),
            values: Some(vec!["Tier 1".into(), "Tier 1".into(), "★".into()]),
        },
        DictionaryTagSource {
            id: 43,
            title: "Other".into(),
            values: Some(vec!["not selected".into()]),
        },
    ];
    req.fields.insert("Back".into(), "original".into());
    req.field_parts = BTreeMap::from([
        (
            "Front".into(),
            vec![FieldPart::Text {
                text: "読む".into(),
            }],
        ),
        (
            "Back".into(),
            vec![FieldPart::Definitions {
                entries: vec![DefinitionContent {
                    source: "Original".into(),
                    text: "original".into(),
                    glossary: Some(
                        json!([{"type":"structured-content","content":{"tag":"div","style":{"fontWeight":"bold"},"content":[{"tag":"ruby","content":["読",{"tag":"rt","content":"よ"}]},{"tag":"ul","content":{"tag":"li","content":"original"}}]}}]),
                    ),
                    presentation: None,
                }],
            }],
        ),
    ]);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    let log = service.log.lock().unwrap();
    let note = &log.iter().find(|r| r["action"] == "addNote").unwrap()["params"]["note"];
    let tags = note["tags"].as_array().unwrap();
    assert_eq!(&tags[..3], &[json!("mixed"), json!("tier_1"), json!("★")]);
    assert_eq!(tags.len(), 4);
    let back = note["fields"]["Back"].as_str().unwrap();
    assert!(back.contains("<ruby>読<rt>よ</rt></ruby>"));
    assert!(back.contains("<ul><li>original</li></ul>"));
    assert!(back.contains("font-weight:bold"));
    assert!(!back.contains("komori-definition"));
}

#[test]
fn popup_presentation_and_frequency_lists_survive_native_write_and_journal_replay() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let mut req = request(prefs);
    let sections = json!([[{"kind":"element","tag":"div","children":[
        {"kind":"element","tag":"ruby","children":[{"kind":"text","value":"読"},{"kind":"element","tag":"rt","reading":true,"children":[{"kind":"text","value":"よ"}]}]},
        {"kind":"text","value":"む。 "},
        {"kind":"element","tag":"div","presentation":"example-group","children":[
            {"kind":"element","tag":"div","presentation":"example-sentence","children":[{"kind":"text","value":"本を読む。"}]},
            {"kind":"element","tag":"div","presentation":"example-translation","children":[{"kind":"text","value":"Read a book."}]}
        ]},
        {"kind":"link","children":[{"kind":"text","value":"<&private>"}]}
    ]}], [{"kind":"text","value":"Second sense"}]]);
    let entry = DefinitionContent {
        source: "Dictionary".into(),
        text: "字".repeat(10000),
        glossary: None,
        presentation: Some(serde_json::from_value(sections.clone()).unwrap()),
    };
    req.fields.insert(
        "Back".into(),
        format!("{}BCCWJ: 637\nCC100: 5279\nTMW: Trainee", entry.text),
    );
    req.field_parts = BTreeMap::from([
        (
            "Front".into(),
            vec![FieldPart::Text {
                text: "読む".into(),
            }],
        ),
        (
            "Back".into(),
            vec![
                FieldPart::Definitions {
                    entries: vec![entry],
                },
                FieldPart::Frequencies {
                    text: "BCCWJ: 637\nCC100: 5279\nTMW: Trainee".into(),
                },
            ],
        ),
    ]);
    assert_eq!(note_status(&path, &req).unwrap(), NoteStatus::Missing);
    assert_eq!(
        create_note(&path, &req).unwrap(),
        NoteOutcome::Created { id: 1234 }
    );
    let log = service.log.lock().unwrap();
    let html = log.iter().find(|r| r["action"] == "addNote").unwrap()["params"]["note"]["fields"]
        ["Back"]
        .as_str()
        .unwrap();
    // Several glossary items become a list; nothing sets display or list markers inline.
    assert!(html.contains(
        "<li data-dictionary=\"Dictionary\"><i>(Dictionary)</i> <span><ul><li><div><ruby>読<rt style=\"opacity:.65;\">よ</rt></ruby>む。 "
    ));
    assert!(html.contains("<li>Second sense</li></ul></span></li>"));
    assert!(html.contains("<a>&lt;&amp;private&gt;</a>"));
    assert!(!html.contains("display:"));
    assert!(!html.contains("list-style"));
    assert!(html.contains("border-inline-start:1px solid currentColor"));
    assert!(html.contains("Read a book."));
    assert!(html.contains("&lt;&amp;private&gt;"));
    assert!(html.contains("<li>BCCWJ: 637</li><li>CC100: 5279</li><li>TMW: Trainee</li>"));
    assert!(html.contains("<ul class=\"komori-frequencies\""));
    assert!(!html.contains("href="));
    // Native accepts only known tags/roles and no arbitrary CSS/path attributes.
    assert!(serde_json::from_value::<presentation::Node>(
        json!({"kind":"element","tag":"script","children":[]})
    )
    .is_err());
    assert!(serde_json::from_value::<presentation::Node>(
        json!({"kind":"element","tag":"div","style":"color:red","children":[]})
    )
    .is_err());
    assert!(serde_json::from_value::<presentation::Node>(
        json!({"kind":"element","tag":"div","presentation":"foreign","children":[]})
    )
    .is_err());
    let serialized = serde_json::to_string(&req).unwrap();
    let replay: NoteRequest = serde_json::from_str(&serialized).unwrap();
    assert_eq!(
        formatted_fields(&replay, "", "").unwrap(),
        formatted_fields(&req, "", "").unwrap()
    );
    assert!(!presentation::valid(&vec![vec![]; 129]));
    assert!(!presentation::valid(&[vec![
        presentation::Node::Break;
        8193
    ]]));
    assert!(!presentation::valid(&[vec![presentation::Node::Text {
        value: "x".repeat(256 * 1024 + 1)
    }]]));
    let mut nested = presentation::Node::Break;
    for _ in 0..33 {
        nested = presentation::Node::Link {
            children: vec![nested],
            url: None,
        };
    }
    assert!(!presentation::valid(&[vec![nested]]));
}

#[test]
fn oversized_serialized_note_is_refused_before_writes_or_uncertain_journal() {
    let service = Service::new(basic);
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let mut prefs = prefs(service.port);
    prefs.duplicate_policy = DuplicatePolicy::Allow;
    save(&path, &prefs).unwrap();
    let mut req = request(prefs);
    // Each field's HTML just fits its own and the total bound; the request envelope does not.
    let entry = |text: String| DefinitionContent {
        source: "Dictionary".into(),
        text,
        glossary: None,
        presentation: None,
    };
    let lines = "$$$$$$$$$$
"
    .repeat(9600);
    let base = definition_html(&[entry(lines.clone())]).len();
    let entry = entry(format!("{lines}{}", "x".repeat(524_200 - base - 4)));
    assert_eq!(definition_html(std::slice::from_ref(&entry)).len(), 524_200);
    for name in ["Front", "Back"] {
        req.fields.insert(name.into(), entry.text.clone());
        req.field_parts.insert(
            name.into(),
            vec![FieldPart::Definitions {
                entries: vec![entry.clone()],
            }],
        );
    }
    assert!(formatted_fields(&req, "", "").is_ok());
    assert_eq!(create_note(&path, &req), Err(AnkiError::ContentTooLarge));
    for action in ["addNote", "updateNoteFields", "addTags", "storeMediaFile"] {
        assert_eq!(service.calls(action), 0);
    }
    assert_eq!(
        connection(&path)
            .unwrap()
            .query_row("SELECT count(*) FROM anki_requests", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
#[ignore = "Requires read-only real popup samples, saved Lapis preferences and local AnkiConnect; writes local HTML evidence only"]
fn real_popup_card_formatting_and_checks() {
    let database =
        std::env::var_os("KOMORI_LIBRARY_DATABASE").expect("set KOMORI_LIBRARY_DATABASE");
    let connection =
        Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let saved: String = connection
        .query_row("SELECT value FROM preferences WHERE name='anki'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let prefs: Preferences = serde_json::from_str(&saved).unwrap();
    let discovery = discover(&prefs).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/validation/0132-real-card-parts.json");
    let samples: Vec<Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut evidence = vec![];
    for sample in samples {
        let req: NoteRequest = serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(), "preferences":prefs, "fields":sample["fields"], "fieldParts":sample["fieldParts"], "dictionarySources":sample["dictionarySources"]})).unwrap();
        validate_note(&req, &prefs, &discovery).unwrap();
        let fields = formatted_fields(&req, "", "").unwrap();
        let start = Instant::now();
        let matches = duplicate_notes(&prefs, &fields[&discovery.fields[0]]).unwrap();
        let milliseconds = start.elapsed().as_millis();
        println!(
            "{} → {}: {} raw / {} rendered glossary bytes, check {} ms ({} matching notes)",
            sample["term"],
            req.fields[&discovery.fields[0]],
            req.fields["Glossary"].len(),
            fields["Glossary"].len(),
            milliseconds,
            matches.len()
        );
        assert!(!fields["Glossary"].contains("href="));
        assert!(
            fields["Frequency"].is_empty()
                || fields["Frequency"].contains("<ul class=\"komori-frequencies\"")
        );
        evidence.push(json!({"term":sample["term"], "fields":fields, "checkMs":milliseconds, "matches":matches.len()}));
    }
    std::fs::write(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/validation/0132-exported-fields.json"),
        serde_json::to_vec(&evidence).unwrap(),
    )
    .unwrap();
}

#[test]
fn checks_batch_configuration_and_bound_the_whole_network_operation() {
    // Configuration and the duplicate search share one request; it outlasts the deadline.
    let service = Service::new(|r| {
        if r["action"] == "multi" {
            thread::sleep(Duration::from_millis(5500));
        }
        basic(r)
    });
    let directory = tempdir().unwrap();
    let path = directory.path().join("catalog.sqlite3");
    let prefs = prefs(service.port);
    save(&path, &prefs).unwrap();
    let start = Instant::now();
    assert_eq!(
        note_status(&path, &request(prefs)),
        Err(AnkiError::Unavailable)
    );
    assert!(start.elapsed() < Duration::from_millis(5400));
    assert_eq!(service.calls("multi"), 1);
    assert_eq!(service.calls("version"), 0);
    assert_eq!(service.calls("modelFieldNames"), 0);
    assert_eq!(service.calls("addNote"), 0);
    assert_eq!(CHECK_DEADLINE.with(Cell::get), None);
}

#[test]
fn length_delimited_http_does_not_wait_for_connection_close() {
    let service = Service::with_hold(basic, Duration::from_secs(1));
    let start = Instant::now();
    assert_eq!(
        call(&prefs(service.port), "version", json!({})).unwrap(),
        json!(6)
    );
    assert!(start.elapsed() < Duration::from_millis(700));
    assert_eq!(
        response_length(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n0"),
        Err(AnkiError::Protocol)
    );
}

#[test]
#[ignore = "Requires a read-only original glossary sample; emits ignored formatting evidence"]
fn real_original_dictionary_glossary() {
    let input = std::env::var("KOMORI_ANKI_GLOSSARY_SAMPLE").expect("Set the sample JSON file");
    let entries: Vec<DefinitionContent> =
        serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    assert!(entries
        .iter()
        .all(|e| e.glossary.as_ref().is_some_and(glossary::valid)));
    let html = definition_html(&entries);
    assert!(html.contains("<ruby>"));
    assert!(html.contains("style=\""));
    assert!(html.contains("<ul>") || html.contains("<ol>"));
    assert!(!html.contains("komori-definition"));
    std::fs::write(Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/validation/0131-original-glossary.html"), format!("<!doctype html><meta charset=\"utf-8\"><title>Original dictionary export validation</title>{html}")).unwrap();
    println!(
        "Original imported entries rendered: {} sources, {} HTML bytes",
        entries.len(),
        html.len()
    );
}

#[test]
#[ignore = "Requires an explicit live catalog; read-only existing Anki card checks"]
fn real_local_anki_existing_checks() {
    let path = std::env::var("KOMORI_LIBRARY_DATABASE").expect("Set the live Komori catalog");
    // Do not migrate the live catalog, clean tags, write preferences or touch notes.
    let connection =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let saved: String = connection
        .query_row("SELECT value FROM preferences WHERE name='anki'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let prefs: Preferences = serde_json::from_str(&saved).unwrap();
    let discovery = discover(&prefs).unwrap();
    assert_eq!(discovery.fields, prefs.mappings[&prefs.model].fields);
    let ids = call(
        &prefs,
        "findNotes",
        json!({"query":query_term("note", &prefs.model)}),
    )
    .unwrap();
    let known = ids.as_array().unwrap().first().and_then(Value::as_i64);
    let text = if let Some(id) = known {
        let notes = call(&prefs, "notesInfo", json!({"notes":[id]})).unwrap();
        notes[0]["fields"][&discovery.fields[0]]["value"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        "読む".into()
    };
    for _ in 0..3 {
        let start = Instant::now();
        discover(&prefs).unwrap();
        let matches = duplicate_notes(&prefs, &text).unwrap();
        println!("Real read-only configuration + existence check: {} ms, {} matching notes, existing sample {}", start.elapsed().as_millis(), matches.len(), known.is_some_and(|id| matches.contains(&id)));
    }
}
