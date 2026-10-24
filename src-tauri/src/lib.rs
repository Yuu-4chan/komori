#[cfg(windows)]
mod alt_menu;
mod anki;
mod app_icon;
mod appearance_preferences;
mod backup;
mod book_details;
mod book_image_export;
mod bookmarks;
mod bulk_progress;
mod clipboard;
mod covers;
mod dictionary;
mod discord_presence;
mod epub;
#[cfg(windows)]
mod event_target;
mod external_link;
mod failure;
mod interface_text;
mod library;
mod library_drop;
mod library_folders;
mod reader_background;
mod reader_content;
mod reader_fonts;
mod reader_monitor;
mod reader_notes;
mod reading_position;
mod reading_sessions;
mod startup;
mod title_cleaning;
mod updates;
mod window_lifecycle;
mod window_size;
mod word_audio;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One Komori at a time: opening it again, even from a shortcut while it waits in the
        // tray, shows the running window instead of a second copy writing the same catalog.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            window_lifecycle::second_launch(app)
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .manage(reader_content::ReaderArchives::default())
        .register_asynchronous_uri_scheme_protocol("komori-book", reader_content::serve_book)
        .register_asynchronous_uri_scheme_protocol("komori-cover", covers::serve_cover)
        .register_asynchronous_uri_scheme_protocol("komori-font", reader_fonts::serve_font)
        .register_asynchronous_uri_scheme_protocol(
            "komori-background",
            reader_background::serve_background,
        )
        .setup(|app| {
            let catalog = library::initialize_catalog(app.handle())?;
            #[cfg_attr(not(windows), allow(unused_variables))]
            let window = window_size::create_main_window(app.handle(), &catalog.database)?;
            app.manage(library_drop::LibraryDropState::default());
            library_drop::install(&window);
            window_lifecycle::install(app.handle(), &catalog.database);
            app_icon::apply(app.handle(), app_icon::saved(&catalog.database).as_deref());
            #[cfg(windows)]
            event_target::forward_close_to(&window);
            #[cfg(windows)]
            alt_menu::guard(&window);
            // Books from before the current cover resolver get their covers in the background,
            // the Library refreshing as they arrive; then libraries from before thumbnails get
            // theirs, and a card that needs a cover sooner builds its own on request.
            let database = catalog.database.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = library::backfill_covers_at(&database, Some(&handle)) {
                    eprintln!("Komori covers could not be backfilled: {error}");
                }
                if let Err(error) = covers::build_missing_thumbnails(&database) {
                    eprintln!("Komori cover thumbnails could not be built: {error}");
                }
            });
            // Books from before Komori read languages, series, and text counts get them once,
            // and the Library refreshes as they arrive.
            let database = catalog.database.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = book_details::build_missing(&database, Some(&handle)) {
                    eprintln!("Komori book details could not be read: {error}");
                }
            });
            // Automatic snapshots, when they are on, from shortly after startup.
            backup::start_automatic(catalog.database.clone());
            app.manage(discord_presence::start(catalog.database.clone()));
            app.manage(catalog);
            app.manage(backup::BackupState::default());
            app.manage(reader_fonts::initialize(app.handle())?);
            app.manage(dictionary::store::initialize_store(app.handle())?);
            app.manage(dictionary::starter::initialize(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::check_for_update,
            updates::install_update,
            word_audio::get_word_audio,
            reader_monitor::get_reader_monitor_size,
            reader_background::get_reader_background,
            reader_background::choose_reader_background,
            reader_background::remove_reader_background,
            reader_fonts::check_system_font,
            reader_fonts::list_system_fonts,
            reader_fonts::list_reader_fonts,
            reader_fonts::imports::import_reader_fonts,
            reader_fonts::download_reader_font,
            reader_fonts::remove_reader_font,
            anki::get_anki_preferences,
            anki::save_anki_preferences,
            anki::discover_anki,
            anki::create_anki_lapis,
            anki::create_anki_note,
            anki::check_anki_note,
            anki::get_anki_pending_requests,
            anki::browse_anki_note,
            anki::get_anki_note_statuses,
            external_link::open_external_link,
            clipboard::read_clipboard_text,
            book_image_export::save_book_image,
            library::list_library,
            library::get_library_book,
            library::import_books,
            library_drop::import_dropped_books,
            library::relink_book,
            library::remove_book,
            library::remove_books,
            library::get_library_store_size,
            library_folders::list_library_folders,
            library_folders::add_library_folder,
            library_folders::remove_library_folder,
            library_folders::scan_library_folders,
            book_details::set_book_series,
            book_details::reset_book_series,
            reader_content::prepare_book_content,
            reading_position::get_reading_position,
            reading_position::save_reading_position,
            reading_position::save_book_progress,
            reading_sessions::save_reading_session,
            reading_sessions::list_reading_sessions,
            reading_sessions::edit_daily_activity,
            reading_sessions::list_library_kanji,
            reading_sessions::get_statistics_counts,
            reading_sessions::delete_reading_sessions,
            reading_sessions::mark_book_unread,
            bookmarks::list_bookmarks,
            bookmarks::create_bookmark,
            bookmarks::rename_bookmark,
            bookmarks::remove_bookmark,
            reader_notes::list_reader_notes,
            reader_notes::create_reader_note,
            reader_notes::edit_reader_note,
            reader_notes::remove_reader_note,
            appearance_preferences::get_appearance_preferences,
            appearance_preferences::save_appearance_preferences,
            startup::get_startup_preferences,
            startup::save_startup_preferences,
            startup::get_startup_book,
            startup::remember_last_book,
            discord_presence::get_discord_preferences,
            discord_presence::save_discord_preferences,
            discord_presence::set_discord_activity,
            discord_presence::set_discord_browsing,
            window_lifecycle::finish_window_close,
            backup::get_backup_settings,
            backup::save_backup_settings,
            backup::export_backup,
            backup::open_backup_file,
            backup::open_snapshot,
            backup::restore_backup,
            backup::list_snapshots,
            backup::create_snapshot,
            backup::delete_snapshot,
            dictionary::store::list_dictionaries,
            dictionary::starter::get_starter_dictionaries,
            dictionary::starter::download_starter_dictionary,
            dictionary::starter::dismiss_starter_dictionaries,
            dictionary::starter::open_starter_information,
            dictionary::store::import_dictionaries,
            dictionary::store::lookup_terms,
            dictionary::store::lookup_kanji,
            dictionary::store::remove_dictionary,
            dictionary::store::remove_dictionaries,
            dictionary::store::move_dictionary,
            dictionary::store::get_dictionary_store_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running Komori");
}
