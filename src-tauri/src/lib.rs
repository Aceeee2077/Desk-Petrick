// ============================================================================
// Prismoo (Tauri 2) — Rust backend entry point.
//
// The renderer is the same TypeScript/HTML/CSS front end the Electron build
// used; it talks to this process through a `window.api` compatibility shim
// (src/renderer/tauri-api.ts) instead of Electron's preload/IPC bridge.
// ============================================================================

mod config;
mod i18n;
mod tray;
mod window;

use tauri::{AppHandle, Manager};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Reports collected by `probe_report` during a `PRISMOO_SELFCHECK` run.
static PET_REPORT: Mutex<Option<String>> = Mutex::new(None);
static SETTINGS_REPORT: Mutex<Option<String>> = Mutex::new(None);

/// Print a self-check line and flush immediately: when stdout is a pipe it is block
/// buffered, and a crash would otherwise swallow the diagnostics.
fn report(line: &str) {
    println!("[selfcheck] {line}");
    let _ = std::io::stdout().flush();
}

fn wait_for(slot: &Mutex<Option<String>>, timeout: Duration) -> Option<String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(value) = slot.lock().unwrap().clone() {
            return Some(value);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Injected by `--self-check`: reports what the pet window actually rendered back
/// to the process (used by `npm run tauri:check` and CI).
const SELF_CHECK_JS: &str = r#"
(async () => {
  const out = { window: 'pet', hasApi: false, hasCanvas: false, drawnPixels: 0 };
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
    out.hitTestOverPet = window.__prismooHitTest ? window.__prismooHitTest(150, 240) : null;
    out.hitTestCorner = window.__prismooHitTest ? window.__prismooHitTest(5, 5) : null;
    const cursor = await window.__TAURI__.core.invoke('cursor_in_window');
    out.cursorInWindow = Array.isArray(cursor) ? 'inside' : 'outside';
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

/// Injected into the settings window by the pet's report: proves the panel loads, the
/// shim works there too, and a config patch round-trips through Rust.
const SETTINGS_CHECK_JS: &str = r#"
(async () => {
  const out = { window: 'settings', hasApi: false };
  try {
    out.hasApi = !!window.api;
    out.hasPanel = !!document.querySelector('.panel');
    out.sections = document.querySelectorAll('section').length;
    out.toggles = document.querySelectorAll('input[type=checkbox]').length;
    const before = await window.api.getConfig();
    out.skin = before.skin;
    const target = before.animSpeed === 1 ? 1.5 : 1;
    const after = await window.api.setConfig({ animSpeed: target });
    out.configRoundTrip = after.animSpeed === target;
    await window.api.setConfig({ animSpeed: before.animSpeed });
    out.restored = (await window.api.getConfig()).animSpeed === before.animSpeed;
  } catch (err) {
    out.error = String(err);
  }
  await window.__TAURI__.core.invoke('probe_report', { payload: JSON.stringify(out) });
})();
"#;

#[tauri::command]
fn probe_report(payload: String) {
    if payload.contains("\"window\":\"settings\"") {
        *SETTINGS_REPORT.lock().unwrap() = Some(payload);
    } else {
        *PET_REPORT.lock().unwrap() = Some(payload);
    }
}

/// Two-phase self-check: probe the pet window, then bring up Settings (on the main
/// thread, which is where windows must be created) and probe that too.
fn spawn_self_check(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3500));
        if let Some(pet) = handle.get_webview_window("pet") {
            let _ = pet.eval(SELF_CHECK_JS);
        }
        let pet = wait_for(&PET_REPORT, Duration::from_secs(10));
        report(&pet.clone().unwrap_or_else(|| r#"{"window":"pet","error":"timeout"}"#.into()));

        let opener = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let _ = window::open_settings(opener);
        });

        std::thread::sleep(Duration::from_millis(2500));
        match handle.get_webview_window("settings") {
            Some(panel) => {
                let _ = panel.eval(SETTINGS_CHECK_JS);
            }
            None => report(r#"{"window":"settings","error":"settings window was not created"}"#),
        }
        let settings = wait_for(&SETTINGS_REPORT, Duration::from_secs(10));
        report(&settings.clone().unwrap_or_else(|| r#"{"window":"settings","error":"timeout"}"#.into()));

        let ok = pet.is_some() && settings.is_some();
        handle.exit(if ok { 0 } else { 1 });
    });
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
            tray::build(app.handle())?;

            if std::env::var("PRISMOO_SELFCHECK").is_ok() {
                spawn_self_check(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_report,
            tray::show_pet_menu,
            i18n::i18n_get,
            window::window_move,
            window::window_move_to,
            window::window_position,
            window::window_center_here,
            window::drag_begin,
            window::drag_move,
            window::drag_end,
            window::set_click_through,
            window::cursor_in_window,
            window::config_get,
            window::config_set,
            window::quit_app,
            window::open_settings,
            window::set_window_opacity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismoo");
}
