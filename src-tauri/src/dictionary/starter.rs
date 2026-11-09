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
const MAX_JOURNAL: u64 = 512 * 1024;
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
    #[cfg_attr(not(windows), allow(dead_code))]
    url: &'static str,
    #[cfg_attr(not(windows), allow(dead_code))]
    asset_repository: Option<&'static str>,
    /// Hugging Face answers from its CDN.
    #[cfg_attr(not(windows), allow(dead_code))]
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
    wiktionary!("ja", "cs", "2c890ff86cc85b92f11db1b24e22a2a736b906e0053397fa427872001788a6e6"),
    wiktionary!("ja", "en", "f4ad518b5dec38a3db6cb5f6bdac78f0f00072b45a9dd5891fc2977fd420194e"),
    wiktionary!("ja", "it", "4887bea20d49b806e5320e32e9ff523d5989ecc5bc35859dc27ed3bd9d785004"),
    wiktionary!("ja", "ko", "d01201b4c36b6454c17128c60cb1106ae4ed3496782ff3b51cc59c36979d74de"),
    wiktionary!("ja", "ku", "2262e6601f0d0208af0bb0b31e9f810e42e80923735c5d0d47672abaa5e3cfd5"),
    wiktionary!("ja", "nl", "256f150058c0fac5a3e478848a44075cb117d4e38d3442d12253c4f79d2b94d7"),
    wiktionary!("ja", "pl", "45a3f73f71a44315aeeb9a4e40e7ca11dd04c08d83017c82b33d0b4b134dad75"),
    wiktionary!("ja", "pt", "d2ab7fb25e3d62c2b140a0d6e282f4c89b7501c0a8429b4f84c9e406fc3c32fc"),
    wiktionary!("ja", "ru", "4255c378e011efe3e27b38cc60884de0a1b6fc77e8c247f54dafc9e2c02ebfe8"),
    wiktionary!("ja", "th", "3260505f974c9e9eea0f97affcaa90ba24ae70e26574a3703c788f89ccac570f"),
    wiktionary!("ja", "tr", "b084cc6e41a007a61439befb1656f99debb5c6d7ad0234d526273e76ca888be9"),
    wiktionary!("ja", "vi", "a9d3902d42c96537b0089732ac7148f0bc36aaf9aef41a1a5a91c0f5cae63a61"),
    wiktionary!("en", "cs", "1346f6ea142616699c4c7be2885d02d7d4065adc78f2ce8f1226810c0c8bf03e"),
    wiktionary!("en", "el", "12363fc097494be02dfedf0672027d7d14a72dbd88d1b3d6cbd944b05523b65f"),
    wiktionary!("en", "ku", "8d29c082b12471bcdbf984558824c626bca69af918aca40eeb7a1791f9e27bd6"),
    wiktionary!("en", "ms", "009ae82e6e7cd70e1762e0a0d5f8550ffba32a5debda0f14d80fd48337f0d605"),
    wiktionary!("en", "nl", "e94eb684f6e085abddd3d00a6161211581941b5535662781b7fbb43ce0536671"),
    wiktionary!("en", "pl", "213f2c18e53d26058f758cbfaec7907d4558937090c6c6c974e61ab4c6e49a1b"),
    wiktionary!("en", "th", "3432c14754111f92a78cb9371f5f66310eee43bdc69e76f7b3aae1a8fdb4bee6"),
    wiktionary!("en", "tr", "1970c0149bdd321b62eb61a8ef2e2d106f2560903709d2144ca12ea033c6e9d9"),
    wiktionary!("en", "vi", "60a82629141966152014612e70557426dce6c5e27f1d022bdef9c555f894ace6"),
    wiktionary!("fr", "cs", "e50a298575d4df36c9793ffd7a6dae39d3c01b80dc7b07980b6f3e0959684670"),
    wiktionary!("fr", "de", "c81ed4e21054c64c3d3e496155832732539fa7e4e19c3fc0a0a9793e1092b491"),
    wiktionary!("fr", "el", "ac860e6ebb300d7a100df6f6565d3946f04375338d83f7096a31091f363403a5"),
    wiktionary!("fr", "es", "6a5fd1e16bfa6a69ae7a1484c7ac3b42312de94b1640870a2667a473f914ea2e"),
    wiktionary!("fr", "it", "6a39f9e3a17c878f92c804768f285afd97437d38f91a21b07c0a6c2016f26e62"),
    wiktionary!("fr", "ja", "276900f9a0bf1292da4f00aa8de5fe06e3d9df578f086974e1b7ae38e8adf687"),
    wiktionary!("fr", "ko", "9da70e3890fd708c1101829149fda1f41a3c3ae30094e4442939ab704774e66e"),
    wiktionary!("fr", "ku", "1a21385422573d32b6a09dbbd0377fa999ff07441c1f451fcab495531bde5350"),
    wiktionary!("fr", "nl", "be8274ade1dec86389db4fa831995d9a0e4e9b5221346f6ba5d0d8611fb2cf1d"),
    wiktionary!("fr", "pl", "4d245b67d965bb4bab730dc130113e4f3f3f2fa5d3e8f2f1642a25a55df3717d"),
    wiktionary!("fr", "pt", "2f3215041861c25f023ec0396265fee604e8908543d3d3e6b52bcc1d263b0180"),
    wiktionary!("fr", "th", "e8c14cb2c2a6e02e50ea6192d0d37841f46cb730a13761682e56ff956a7b838a"),
    wiktionary!("fr", "tr", "bb12b600c084e9cd9ad9a54eecfb6f92d86a15de4c8b3fc5f7dc87f3976556d9"),
    wiktionary!("fr", "vi", "08f15ffc93ff6a55c0738d1872cfb2e0c7c87eca6421309dae24b9936478e7c2"),
    wiktionary!("pt", "de", "758fa72d0ebb65ddfa73e35f9391a657a481c591d3308e9f5c9a1fb12e479a82"),
    wiktionary!("pt", "el", "25d52fccd82421e024051e9247715b1cd872537c0efbdc07313b96b23d4f4056"),
    wiktionary!("pt", "es", "771204e1dd6980b954de6d923120bb785eeeb3ea7d7733bb749712f697dd7e40"),
    wiktionary!("pt", "fr", "c416eba2655b427dabe86b74ba13db296aaa248619f9e97befefb60308588540"),
    wiktionary!("pt", "ja", "3e0d7ec8178399dcfc1c028aed49d74ac6f62e0d74d545a66446a472f902e55b"),
    wiktionary!("pt", "ku", "eec0cb2943bd4e3e68c63886b64d3d5c280219616220dfe0d9ca0d4eb799c325"),
    wiktionary!("pt", "pl", "3ad153ac2ba269150bbb992ee1ee0b928c67ae9533c0270cf7020c6eea0861d3"),
    wiktionary!("pt", "ru", "879adb6424b6213a2faa7a9731df4e71b1e50be475b4a52c8639d9c148f664f4"),
    wiktionary!("pt", "th", "e9d0b939fa9d17ca713df26ec729a3234d71d3199a7bd3fbee00ce5577f4cf26"),
    wiktionary!("pt", "tr", "04aeab039ad970a81c63fd7733e05dd57008556157ecf6c60b5640d320ec9f1d"),
    wiktionary!("it", "cs", "83e9df00505fe1dbc724bfb5797065c7d76722f1a10f2b611cfec690d9e7b89b"),
    wiktionary!("it", "de", "55f83c6c24b42f778977ab72d43e7097fd501140ca174d6d3a945867ecdc522b"),
    wiktionary!("it", "el", "8b1ade04bad703ab84ff452c699b1a85f733220a91dc90c8431ad3357d8b222d"),
    wiktionary!("it", "es", "fdeb3f66368c921c19c6ad537af600f607c8c8bfbc4751d41d6086e87b78e203"),
    wiktionary!("it", "ja", "c6613137aaaa7eb24be0a58a7bec91710ae0c3dc72ab0ad61f7bb77903cee850"),
    wiktionary!("it", "ko", "c4438b2a198911c9a4f983e2dbce891445feddcf4c7260568ddbfa5707d0de5d"),
    wiktionary!("it", "ku", "23bba5a07fba8c7fd54509154f8308d4183fa765bcb39bae41c4c33bb781deac"),
    wiktionary!("it", "nl", "b9f58cae1cba8c852c3778bd14fb71f5a6dca0df4c284ff59fb703b9398e72b1"),
    wiktionary!("it", "pl", "bdfcfe7c2d9d2695a75317f00672bcd86698881a23d8b6554ce713aa17a6d5ef"),
    wiktionary!("it", "pt", "786b1bed008b357c30d994ca013386aa43a5aa100f349d83788a422596abeaa7"),
    wiktionary!("it", "ru", "a8b7b885b7ddfa86f2ec19cc4a4f6a097d7a0389632f86e4d3be8958f8ce2b86"),
    wiktionary!("it", "th", "8335561691d42d642d2f6a4d4e5df7e5c75e34a2db9af0d78288809630f9a508"),
    wiktionary!("it", "tr", "9f71d263ea0ff86f120e5774ec3d257a851750677a73a41c8e22224e92836537"),
    wiktionary!("es", "cs", "793a273542c2c450480ba19acadf5765425a8bfe5bf9bb123a574e478f87565e"),
    wiktionary!("es", "de", "349c7cca3094ce40ac2f5c83f37a78f1716229a186e0d483b9f2c4a43009d6d2"),
    wiktionary!("es", "el", "9161df63ff96224b1faa3066e4712713019ae7dfdd584b35ae553517b19550b8"),
    wiktionary!("es", "it", "9436dd8fab395ad05b71d2d5323f871109a349502c1c2a5ea74401371db32f92"),
    wiktionary!("es", "ja", "02761b820142fbade84eff5a2ac9d0961d47ed0d978f19599d82e3e541de4b8d"),
    wiktionary!("es", "ko", "53b7fd29b62e6dc86e262a76e8cb8b8536942353fa4a2b50fff871ed4e6f942f"),
    wiktionary!("es", "ku", "361b8f22ef6cf153e376a9ef9cdc49a6baaf27985128d43e225d236b8edb553e"),
    wiktionary!("es", "nl", "9c99a76fabe3ad113faa95de4c829b7382c8935704e1ed08a6eb45609d66c627"),
    wiktionary!("es", "pl", "b211763134c983ea698a95bcc5756815f0279475cb3d45574cc55ae2fb8caecb"),
    wiktionary!("es", "pt", "c3368b53b89b9a236baf67c1bf5511e405ecc254cedafdf51f3aa7aabd9f0673"),
    wiktionary!("es", "th", "501538d41c212c89b7853aa34919e2ad96600c3b046714fbb9485b864a2807ee"),
    wiktionary!("es", "tr", "2bf5ee27effdf16909417119843b69834d4fbc03a493c6e04dadc6fea53dcd29"),
    wiktionary!("es", "vi", "41e820ab58e4f5e91250fe82d12be227e7b1ec5d838144369b8dc9c0491d4087"),
    wiktionary!("ko", "ku", "bccd5d28a1c4efc66f7782a8324b26a049b249ad2dcf1e1cd93803fd51655264"),
    wiktionary!("ko", "pl", "819a0400ed21738b1d745ce34066955d4001550ee847bc433a1d456b247ed27d"),
    wiktionary!("ko", "ru", "e07b1bbf03e098adc13bfaaffe4fae78f87a777ca3d6f271269b66d8b6e95072"),
    wiktionary!("zh", "it", "118f10f5757c1e0837170cc510f93cbb86b34c9eca38dedeca734259e7d899de"),
    wiktionary!("zh", "ko", "184690737749c243b2c1a31c4be70ccf5caeb6535590bb88974f0fa1adcce670"),
    wiktionary!("zh", "pl", "8ffcfa94ac4965d6331e3bc0e0b89d8cd3fdf3f2acb0b269f640df1bf66bbe99"),
    wiktionary!("zh", "th", "9e417aebdc9ad1ed3c8b750fd4b84e8fe3ee268bc475aa5758e173d3e364a0dc"),
    wiktionary!("zh", "vi", "ab2572671ec71bf1f13e4146fa6f2bf39d8ddd3886d28586c59db06d886ed4f1"),
    wiktionary!("zh", "zh", "e75fbcb3f58a0167ea2ba58f5fd3c69b802f34c026cbdac41cc21cf1dc6b8b54"),
    wiktionary!("de", "cs", "8e426bf809d76d973606d0167978c137ad30c557f93bd5050e67f0ee6a9130f4"),
    wiktionary!("de", "de", "96b05243f25c8f9510322887d7dbcbb62054d56dd3f2c58f3c5e0586e55a57a0"),
    wiktionary!("de", "el", "859c81379625735b2cc109eb024104f25e250c48ecdc110c3dac4918241b283d"),
    wiktionary!("de", "es", "f68c977171801406d394d5fbaea1fd5f9e245e787f9738c599f8241eebcf0882"),
    wiktionary!("de", "it", "1432b69232420fe715e133da5d8cff0829b7196eaf34d3761cb0f30329cebafc"),
    wiktionary!("de", "ja", "e1420762018b001d7416d0359867e2d75bb9b04f6572afa80030e7562cbec6e8"),
    wiktionary!("de", "ko", "1f15558c4eaa8dc029be02450bf39ec2982dfcafa01c6ed779e20351f988e55f"),
    wiktionary!("de", "ku", "4ffee6fb4c342bf899d6f3689c5ab8db4f1375635a9056f786d7ebfd5a5132d6"),
    wiktionary!("de", "nl", "b9ec9552a4b0453e75fab70c09eb7fe6d7f91ca63c40625e910fd45552479809"),
    wiktionary!("de", "pl", "6af04bc13114d03eecf0e3f11b3c552ca6045cc69970c3236c5fe8b30824a67f"),
    wiktionary!("de", "pt", "6797d11d2003093c5ddf2efda369186009f1b09a01660b0dd06e26c8e6c7c487"),
    wiktionary!("de", "ru", "e69831132270c07e13341f42fd1481d324b29b246776b1ee0c1d587779e1e211"),
    wiktionary!("de", "th", "0cc6c901a48a5f3b3676d6c16e0b25779093fbcafeba58f77f0d78526a40d38e"),
    wiktionary!("de", "tr", "770d1c92a9445f43ca618c557650ec60502c8780a466cfadc0617fe30aef83d5"),
    wiktionary!("ru", "cs", "9674493ad942913bd1cc50dbd39a450b343c0b1fe44f7e857fb3f919eeb61090"),
    wiktionary!("ru", "de", "1d8e227c687758a6a66e00369120f7515910e2ee882969ab67d3e1ca1a8292d6"),
    wiktionary!("ru", "el", "5b0674f4310a95cd50e8532dc24e8745dc2060d9bd69507de3cd8047cc43de03"),
    wiktionary!("ru", "ja", "b435f163ce6e55f0e7e8df5dcb46b0b8b4dd78654f88b8e28c150683fadfd660"),
    wiktionary!("ru", "ko", "e3c9c5210cd612a617ebea9facad6ede448f5bd0e30fe4ba305ee1b7816384f8"),
    wiktionary!("ru", "ku", "f49e18de802336dbfa38c8861b12908eeb506083e4325ba930de5276f48cb721"),
    wiktionary!("ru", "nl", "a413a91f9f82616b827c52de55542291df9cff9f0e0c79758c98032701b4f34a"),
    wiktionary!("ru", "pl", "288295c33a60685d69c019e0fe6513e501794eb1d43e9393c4975701e63bd0f0"),
    wiktionary!("ru", "pt", "900b673b8ea5375c8adf33fee3942bbf359cc5f991f1d01bd489c97eb59384f9"),
    wiktionary!("ru", "tr", "a3dd3d8450547c2bec5a5597f057300a28f01e4729b41118fb304265811ad84c"),
    wiktionary!("ru", "vi", "0ee1de87d5e64b0dcebdf9ee15e3d552702ff2b1411f8f11e60e7e4a9b50a5ba"),
    wiktionary_ipa!("ja", "cs", "2a273ec088249d41047bb22887567074e25b9d7fa776a350eb1f037b5eb8b3c5"),
    wiktionary_ipa!("ja", "en", "f6d5e865957e85004146097d09f945141f2641d123c851fbd27d43167a64e747"),
    wiktionary_ipa!("ja", "fr", "9ec8c139f4fb973027b94046c53cc647457eebdf1beeed41a46b0a11db91e90e"),
    wiktionary_ipa!("ja", "ko", "d2eb3860fde1da33aa4ce8f88d23301e4f4ee19abdb8c876f0a20bce73bb17a7"),
    wiktionary_ipa!("ja", "zh", "4f3f6358bd09e3afab4494883ffecbe74eebfd91b991859c0df5941937b3c50c"),
    wiktionary_ipa!("en", "cs", "3c6480dd481efe1b05cdb454284b4e286239c070cd89dfc2a60d882d9ec78bdf"),
    wiktionary_ipa!("en", "el", "eab21508b35dd634b4ba6ccf9537d51d309ca080ff97838dfe6665968d98b407"),
    wiktionary_ipa!("en", "nl", "5b581b2de0be35d858a9105c6beefa165033a7bee358b91015f724d87ba3414a"),
    wiktionary_ipa!("en", "pl", "668fb8e6b805f9276f7fe2bc51b57f5253d9654a9de7aafa5c46fa832bd16cc3"),
    wiktionary_ipa!("en", "th", "4713b5a75167e3fe0a31e9718d895165cdf7299d8edaf224f9691f6504a70865"),
    wiktionary_ipa!("en", "vi", "29fa0d31dc8569adc08b1c73a7026b051c824ef0282b4416f12c56aedb5dcdde"),
    wiktionary_ipa!("fr", "cs", "44441ef9af840a660dfe2f345065b3610b3f5a042f5c2936bc15cb8b8c9580b6"),
    wiktionary_ipa!("fr", "de", "e4612677e50caa708c8ff2d23b9ee960124eefe88184dffbc4d02532b8a32fbe"),
    wiktionary_ipa!("fr", "el", "331a7c2dc4fbde47be1d0a2a9a47a013228b58f4027b0cf429c0e4c2f76ae9c9"),
    wiktionary_ipa!("fr", "es", "25db8c848644bbc898a57bce72820e1e98ac1b9fea0909fe159a5a1745c79cd8"),
    wiktionary_ipa!("fr", "it", "8afff40864c497d9a84453d216405b6d4f35ddf24680a11361fcb67c649ed2ab"),
    wiktionary_ipa!("fr", "ja", "31269b55b42594904d4c569f1846466d4a7354e5dbbc1797bfddcd6869ed51b1"),
    wiktionary_ipa!("fr", "nl", "beb5b733d678875592b180eee19d4da17f29503cacff2e4fe5e110fc477e0006"),
    wiktionary_ipa!("fr", "pl", "272d1d7fe768deffc75a7b8a4015dc86c51381cb493ec767dde79b83436d5e73"),
    wiktionary_ipa!("fr", "th", "c2255dda7744075a9a04f79491d48ae897824502a992854d8c24a4a5d43bace8"),
    wiktionary_ipa!("pt", "de", "b5ddbc3fd00280ded8958bd518efd6d32ef580d1f01d03374aca04d392cc6d5a"),
    wiktionary_ipa!("pt", "es", "4994e829db47b0970e27ea286cbce08a7032e6da89d864842658f6024477c3bc"),
    wiktionary_ipa!("pt", "fr", "1f6163b6e07cfcce2bc1c5a007e9938498b69ec82a12a81f9d932cfa4a4e6c5b"),
    wiktionary_ipa!("pt", "ja", "af07e2b453c5e388e36df87137105a729e0fec7acd72383a7ee8556a0e865450"),
    wiktionary_ipa!("pt", "pl", "de07f0fee6fd7b0cbfa22239e324826a27f285fc091866c2f1a27298b49c5d75"),
    wiktionary_ipa!("pt", "th", "7cba1b5e72728fde0e4de2714a583d76bec86b82bd92a3a23899a995b642bea2"),
    wiktionary_ipa!("it", "de", "7aa24659d531b8ea40f4851413c52e0bc29da9b86a611ad4022a3f355a72ca44"),
    wiktionary_ipa!("it", "es", "d5974a33b63607a2f5952022353ad9a16fc589d9b77e3cabb37cb196c4017f47"),
    wiktionary_ipa!("it", "pl", "bbf51a84e932544318c9efd1e1fac4e466b277887f697620aa693b333d8405ed"),
    wiktionary_ipa!("es", "de", "3684786a4d29e84cb671bee4f68e77c1271297b95384fc65c9073560a3b44ace"),
    wiktionary_ipa!("es", "ja", "165b5a88dc1294a0c8a00d3e6ba3a911628bebfbf594172839e5e06faba8fc20"),
    wiktionary_ipa!("es", "pl", "1f68bad20f9acf1261b1804bbeede64006e0e4b6811372e7c8c7fb2bab9f0e3a"),
    wiktionary_ipa!("zh", "pl", "f794928da4531844cb5ffd77edf7e06b8a9bcec1d0341424c41de3654b35d281"),
    wiktionary_ipa!("zh", "th", "bf6fc46589a48e596953f4df79e6f75d6a1e3c137e78c535ec2b9654a44f7190"),
    wiktionary_ipa!("zh", "vi", "bb32cc5f867b20363aa7ac65d07b84f72ab34c73cf299aef4a17bbf4a05c2e69"),
    wiktionary_ipa!("zh", "zh", "238e6ea368e77ff41175965cbe3f53f36fc9efd8b73b4dc74ed617880dcd49d1"),
    wiktionary_ipa!("de", "cs", "9baa6aa8abd8e2cbcd33fb7aa5e67bb430f13fb4894564813966673b1ca91a3b"),
    wiktionary_ipa!("de", "de", "5d27647518cd13b5a1b54dd2a8f4d113cb6a74972217bcd38e920e309f6ec1e3"),
    wiktionary_ipa!("de", "es", "6cf2a102b71fad331ff187ee032a6ac9ada60efdae85f4fd94154b54c46e06be"),
    wiktionary_ipa!("de", "it", "ee8ccb45df70da389cbd256bf19bd0dabfa24f9e4d23e41d5966a289d85c569a"),
    wiktionary_ipa!("de", "ja", "1e34a367894849641a15459915a8b4c4b2b67bd31548e7a92bf8a0ac28c1da5b"),
    wiktionary_ipa!("de", "ko", "d1afe01dc2ae56cb2c8be4d45d0d3a398ff85b4826e336c4dc9f81d4caf87da4"),
    wiktionary_ipa!("de", "nl", "18f1a3648a1ff2bfa048ab4a27f1434320fad846af1b9d996f15a5afe295950c"),
    wiktionary_ipa!("de", "pl", "c18dd3b646eb823af296958d394794a83aeb9c34a1c8e66a7bf4732f842b0e0d"),
    wiktionary_ipa!("de", "pt", "e598caa71ba400462fb28bdba0fb4f7be4abd89815f731c2604dbe0b9dee8fd5"),
    wiktionary_ipa!("de", "ru", "85429a752a81fd99cf314d2f17ba91e737250aa9901639f3756150730d89876d"),
    wiktionary_ipa!("de", "th", "2de8c981dde3f4fac55cd7cf8dfb1a84e621e2e7a0332f628067923693c5ca7e"),
    wiktionary_ipa!("ru", "cs", "879bd3086faa8cd667251ab3944365b72a1764f4b7d25f11e3fa56adbacd9603"),
    wiktionary_ipa!("ru", "de", "40f28625188e0ec1019fc9195a6978e107032c37e8773cae754943d426230c57"),
    wiktionary_ipa!("ru", "ja", "a3a47b1820fdacda6a62e61b8f45d307f31ff2366203a5506debce789031355f"),
    wiktionary_ipa!("ru", "ko", "ec4dfd3b8c567a5862baffc104a8d4e1285b357ef37a1400e4c0ea5cebd54a91"),
    wiktionary_ipa!("ru", "pl", "d835fc0baa9e2c4f3ca3a2b8cd36ee4e783b98993ca8da4194c82fc5d2299e05"),
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

