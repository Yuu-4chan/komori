//! The words Komori's native surfaces show (the tray menu, file dialog titles and filters, a
//! backup's suggested file name and the Discord status) in the saved interface language. The frontend's message
//! catalog holds everything else; English is the fallback here as there.
use std::path::Path;

/// The interface languages, as the appearance record saves them.
pub(crate) const LANGUAGES: [&str; 5] = ["en", "ja", "zh-CN", "ko", "pt-BR"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    /// Discord's status line after 5 minutes without reading or using a page, or with nothing
    /// to show.
    DiscordIdle,
    /// Discord's status line while each page outside the Reader is in use.
    DiscordLibrary,
    DiscordDictionary,
    DiscordStatistics,
    DiscordSettings,
}

/// The saved interface language, or English when none is saved or it cannot be read.
pub(crate) fn language(database: &Path) -> &'static str {
    crate::appearance_preferences::interface_language(database)
}

/// The text in `language`; an unknown language reads English.
pub(crate) fn text(language: &str, text: Text) -> &'static str {
    use Text::*;
    let [en, ja, zh, ko, pt] = match text {
        ShowKomori => [
            "Show Komori",
            "Komori を表示",
            "显示 Komori",
            "Komori 표시",
            "Mostrar o Komori",
        ],
        Quit => ["Quit", "終了", "退出", "종료", "Sair"],
        ImportEpubs => [
            "Import EPUBs",
            "EPUB を取り込む",
            "导入 EPUB",
            "EPUB 가져오기",
            "Importar EPUBs",
        ],
        RelinkEpub => [
            "Relink EPUB",
            "EPUB を再リンク",
            "重新关联 EPUB",
            "EPUB 다시 연결",
            "Revincular EPUB",
        ],
        EpubBooks => [
            "EPUB books",
            "EPUB 書籍",
            "EPUB 图书",
            "EPUB 책",
            "Livros EPUB",
        ],
        AddBookFolder => [
            "Add a book folder",
            "本のフォルダーを追加",
            "添加图书文件夹",
            "책 폴더 추가",
            "Adicionar uma pasta de livros",
        ],
        AddDictionaries => [
            "Add dictionaries",
            "辞書を追加",
            "添加词典",
            "사전 추가",
            "Adicionar dicionários",
        ],
        DictionaryArchives => [
            "Dictionary archives",
            "辞書アーカイブ",
            "词典压缩包",
            "사전 압축 파일",
            "Arquivos de dicionário",
        ],
        ChooseReaderBackground => [
            "Choose Reader background",
            "読書画面の背景を選択",
            "选择阅读器背景",
            "뷰어 배경 선택",
            "Escolher o fundo do leitor",
        ],
        BackgroundImages => [
            "Background images",
            "背景画像",
            "背景图片",
            "배경 이미지",
            "Imagens de fundo",
        ],
        ExportBackup => [
            "Export backup",
            "バックアップを書き出す",
            "导出备份",
            "백업 내보내기",
            "Exportar backup",
        ],
        ImportBackup => [
            "Import backup",
            "バックアップを読み込む",
            "导入备份",
            "백업 가져오기",
            "Importar backup",
        ],
        KomoriBackup => [
            "Komori backup",
            "Komori バックアップ",
            "Komori 备份",
            "Komori 백업",
            "Backup do Komori",
        ],
        AllFiles => [
            "All files",
            "すべてのファイル",
            "所有文件",
            "모든 파일",
            "Todos os arquivos",
        ],
        BackupFileName => [
            "Komori backup",
            "Komori バックアップ",
            "Komori 备份",
            "Komori 백업",
            "Backup do Komori",
        ],
        SaveImage => [
            "Save image",
            "画像を保存",
            "保存图片",
            "이미지 저장",
            "Salvar imagem",
        ],
        Images => ["Images", "画像", "图片", "이미지", "Imagens"],
        DiscordReading => ["Reading", "読書中", "阅读中", "독서 중", "Lendo"],
        DiscordIdle => ["Idle", "退席中", "闲置", "자리 비움", "Ausente"],
        DiscordLibrary => [
            "Browsing the library",
            "本棚を閲覧中",
            "浏览书架中",
            "서재 둘러보는 중",
            "Navegando na biblioteca",
        ],
        DiscordDictionary => [
            "Using the dictionary",
            "辞書で検索中",
            "查词典中",
            "사전 검색 중",
            "Usando o dicionário",
        ],
        DiscordStatistics => [
            "Viewing statistics",
            "統計を確認中",
            "查看统计中",
            "통계 확인 중",
            "Vendo estatísticas",
        ],
        DiscordSettings => [
            "Changing settings",
            "設定を変更中",
            "调整设置中",
            "설정 변경 중",
            "Ajustando configurações",
        ],
    };
    match language {
        "ja" => ja,
        "zh-CN" => zh,
        "ko" => ko,
        "pt-BR" => pt,
        _ => en,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Text; 23] = [
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
        Text::DiscordIdle,
        Text::DiscordLibrary,
        Text::DiscordDictionary,
        Text::DiscordStatistics,
        Text::DiscordSettings,
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
            assert_eq!(text("fr", item), text("en", item));
        }
        assert_eq!(text("ja", Text::Quit), "終了");
        assert_eq!(text("pt-BR", Text::ShowKomori), "Mostrar o Komori");
    }
}
