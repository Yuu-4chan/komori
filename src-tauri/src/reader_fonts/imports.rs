//! Imported fonts are immutable, content-addressed, Reader-owned copies. No source path crosses IPC.
use super::*;

const MAX_IMPORTED: usize = 128;
// User-selected local fonts can be larger than the curated Google downloads.
const MAX_IMPORTED_BYTES: usize = 100_000_000;
pub(super) fn clean_partial(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|_| "Font storage is unavailable.")? {
        let entry = entry.map_err(|_| "Font storage is unavailable.")?;
        if let Some(id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix("upload-"))
            .and_then(|name| name.strip_suffix(".partial"))
        {
            if valid_id(id) {
                clean_stage(&root.join(format!("upload-{id}.partial")))?;
            }
        }
    }
    Ok(())
}
pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn bytes(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("Unknown font.".into());
    }
    safe_directory(root)?;
    let dir = root.join(format!("upload-{id}"));
    safe_directory(&dir)?;
    let bytes = read_bounded(&dir.join("font.ttf"), MAX_IMPORTED_BYTES)?;
    if !verified(&bytes, id) {
        return Err("Invalid font file.".into());
    }
    Ok(bytes)
}
fn metadata(id: String, data: &[u8]) -> Result<DownloadedFont, String> {
    // Collections and compressed webfonts are not accepted; one sfnt face per owned file.
    if !data.starts_with(&[0, 1, 0, 0]) && !data.starts_with(b"OTTO") {
        return Err("Choose a TTF or OTF font.".into());
    }
    let face = ttf_parser::Face::parse(data, 0).map_err(|_| "Invalid font file.")?;
    let family = [16, 1]
        .into_iter()
        .find_map(|name_id| {
            face.names()
                .into_iter()
                .filter(|n| n.name_id == name_id)
                .filter_map(|n| n.to_string())
                .find(|name| valid_family(name))
        })
        .ok_or("This font has no usable family name.")?;
    let weight = face
        .variation_axes()
        .into_iter()
        .find(|a| a.tag == ttf_parser::Tag::from_bytes(b"wght"))
        .map(|a| {
            format!(
                "{} {}",
                a.min_value.round().clamp(1.0, 1000.0) as u16,
                a.max_value.round().clamp(1.0, 1000.0) as u16
            )
        })
        .unwrap_or_else(|| face.weight().to_number().to_string());
    Ok(DownloadedFont {
        url: Some(format!("http://komori-font.localhost/uploaded/{id}.ttf")),
        family_id: id.clone(),
        id,
        family,
        weight,
        source: "uploaded",
        style: if face.is_italic() { "italic" } else { "normal" }.into(),
        available: true,
    })
}
pub(super) fn list(root: &Path) -> Vec<DownloadedFont> {
    if safe_directory(root).is_err() {
        return vec![];
    }
    let Ok(entries) = fs::read_dir(root) else {
        return vec![];
    };
    let mut fonts: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_prefix("upload-")?;
            let data = bytes(root, id).ok()?;
            metadata(id.into(), &data).ok()
        })
        .take(MAX_IMPORTED)
        .collect();
    fonts.sort_by(|a, b| {
        a.family
            .cmp(&b.family)
            .then(a.weight.cmp(&b.weight))
            .then(a.id.cmp(&b.id))
    });
    fonts
}
fn import(root: &Path, data: &[u8]) -> Result<(), String> {
    safe_directory(root)?;
    if data.len() > MAX_IMPORTED_BYTES {
        return Err("Font is too large.".into());
    }
    let id = format!("{:x}", Sha256::digest(data));
    metadata(id.clone(), data)?;
    if bytes(root, &id).is_ok() {
        return Ok(());
    }
    if list(root).len() >= MAX_IMPORTED {
        return Err("The Reader font limit was reached.".into());
    }
    let stage = root.join(format!("upload-{id}.partial"));
    clean_stage(&stage)?;
    fs::create_dir(&stage).map_err(|_| "Could not save font.")?;
    let result = (|| {
        let mut file =
            fs::File::create(stage.join("font.ttf")).map_err(|_| "Could not save font.")?;
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save font.")?;
        drop(file);
        let target = root.join(format!("upload-{id}"));
        clean_stage(&target)?;
        fs::rename(&stage, target).map_err(|_| "Could not save font.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = clean_stage(&stage);
    }
    result
}
#[derive(Serialize)]
pub(crate) struct ImportResult {
    fonts: Vec<DownloadedFont>,
    failed: usize,
}
#[tauri::command]
pub(crate) async fn import_reader_fonts(app: tauri::AppHandle) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = rfd::FileDialog::new()
            .set_title("Add Reader fonts")
            .add_filter("Fonts", &["ttf", "otf"])
            .pick_files();
        let state = app.state::<FontState>();
        let _lock = state.write.lock().map_err(|_| "Font storage is busy.")?;
        let mut failed = 0;
        if let Some(paths) = paths {
            if paths.len() > MAX_IMPORTED {
                return Err("Choose at most 128 fonts.".into());
            }
            for path in paths {
                if read_bounded(&path, MAX_IMPORTED_BYTES)
                    .and_then(|data| import(&state.root, &data))
                    .is_err()
                {
                    failed += 1;
                }
            }
        }
        Ok(ImportResult {
            fonts: super::list(&state.root),
            failed,
        })
    })
    .await
    .map_err(|_| "Could not import fonts.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_bad_data_ids_and_paths_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("unrelated"), b"keep").unwrap();
        for data in [b"bad font".as_slice(), b"OTTOinvalid", b"ttcfcollection"] {
            assert!(import(root.path(), data).is_err());
        }
        for id in ["../font", "", "abc", &"F".repeat(64)] {
            assert!(bytes(root.path(), id).is_err());
        }
        assert!(list(root.path()).is_empty());
        assert_eq!(fs::read(root.path().join("unrelated")).unwrap(), b"keep");
    }
    #[test]
    fn refuses_sources_over_one_hundred_mb_before_reading_or_publishing() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("oversized.ttf");
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_IMPORTED_BYTES as u64 + 1)
            .unwrap();
        assert!(read_bounded(&source, MAX_IMPORTED_BYTES).is_err());
        assert!(list(root.path()).is_empty());
        assert_eq!(fs::metadata(source).unwrap().len(), 100_000_001);
    }
    #[cfg(windows)]
    #[test]
    fn imports_and_serves_a_valid_font_larger_than_the_old_download_cap() {
        let root = tempfile::tempdir().unwrap();
        let mut data = fs::read("C:/Windows/Fonts/arial.ttf").unwrap();
        // Valid sfnt tables with trailing padding exercise the whole large-file path.
        data.resize(34 * 1024 * 1024, 0);
        import(root.path(), &data).unwrap();
        let fonts = list(root.path());
        assert_eq!(fonts.len(), 1);
        assert_eq!(bytes(root.path(), &fonts[0].id).unwrap(), data);
    }
    #[cfg(windows)]
    #[test]
    fn imports_reopens_deduplicates_serves_and_removes_a_real_font_read_only() {
        let root = tempfile::tempdir().unwrap();
        let source = Path::new("C:/Windows/Fonts/arial.ttf");
        let original = fs::read(source).unwrap();
        import(root.path(), &original).unwrap();
        import(root.path(), &original).unwrap();
        let fonts = list(root.path());
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].family, "Arial");
        assert_eq!(fonts[0].weight, "400");
        let request = Request::builder()
            .uri(format!("/uploaded/{}.ttf", fonts[0].id))
            .body(vec![])
            .unwrap();
        assert_eq!(
            super::super::handle_request(root.path(), &request).body(),
            &original
        );
        assert_eq!(fs::read(source).unwrap(), original);
        clean_stage(&root.path().join(format!("upload-{}", fonts[0].id))).unwrap();
        assert!(list(root.path()).is_empty());
        import(root.path(), &original).unwrap();
        fs::write(
            root.path()
                .join(format!("upload-{}", fonts[0].id))
                .join("font.ttf"),
            b"corrupt",
        )
        .unwrap();
        assert!(list(root.path()).is_empty());
        import(root.path(), &original).unwrap();
        assert_eq!(list(root.path()).len(), 1);
    }
}
