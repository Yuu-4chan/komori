//! Reader-only font choices and a fixed, integrity-pinned Google Fonts collection, a few of
//! whose files come with the installer. No caller supplies a URL or path. Fonts are never
//! installed into Windows.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    http::{Method, Request, Response, StatusCode},
    Emitter, Manager, State, UriSchemeContext, UriSchemeResponder, Wry,
};

const COMMIT: &str = "9710da1eacb3be272583c3224dcb70f9da6eadbb";
const MAX_BYTES: usize = 32 * 1024 * 1024;
const PRESETS: [&str; 13] = [
    "yu-mincho",
    "noto-serif-jp",
    "noto-serif-sc",
    "noto-serif-kr",
    "georgia",
    "serif",
    "segoe-ui",
    "yu-gothic",
    "noto-sans-jp",
    "noto-sans-sc",
    "noto-sans-kr",
    "inter",
    "sans-serif",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum FontChoice {
    Preset { id: String },
    System { family: String },
    Google { id: String },
    Uploaded { id: String },
}
impl FontChoice {
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Preset { id } => PRESETS.contains(&id.as_str()),
            Self::System { family } => valid_family(family),
            Self::Google { id } => FONTS.iter().any(|f| &f.family_id == id),
            Self::Uploaded { id } => imports::valid_id(id),
        }
    }
    pub(crate) fn from_stored(
        value: Option<&serde_json::Value>,
        legacy: Option<&str>,
    ) -> Option<Self> {
        // An explicitly invalid new field does not silently resurrect a retired choice.
        if let Some(value) = value {
            return serde_json::from_value::<Self>(value.clone())
                .ok()
                .filter(Self::valid);
        }
        legacy
            .map(|id| Self::Preset { id: id.into() })
            .filter(Self::valid)
    }
}

/// A single family name, never CSS, a URL or a path. Quoting happens only in the adapter.
pub(crate) fn valid_family(family: &str) -> bool {
    !family.is_empty()
        && family.trim() == family
        && family.chars().count() <= 128
        && family.chars().all(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\\' | '/'
                        | ':'
                        | ';'
                        | '{'
                        | '}'
                        | '<'
                        | '>'
                        | '"'
                        | '\''
                        | '('
                        | ')'
                        | ','
                        | '@'
                )
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Font {
    id: String,
    family_id: String,
    family: String,
    weight: String,
    path: String,
    hash: String,
    license_hash: String,
    size: usize,
    /// The installer includes this file, so it is available without a download.
    #[serde(default)]
    bundled: bool,
}
#[derive(Deserialize)]
struct Catalog {
    commit: String,
    fonts: Vec<Font>,
}
static FONTS: std::sync::LazyLock<Vec<Font>> = std::sync::LazyLock::new(|| {
    let catalog: Catalog = serde_json::from_str(include_str!(
        "../../src/features/reader/googleFontCatalog.json"
    ))
    .expect("Owned font catalog");
    assert_eq!(catalog.commit, COMMIT);
    catalog.fonts
});
pub(crate) mod imports;
fn font(id: &str) -> Option<&'static Font> {
    FONTS.iter().find(|f| f.id == id)
}

