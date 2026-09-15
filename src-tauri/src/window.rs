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
use std::sync::Mutex;
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

/// Keep the window fully inside the monitor it currently sits on, so the pet can
/// never be walked or dragged off-screen.
fn clamp_to_monitor(window: &WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return (x, y);
    };
    let Ok(size) = window.outer_size() else {
        return (x, y);
    };
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let max_x = (monitor_pos.x + monitor_size.width as i32 - size.width as i32).max(monitor_pos.x);
    let max_y = (monitor_pos.y + monitor_size.height as i32 - size.height as i32).max(monitor_pos.y);
    (x.clamp(monitor_pos.x, max_x), y.clamp(monitor_pos.y, max_y))
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
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();
    let x = monitor_pos.x + (monitor_size.width as i32 - size.width as i32) / 2;
    let y = monitor_pos.y + (monitor_size.height as i32 - size.height as i32) / 2;
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
pub fn drag_end(state: State<'_, DragState>) {
    *state.0.lock().unwrap() = None;
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
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("renderer/settings.html".into()),
    )
    .title("Prismoo")
    .inner_size(880.0, 680.0)
    .min_inner_size(720.0, 520.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open (or focus) the standalone chat window.
#[tauri::command]
pub fn open_chat(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("chat") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "chat",
        tauri::WebviewUrl::App("renderer/chat.html".into()),
    )
    .title("Prismoo")
    .inner_size(900.0, 720.0)
    .min_inner_size(720.0, 560.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
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
