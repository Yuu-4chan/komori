//! Curated, native-owned starter downloads. No caller URLs, paths or remote lookup.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    archive::{BankKind, DictionaryArchive},
    store::{self, DictionaryStoreState, ImportStatus},
};

const MAX_DOWNLOAD: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
/// The largest saved status: one small record per source.
const MAX_JOURNAL: u64 = 64 * 1024;
const EVENT: &str = "starter-dictionaries-changed";
const FAILURE: &str =
    "Could not download or verify this dictionary. Check your connection and try again.";

struct Source {
    id: &'static str,
    /// The lookup language it serves, and the language of its definitions when that matters.
    language: &'static str,
    definitions: Option<&'static str>,
    name: &'static str,
    description: &'static str,
    attribution: &'static str,
    page: &'static str,
    url: &'static str,
    asset_repository: Option<&'static str>,
    /// Hugging Face answers from its CDN.
    hugging_face: bool,
    hash: Option<&'static str>,
    title_prefix: &'static str,
    /// The bank a genuine archive of this source must contain.
    bank: BankKind,
}

// Explicit snapshots: downloads never update an existing imported revision automatically.
// New sources are appended: each saved download status is stored by its position here.
/// One pinned commit of the wty release, so each download's hash holds.
macro_rules! wty_url {
    ($language:literal, $definitions:literal, $suffix:literal) => {
        concat!(
            "https://huggingface.co/datasets/daxida/wty-release/resolve/de7ed9cd558acce3423ccf6e17dc690f8a839bf2/latest/dict/",
            $language, "/", $definitions, "/wty-", $language, "-", $definitions, $suffix, ".zip"
        )
    };
}
macro_rules! wiktionary {
    ($language:literal, $definitions:literal, $hash:literal) => {
        Source {
            id: concat!("wty-", $language, "-", $definitions),
            language: $language,
            definitions: Some($definitions),
            name: "Wiktionary",
            description: "Words with definitions from Wiktionary.",
            attribution: WIKTIONARY_CREDIT,
            page: WIKTIONARY_PAGE,
            url: wty_url!($language, $definitions, ""),
            asset_repository: None,
            hugging_face: true,
            hash: Some($hash),
            title_prefix: concat!("wty-", $language, "-", $definitions),
            bank: BankKind::Term,
        }
    };
}
macro_rules! wiktionary_ipa {
    ($language:literal, $definitions:literal, $hash:literal) => {
        Source {
            id: concat!("wty-", $language, "-", $definitions, "-ipa"),
            language: $language,
            definitions: Some($definitions),
            name: "Wiktionary pronunciation",
            description: "Pronunciations in IPA from Wiktionary.",
            attribution: WIKTIONARY_CREDIT,
            page: WIKTIONARY_PAGE,
            url: wty_url!($language, $definitions, "-ipa"),
            asset_repository: None,
            hugging_face: true,
            hash: Some($hash),
            title_prefix: concat!("wty-", $language, "-", $definitions, "-ipa"),
            bank: BankKind::TermMeta,
        }
    };
}
const WIKTIONARY_CREDIT: &str = "Wiktionary contributors, through Kaikki.org; package by wty.";
const WIKTIONARY_PAGE: &str = "https://github.com/yomidevs/wiktionary-to-yomitan";

