use std::sync::Mutex;
use tauri::Manager;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

mod ai_provider;
mod commands;
mod license;
mod prompt_builder;

struct BackendProcess(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

pub struct HttpClient(pub reqwest::Client);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(HttpClient(reqwest::Client::new()))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_analyze,
            commands::ai::get_ai_config,
            commands::ai::set_ai_config,
            commands::ai::get_usage_status,
            commands::license::activate_license,
            commands::license::get_license_status,
        ])
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .expect("could not resolve resource dir");
                let backend_js = resource_dir.join("backend").join("server.js");

                // Pass bundled ffmpeg path to the backend process
                let ffmpeg_path = resource_dir
                    .join("ffmpeg")
                    .join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

                let (_rx, child) = app
                    .shell()
                    .command("node")
                    .args([backend_js.to_string_lossy().as_ref()])
                    .env("FFMPEG_PATH", ffmpeg_path.to_string_lossy().as_ref())
                    .spawn()
                    .expect("failed to spawn backend server — is Node.js installed?");

                app.manage(BackendProcess(Mutex::new(Some(child))));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            #[cfg(not(debug_assertions))]
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
