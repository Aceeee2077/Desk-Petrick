// ============================================================================
// Window commands — pet-window movement, dragging and click-through.
//
// Electron exposed `setIgnoreMouseEvents(true, { forward: true })`, which keeps
// forwarding mousemove while the window is click-through. Tauri has no `forward`
// flag, so the renderer still owns the alpha hit-test and simply toggles
// click-through as the cursor enters/leaves the pet's opaque pixels.
// ============================================================================

use crate::config::ConfigState;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

/// Anchor captured when a drag starts, so the window tracks the cursor delta
/// instead of accumulating per-move rounding error.
#[derive(Clone, Copy)]
pub struct DragAnchor {
    win_x: i32,
    win_y: i32,
    cur_x: f64,
    cur_y: f64,
}

#[derive(Default)]
pub struct DragState(pub Mutex<Option<DragAnchor>>);

/// Read a boolean setting from the persisted config.
fn config_bool(window: &WebviewWindow, key: &str, fallback: bool) -> bool {
    window
        .app_handle()
        .try_state::<ConfigState>()
        .and_then(|state| state.get(key).as_bool())
        .unwrap_or(fallback)
}

/// Keep the window fully inside its allowed area, so the pet can never be walked or
/// dragged off-screen. By default that area is the current monitor's work area (the
/// taskbar is respected); with "cross monitors" enabled it becomes the bounding box
/// of every monitor instead.
fn clamp_to_monitor(window: &WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let stay_on_one = config_bool(window, "stayOnOneDisplay", true);
    clamp_to(window, x, y, !stay_on_one)
}

/// Bounding rectangle the pet must stay inside: either its current monitor's work
/// area, or the union of every monitor's work area.
fn bounds(window: &WebviewWindow, all_monitors: bool) -> Option<(i32, i32, i32, i32)> {
    if !all_monitors {
        let monitor = window.current_monitor().ok().flatten()?;
        let area = monitor.work_area();
        return Some((
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        ));
    }

    let monitors = window.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for monitor in monitors {
        let area = monitor.work_area();
        min_x = min_x.min(area.position.x);
        min_y = min_y.min(area.position.y);
        max_x = max_x.max(area.position.x + area.size.width as i32);
        max_y = max_y.max(area.position.y + area.size.height as i32);
    }
    Some((min_x, min_y, max_x - min_x, max_y - min_y))
}

fn clamp_to(window: &WebviewWindow, x: i32, y: i32, all_monitors: bool) -> (i32, i32) {
    let Ok(size) = window.outer_size() else {
        return (x, y);
    };
    let Some((bx, by, bw, bh)) = bounds(window, all_monitors) else {
        return (x, y);
    };
    let max_x = (bx + bw - size.width as i32).max(bx);
    let max_y = (by + bh - size.height as i32).max(by);
    (x.clamp(bx, max_x), y.clamp(by, max_y))
}

// ---------- Position memory ----------

fn position_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("position.json")
}

fn read_position(app: &AppHandle) -> Option<(i32, i32)> {
    let raw = fs::read_to_string(position_path(app)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    Some((
        value.get("x")?.as_i64()? as i32,
        value.get("y")?.as_i64()? as i32,
    ))
}

/// Poll the pet window's position and persist it when it changes.
///
/// Polling is deliberate: the window moves from drags, the auto-walk loop and the
/// auto-jump parabola, and hooking every one of those would mean a file write per
/// frame. A 1.5 s tick is far below anyone's patience and costs nothing.
pub fn spawn_position_saver(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<(i32, i32)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let Some(pet) = handle.get_webview_window("pet") else {
                continue;
            };
            let Ok(position) = pet.outer_position() else {
                continue;
            };
            let current = (position.x, position.y);
            if last != Some(current) {
                last = Some(current);
                let payload = serde_json::json!({ "x": current.0, "y": current.1 }).to_string();
                let _ = fs::write(position_path(&handle), payload);
            }
        }
    });
}