pub(crate) struct FontState {
    root: PathBuf,
    /// Where the installer's fonts are, laid out as downloads are, read-only.
    bundled: Vec<PathBuf>,
    write: Mutex<()>,
}
impl FontState {
    fn list(&self) -> Vec<DownloadedFont> {
        list(&self.root, &self.bundled)
    }
}
/// The folders that may hold the installer's fonts: beside the executable, and in a development
/// build the folder the build fetches them into. On Android they are among the APK's assets.
#[cfg(target_os = "android")]
fn bundled_roots(_: &tauri::AppHandle) -> Vec<PathBuf> {
    vec![PathBuf::from("reader-fonts")]
}
#[cfg(not(target_os = "android"))]
fn bundled_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("reader-fonts"))
        .into_iter()
        .collect();
    if cfg!(debug_assertions) {
        roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts"));
    }
    roots
}
pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<FontState, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Font storage is unavailable.")?
        .join("reader-fonts");
    fs::create_dir_all(&root).map_err(|_| "Font storage is unavailable.")?;
    safe_directory(&root)?;
    // Only the fixed staging names are cleaned up after a interrupted download.
    for f in FONTS.iter() {
        clean_stage(&root.join(format!("{}.partial", f.id)))?;
    }
    imports::clean_partial(&root)?;
    Ok(FontState {
        root,
        bundled: bundled_roots(app),
        write: Mutex::new(()),
    })
}
fn safe_directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Font storage is unavailable.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Font storage is unavailable.".into());
        }
    }
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Font storage is unavailable.".into());
    }
    Ok(())
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Font file is unavailable.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Invalid font file.".into());
        }
    }
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > limit as u64 {
        return Err("Invalid font file.".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Font file is unavailable.")?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Font file is unavailable.")?;
    if bytes.len() > limit {
        return Err("Invalid font file.".into());
    }
    Ok(bytes)
}
fn verified(bytes: &[u8], hash: &str) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == hash
}
fn installed_bytes(root: &Path, f: &Font) -> Result<Vec<u8>, String> {
    safe_directory(root)?;
    let dir = root.join(&f.id);
    safe_directory(&dir)?;
    checked(f, |name, limit| read_bounded(&dir.join(name), limit))
}
/// The font's file, when it and its license, read by `read`, are the catalog's.
fn checked(
    f: &Font,
    read: impl Fn(&str, usize) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let license = read("OFL.txt", 16384)?;
    let bytes = read("font.ttf", MAX_BYTES)?;
    if bytes.len() != f.size || !verified(&bytes, &f.hash) || !verified(&license, &f.license_hash) {
        return Err("Font files failed verification. Download again.".into());
    }
    Ok(bytes)
}
/// An included font from the installer, verified like a download.
fn bundled_bytes(roots: &[PathBuf], f: &Font) -> Option<Vec<u8>> {
    if !f.bundled {
        return None;
    }
    roots.iter().find_map(|root| {
        #[cfg(target_os = "android")]
        return checked(f, |name, limit| {
            crate::android::read_asset(&root.join(&f.id).join(name), limit)
                .map_err(|_| "Font file is unavailable.".to_owned())
        })
        .ok();
        #[cfg(not(target_os = "android"))]
        installed_bytes(root, f).ok()
    })
}
fn clean_stage(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    safe_directory(dir)?;
    for name in ["font.ttf", "OFL.txt"] {
        let path = dir.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|_| "Could not remove font files.")?;
        }
    }
    fs::remove_dir(dir).map_err(|_| "Could not remove font files.".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedFont {
    id: String,
    family: String,
    family_id: String,
    weight: String,
    source: &'static str,
    style: String,
    available: bool,
    /// Included with Komori: available without a download, and never removed.
    bundled: bool,
    url: Option<String>,
}
fn list(root: &Path, bundled: &[PathBuf]) -> Vec<DownloadedFont> {
    FONTS
        .iter()
        .map(|f| {
            let included = bundled_bytes(bundled, f).is_some();
            let available = included || installed_bytes(root, f).is_ok();
            let scheme = if cfg!(any(windows, target_os = "android")) {
                "http://komori-font.localhost"
            } else {
                "komori-font://localhost"
            };
            DownloadedFont {
                id: f.id.clone(),
                family: f.family.clone(),
                family_id: f.family_id.clone(),
                weight: f
                    .weight
                    .split_whitespace()
                    .map(|w| w.parse::<f32>().unwrap() as u16)
                    .map(|w| w.to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
                source: "google",
                style: "normal".into(),
                available,
                bundled: included,
                url: available.then(|| format!("{scheme}/{}/{}.ttf", f.id, f.hash)),
            }
        })
        .chain(imports::list(root))
        .collect()
}
#[tauri::command]
pub(crate) async fn list_reader_fonts(
    state: State<'_, FontState>,
) -> Result<Vec<DownloadedFont>, String> {
    let (root, bundled) = (state.root.clone(), state.bundled.clone());
    tauri::async_runtime::spawn_blocking(move || list(&root, &bundled))
        .await
        .map_err(|_| "Could not list fonts.".into())
}

#[derive(Serialize)]
pub(crate) struct SystemFont {
    family: String,
    available: bool,
    faces: Vec<SystemFace>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemFace {
    family: String,
    name: String,
    weight: i32,
    style: &'static str,
}
#[tauri::command]
pub(crate) async fn check_system_font(family: String) -> Result<SystemFont, String> {
    if !valid_family(&family) {
        return Err("Enter a font family name, without CSS or a path.".into());
    }
    tauri::async_runtime::spawn_blocking(move || SystemFont {
        available: system_available(&family),
        faces: system_faces(&family),
        family,
    })
    .await
    .map_err(|_| "Could not check this font.".into())
}
#[cfg(windows)]
fn system_faces(family: &str) -> Vec<SystemFace> {
    use windows_sys::Win32::Graphics::Gdi::*;
    unsafe extern "system" fn found(
        log: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        data: isize,
    ) -> i32 {
        let (family, faces) = &mut *(data as *mut (String, Vec<SystemFace>));
        let font = &*(log as *const ENUMLOGFONTEXW);
        let decode = |name: &[u16]| {
            String::from_utf16_lossy(
                &name[..name.iter().position(|&v| v == 0).unwrap_or(name.len())],
            )
        };
        let name = decode(&font.elfFullName);
        if decode(&font.elfLogFont.lfFaceName).eq_ignore_ascii_case(family)
            && valid_family(&name)
            && (1..=1000).contains(&font.elfLogFont.lfWeight)
        {
            faces.push(SystemFace {
                family: family.clone(),
                name,
                weight: font.elfLogFont.lfWeight,
                style: if font.elfLogFont.lfItalic == 0 {
                    "normal"
                } else {
                    "italic"
                },
            });
        }
        1
    }
    let mut result = (family.to_owned(), Vec::new());
    unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return result.1;
        }
        let mut log: LOGFONTW = std::mem::zeroed();
        log.lfCharSet = DEFAULT_CHARSET;
        let name: Vec<u16> = family.encode_utf16().collect();
        if name.len() >= log.lfFaceName.len() {
            DeleteDC(dc);
            return result.1;
        }
        log.lfFaceName[..name.len()].copy_from_slice(&name);
        EnumFontFamiliesExW(dc, &log, Some(found), &mut result as *mut _ as isize, 0);
        DeleteDC(dc);
    }
    result.1.sort_by(|a, b| a.name.cmp(&b.name));
    result.1.dedup_by(|a, b| a.name == b.name);
    result.1
}
#[cfg(not(windows))]
fn system_faces(_: &str) -> Vec<SystemFace> {
    Vec::new()
}
/// The font families installed on this computer, sorted and without duplicates, so the Reader
/// can offer them by name. Only names a Reader font choice accepts are listed.
#[tauri::command]
pub(crate) async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut families: Vec<String> = system_families()
            .into_iter()
            .filter(|family| valid_family(family))
            .collect();
        families.sort_by_key(|family| family.to_lowercase());
        families.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        families
    })
    .await
    .map_err(|_| "Could not list this computer's fonts.".into())
}
#[cfg(windows)]
fn system_families() -> Vec<String> {
    use windows_sys::Win32::Graphics::Gdi::*;
    unsafe extern "system" fn found(
        log: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        data: isize,
    ) -> i32 {
        let families = &mut *(data as *mut Vec<String>);
        let name = &(*log).lfFaceName;
        let end = name.iter().position(|&v| v == 0).unwrap_or(name.len());
        let family = String::from_utf16_lossy(&name[..end]);
        // `@` names are the vertical-writing aliases of the same families.
        if !family.is_empty() && !family.starts_with('@') {
            families.push(family);
        }
        1
    }
    let mut families = Vec::new();
    unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return families;
        }
        let mut log: LOGFONTW = std::mem::zeroed();
        log.lfCharSet = DEFAULT_CHARSET;
        EnumFontFamiliesExW(dc, &log, Some(found), &mut families as *mut _ as isize, 0);
        DeleteDC(dc);
    }
    families
}
#[cfg(not(windows))]
fn system_families() -> Vec<String> {
    Vec::new()
}
#[cfg(windows)]
fn system_available(family: &str) -> bool {
    use windows_sys::Win32::Graphics::Gdi::*;
    struct Probe {
        name: String,
        found: bool,
    }
    unsafe extern "system" fn found(
        log: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        data: isize,
    ) -> i32 {
        let probe = &mut *(data as *mut Probe);
        let name = &(*log).lfFaceName;
        let end = name.iter().position(|&v| v == 0).unwrap_or(name.len());
        if String::from_utf16_lossy(&name[..end]).to_lowercase() == probe.name {
            probe.found = true;
            return 0;
        }
        1
    }
    let mut probe = Probe {
        name: family.to_lowercase(),
        found: false,
    };
    unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return false;
        }
        let mut log: LOGFONTW = std::mem::zeroed();
        log.lfCharSet = DEFAULT_CHARSET;
        EnumFontFamiliesExW(dc, &log, Some(found), &mut probe as *mut _ as isize, 0);
        DeleteDC(dc);
    }
    probe.found
}
#[cfg(not(windows))]
fn system_available(_: &str) -> bool {
    false
}

