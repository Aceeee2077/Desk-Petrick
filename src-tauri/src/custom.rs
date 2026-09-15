// ============================================================================
// Custom appearance — the Tauri counterpart of the Electron custom-image code,
// minus the ONNX background removal (dropped in this rewrite).
//
// The picked image is copied into <app config>/custom/custom.<ext>; the renderer
// receives the absolute path and turns it into an `asset:` URL via convertFileSrc.
// The asset protocol scope in tauri.conf.json limits reads to that folder.
// ============================================================================

use crate::i18n::translate;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const CUSTOM_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MAX_CUSTOM_BYTES: u64 = 60 * 1024 * 1024;

fn locale(app: &AppHandle) -> String {
    app.try_state::<crate::config::ConfigState>()
        .and_then(|state| state.get("locale").as_str().map(str::to_string))
        .unwrap_or_else(|| "zh".to_string())
}

fn custom_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("custom")
}

fn find_custom(dir: &Path) -> Option<PathBuf> {
    CUSTOM_EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("custom{ext}")))
        .find(|candidate| candidate.is_file())
}

fn clear_existing(dir: &Path) {
    for ext in CUSTOM_EXTENSIONS {
        let _ = fs::remove_file(dir.join(format!("custom{ext}")));
    }
}

#[tauri::command]
pub fn custom_get(app: AppHandle) -> Value {
    match find_custom(&custom_dir(&app)) {
        Some(path) => json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "mode": "single",
        }),
        None => json!({ "ok": false }),
    }
}

#[tauri::command]
pub async fn custom_pick(app: AppHandle) -> Value {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });

    let Some(picked) = receiver.recv().ok().flatten() else {
        return json!({ "ok": false });
    };
    let Ok(source) = picked.into_path() else {
        return json!({ "ok": false, "error": translate(&locale(&app), "dialog.readFailed") });
    };

    let extension = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if !CUSTOM_EXTENSIONS.contains(&extension.as_str()) {
        return json!({ "ok": false, "error": translate(&locale(&app), "dialog.unsupportedFormat") });
    }
    if fs::metadata(&source).map(|m| m.len()).unwrap_or(0) > MAX_CUSTOM_BYTES {
        return json!({ "ok": false, "error": translate(&locale(&app), "dialog.fileTooLarge") });
    }

    let dir = custom_dir(&app);
    if fs::create_dir_all(&dir).is_err() {
        return json!({ "ok": false, "error": translate(&locale(&app), "dialog.copyFailed") });
    }
    clear_existing(&dir);
    let target = dir.join(format!("custom{extension}"));
    if fs::copy(&source, &target).is_err() {
        return json!({ "ok": false, "error": translate(&locale(&app), "dialog.copyFailed") });
    }

    // Keep the config pointing at the copy so the settings panel can show it.
    if let Some(config) = app.try_state::<crate::config::ConfigState>() {
        let merged = config.apply(&json!({ "customImagePath": target.to_string_lossy() }));
        config.persist();
        let _ = tauri::Emitter::emit(&app, "config-changed", merged);
    }

    json!({
        "ok": true,
        "path": target.to_string_lossy(),
        "mode": "single",
    })
}

#[tauri::command]
pub fn custom_clear(app: AppHandle) -> bool {
    let dir = custom_dir(&app);
    let existed = find_custom(&dir).is_some();
    clear_existing(&dir);
    if let Some(config) = app.try_state::<crate::config::ConfigState>() {
        let merged = config.apply(&json!({ "customImagePath": "" }));
        config.persist();
        let _ = tauri::Emitter::emit(&app, "config-changed", merged);
    }
    existed
}