static SOURCES: &[Source] = &[
    Source {
        id: "jitendex", language: "ja", definitions: Some("en"), name: "Jitendex", description: "Japanese–English definitions with examples and usage notes.",
        attribution: "Stephen Kraus; JMdict by EDRDG, examples by Tatoeba (CC BY 2.0 FR), furigana by JmdictFurigana.",
        page: "https://jitendex.org/pages/legal.html",
        url: "https://github.com/stephenmk/stephenmk.github.io/releases/download/2026.10.03.0/jitendex-yomitan.zip",
        asset_repository: Some("744330420"), hugging_face: false,
        hash: Some("e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356"),
        title_prefix: "Jitendex", bank: BankKind::Term,
    },
    Source {
        id: "jmdict", language: "ja", definitions: Some("en"), name: "JMdict", description: "Japanese–English definitions without examples.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/JMdict_english.zip",
        asset_repository: Some("696075636"), hugging_face: false,
        hash: Some("a2053ac64d4bf1fd17f5d7a5d1cf2df5f7ebc4415da0d63ae04a724ef6c330dd"),
        title_prefix: "JMdict", bank: BankKind::Term,
    },
    Source {
        id: "jiten", language: "ja", definitions: None, name: "Jiten frequency", description: "Global word frequency ranks from Japanese media. Add a term dictionary for definitions.",
        attribution: "Jiten — global Japanese media frequency list.",
        page: "https://jiten.moe/frequency-dictionaries",
        url: "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan",
        asset_repository: None, hugging_face: false, hash: None, title_prefix: "Jiten", bank: BankKind::TermMeta,
    },
    Source {
        id: "kanjidic", language: "ja", definitions: Some("en"), name: "KANJIDIC", description: "Kanji meanings, on and kun readings, stroke counts and grades.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/KANJIDIC_english.zip",
        asset_repository: Some("696075636"), hugging_face: false,
        hash: Some("a657edea5035cb436366b5581f3e77d4c7dbc93e214048100cf441602d50e8a2"),
        title_prefix: "KANJIDIC", bank: BankKind::Kanji,
    },
    Source {
        id: "jmnedict", language: "ja", definitions: Some("en"), name: "JMnedict", description: "Japanese proper names: people, places, companies and works.",
        attribution: "Electronic Dictionary Research and Development Group (EDRDG); package by yomidevs.",
        page: "https://github.com/yomidevs/jmdict-yomitan#license",
        url: "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-10-04/JMnedict.zip",
        asset_repository: Some("696075636"), hugging_face: false,
        hash: Some("09c9e4f7947beddf87924bcf36915c1f5bf8555c354246dd6b3057d3569b6f57"),
        title_prefix: "JMnedict", bank: BankKind::Term,
    },
    wiktionary!("ja", "ja", "8affbadcec191512d3736b5e81a9ea63b02dcd93dc951eb7604edd7c64af2851"),
    wiktionary!("ja", "fr", "34813c0e3eceb011a81b72c2b8abd64169198bf6723a12f44f8b60e52c08510b"),
    wiktionary!("ja", "zh", "0aada48c9c25d5db860cb7acf56ec38bdcaae69628103b7ac1fcbd5ac83cb8c2"),
    wiktionary!("en", "ja", "6d75a7aef3c33e0efff58c09671a298abf48b0efbe22b7bfb90a34486f0f72c2"),
    wiktionary!("en", "en", "0e62d0d3d6bf68c3f65906b5940601a375392f45d89a50e5dcb5068e1961436f"),
    wiktionary!("en", "fr", "4cffe210c66826d201ae7b8182064c4163b743f6e8f4401293dc1dfe3e02f382"),
    wiktionary!("en", "pt", "e792e22c87658c8560f0f9791d0f57d5d32e41a58b5956fbad618c261a548bde"),
    wiktionary!("en", "it", "f6703151e78df23ecc55984b9f7b344a91b0c5b2b0d9069f1df5438cb1d6cbfe"),
    wiktionary!("en", "es", "593e68de7a6fad658e9395f426c6fee7350ed727188059c8332e465194b765cf"),
    wiktionary!("en", "ko", "dace97a57d5c09518fb6d9805cdc32883722990f7eef0b153e3a45272c9d5074"),
    wiktionary!("en", "zh", "1533c163bd4a0513f37a9786d01da40e869830587d04f0bf19ee36abf0364778"),
    wiktionary!("en", "de", "967e455817a21be4e8b634370a15af0001340a8e5e8e3e171b43977062562330"),
    wiktionary!("en", "ru", "ee079b9826995a91e61b37649b1edec0d82447fa9512b2a5222d4a229d24fe36"),
    wiktionary!("fr", "en", "7ce164c86d0ad613d55f1397766ca206e9898099125d13b7c14222b2a05bf8a7"),
    wiktionary!("fr", "fr", "8911b8d22d8f886eb0f700cd202e429e78e77c9ef59bc0fcebaa9d18bb1330f3"),
    wiktionary!("fr", "zh", "8883710b0b6155129ddf98018ca9bc42a7af907eec10fca768cf57234916825d"),
    wiktionary!("fr", "ru", "9e5ae7f16908a28d21f698316108cceb745fb3edde5b02b30b063b77d11670a0"),
    wiktionary!("pt", "en", "90c8e8fe98818163c21ea84ac4dbc8683395c8b696b312054744e5739bfe8ee8"),
    wiktionary!("pt", "pt", "de2485bce47c0160147d07970740cb7beb7e8158bcc918baf86cc21cae3adc09"),
    wiktionary!("pt", "zh", "2580fe2a7b1c8a6492ff2a5ddccf663db1284eb9ec51b91d3579e616e55af1dd"),
    wiktionary!("it", "en", "f7d92e821cd87f759c381f232ca1ff83151f59062b80a5d89a1323d13cddef71"),
    wiktionary!("it", "fr", "8504bef22f2a8bfec23622a7062b97ab89e35a6c414ee4a398ae8a495fd9ebfa"),
    wiktionary!("it", "it", "2766fd5e778df97e4a2ef48357409743908a0d4ad946e0cf54763888f655fa1f"),
    wiktionary!("it", "zh", "89357b6317d2eb0b6a980416e880319c27cdcc29ca3e6bccc6cc339c584d472c"),
    wiktionary!("es", "en", "967f390f19509b46ef0fd1eeef19093c027c0f91242ca57d171a8ca5bfdd658d"),
    wiktionary!("es", "fr", "2a05572efa427a5f08db0a235d2d2292c7049a64583c143c977db455dd6cecd8"),
    wiktionary!("es", "es", "1b82fef5f73c72b87c36abeb2d99552d28ae04a0b9a1b2710d8a16ccb4f96276"),
    wiktionary!("es", "zh", "69ed31617c258b8c014b7d0fe15d20844fd30d43ea615d9c19b4fa2e8aa28efa"),
    wiktionary!("es", "ru", "b92703dc37db73f86bc84be20b679245b9ec66f6ce64c87ed51090cb512545c5"),
    wiktionary!("ko", "ja", "72f118d818cad0b364463e4da36b125c6cc7f20c43e6469ad981f50c33cb1f32"),
    wiktionary!("ko", "en", "2783441d710cbc0498d7f0c24fc28779d9bf107292b30da1d468700f0b0cfc73"),
    wiktionary!("ko", "fr", "92001701d29a1ec1f3b6a15e26ce6ca392ce54b3a1bf2e9f92c56913ff017654"),
    wiktionary!("ko", "ko", "e849ccf1271449d7aa911ef25299b7029a0aba7239933739c26f99f680e9e22c"),
    wiktionary!("ko", "zh", "eb1c5635670befa09e6ec2f8f44cc3339d8066038b53d05aa040d00c36f3dc01"),
    wiktionary!("zh", "ja", "0eb88ce4758ea5cface16832a1bd5770f2de2dea2bdda5df28682d83290ce960"),
    wiktionary!("zh", "en", "f055265a63269980b2315ab18a3402684105fcff98a2a75385b5e50c3c7b576f"),
    wiktionary!("zh", "fr", "e97688a67d27b22138526461a18930a62dce7451cbe57d19773bd58b493fbbaa"),
    wiktionary!("de", "en", "a9af3cc38777c8ec77c5dccc85883745a0268b0a9577c5c5eded25aa9396079d"),
    wiktionary!("de", "fr", "7e90b1196ac38db3ae8b67dd241ea7a7741d0600af1827991a8315148959e902"),
    wiktionary!("de", "zh", "7baa17228b6c082899d33fb1b22bd3f54a0bd0609d71061272ea0c9209796096"),
    wiktionary!("ru", "en", "3c46775512bddc27759d79a9870c0540c6592a4c6d70a44c4b7de5c85fbfc4fb"),
    wiktionary!("ru", "fr", "b0a4850ce241365945c973a2513afb692aa5d9b29ea77234c36f442a594f149c"),
    wiktionary!("ru", "zh", "9567659caf1875c88265da5c1723aa906c6d7c6ee3e63fb80398429a86fc2741"),
    wiktionary!("ru", "ru", "f4b5de258377a7462aa87ce4e01024f5f43e25cf4ab318a290206789d62209b6"),
    wiktionary_ipa!("en", "ja", "5d8cd690b265ba6675c62a79d84e328230344bafa67b75c8ba104671638a64d2"),
    wiktionary_ipa!("en", "en", "88d23f6d8b68cadb62cd81135bb39212a44882e2daa40d65f8af6a35982ba930"),
    wiktionary_ipa!("en", "fr", "4b4b5c3d18991f10ab38f2adbeca6cab16d4f3f96e8f56202e30865cb899077b"),
    wiktionary_ipa!("en", "pt", "f5ee50d939b520faff3b12fbafd4a7faf8c5cc06dbb02c9b6c432d5422dc56f3"),
    wiktionary_ipa!("en", "it", "2b84aeb99ae70a535e250d4738a11227f76e4b40e838406552c734f94e4dca0e"),
    wiktionary_ipa!("en", "es", "0a26f6c35eba206f46ef2a5d313e13edb19a9fc2d600f9059c248e0a2c4124a4"),
    wiktionary_ipa!("en", "ko", "2b3d0951d3d8660d45029e98603e5afdcac23f469217bfa358165d619e4f5766"),
    wiktionary_ipa!("en", "zh", "3e2ab067b95528a467b102ee59325c9521bed6fc2dee4f8389e303dfeb7904e4"),
    wiktionary_ipa!("en", "de", "a7c47302ea1759a1ca1e58f9df2f391da2d1d1f079c13c624f213e8f021c8560"),
    wiktionary_ipa!("en", "ru", "334b05776113a5b1fcdb052268e77da20bc3d954e10ff4bd927836b917a8fc5b"),
    wiktionary_ipa!("fr", "en", "502409627f0465d6c0b10aa65d4b99ccc9fad01b6d3e58cfb38e838ab9deafd9"),
    wiktionary_ipa!("fr", "fr", "5ebd9c2f8ccec374426b23a68382c469d0add7c55880c18ed1ea033078c919a0"),
    wiktionary_ipa!("fr", "zh", "6d9bc00be7282a18acff274ed1fb3d319b052907cac587cd2aad3fbfab84741d"),
    wiktionary_ipa!("fr", "ru", "2a3fa3860ca33377652cf064b074d9a3aa5f34c6b9012a2ebf0272d5d8ef0a9b"),
    wiktionary_ipa!("pt", "en", "52014c2a70d965e8bd04173ca5212b6b41fa51aa5e1dead0309f64b6086006d9"),
    wiktionary_ipa!("pt", "pt", "25deba65e15596ac6f878f47c6f1077aad58cca9df0ec75d0eaf85e50a3f2068"),
    wiktionary_ipa!("it", "en", "1b9f608de4bf3d621a3e1b588b9288628a29107a2c4ebdad4c5467fb18999c38"),
    wiktionary_ipa!("it", "fr", "0bdbbdb2c857f7a8717c4856bea00736f8907b90de46e3d99a04b02d833e4f69"),
    wiktionary_ipa!("it", "it", "118d76627c77016f8d0d84598ce7be954ccc1e8de254484c6099f67613ff9544"),
    wiktionary_ipa!("it", "zh", "74736d013b179d841c2bb2e6bdeb62e95fb961744a88187e1b8dc98a052e84e7"),
    wiktionary_ipa!("es", "en", "b5c988f317d756b6ca1ac1c3ad00b577a66a28b823e0dc41cdf52a4a16289671"),
    wiktionary_ipa!("es", "fr", "7b36d59a673097fcd216e64065662313537313e0593516e17f91b73c83d730bf"),
    wiktionary_ipa!("es", "es", "34757787c14774f9739b71fae549ea20d6a3fb737c6c11bac16567c1591631fd"),
    wiktionary_ipa!("es", "zh", "1124c68c70b3140e5f355d5e52a515792327c163254846d4f1e0f635ac9dba1d"),
    wiktionary_ipa!("es", "ru", "5fdb4793e0d9558f4cad3790b3dab125c94db16fd07f6f3eea8e97d8071c3efd"),
    wiktionary_ipa!("ko", "ja", "605d726f53c3145b62b9f1d4490a8d13b0ac992e8855654c5a05f1649ad0486e"),
    wiktionary_ipa!("ko", "en", "75697a063244b7a83470a3cbf875b570e03299fdbca0c4b0f583886fc0dfff3e"),
    wiktionary_ipa!("ko", "ko", "3a1376da1e085dd4d5d27c5939641c5f76d1904e0e2d8658ee6b43b8346b0b4d"),
    wiktionary_ipa!("ko", "zh", "dc8aeed9f711e21eb1e9b0d8fbba52bbde87e014a3621bbde0aeb056f87da4c8"),
    wiktionary_ipa!("zh", "ja", "f2a5f50d621a3e69e78bfcda361c6375f77f08e40ba4016c581cfacc5bdbd6ec"),
    wiktionary_ipa!("zh", "en", "9c999cf2647e6c9cca7980c1e6c0cf2ab5294a52cb50b9359f2d51f162e925c7"),
    wiktionary_ipa!("zh", "fr", "2b7c7b882fe20d1739485de3383d5f453472ded4b0f702e3b5ba11d6ed55c031"),
    wiktionary_ipa!("de", "en", "e0ff90dab5b89e35a8b64e101aa2a7f2d3a5f08684ce90c492d42a146de4d81b"),
    wiktionary_ipa!("de", "fr", "99eff5a465fcec98c0c5c72aa7b73707440cda6c5bc799bccc05c1971da14a01"),
    wiktionary_ipa!("de", "zh", "220059019bd1b7423337ecc2976632d41b0f57720e07af61a140d3be9be6c6bb"),
    wiktionary_ipa!("ru", "en", "43fdf8473dec083a80f8510964585deb3f43b172054008c36dfd2ac10910bbeb"),
    wiktionary_ipa!("ru", "fr", "0399a7de4745d75e9975dffbba2d786f8450e079251e395cbeb558a1e315dfbf"),
    wiktionary_ipa!("ru", "zh", "5c41426b90718cd6073c540a3f6bbd57cdea8b3ed760957ef3b5b997ee637ce1"),
    wiktionary_ipa!("ru", "ru", "e035f9e6df324bf3ae5e809a0c01546aa84c8b836ac797b33ae534222c42da5f"),
];

