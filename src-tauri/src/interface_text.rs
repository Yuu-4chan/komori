//! The words Komori's native surfaces show (the tray menu, file dialog titles and filters, a
//! backup's suggested file name and the Discord status) in the saved interface language. The frontend's message
//! catalog holds everything else; English is the fallback here as there.
use std::path::Path;

/// The interface languages, as the appearance record saves them.
pub(crate) const LANGUAGES: [&str; 11] = [
    "en", "ja", "zh-CN", "zh-TW", "ko", "de", "es", "fr", "it", "pt-BR", "ru",
];

/// The tray's items and the PC's file dialog titles are not shown on Android, which has no tray
/// and names its own document picker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) enum Text {
    ShowKomori,
    Quit,
    ImportEpubs,
    RelinkEpub,
    EpubBooks,
    AddBookFolder,
    AddDictionaries,
    DictionaryArchives,
    ChooseReaderBackground,
    BackgroundImages,
    ExportBackup,
    ImportBackup,
    KomoriBackup,
    AllFiles,
    /// A backup's suggested file name before its date.
    BackupFileName,
    SaveImage,
    Images,
    /// Discord's status line while a book is open with its title hidden.
    DiscordReading,
}

/// The saved interface language, or English when none is saved or it cannot be read.
pub(crate) fn language(database: &Path) -> &'static str {
    crate::appearance_preferences::interface_language(database)
}

