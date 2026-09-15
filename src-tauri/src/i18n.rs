// ============================================================================
// i18n — serves the same flat dictionary the Electron main process provided.
//
// The dictionary itself lives in src/shared/i18n.ts (single source of truth)
// and is compiled into src-tauri/resources/i18n.json by
// scripts/build-tauri-resources.mjs.
// ============================================================================

use crate::config::ConfigState;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::State;

const I18N_JSON: &str = include_str!("../resources/i18n.json");

/// Parsed once — the dictionaries are static data compiled into the binary.
fn dictionaries() -> &'static Value {
    static DICTS: OnceLock<Value> = OnceLock::new();
    DICTS.get_or_init(|| serde_json::from_str(I18N_JSON).unwrap_or_else(|_| json!({})))
}

/// Look up one string for the given locale (used by the tray and native dialogs).
pub fn translate(locale: &str, key: &str) -> String {
    dictionaries()
        .get(locale)
        .and_then(|dict| dict.get(key))
        .and_then(|value| value.as_str())
        .unwrap_or(key)
        .to_string()
}

/// Same as `translate`, with `{name}` placeholders substituted.
pub fn translate_params(locale: &str, key: &str, params: &[(&str, String)]) -> String {
    let mut text = translate(locale, key);
    for (name, value) in params {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

#[tauri::command]
pub fn i18n_get(state: State<'_, ConfigState>) -> Value {
    let dictionaries = dictionaries();
    let locale = state
        .get("locale")
        .as_str()
        .unwrap_or("zh")
        .to_string();
    let dict = dictionaries
        .get(&locale)
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({ "locale": locale, "dict": dict })
}