fn source(id: &str) -> Result<&'static Source, String> {
    SOURCES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Unknown starter dictionary.".into())
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    #[default]
    Ready,
    Downloading,
    Verifying,
    Importing,
    Imported,
    AlreadyImported,
    Failed,
    Interrupted,
}
impl Phase {
    fn active(self) -> bool {
        matches!(self, Self::Downloading | Self::Verifying | Self::Importing)
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    phase: Phase,
    received: u64,
    total: Option<u64>,
    /// The imported dictionary's title, so the list says added only while it is installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    started: bool,
    dismissed: bool,
    /// One per source, by position; a status saved before a source was added has fewer.
    jobs: Vec<Job>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            started: false,
            dismissed: false,
            jobs: vec![Job::default(); SOURCES.len()],
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    id: &'static str,
    language: &'static str,
    definitions: Option<&'static str>,
    name: &'static str,
    description: &'static str,
    attribution: &'static str,
    license: &'static str,
    #[serde(flatten)]
    job: Job,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    revision: u64,
    started: bool,
    dismissed: bool,
    entries: Vec<Entry>,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    journal: Journal,
}
pub(crate) struct StarterState {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

fn snapshot(inner: &Inner) -> Snapshot {
    Snapshot {
        revision: inner.revision,
        started: inner.journal.started,
        dismissed: inner.journal.dismissed,
        entries: SOURCES
            .iter()
            .zip(&inner.journal.jobs)
            .map(|(s, job)| Entry {
                id: s.id,
                language: s.language,
                definitions: s.definitions,
                name: s.name,
                description: s.description,
                attribution: s.attribution,
                license: "CC BY-SA 4.0",
                job: job.clone(),
            })
            .collect(),
    }
}

fn safe(path: &Path, directory: bool) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| "Starter dictionary storage is unavailable.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Unsafe starter dictionary storage.".into());
        }
    }
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err("Unsafe starter dictionary storage.".into());
    }
    Ok(())
}