/// Restore the remembered position, then reveal the pet window.
///
/// The window is declared hidden in tauri.conf.json so it never flashes at the
/// centre of the screen before moving to where it belongs.
#[tauri::command]
pub async fn show_pet_window(app: AppHandle) -> Result<(), String> {
    let Some(pet) = app.get_webview_window("pet") else {
        return Ok(());
    };

    // The OS applies the window's creation geometry asynchronously, so anything set
    // immediately after the window is built gets overwritten and the pet lands in the
    // corner. Let that settle, then position, then reveal — no wrong-position flash.
    std::thread::sleep(Duration::from_millis(300));

    match read_position(&app) {
        Some((x, y)) => {
            // Clamp against every monitor: a position saved on a display that is now
            // unplugged must land back on-screen, not be pulled to the primary.
            let (x, y) = clamp_to(&pet, x, y, true);
            let _ = pet.set_position(PhysicalPosition::new(x, y));
        }
        // First run (or a forgotten position): start centred.
        None => {
            let _ = center_on_work_area(&pet);
        }
    }
    pet.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_move(window: WebviewWindow, dx: i32, dy: i32) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let (x, y) = clamp_to_monitor(&window, position.x + dx, position.y + dy);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_move_to(window: WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    let (x, y) = clamp_to_monitor(&window, x, y);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_position(window: WebviewWindow) -> Result<(i32, i32), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    Ok((position.x, position.y))
}

#[tauri::command]
pub fn window_center_here(window: WebviewWindow) -> Result<(), String> {
    center_on_work_area(&window)
}

/// Centre the window on the work area (not the full monitor) of the display it is on.
///
/// The window config's `center: true` did not take effect — the pet kept landing at
/// the bottom-left of the work area — so centring is done explicitly instead.
fn center_on_work_area(window: &WebviewWindow) -> Result<(), String> {
    let monitor = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor().map_err(|e| e.to_string())?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + (area.size.height as i32 - size.height as i32) / 2;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Center the pet window on its current monitor (used by the tray / context menu).
pub fn center_pet(app: &AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = window_center_here(pet);
    }
}

#[tauri::command]
pub fn drag_begin(window: WebviewWindow, state: State<'_, DragState>) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(DragAnchor {
        win_x: position.x,
        win_y: position.y,
        cur_x: cursor.x,
        cur_y: cursor.y,
    });
    Ok(())
}

