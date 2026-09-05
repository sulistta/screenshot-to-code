mod commands;
mod engine;
mod media;
mod preferences;
mod preview;
mod providers;
mod research;
mod services;
mod state;
mod store;
mod stream;
mod transfer;

use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol("preview", preview::serve)
        .setup(|app| {
            let state =
                state::AppState::new(app.path().app_data_dir()?).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::get_transcript,
            commands::list_iterations,
            commands::get_files,
            commands::edit_file,
            commands::revision_diff,
            commands::restore_revision,
            commands::set_project_options,
            commands::duplicate_project,
            commands::restore_draft,
            commands::subscribe_project,
            commands::unsubscribe_project,
            commands::cancel_run,
            commands::answer_question,
            transfer::import_project,
            transfer::import_project_folder,
            transfer::export_project,
            transfer::git_checkpoint,
            engine::start_run,
            preferences::load_preferences,
            preferences::save_preferences,
            providers::list_models,
            providers::test_provider,
            services::services_status,
            services::start_services,
            services::stop_services,
            preview::open_preview,
            preview::capabilities
        ])
        .build(tauri::generate_context!())
        .expect("Unable to initialize the desktop studio");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = app.try_state::<state::AppState>() {
                if let Ok(mut inner) = state.lock() {
                    for run in inner.runs.values() {
                        run.cancel.cancel();
                    }
                    inner.services.clear();
                }
            }
        }
    });
}