fn clean(root: &Path) -> Result<(), String> {
    safe(root, true)?;
    for name in SOURCES
        .iter()
        .map(|s| format!("{}.part", s.id))
        .chain(["state.pending".into()])
    {
        let path = root.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            safe(&path, false)?;
            fs::remove_file(path)
                .map_err(|_| "Could not clean the interrupted dictionary download.")?;
        }
    }
    Ok(())
}

fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    safe(root, true)?;
    let path = root.join("state.json");
    if fs::symlink_metadata(&path).is_ok() {
        safe(&path, false)?;
    }
    let bytes = serde_json::to_vec(journal).map_err(|_| "Could not save download status.")?;
    let pending = root.join("state.pending");
    if fs::symlink_metadata(&pending).is_ok() {
        safe(&pending, false)?;
        fs::remove_file(&pending).map_err(|_| "Could not save download status.")?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .map_err(|_| "Could not save download status.")?;
    let stage = Stage(pending);
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save download status.")?;
    drop(file);
    fs::rename(&stage.0, path).map_err(|_| "Could not save download status.".into())
}

fn initialize_at(root: PathBuf) -> Result<StarterState, String> {
    fs::create_dir_all(&root).map_err(|_| "Starter dictionary storage is unavailable.")?;
    clean(&root)?;
    let path = root.join("state.json");
    let mut journal = if path.exists() {
        safe(&path, false)?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| "Could not read download status.")?
            .take(MAX_JOURNAL + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read download status.")?;
        if bytes.len() as u64 > MAX_JOURNAL {
            Journal::default()
        } else {
            serde_json::from_slice::<Journal>(&bytes).unwrap_or_default()
        }
    } else {
        Journal::default()
    };
    journal.jobs.resize(SOURCES.len(), Job::default());
    for job in &mut journal.jobs {
        if job.phase.active() {
            job.phase = Phase::Interrupted;
        }
        job.received = 0;
        job.total = None;
    }
    save(&root, &journal)?;
    Ok(StarterState {
        root,
        inner: Arc::new(Mutex::new(Inner {
            revision: 0,
            journal,
        })),
    })
}

pub(crate) fn initialize(app: &AppHandle) -> Result<StarterState, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate dictionary storage.")?
        .join("starter-dictionaries");
    initialize_at(root)
}

