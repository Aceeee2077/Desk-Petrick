// ============================================================================
// Prismoo (Tauri 2) — Rust backend entry point.
//
// The renderer is the same TypeScript/HTML/CSS front end the Electron build
// used; it talks to this process through a `window.api` compatibility shim
// instead of Electron's preload/IPC bridge.
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Prismoo");
}