/// The kana a Japanese book needs all of; its kanji are in the book's counted text.
const KANA_SAMPLE: &str = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコ";
/// Common Hangul, as a Korean book needs all of it; its hanja are in the book's counted text.
const HANGUL_SAMPLE: &str = "가나다라마바사아자차카타파하한글은는이을를에의고로";
/// Stand-ins for a Chinese book's text before it has been counted.
const SIMPLIFIED_SAMPLE: &str = "这们说对时过还进发经问见从现开关门国会学书东车";
const TRADITIONAL_SAMPLE: &str = "這們說對時過還進發經問見從現開關門國會學書東車";

/// Whether a font has what a book's text needs: for a Chinese, Japanese or Korean book, its kana
/// or Hangul and all but a few rare ones of its distinct Han characters. Others are always fit.
fn covers_language(language: &str, han: &str, has: impl Fn(&[char]) -> Vec<bool>) -> bool {
    let (all, most): (&str, &str) = match language {
        "ko" => (HANGUL_SAMPLE, han),
        "ja" => (KANA_SAMPLE, han),
        "zh-Hant" => (
            "",
            if han.is_empty() {
                TRADITIONAL_SAMPLE
            } else {
                han
            },
        ),
        "zh" | "zh-Hans" => (
            "",
            if han.is_empty() {
                SIMPLIFIED_SAMPLE
            } else {
                han
            },
        ),
        _ => return true,
    };
    let all: Vec<char> = all.chars().collect();
    let most: Vec<char> = most.chars().collect();
    let found = has(&most).iter().filter(|found| **found).count();
    has(&all).iter().all(|found| *found) && found * 100 >= most.len() * 99
}