/// The text in `language`; an unknown language reads English.
pub(crate) fn text(language: &str, text: Text) -> &'static str {
    use Text::*;
    let [en, ja, zh, zh_tw, ko, pt, de, es, fr, it, ru] = match text {
        ShowKomori => [
            "Show Komori",
            "Komori を表示",
            "显示 Komori",
            "顯示 Komori",
            "Komori 표시",
            "Mostrar o Komori",
            "Komori anzeigen",
            "Mostrar Komori",
            "Afficher Komori",
            "Mostra Komori",
            "Показать Komori",
        ],
        Quit => [
            "Quit",
            "終了",
            "退出",
            "結束",
            "종료",
            "Sair",
            "Beenden",
            "Salir",
            "Quitter",
            "Esci",
            "Выход",
        ],
        ImportEpubs => [
            "Import EPUBs",
            "EPUB を取り込む",
            "导入 EPUB",
            "匯入 EPUB",
            "EPUB 가져오기",
            "Importar EPUBs",
            "EPUBs importieren",
            "Importar EPUB",
            "Importer des EPUB",
            "Importa EPUB",
            "Импорт EPUB",
        ],
        RelinkEpub => [
            "Relink EPUB",
            "EPUB を再リンク",
            "重新关联 EPUB",
            "重新關聯 EPUB",
            "EPUB 다시 연결",
            "Revincular EPUB",
            "EPUB neu verknüpfen",
            "Volver a vincular EPUB",
            "Relier l’EPUB",
            "Ricollega EPUB",
            "Привязать EPUB заново",
        ],
        EpubBooks => [
            "EPUB books",
            "EPUB 書籍",
            "EPUB 图书",
            "EPUB 圖書",
            "EPUB 책",
            "Livros EPUB",
            "EPUB-Bücher",
            "Libros EPUB",
            "Livres EPUB",
            "Libri EPUB",
            "Книги EPUB",
        ],
        AddBookFolder => [
            "Add a book folder",
            "本のフォルダーを追加",
            "添加图书文件夹",
            "新增圖書資料夾",
            "책 폴더 추가",
            "Adicionar uma pasta de livros",
            "Buchordner hinzufügen",
            "Añadir una carpeta de libros",
            "Ajouter un dossier de livres",
            "Aggiungi una cartella di libri",
            "Добавить папку с книгами",
        ],
        AddDictionaries => [
            "Add dictionaries",
            "辞書を追加",
            "添加词典",
            "新增詞典",
            "사전 추가",
            "Adicionar dicionários",
            "Wörterbücher hinzufügen",
            "Añadir diccionarios",
            "Ajouter des dictionnaires",
            "Aggiungi dizionari",
            "Добавить словари",
        ],
        DictionaryArchives => [
            "Dictionary archives",
            "辞書アーカイブ",
            "词典压缩包",
            "詞典壓縮檔",
            "사전 압축 파일",
            "Arquivos de dicionário",
            "Wörterbucharchive",
            "Archivos de diccionario",
            "Archives de dictionnaires",
            "Archivi di dizionari",
            "Архивы словарей",
        ],
        ChooseReaderBackground => [
            "Choose Reader background",
            "読書画面の背景を選択",
            "选择阅读器背景",
            "選擇閱讀器背景",
            "뷰어 배경 선택",
            "Escolher o fundo do leitor",
            "Hintergrund der Leseansicht wählen",
            "Elegir el fondo del lector",
            "Choisir l’arrière-plan du lecteur",
            "Scegli lo sfondo del lettore",
            "Выбрать фон режима чтения",
        ],
        BackgroundImages => [
            "Background images",
            "背景画像",
            "背景图片",
            "背景圖片",
            "배경 이미지",
            "Imagens de fundo",
            "Hintergrundbilder",
            "Imágenes de fondo",
            "Images d’arrière-plan",
            "Immagini di sfondo",
            "Фоновые изображения",
        ],
        ExportBackup => [
            "Export backup",
            "バックアップを書き出す",
            "导出备份",
            "匯出備份",
            "백업 내보내기",
            "Exportar backup",
            "Sicherung exportieren",
            "Exportar copia de seguridad",
            "Exporter une sauvegarde",
            "Esporta backup",
            "Экспорт резервной копии",
        ],
        ImportBackup => [
            "Import backup",
            "バックアップを読み込む",
            "导入备份",
            "匯入備份",
            "백업 가져오기",
            "Importar backup",
            "Sicherung importieren",
            "Importar copia de seguridad",
            "Importer une sauvegarde",
            "Importa backup",
            "Импорт резервной копии",
        ],
        KomoriBackup => [
            "Komori backup",
            "Komori バックアップ",
            "Komori 备份",
            "Komori 備份",
            "Komori 백업",
            "Backup do Komori",
            "Komori-Sicherung",
            "Copia de seguridad de Komori",
            "Sauvegarde Komori",
            "Backup di Komori",
            "Резервная копия Komori",
        ],
        AllFiles => [
            "All files",
            "すべてのファイル",
            "所有文件",
            "所有檔案",
            "모든 파일",
            "Todos os arquivos",
            "Alle Dateien",
            "Todos los archivos",
            "Tous les fichiers",
            "Tutti i file",
            "Все файлы",
        ],
        BackupFileName => [
            "Komori backup",
            "Komori バックアップ",
            "Komori 备份",
            "Komori 備份",
            "Komori 백업",
            "Backup do Komori",
            "Komori-Sicherung",
            "Copia de seguridad de Komori",
            "Sauvegarde Komori",
            "Backup di Komori",
            "Резервная копия Komori",
        ],
        SaveImage => [
            "Save image",
            "画像を保存",
            "保存图片",
            "儲存圖片",
            "이미지 저장",
            "Salvar imagem",
            "Bild speichern",
            "Guardar imagen",
            "Enregistrer l’image",
            "Salva immagine",
            "Сохранить изображение",
        ],
        Images => [
            "Images",
            "画像",
            "图片",
            "圖片",
            "이미지",
            "Imagens",
            "Bilder",
            "Imágenes",
            "Images",
            "Immagini",
            "Изображения",
        ],
        DiscordReading => [
            "Reading",
            "読書中",
            "阅读中",
            "閱讀中",
            "독서 중",
            "Lendo",
            "Liest",
            "Leyendo",
            "En lecture",
            "Sta leggendo",
            "Читает",
        ],
    };
    match language {
        "ja" => ja,
        "zh-CN" => zh,
        "zh-TW" => zh_tw,
        "ko" => ko,
        "de" => de,
        "es" => es,
        "fr" => fr,
        "it" => it,
        "pt-BR" => pt,
        "ru" => ru,
        _ => en,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Text; 18] = [
        Text::ShowKomori,
        Text::Quit,
        Text::ImportEpubs,
        Text::RelinkEpub,
        Text::EpubBooks,
        Text::AddBookFolder,
        Text::AddDictionaries,
        Text::DictionaryArchives,
        Text::ChooseReaderBackground,
        Text::BackgroundImages,
        Text::ExportBackup,
        Text::ImportBackup,
        Text::KomoriBackup,
        Text::AllFiles,
        Text::BackupFileName,
        Text::SaveImage,
        Text::Images,
        Text::DiscordReading,
    ];

    #[test]
    fn every_language_names_every_native_text_and_unknown_ones_read_english() {
        for language in LANGUAGES {
            for item in ALL {
                let shown = text(language, item);
                assert!(!shown.trim().is_empty(), "{language} {item:?}");
                // A file name part never holds a character Windows refuses.
                assert!(!shown.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']));
            }
        }
        for item in ALL {
            assert_eq!(text("ar", item), text("en", item));
        }
        assert_eq!(text("ja", Text::Quit), "終了");
        assert_eq!(text("pt-BR", Text::ShowKomori), "Mostrar o Komori");
        assert_eq!(text("zh-TW", Text::AllFiles), "所有檔案");
        assert_eq!(text("ru", Text::Quit), "Выход");
    }
}
