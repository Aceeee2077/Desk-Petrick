// ============================================================================
// Tray icon + pet context menu.
//
// Mirrors the Electron build: a resident tray icon with a localized menu, left
// click opens Settings, and right-clicking the pet pops the same actions at the
// cursor. Items whose feature is not ported yet stay visible but disabled, so the
// menu never silently lies about what the app can do.
// ============================================================================

use crate::config::ConfigState;
use crate::i18n::translate;
use tauri::image::Image;
use tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

fn current_locale(app: &AppHandle) -> String {
    app.try_state::<ConfigState>()
        .and_then(|state| state.get("locale").as_str().map(str::to_string))
        .unwrap_or_else(|| "zh".to_string())
}

/// Build the tray / context menu with the active locale's labels.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let locale = current_locale(app);
    let label = |key: &str| translate(&locale, key);

    let chat = MenuItem::with_id(app, "chat", label("menu.chat"), true, None::<&str>)?;
    // Not ported yet -> present but disabled (the updater lands later).
    let update = MenuItem::with_id(app, "update", label("menu.checkUpdate"), false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", label("menu.settings"), true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", label("menu.resetPos"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", label("menu.quit"), true, None::<&str>)?;

    Menu::with_items(app, &[&chat, &update, &settings, &reset, &separator, &quit])
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "chat" => {
            let _ = crate::window::open_chat(app.clone());
        }
        "settings" => {
            let _ = crate::window::open_settings(app.clone());
        }
        "reset" => crate::window::center_pet(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let locale = current_locale(app);
    let menu = build_menu(app)?;
    let icon = Image::from_bytes(include_bytes!("../../src/assets/tray.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        // Left click opens Settings, so the menu must not also pop on left click.
        .show_menu_on_left_click(false)
        .tooltip(translate(&locale, "tray.tooltip"))
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                let _ = crate::window::open_settings(app);
            }
        })
        .build(app)?;
    Ok(())
}

/// Re-label the tray after a locale switch.
pub fn rebuild(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let locale = current_locale(app);
    tray.set_menu(Some(build_menu(app)?))?;
    tray.set_tooltip(Some(translate(&locale, "tray.tooltip")))?;
    Ok(())
}

#[tauri::command]
pub fn show_pet_menu(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    // `ContextMenu::popup` takes the plain Window hosting the webview.
    let target: tauri::Window = window.as_ref().window();
    menu.popup(target).map_err(|e| e.to_string())
}