/// Which of these characters a font has; none when it can't be read.
fn font_has(root: &Path, bundled: &[PathBuf], font: &FontChoice, chars: &[char]) -> Vec<bool> {
    let in_file = |bytes: Option<Vec<u8>>| {
        let parsed = bytes
            .as_deref()
            .and_then(|data| ttf_parser::Face::parse(data, 0).ok());
        chars
            .iter()
            .map(|c| {
                parsed
                    .as_ref()
                    .is_some_and(|face| face.glyph_index(*c).is_some())
            })
            .collect()
    };
    match font {
        FontChoice::Preset { id } => match preset_family(id) {
            Some(family) => system_has(family, chars),
            None => vec![false; chars.len()],
        },
        FontChoice::System { family } => system_has(family, chars),
        FontChoice::Google { id } => in_file(
            FONTS
                .iter()
                .filter(|f| &f.family_id == id)
                .find_map(|f| bundled_bytes(bundled, f).or_else(|| installed_bytes(root, f).ok())),
        ),
        FontChoice::Uploaded { id } => in_file(imports::bytes(root, id).ok()),
    }
}

/// The installed family a preset names; generic and Latin-only presets name none to check.
fn preset_family(id: &str) -> Option<&'static str> {
    match id {
        "yu-mincho" => Some("Yu Mincho"),
        "yu-gothic" => Some("Yu Gothic"),
        "noto-serif-jp" => Some("Noto Serif JP"),
        "noto-sans-jp" => Some("Noto Sans JP"),
        "noto-serif-sc" => Some("Noto Serif SC"),
        "noto-sans-sc" => Some("Noto Sans SC"),
        "noto-serif-kr" => Some("Noto Serif KR"),
        "noto-sans-kr" => Some("Noto Sans KR"),
        _ => None,
    }
}

#[cfg(windows)]
fn system_has(family: &str, chars: &[char]) -> Vec<bool> {
    use windows_sys::Win32::Graphics::Gdi::*;
    let mut found = vec![false; chars.len()];
    if chars.is_empty() || !system_available(family) {
        return found;
    }
    let text: Vec<u16> = chars
        .iter()
        .map(|c| u16::try_from(*c as u32).unwrap_or(0xFFFD))
        .collect();
    let mut glyphs = vec![0u16; text.len()];
    // SAFETY: the context and font are created and released here, and both buffers hold
    // `text.len()` units.
    unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return found;
        }
        let mut log: LOGFONTW = std::mem::zeroed();
        log.lfCharSet = DEFAULT_CHARSET;
        for (to, from) in log
            .lfFaceName
            .iter_mut()
            .zip(family.encode_utf16().take(31))
        {
            *to = from;
        }
        let font = CreateFontIndirectW(&log);
        if !font.is_null() {
            let before = SelectObject(dc, font as _);
            let read = GetGlyphIndicesW(
                dc,
                text.as_ptr(),
                text.len() as i32,
                glyphs.as_mut_ptr(),
                GGI_MARK_NONEXISTING_GLYPHS,
            );
            if read != u32::MAX {
                for ((found, glyph), unit) in found.iter_mut().zip(&glyphs).zip(&text) {
                    *found = *glyph != 0xFFFF && *unit != 0xFFFD;
                }
            }
            SelectObject(dc, before);
            DeleteObject(font as _);
        }
        DeleteDC(dc);
    }
    found
}
#[cfg(not(windows))]
fn system_has(_: &str, chars: &[char]) -> Vec<bool> {
    vec![false; chars.len()]
}

