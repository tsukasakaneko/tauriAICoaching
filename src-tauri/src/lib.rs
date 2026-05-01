use std::sync::Mutex;
use tauri::Manager;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

struct BackendProcess(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // In release builds, spawn the bundled backend server.
            // In dev mode, `npm run dev:all` already starts it via concurrently.
            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .expect("could not resolve resource dir");
                let backend_js = resource_dir.join("backend").join("server.js");

                let (_rx, child) = app
                    .shell()
                    .command("node")
                    .args([backend_js.to_string_lossy().as_ref()])
                    .spawn()
                    .expect("failed to spawn backend server — is Node.js installed?");

                app.manage(BackendProcess(Mutex::new(Some(child))));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Kill the backend process when the app exits (release only).
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