#[tauri::command]
pub(crate) fn get_starter_dictionaries(state: State<'_, StarterState>) -> Snapshot {
    snapshot(&state.inner.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
pub(crate) fn dismiss_starter_dictionaries(
    state: State<'_, StarterState>,
) -> Result<Snapshot, String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.journal.jobs.iter().any(|job| job.phase.active()) {
        return Err("Wait for the download to finish.".into());
    }
    let mut journal = inner.journal.clone();
    journal.dismissed = true;
    save(&state.root, &journal)?;
    inner.journal = journal;
    inner.revision += 1;
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn open_starter_information(id: String, license: bool) -> Result<(), String> {
    let s = source(&id)?;
    crate::external_link::open_external_link(if license {
        "https://creativecommons.org/licenses/by-sa/4.0/".into()
    } else {
        s.page.into()
    })
    .await
}

fn update(
    state: &StarterState,
    app: &AppHandle,
    index: usize,
    phase: Phase,
    received: u64,
    total: Option<u64>,
    title: Option<String>,
) {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.journal.jobs[index] = Job {
        phase,
        received,
        total,
        title,
    };
    inner.revision += 1;
    if !phase.active() {
        let _ = save(&state.root, &inner.journal);
    }
    let _ = app.emit_to("main", EVENT, snapshot(&inner));
}

#[tauri::command]
pub(crate) fn download_starter_dictionary(
    id: String,
    app: AppHandle,
    state: State<'_, StarterState>,
    store: State<'_, DictionaryStoreState>,
) -> Result<Snapshot, String> {
    let s = source(&id)?;
    let index = SOURCES.iter().position(|entry| entry.id == s.id).unwrap();
    let initial = {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.journal.jobs.iter().any(|job| job.phase.active()) {
            return Err("Another starter download is running.".into());
        }
        let mut journal = inner.journal.clone();
        journal.started = true;
        journal.dismissed = false;
        journal.jobs[index] = Job {
            phase: Phase::Downloading,
            ..Job::default()
        };
        save(&state.root, &journal)?;
        inner.journal = journal;
        inner.revision += 1;
        snapshot(&inner)
    };
    let worker = StarterState {
        root: state.root.clone(),
        inner: Arc::clone(&state.inner),
    };
    let database = store.database.clone();
    let write_lock = Arc::clone(&store.write_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(
            &worker.root,
            s,
            &database,
            &write_lock,
            &|phase, received, total| {
                update(&worker, &app, index, phase, received, total, None);
            },
            fetch,
        );
        let (phase, title) =
            result.map_or((Phase::Failed, None), |(phase, title)| (phase, Some(title)));
        update(&worker, &app, index, phase, 0, None, title);
    });
    Ok(initial)
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

type Progress<'a> = &'a dyn Fn(Phase, u64, Option<u64>);
fn install(
    root: &Path,
    s: &Source,
    database: &Path,
    lock: &Mutex<()>,
    progress: Progress<'_>,
    get: impl Fn(&Source, &mut File, Progress<'_>) -> Result<(), String>,
) -> Result<(Phase, String), String> {
    safe(root, true)?;
    let path = root.join(format!("{}.part", s.id));
    // Create-new refuses links, stale files and concurrent staging collisions.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| FAILURE)?;
    let stage = Stage(path);
    get(s, &mut file, progress)?;
    file.sync_all().map_err(|_| FAILURE)?;
    drop(file);
    progress(Phase::Verifying, 0, None);
    verify(&stage.0, s)?;
    progress(Phase::Importing, 0, None);
    let _writing = lock.lock().map_err(|_| "Could not save this dictionary.")?;
    let mut connection =
        store::open_store(database).map_err(|_| "Could not save this dictionary.")?;
    match store::import_one(&mut connection, &stage.0) {
        (ImportStatus::Imported, Some(title)) => Ok((Phase::Imported, title)),
        (ImportStatus::AlreadyImported, Some(title)) => Ok((Phase::AlreadyImported, title)),
        _ => Err("Could not import this dictionary. Nothing was added. Try again.".into()),
    }
}

fn verify(path: &Path, s: &Source) -> Result<(), String> {
    safe(path, false)?;
    let mut file = File::open(path).map_err(|_| FAILURE)?;
    if file.metadata().map_err(|_| FAILURE)?.len() > MAX_DOWNLOAD {
        return Err(FAILURE.into());
    }
    if let Some(expected) = s.hash {
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 32768];
        loop {
            let read = file.read(&mut buffer).map_err(|_| FAILURE)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        if format!("{:x}", hash.finalize()) != expected {
            return Err(FAILURE.into());
        }
    }
    // Strict CRC checking for downloaded archives; legacy manual archives retain their reader.
    let mut zip =
        zip::ZipArchive::new(File::open(path).map_err(|_| FAILURE)?).map_err(|_| FAILURE)?;
    if zip.len() > 20_000 {
        return Err(FAILURE.into());
    }
    let mut total = 0u64;
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| FAILURE)?;
        total = total.checked_add(entry.size()).ok_or(FAILURE)?;
        if total > MAX_EXPANDED
            || entry.size() > 512 * 1024 * 1024
            || !names.insert(entry.name().to_owned())
        {
            return Err(FAILURE.into());
        }
        let limit = entry.size();
        let read = std::io::copy(&mut entry.by_ref().take(limit + 1), &mut std::io::sink())
            .map_err(|_| FAILURE)?;
        if read != limit {
            return Err(FAILURE.into());
        }
    }
    let archive = DictionaryArchive::open(path).map_err(|_| FAILURE)?;
    if !archive.index().title.starts_with(s.title_prefix) || archive.bank_count(s.bank) == 0 {
        return Err(FAILURE.into());
    }
    Ok(())
}

// GitHub releases may redirect once to their repository-specific signed asset path, and Hugging
// Face to its CDN; both downloads are checked against a pinned hash.
// Jiten's published API endpoint has no redirect allowance.
fn allowed_redirect(s: &Source, url: &str) -> bool {
    if s.hugging_face {
        return url
            .strip_prefix("https://")
            .and_then(|rest| rest.split_once('/'))
            .is_some_and(|(host, _)| host.ends_with(".hf.co"))
            && url.len() < 8192
            && !url
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || "\\\"<>#".contains(c));
    }
    let Some(repository) = s.asset_repository else {
        return false;
    };
    let prefix = format!("https://release-assets.githubusercontent.com/github-production-release-asset/{repository}/");
    let Some(tail) = url.strip_prefix(&prefix) else {
        return false;
    };
    let Some((asset, query)) = tail.split_once('?') else {
        return false;
    };
    uuid::Uuid::parse_str(asset).is_ok()
        && !query.is_empty()
        && url.len() < 8192
        && !url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "\\\"<>#".contains(c))
}