/// Elsewhere, as on the phone, the same download through Komori's HTTP client: one allowed
/// redirect, the same limits, and progress every 256 KiB.
#[cfg(not(windows))]
fn fetch(s: &Source, file: &mut File, progress: Progress<'_>) -> Result<(), String> {
    use reqwest::{header::LOCATION, redirect::Policy, StatusCode};
    use std::time::{Duration, Instant};
    let client = crate::http::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .build()
        .map_err(|_| FAILURE)?;
    let started = Instant::now();
    tauri::async_runtime::block_on(async {
        let mut url = s.url.to_owned();
        for hop in 0..=1 {
            let mut response = client.get(&url).send().await.map_err(|_| FAILURE)?;
            if response.status() == StatusCode::FOUND && hop == 0 {
                let next = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|location| location.to_str().ok())
                    .ok_or(FAILURE)?;
                if !allowed_redirect(s, next) {
                    return Err(FAILURE.into());
                }
                url = next.to_owned();
                continue;
            }
            if response.status() != StatusCode::OK {
                return Err(FAILURE.into());
            }
            let total = response.content_length();
            if total.is_some_and(|size| size == 0 || size > MAX_DOWNLOAD) {
                return Err(FAILURE.into());
            }
            let mut received = 0u64;
            let mut announced = 0u64;
            while let Some(chunk) = response.chunk().await.map_err(|_| FAILURE)? {
                if started.elapsed().as_secs() > 600 {
                    return Err(FAILURE.into());
                }
                received += chunk.len() as u64;
                if received > MAX_DOWNLOAD || total.is_some_and(|size| received > size) {
                    return Err(FAILURE.into());
                }
                file.write_all(&chunk).map_err(|_| FAILURE)?;
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
        Err(FAILURE.into())
    })
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
