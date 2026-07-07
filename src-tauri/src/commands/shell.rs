use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("HTTPSのURLのみ開けます".to_string());
    }
    app.shell().open(&url, None).map_err(|e| e.to_string())
}

/// P1-11: レポート画像(base64 PNG)を Downloads に保存し、保存先パスを返す。
/// ダイアログ無しの1クリック保存。Downloads が取れない環境は app_local_data_dir。
#[tauri::command]
pub async fn save_report_image(app: AppHandle, base64_png: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png.as_bytes())
        .map_err(|_| "画像データのデコードに失敗しました".to_string())?;
    if bytes.is_empty() {
        return Err("画像データが空です".to_string());
    }

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| format!("保存先ディレクトリを取得できません: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("保存先の作成に失敗しました: {}", e))?;

    let filename = format!(
        "CoachMate_Report_{}.png",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let path = dir.join(filename);
    std::fs::write(&path, &bytes).map_err(|e| format!("画像の保存に失敗しました: {}", e))?;
    Ok(path.to_string_lossy().into_owned())
}