/// Whether a font has what this book's text needs; the Reader replaces one that doesn't.
#[tauri::command]
pub(crate) async fn font_supports_book(
    font: FontChoice,
    book_id: String,
    fonts: State<'_, FontState>,
    catalog: State<'_, crate::library::CatalogState>,
) -> Result<bool, String> {
    if !font.valid() {
        return Err("Unknown font.".into());
    }
    let (root, bundled) = (fonts.root.clone(), fonts.bundled.clone());
    let database = catalog.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = crate::library::open_catalog(&database)?;
        let (language, han) = connection
            .query_row(
                "SELECT language, kanji FROM book_details WHERE book_id = ?1",
                [&book_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .unwrap_or((None, None));
        Ok(covers_language(
            language.as_deref().unwrap_or_default(),
            han.as_deref().unwrap_or_default(),
            |chars| font_has(&root, &bundled, &font, chars),
        ))
    })
    .await
    .map_err(|_| "Could not check this font.".to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    operation_id: String,
    id: String,
    completed: usize,
    total: usize,
}

#[tauri::command]
pub(crate) async fn download_reader_font(
    app: tauri::AppHandle,
    id: String,
    operation_id: String,
) -> Result<Vec<DownloadedFont>, String> {
    let f = font(&id).ok_or("Unknown font.")?;
    if uuid::Uuid::parse_str(&operation_id).is_err() {
        return Err("Invalid operation ID.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FontState>();
        let _lock = state.write.lock().map_err(|_| "Font storage is busy.")?;
        if bundled_bytes(&state.bundled, f).is_some() {
            return Ok(state.list());
        }
        download(
            &state.root,
            f,
            |completed| {
                let _ = app.emit_to(
                    "main",
                    "reader-font-progress",
                    Progress {
                        operation_id: operation_id.clone(),
                        id: id.clone(),
                        completed,
                        total: f.size,
                    },
                );
            },
            fetch,
        )?;
        Ok(state.list())
    })
    .await
    .map_err(|_| "Font download failed.".to_string())?
}
fn download(
    root: &Path,
    f: &Font,
    progress: impl Fn(usize),
    get: impl Fn(&str, usize, &dyn Fn(usize)) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    safe_directory(root)?;
    if installed_bytes(root, f).is_ok() {
        progress(f.size);
        return Ok(());
    }
    let stage = root.join(format!("{}.partial", f.id));
    clean_stage(&stage)?;
    fs::create_dir(&stage).map_err(|_| "Could not save font.")?;
    let result = (|| {
        progress(0);
        let bytes = get(
            &format!("/google/fonts/{COMMIT}/{}", f.path),
            MAX_BYTES,
            &progress,
        )?;
        if bytes.len() != f.size || !verified(&bytes, &f.hash) {
            return Err("Font download failed verification. Retry the download.".into());
        }
        let folder = f.path.rsplit_once('/').unwrap().0;
        let license = get(
            &format!("/google/fonts/{COMMIT}/{folder}/OFL.txt"),
            16384,
            &|_| {},
        )?;
        if !verified(&license, &f.license_hash) {
            return Err("Font license failed verification. Retry the download.".into());
        }
        for (name, data) in [("font.ttf", bytes), ("OFL.txt", license)] {
            let mut file =
                fs::File::create(stage.join(name)).map_err(|_| "Could not save font.")?;
            file.write_all(&data)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Could not save font.")?;
        }
        let target = root.join(&f.id);
        clean_stage(&target)?; // Repair a corrupt owned download, never a caller-provided path.
        fs::rename(&stage, target).map_err(|_| "Could not save font.")?;
        progress(f.size);
        Ok(())
    })();
    if result.is_err() {
        let _ = clean_stage(&stage);
    }
    result
}
#[tauri::command]
pub(crate) async fn remove_reader_font(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<DownloadedFont>, String> {
    if font(&id).is_none() && !imports::valid_id(&id) {
        return Err("Unknown font.".into());
    }
    if font(&id).is_some_and(|f| f.bundled) {
        return Err("Fonts included with Komori cannot be removed.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FontState>();
        let _lock = state.write.lock().map_err(|_| "Font storage is busy.")?;
        safe_directory(&state.root)?;
        let directory = if imports::valid_id(&id) {
            format!("upload-{id}")
        } else {
            id
        };
        clean_stage(&state.root.join(directory))?;
        Ok(state.list())
    })
    .await
    .map_err(|_| "Could not remove font.".to_string())?
}

/// WinHTTP owns HTTPS/TLS, fixed host, bounded reads, timeouts and no redirects.
#[cfg(windows)]
fn fetch(path: &str, limit: usize, progress: &dyn Fn(usize)) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Networking::WinHttp::*;
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    let error = || "Could not download font. Check your connection and retry.".to_string();
    unsafe {
        let session = Handle(WinHttpOpen(
            wide("Komori Reader Fonts").as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() {
            return Err(error());
        }
        if WinHttpSetTimeouts(session.0, 10000, 10000, 15000, 15000) == 0 {
            return Err(error());
        }
        let connection = Handle(WinHttpConnect(
            session.0,
            wide("raw.githubusercontent.com").as_ptr(),
            443,
            0,
        ));
        if connection.0.is_null() {
            return Err(error());
        }
        let request = Handle(WinHttpOpenRequest(
            connection.0,
            wide("GET").as_ptr(),
            wide(path).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        if request.0.is_null() {
            return Err(error());
        }
        let redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        if WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            &redirects as *const _ as *const c_void,
            std::mem::size_of_val(&redirects) as u32,
        ) == 0
        {
            return Err(error());
        }
        if WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0) == 0
            || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0
        {
            return Err(error());
        }
        let mut status: u32 = 0;
        let mut size = 4;
        if WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            &mut status as *mut _ as *mut c_void,
            &mut size,
            std::ptr::null_mut(),
        ) == 0
            || status != 200
        {
            return Err(error());
        }
        let mut result = Vec::new();
        let started = std::time::Instant::now();
        loop {
            if started.elapsed().as_secs() > 90 {
                return Err(error());
            }
            let mut buffer = [0u8; 32768];
            let mut read = 0;
            if WinHttpReadData(
                request.0,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut read,
            ) == 0
            {
                return Err(error());
            }
            if read == 0 {
                break;
            }
            if result.len() + read as usize > limit {
                return Err("Font download exceeded its size limit.".into());
            }
            result.extend_from_slice(&buffer[..read as usize]);
            progress(result.len());
        }
        Ok(result)
    }
}
/// Elsewhere, as on the phone, the same fixed host, limits, timeouts and no redirects through
/// Komori's HTTP client.
#[cfg(not(windows))]
fn fetch(path: &str, limit: usize, progress: &dyn Fn(usize)) -> Result<Vec<u8>, String> {
    use reqwest::{redirect::Policy, StatusCode};
    use std::time::{Duration, Instant};
    let error = || "Could not download font. Check your connection and retry.".to_string();
    let client = crate::http::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .build()
        .map_err(|_| error())?;
    let started = Instant::now();
    tauri::async_runtime::block_on(async {
        let mut response = client
            .get(format!("https://raw.githubusercontent.com{path}"))
            .send()
            .await
            .map_err(|_| error())?;
        if response.status() != StatusCode::OK {
            return Err(error());
        }
        let mut result = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| error())? {
            if started.elapsed().as_secs() > 90 {
                return Err(error());
            }
            if result.len() + chunk.len() > limit {
                return Err("Font download exceeded its size limit.".into());
            }
            result.extend_from_slice(&chunk);
            progress(result.len());
        }
        Ok(result)
    })
}

pub(crate) fn serve_font(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(response(StatusCode::FORBIDDEN, Vec::new()));
        return;
    }
    let state = context.app_handle().state::<FontState>();
    let (root, bundled) = (state.root.clone(), state.bundled.clone());
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(handle_request(&root, &bundled, &request))
    });
}
fn handle_request(
    root: &Path,
    bundled: &[PathBuf],
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return response(StatusCode::METHOD_NOT_ALLOWED, Vec::new());
    }
    let found = FONTS
        .iter()
        .find(|f| request.uri().path() == format!("/{}/{}.ttf", f.id, f.hash));
    let uploaded = request
        .uri()
        .path()
        .strip_prefix("/uploaded/")
        .and_then(|p| p.strip_suffix(".ttf"))
        .filter(|id| imports::valid_id(id))
        .and_then(|id| imports::bytes(root, id).ok());
    let bytes = found
        .filter(|_| request.uri().query().is_none())
        .and_then(|f| bundled_bytes(bundled, f).or_else(|| installed_bytes(root, f).ok()))
        .or_else(|| {
            request
                .uri()
                .query()
                .is_none()
                .then_some(uploaded)
                .flatten()
        });
    match bytes {
        Some(bytes) => response(StatusCode::OK, bytes),
        None => response(StatusCode::NOT_FOUND, Vec::new()),
    }
}
fn response(status: StatusCode, bytes: Vec<u8>) -> Response<Vec<u8>> {
    // Every font URL names the SHA-256 of the only bytes it serves, so a served font never
    // changes: each section of a book reuses it instead of fetching it again. A font not
    // found may be downloaded later.
    let cache = if status == StatusCode::OK {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    Response::builder()
        .status(status)
        .header("Content-Type", "font/ttf")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .expect("Static font response")
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_font_fits_a_book_by_the_characters_its_text_needs() {
        let having = |text: &'static str| {
            move |chars: &[char]| chars.iter().map(|c| text.contains(*c)).collect::<Vec<_>>()
        };
        // Korean needs its Hangul, whatever else the font has.
        assert!(super::covers_language(
            "ko",
            "",
            having(super::HANGUL_SAMPLE)
        ));
        assert!(!super::covers_language("ko", "", having("かな漢字")));
        // Chinese is measured on the book's own characters, and a rare one or two may be missing.
        let han: String = (0..200u32)
            .filter_map(|n| char::from_u32(0x4E00 + n))
            .collect();
        let most: String = han.chars().skip(2).collect();
        let less: String = han.chars().skip(3).collect();
        let leak = |text: String| -> &'static str { Box::leak(text.into_boxed_str()) };
        assert!(super::covers_language("zh-Hant", &han, having(leak(most))));
        assert!(!super::covers_language("zh-Hant", &han, having(leak(less))));
        // A book not counted yet is measured on common characters of its script.
        assert!(super::covers_language(
            "zh-Hans",
            "",
            having(super::SIMPLIFIED_SAMPLE)
        ));
        assert!(!super::covers_language(
            "zh-Hans",
            "",
            having(super::TRADITIONAL_SAMPLE)
        ));
        // Japanese needs its kana and kanji.
        assert!(super::covers_language(
            "ja",
            "漢",
            having(leak(format!("{}漢", super::KANA_SAMPLE)))
        ));
        assert!(!super::covers_language(
            "ja",
            "漢",
            having(super::HANGUL_SAMPLE)
        ));
        // Other books keep any font.
        assert!(super::covers_language("fr", "", having("")));
        assert!(super::covers_language("", "", having("")));
    }

    use super::*;
    #[cfg(windows)]
    #[test]
    #[ignore = "Downloads pinned Google Fonts into a temporary directory"]
    fn real_reader_font_weights() {
        let root = tempfile::tempdir().unwrap();
        for id in [
            "klee-one",
            "klee-one-600",
            "zen-old-mincho-700",
            "noto-serif-jp",
            "lora",
        ] {
            let f = font(id).unwrap();
            download(root.path(), f, |_| {}, fetch).unwrap();
            let data = installed_bytes(root.path(), f).unwrap();
            let face = ttf_parser::Face::parse(&data, 0).unwrap();
            assert!(face.number_of_glyphs() > 0);
            if f.weight.contains(' ') {
                assert!(face.is_variable());
            } else {
                assert_eq!(face.weight().to_number().to_string(), f.weight);
            }
            assert!(list(root.path(), &[])
                .iter()
                .any(|font| font.id == id && font.available));
            clean_stage(&root.path().join(id)).unwrap();
            assert!(
                !list(root.path(), &[])
                    .iter()
                    .find(|font| font.id == id)
                    .unwrap()
                    .available
            );
            download(root.path(), f, |_| {}, fetch).unwrap();
        }
    }

    #[test]
    fn catalog_has_unique_bounded_files_and_every_selectable_family() {
        let mut ids = std::collections::HashSet::new();
        for f in FONTS.iter() {
            assert!(ids.insert(&f.id));
            assert!(f.size <= MAX_BYTES);
            assert!(valid_family(&f.family));
            assert!(f.path.starts_with("ofl/") && !f.path.contains(".."));
            assert!(imports::valid_id(&f.hash) && imports::valid_id(&f.license_hash));
            assert!(FONTS.iter().any(|regular| regular.id == f.family_id));
        }
    }
    #[test]
    fn the_installer_includes_one_regular_file_of_each_starter_family() {
        let bundled: Vec<&str> = FONTS
            .iter()
            .filter(|f| f.bundled)
            .map(|f| f.id.as_str())
            .collect();
        assert_eq!(
            bundled,
            [
                "zen-old-mincho",
                "klee-one",
                "noto-sans-jp",
                "noto-sans-sc",
                "noto-sans-kr"
            ]
        );
        assert!(FONTS
            .iter()
            .filter(|f| f.bundled)
            .all(|f| f.id == f.family_id));
    }
    #[test]
    fn included_fonts_are_verified_served_and_listed_without_a_download() {
        let downloads = tempfile::tempdir().unwrap();
        let included = tempfile::tempdir().unwrap();
        let data = b"included font fixture";
        let license = b"included license fixture";
        let mut fixture = Font {
            id: "fixture".into(),
            family_id: "fixture".into(),
            family: "Fixture".into(),
            weight: "400".into(),
            path: "ofl/fixture/font.ttf".into(),
            hash: format!("{:x}", Sha256::digest(data)),
            license_hash: format!("{:x}", Sha256::digest(license)),
            size: data.len(),
            bundled: true,
        };
        let roots = [
            downloads.path().join("missing"),
            included.path().to_path_buf(),
        ];
        assert!(bundled_bytes(&roots, &fixture).is_none());
        fs::create_dir(included.path().join("fixture")).unwrap();
        fs::write(included.path().join("fixture").join("font.ttf"), data).unwrap();
        fs::write(included.path().join("fixture").join("OFL.txt"), license).unwrap();
        assert_eq!(bundled_bytes(&roots, &fixture).unwrap(), data);
        // Only a file the catalog marks as included is read from the installer's folder.
        fixture.bundled = false;
        assert!(bundled_bytes(&roots, &fixture).is_none());
        fixture.bundled = true;
        fs::write(included.path().join("fixture").join("font.ttf"), b"corrupt").unwrap();
        assert!(bundled_bytes(&roots, &fixture).is_none());
        // The real catalog's included fonts are unavailable when their folder is missing.
        let fonts = list(downloads.path(), &roots);
        let klee = fonts.iter().find(|f| f.id == "klee-one").unwrap();
        assert!(!klee.available && !klee.bundled && klee.url.is_none());
    }
    #[test]
    fn choices_and_migration_are_typed_and_independent() {
        let old = FontChoice::from_stored(None, Some("georgia")).unwrap();
        assert_eq!(
            old,
            FontChoice::Preset {
                id: "georgia".into()
            }
        );
        assert!(FontChoice::from_stored(
            Some(&serde_json::json!({"source":"google","id":"arbitrary"})),
            Some("georgia")
        )
        .is_none());
        for name in ["Arial", "Yu Mincho", "ＭＳ 明朝", "A Font-2"] {
            assert!(valid_family(name));
        }
        for name in [
            "",
            " Arial",
            "Arial, serif",
            "a; color:red",
            "file://a",
            "a\n",
            "url(a)",
        ] {
            assert!(!valid_family(name));
        }
        assert!(!valid_family(&"x".repeat(129)));
    }
    #[test]
    fn failed_download_cleans_staging_without_publishing_or_touching_other_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("unrelated"), b"keep").unwrap();
        assert!(download(
            dir.path(),
            &FONTS[0],
            |_| {},
            |_, _, _| Ok(b"invalid font".to_vec())
        )
        .is_err());
        assert!(!dir.path().join("zen-old-mincho.partial").exists());
        assert!(!dir.path().join("zen-old-mincho").exists());
        assert_eq!(fs::read(dir.path().join("unrelated")).unwrap(), b"keep");
        assert!(list(dir.path(), &[])
            .iter()
            .all(|f| !f.available && f.url.is_none()));
    }
    #[test]
    fn verified_download_is_atomic_reopens_removes_and_redownloads() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"pinned font fixture";
        let license = b"pinned license fixture";
        let fixture = Font {
            id: "zen-old-mincho".into(),
            family_id: "zen-old-mincho".into(),
            family: "Fixture".into(),
            weight: "400".into(),
            path: "ofl/fixture/font.ttf".into(),
            hash: format!("{:x}", Sha256::digest(data)),
            license_hash: format!("{:x}", Sha256::digest(license)),
            size: data.len(),
            bundled: false,
        };
        let get = |path: &str, _: usize, progress: &dyn Fn(usize)| {
            if path.ends_with("OFL.txt") {
                Ok(license.to_vec())
            } else {
                progress(data.len());
                Ok(data.to_vec())
            }
        };
        download(dir.path(), &fixture, |_| {}, get).unwrap();
        assert!(!dir.path().join("zen-old-mincho.partial").exists());
        assert_eq!(installed_bytes(dir.path(), &fixture).unwrap(), data);
        download(
            dir.path(),
            &fixture,
            |_| {},
            |_, _, _| panic!("No repeat download"),
        )
        .unwrap();
        clean_stage(&dir.path().join(&fixture.id)).unwrap();
        assert!(installed_bytes(dir.path(), &fixture).is_err());
        download(dir.path(), &fixture, |_| {}, get).unwrap();
        fs::write(dir.path().join(&fixture.id).join("font.ttf"), b"corrupt").unwrap();
        assert!(installed_bytes(dir.path(), &fixture).is_err());
        // A failed replacement retains the corrupt final directory until a verified retry.
        assert!(download(
            dir.path(),
            &fixture,
            |_| {},
            |_, _, _| Err("Offline".into())
        )
        .is_err());
        download(dir.path(), &fixture, |_| {}, get).unwrap();
        assert_eq!(installed_bytes(dir.path(), &fixture).unwrap(), data);
    }
    #[test]
    fn protocol_rejects_unknown_paths_methods_queries_and_corrupt_fonts() {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            "/../../font.ttf",
            "/zen-old-mincho",
            "/unknown/123.ttf",
            "/zen-old-mincho/font.ttf",
        ] {
            let refused = handle_request(
                dir.path(),
                &[],
                &Request::builder().uri(path).body(Vec::new()).unwrap(),
            );
            assert_eq!(refused.status(), StatusCode::NOT_FOUND);
            // A font not found now may be downloaded later.
            assert_eq!(refused.headers()["Cache-Control"], "no-store");
        }
        let path = format!("/{}/{}.ttf", FONTS[0].id, FONTS[0].hash);
        assert_eq!(
            handle_request(
                dir.path(),
                &[],
                &Request::builder()
                    .method("POST")
                    .uri(&path)
                    .body(Vec::new())
                    .unwrap()
            )
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            handle_request(
                dir.path(),
                &[],
                &Request::builder()
                    .uri(format!("{path}?file=a"))
                    .body(Vec::new())
                    .unwrap()
            )
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    #[cfg(windows)]
    #[test]
    fn native_installed_font_probe_does_not_accept_windows_fallbacks() {
        assert!(system_available("Arial"));
        let faces = system_faces("Arial");
        assert!(faces.iter().any(|f| f.weight == 400 && f.style == "normal"));
        assert!(faces.iter().any(|f| f.weight == 700 && f.style == "normal"));
        assert!(faces.iter().any(|f| f.weight == 700 && f.style == "italic"));
        assert!(faces
            .iter()
            .all(|f| f.family == "Arial" && valid_family(&f.name)));
        assert!(system_available("arial"));
        assert!(!system_available("Komori nonexistent font 0169"));
    }
}