#[cfg(windows)]
fn fetch(s: &Source, file: &mut File, progress: Progress<'_>) -> Result<(), String> {
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
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe fn header(request: *mut c_void, kind: u32) -> Option<String> {
        let mut buffer = vec![0u16; 8192];
        let mut size = (buffer.len() * 2) as u32;
        if WinHttpQueryHeaders(
            request,
            kind,
            std::ptr::null(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        Some(
            String::from_utf16_lossy(&buffer[..size as usize / 2])
                .trim_end_matches('\0')
                .to_owned(),
        )
    }
    let started = std::time::Instant::now();
    let mut url = s.url.to_owned();
    // SAFETY: NUL-terminated strings and buffers outlive each WinHTTP call; RAII closes all handles.
    unsafe {
        let session = Handle(WinHttpOpen(
            wide("Komori Starter Dictionaries").as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() || WinHttpSetTimeouts(session.0, 10000, 10000, 15000, 15000) == 0 {
            return Err(FAILURE.into());
        }
        for hop in 0..=1 {
            let (host, path) = url
                .strip_prefix("https://")
                .and_then(|rest| rest.split_once('/'))
                .ok_or(FAILURE)?;
            let connection = Handle(WinHttpConnect(session.0, wide(host).as_ptr(), 443, 0));
            if connection.0.is_null() {
                return Err(FAILURE.into());
            }
            let request = Handle(WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide(&format!("/{path}")).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            ));
            if request.0.is_null() {
                return Err(FAILURE.into());
            }
            let redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
            if WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_REDIRECT_POLICY,
                (&redirects as *const u32).cast(),
                4,
            ) == 0
                || WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0)
                    == 0
                || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0
            {
                return Err(FAILURE.into());
            }
            let status = header(request.0, WINHTTP_QUERY_STATUS_CODE).ok_or(FAILURE)?;
            if status == "302" && hop == 0 {
                let next = header(request.0, WINHTTP_QUERY_LOCATION).ok_or(FAILURE)?;
                if !allowed_redirect(s, &next) {
                    return Err(FAILURE.into());
                }
                url = next;
                continue;
            }
            if status != "200" {
                return Err(FAILURE.into());
            }
            let total = header(request.0, WINHTTP_QUERY_CONTENT_LENGTH)
                .map(|text| text.parse::<u64>().map_err(|_| FAILURE))
                .transpose()?;
            if total.is_some_and(|size| size == 0 || size > MAX_DOWNLOAD) {
                return Err(FAILURE.into());
            }
            let mut received = 0u64;
            let mut announced = 0u64;
            loop {
                if started.elapsed().as_secs() > 600 {
                    return Err(FAILURE.into());
                }
                let mut buffer = [0u8; 32768];
                let mut read = 0;
                if WinHttpReadData(
                    request.0,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                ) == 0
                {
                    return Err(FAILURE.into());
                }
                if read == 0 {
                    break;
                }
                received += read as u64;
                if received > MAX_DOWNLOAD || total.is_some_and(|size| received > size) {
                    return Err(FAILURE.into());
                }
                file.write_all(&buffer[..read as usize])
                    .map_err(|_| FAILURE)?;
                if received - announced >= 256 * 1024 {
                    progress(Phase::Downloading, received, total);
                    announced = received;
                }
            }
            if received == 0 || total.is_some_and(|size| received != size) {
                return Err(FAILURE.into());
            }
            progress(Phase::Downloading, received, total);
            return Ok(());
        }
    }
    Err(FAILURE.into())
}

#[cfg(not(windows))]
fn fetch(_: &Source, _: &mut File, _: Progress<'_>) -> Result<(), String> {
    Err("Starter downloads require Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn archive(title: &str, frequency: bool, malformed: bool) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("index.json", options).unwrap();
        write!(
            zip,
            "{{\"title\":\"{title}\",\"revision\":\"test\",\"format\":3}}"
        )
        .unwrap();
        zip.start_file(
            if frequency {
                "term_meta_bank_1.json"
            } else {
                "term_bank_1.json"
            },
            options,
        )
        .unwrap();
        zip.write_all(if malformed {
            b"[false]"
        } else if frequency {
            br#"[["read","freq",2]]"#
        } else {
            br#"[["read","read","","",1,["to read"],1,""]]"#
        })
        .unwrap();
        zip.finish().unwrap().into_inner()
    }

    fn fixture() -> Source {
        Source {
            hash: None,
            ..SOURCES[0]
        }
    }

    #[test]
    fn every_lookup_language_has_a_pinned_wiktionary_dictionary_and_ids_are_unique() {
        for language in ["ja", "en", "fr", "pt", "it", "es", "ko", "zh", "de", "ru"] {
            assert!(
                SOURCES
                    .iter()
                    .any(|s| s.language == language && s.bank == BankKind::Term),
                "{language}"
            );
        }
        for (index, s) in SOURCES.iter().enumerate() {
            assert!(
                SOURCES[..index].iter().all(|other| other.id != s.id),
                "{}",
                s.id
            );
            if s.hugging_face {
                assert_eq!(s.hash.map(str::len), Some(64), "{}", s.id);
                assert!(s.url.ends_with(&format!("/{}.zip", s.id)), "{}", s.id);
                assert_eq!(s.title_prefix, s.id);
            }
        }
        // Every status fits what a restart reads back.
        let journal = Journal::default();
        assert!((serde_json::to_vec(&journal).unwrap().len() as u64) < MAX_JOURNAL);
    }

    #[test]
    fn hugging_face_downloads_redirect_only_to_its_cdn() {
        let s = source("wty-fr-en").unwrap();
        assert!(allowed_redirect(
            s,
            "https://us.aws.cdn.hf.co/xet-bridge-us/1/2?X-Amz=3"
        ));
        assert!(allowed_redirect(
            s,
            "https://cas-bridge.xethub.hf.co/xet-bridge-us/1/2?X-Amz=3"
        ));
        for invalid in [
            "http://us.aws.cdn.hf.co/a",
            "https://hf.co.evil.example/a",
            "https://evil.example/.hf.co/a",
            "https://us.aws.cdn.hf.co/a#fragment",
            "https://us.aws.cdn.hf.co/a\n",
        ] {
            assert!(!allowed_redirect(s, invalid), "{invalid}");
        }
    }

    #[test]
    fn descriptions_never_name_yomitan_while_attribution_keeps_its_credit() {
        for source in SOURCES {
            assert!(!source.description.to_lowercase().contains("yomitan"));
        }
        assert!(SOURCES[1].attribution.contains("package by yomidevs"));
    }

    #[test]
    fn native_catalog_refuses_caller_urls_and_foreign_redirects() {
        for id in ["", "https://jitendex.org", "../jitendex", "Jitendex"] {
            assert!(source(id).is_err());
        }
        let valid = "https://release-assets.githubusercontent.com/github-production-release-asset/744330420/0523806b-6e18-4396-886b-ddefb0fa910e?sig=abc";
        assert!(allowed_redirect(&SOURCES[0], valid));
        for invalid in [
            valid.replace("https://", "http://"),
            valid.replace("744330420", "696075636"),
            valid.replace(".com/", ".com.evil/"),
            format!("{valid}#fragment"),
            format!("{valid}\n"),
            valid.replace("0523806b-6e18-4396-886b-ddefb0fa910e", "../elsewhere"),
        ] {
            assert!(!allowed_redirect(&SOURCES[0], &invalid));
        }
        assert!(!allowed_redirect(&SOURCES[2], valid));
    }

    #[test]
    fn verified_import_duplicate_and_restart_use_the_existing_transactional_store() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionary.sqlite3");
        let s = fixture();
        let bytes = archive("Jitendex fixture", false, false);
        let phases = std::cell::RefCell::new(Vec::new());
        let progress = |phase, _, _| phases.borrow_mut().push(phase);
        let get = |_: &Source, file: &mut File, _: Progress<'_>| {
            file.write_all(&bytes).map_err(|_| FAILURE.into())
        };
        let lock = Mutex::new(());
        assert_eq!(
            install(&state.root, &s, &database, &lock, &progress, get)
                .unwrap()
                .0,
            Phase::Imported
        );
        assert_eq!(*phases.borrow(), [Phase::Verifying, Phase::Importing]);
        assert_eq!(
            install(&state.root, &s, &database, &lock, &progress, get)
                .unwrap()
                .0,
            Phase::AlreadyImported
        );
        let connection = store::open_store(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM dictionaries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT expression FROM terms", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "read"
        );
        assert!(!state.root.join("jitendex.part").exists());
        drop(connection);
        drop(state);
        assert!(initialize_at(dir.path().join("stage")).is_ok());
        assert_eq!(
            store::open_store(&database)
                .unwrap()
                .query_row("SELECT count(*) FROM terms", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn refusal_cleanup_retry_and_rollback_keep_existing_data_and_unowned_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionary.sqlite3");
        let lock = Mutex::new(());
        let s = fixture();
        let file = state.root.join("untouched.zip");
        fs::write(&file, b"private").unwrap();
        let before = fs::metadata(&file).unwrap().modified().unwrap();
        for bytes in [
            b"not a ZIP".to_vec(),
            archive("wrong source", false, false),
            archive("Jitendex broken", false, true),
        ] {
            assert!(install(
                &state.root,
                &s,
                &database,
                &lock,
                &|_, _, _| {},
                |_, file, _| file.write_all(&bytes).map_err(|_| FAILURE.into())
            )
            .is_err());
            assert!(!state.root.join("jitendex.part").exists());
        }
        assert!(install(
            &state.root,
            &s,
            &database,
            &lock,
            &|_, _, _| {},
            |_, file, _| {
                file.write_all(b"partial").unwrap();
                Err(FAILURE.into())
            }
        )
        .is_err());
        let connection = store::open_store(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM dictionaries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let bytes = archive("Jitendex retry", false, false);
        assert_eq!(
            install(
                &state.root,
                &s,
                &database,
                &lock,
                &|_, _, _| {},
                |_, file, _| file.write_all(&bytes).map_err(|_| FAILURE.into())
            )
            .unwrap(),
            (Phase::Imported, "Jitendex retry".into())
        );
        assert_eq!(fs::read(&file).unwrap(), b"private");
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before);
        // Create-new failure must not delete a preexisting file, even at a known stage name.
        fs::write(state.root.join("jitendex.part"), b"existing").unwrap();
        assert!(install(
            &state.root,
            &s,
            &database,
            &lock,
            &|_, _, _| {},
            |_, _, _| panic!("must not download")
        )
        .is_err());
        assert_eq!(
            fs::read(state.root.join("jitendex.part")).unwrap(),
            b"existing"
        );
    }

    #[test]
    fn hash_crc_role_and_archive_size_are_verified_before_import() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.zip");
        let bytes = archive("Jitendex fixture", false, false);
        fs::write(&file, &bytes).unwrap();
        assert!(verify(&file, &SOURCES[0]).is_err()); // wrong pinned SHA-256
        assert!(verify(&file, &fixture()).is_ok());
        let mut corrupt = bytes.clone();
        let start = corrupt.windows(7).position(|w| w == b"to read").unwrap();
        corrupt[start] = b'X';
        fs::write(&file, corrupt).unwrap();
        assert!(verify(&file, &fixture()).is_err());
        fs::write(&file, archive("Jiten", false, false)).unwrap();
        assert!(verify(&file, &SOURCES[2]).is_err());
        fs::write(&file, archive("Jiten", true, false)).unwrap();
        assert!(verify(&file, &SOURCES[2]).is_ok());
        File::create(&file)
            .unwrap()
            .set_len(MAX_DOWNLOAD + 1)
            .unwrap();
        assert!(verify(&file, &fixture()).is_err());
    }

    #[test]
    fn interrupted_phases_reopen_retryably_and_clean_only_owned_staging() {
        for phase in [Phase::Downloading, Phase::Verifying, Phase::Importing] {
            let dir = tempfile::tempdir().unwrap();
            let mut journal = Journal {
                started: true,
                ..Journal::default()
            };
            journal.jobs[0].phase = phase;
            journal.jobs[1].phase = Phase::Imported;
            save(dir.path(), &journal).unwrap();
            fs::write(dir.path().join("jitendex.part"), b"partial").unwrap();
            fs::write(
                dir.path().join("state.pending"),
                b"interrupted journal write",
            )
            .unwrap();
            fs::write(dir.path().join("other.zip"), b"unowned").unwrap();
            let state = initialize_at(dir.path().to_path_buf()).unwrap();
            let recovered = snapshot(&state.inner.lock().unwrap());
            assert_eq!(recovered.entries[0].job.phase, Phase::Interrupted);
            assert_eq!(recovered.entries[1].job.phase, Phase::Imported);
            assert!(recovered.started);
            assert!(!dir.path().join("jitendex.part").exists());
            assert!(!dir.path().join("state.pending").exists());
            assert_eq!(fs::read(dir.path().join("other.zip")).unwrap(), b"unowned");
        }
    }

    #[test]
    fn a_status_saved_before_sources_were_added_keeps_its_entries() {
        let dir = tempfile::tempdir().unwrap();
        let ready = r#"{"phase":"ready","received":0,"total":null}"#;
        let imported = r#"{"phase":"imported","received":0,"total":null}"#;
        fs::write(
            dir.path().join("state.json"),
            format!(
                r#"{{"started":true,"dismissed":false,"jobs":[{ready},{imported},{imported}]}}"#
            ),
        )
        .unwrap();
        let state = initialize_at(dir.path().to_path_buf()).unwrap();
        let entries = snapshot(&state.inner.lock().unwrap()).entries;
        let phases: Vec<_> = entries.iter().map(|e| (e.id, e.job.phase)).collect();
        assert_eq!(
            phases[..5],
            [
                ("jitendex", Phase::Ready),
                ("jmdict", Phase::Imported),
                ("jiten", Phase::Imported),
                ("kanjidic", Phase::Ready),
                ("jmnedict", Phase::Ready),
            ]
        );
    }

    #[test]
    fn a_kanji_source_needs_a_kanji_bank() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kanji.zip");
        let kanji = Source {
            hash: None,
            ..SOURCES[3]
        };
        fs::write(&file, archive("KANJIDIC fixture", false, false)).unwrap();
        assert!(verify(&file, &kanji).is_err());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        zip.start_file("index.json", options).unwrap();
        zip.write_all(br#"{"title":"KANJIDIC fixture","revision":"test","format":3}"#)
            .unwrap();
        zip.start_file("kanji_bank_1.json", options).unwrap();
        zip.write_all(r#"[["読","ドク","よ.む","",["read"],{}]]"#.as_bytes())
            .unwrap();
        fs::write(&file, zip.finish().unwrap().into_inner()).unwrap();
        assert!(verify(&file, &kanji).is_ok());
    }

    #[test]
    #[ignore = "official network download; isolated store only"]
    fn real_wiktionary_download() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionaries.sqlite3");
        for id in ["wty-ko-en", "wty-ko-en-ipa"] {
            let result = install(
                &state.root,
                source(id).unwrap(),
                &database,
                &Mutex::new(()),
                &|_, _, _| {},
                fetch,
            );
            assert_eq!(result.unwrap().0, Phase::Imported, "{id}");
        }
        let connection = store::open_store(&database).unwrap();
        let languages: Vec<String> = connection
            .prepare("SELECT language FROM dictionaries")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(languages, ["ko", "ko"]);
    }

    #[test]
    #[ignore = "official network downloads; isolated store only"]
    fn real_starter_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let state = initialize_at(dir.path().join("stage")).unwrap();
        let database = dir.path().join("dictionaries.sqlite3");
        for s in SOURCES.iter().filter(|s| !s.hugging_face) {
            let result = install(
                &state.root,
                s,
                &database,
                &Mutex::new(()),
                &|_, _, _| {},
                fetch,
            );
            println!("{}: {:?}", s.name, result);
            assert_eq!(result.unwrap().0, Phase::Imported);
        }
        let connection = store::open_store(&database).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM dictionaries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count,
            SOURCES.iter().filter(|s| !s.hugging_face).count() as i64
        );
        assert!(
            connection
                .query_row(
                    "SELECT count(*) FROM term_meta WHERE mode='freq'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                > 0
        );
    }
}