#[tauri::command]
pub fn drag_move(window: WebviewWindow, state: State<'_, DragState>) -> Result<(), String> {
    let anchor = *state.0.lock().unwrap();
    let Some(anchor) = anchor else {
        return Ok(());
    };
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let x = anchor.win_x + (cursor.x - anchor.cur_x).round() as i32;
    let y = anchor.win_y + (cursor.y - anchor.cur_y).round() as i32;
    let (x, y) = clamp_to_monitor(&window, x, y);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drag_end(window: WebviewWindow, state: State<'_, DragState>) {
    *state.0.lock().unwrap() = None;
    if config_bool(&window, "snapToEdge", false) {
        snap_to_edge(&window);
    }
}

/// Snap flush to the nearest work-area edge when the pet is dropped close to it.
fn snap_to_edge(window: &WebviewWindow) {
    const THRESHOLD: i32 = 28;
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let area = monitor.work_area();
    let left = area.position.x;
    let top = area.position.y;
    let right = area.position.x + area.size.width as i32;
    let bottom = area.position.y + area.size.height as i32;
    let width = size.width as i32;
    let height = size.height as i32;

    let mut x = position.x;
    let mut y = position.y;
    if (position.x - left).abs() <= THRESHOLD {
        x = left;
    } else if (right - (position.x + width)).abs() <= THRESHOLD {
        x = right - width;
    }
    if (position.y - top).abs() <= THRESHOLD {
        y = top;
    } else if (bottom - (position.y + height)).abs() <= THRESHOLD {
        y = bottom - height;
    }

    if x != position.x || y != position.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
pub fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

/// Cursor position in window-local CSS pixels, or None when it is outside the window.
///
/// Electron forwarded mousemove events to a click-through window; Tauri does not, so
/// once the pet becomes click-through nothing in the renderer can notice the cursor
/// coming back. The renderer polls this instead and re-enables interaction itself.
#[tauri::command]
pub fn cursor_in_window(window: WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    let x = (cursor.x - position.x as f64) / scale;
    let y = (cursor.y - position.y as f64) / scale;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    if x < 0.0 || y < 0.0 || x >= width || y >= height {
        Ok(None)
    } else {
        Ok(Some((x, y)))
    }
}

#[tauri::command]
pub fn config_get(state: State<'_, ConfigState>) -> Value {
    state.snapshot()
}

#[tauri::command]
pub fn config_set(app: AppHandle, state: State<'_, ConfigState>, patch: Value) -> Value {
    let locale_before = state
        .get("locale")
        .as_str()
        .unwrap_or("zh")
        .to_string();
    let merged = state.apply(&patch);
    state.persist();
    let _ = app.emit("config-changed", merged.clone());

    // The tray labels / tooltip are localized, so a language switch re-labels them.
    let locale_after = state.get("locale").as_str().unwrap_or("zh").to_string();
    if locale_before != locale_after {
        let _ = crate::tray::rebuild(&app);
    }
    merged
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Open (or focus) the settings panel.
///
/// `async` is load-bearing: Tauri runs sync commands on the main thread, and building
/// a webview window from there deadlocks — the outer frame appears but its webview
/// never initialises, so the window stays blank white and the app stops responding
/// (tray included). Async commands run on the runtime's thread pool instead, which
/// leaves the main thread free to service the window creation.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    build_settings(&app)
}

fn build_settings(app: &AppHandle) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("renderer/settings.html".into()),
    )
    .title("Prismoo")
    .inner_size(880.0, 680.0)
    .min_inner_size(720.0, 520.0)
    .center()
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Open (or focus) the standalone chat window.
#[tauri::command]
pub async fn open_chat(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("chat") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    build_chat(&app)
}

fn build_chat(app: &AppHandle) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(app, "chat", tauri::WebviewUrl::App("renderer/chat.html".into()))
        .title("Prismoo")
        .inner_size(900.0, 720.0)
        .min_inner_size(720.0, 560.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_chat(app: AppHandle) {
    if let Some(window) = app.get_webview_window("chat") {
        let _ = window.close();
    }
}

/// Whether Prismoo is registered to start with the OS session.
#[tauri::command]
pub fn autolaunch_get(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable / disable auto-launch and report the resulting state.
#[tauri::command]
pub fn autolaunch_set(app: AppHandle, enabled: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    manager.is_enabled().unwrap_or(enabled)
}

/// The running app version (from Cargo.toml / tauri.conf.json).
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Diagnostic: what Tauri thinks the monitors and the pet window look like.
#[tauri::command]
pub fn debug_monitors(window: WebviewWindow) -> Value {
    let monitors: Vec<Value> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            serde_json::json!({
                "pos": [m.position().x, m.position().y],
                "size": [m.size().width, m.size().height],
                "work": [area.position.x, area.position.y, area.size.width, area.size.height],
                "scale": m.scale_factor(),
            })
        })
        .collect();
    let position = window.outer_position().ok();
    let size = window.outer_size().ok();
    serde_json::json!({
        "monitors": monitors,
        "windowPos": position.map(|p| [p.x, p.y]),
        "windowSize": size.map(|s| [s.width, s.height]),
        "windowScale": window.scale_factor().ok(),
    })
}

/// Open the GitHub Releases page — the manual stand-in until the updater is ported.
#[tauri::command]
pub fn open_releases(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://github.com/Aceeee2077/Desk-Petrick/releases/latest",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

/// Set the pet window's opacity (0.5 - 1.0).
#[tauri::command]
pub fn set_window_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        // Tauri has no per-window alpha on Windows; keep the value in the config
        // and apply it in the renderer (CSS opacity) instead.
        let _ = pet;
    }
    let _ = opacity;
    Ok(())
}
