// ============================================================================
// i18n — serves the same flat dictionary the Electron main process provided.
//
// The dictionary itself lives in src/shared/i18n.ts (single source of truth)
// and is compiled into src-tauri/resources/i18n.json by
// scripts/build-tauri-resources.mjs.
// ============================================================================

use crate::config::ConfigState;
use serde_json::{json, Value};
use tauri::State;

const I18N_JSON: &str = include_str!("../resources/i18n.json");

#[tauri::command]
pub fn i18n_get(state: State<'_, ConfigState>) -> Value {
    let dictionaries: Value = serde_json::from_str(I18N_JSON).unwrap_or_else(|_| json!({}));
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
