// ============================================================================
// Prismoo (Tauri 2) — Rust backend entry point.
//
// The renderer is the same TypeScript/HTML/CSS front end the Electron build
// used; it talks to this process through a `window.api` compatibility shim
// (src/renderer/tauri-api.ts) instead of Electron's preload/IPC bridge.
// ============================================================================

mod config;
mod i18n;
mod window;

use tauri::{AppHandle, Manager};

/// Injected by `--self-check`: reports what the pet window actually rendered back
/// to the process (used by `npm run tauri:check` and CI).
const SELF_CHECK_JS: &str = r#"
(async () => {
  const out = { hasApi: false, hasCanvas: false, drawnPixels: 0 };
  try {
    const c = document.getElementById('pet-canvas');
    out.hasCanvas = !!c;
    out.hasApi = !!window.api;
    const cfg = await window.api.getConfig();
    out.skin = cfg.skin;
    out.theme = cfg.theme;
    const i18n = await window.api.getI18n();
    out.locale = i18n.locale;
    out.i18nKeys = Object.keys(i18n.dict || {}).length;
  } catch (err) {
    out.apiError = String(err);
  }
  try {
    const c = document.getElementById('pet-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    out.drawnPixels = n;
  } catch (err) {
    out.canvasError = String(err);
  }
  await window.__TAURI__.core.invoke('probe_report', { payload: JSON.stringify(out) });
})();
"#;

#[tauri::command]
fn probe_report(app: AppHandle, payload: String) {
    println!("[selfcheck] {payload}");
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = config::init(app.handle());
            app.manage(config);
            app.manage(window::DragState::default());

            if std::env::var("PRISMOO_SELFCHECK").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3500));
                    match handle.get_webview_window("pet") {
                        Some(pet) => {
                            let _ = pet.eval(SELF_CHECK_JS);
                        }
                        None => {
                            println!("[selfcheck] pet window was not created");
                            handle.exit(1);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_report,
            i18n::i18n_get,
            window::window_move,
            window::window_move_to,
            window::window_position,
            window::window_center_here,
            window::drag_begin,
            window::drag_move,
            window::drag_end,
            window::set_click_through,
            window::config_get,
            window::config_set,
            window::quit_app,
            window::open_settings,
            window::set_window_opacity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismoo");
}
