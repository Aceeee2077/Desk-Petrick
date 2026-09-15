// ============================================================================
// Config store — the Tauri counterpart of src/shared/config.ts.
//
// The config is kept as a JSON object rather than a mirrored Rust struct: the
// renderer already owns the schema (src/shared/types.ts), so treating it as a
// patchable document avoids two definitions drifting apart.
// ============================================================================

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct ConfigState {
    path: PathBuf,
    value: Mutex<Value>,
}

/// Mirrors DEFAULT_CONFIG in src/shared/config.ts.
pub fn defaults() -> Value {
    json!({
        "skin": "cat",
        "animSpeed": 1,
        "opacity": 1,
        "autoLaunch": false,
        "aiEnabled": false,
        "apiKey": "",
        "apiBaseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "soundEnabled": true,
        "customImageMode": "single",
        "customImagePath": "",
        "autoCutout": true,
        "cutoutTolerance": 25,
        "locale": "zh",
        "theme": "light",
        "accessory": "none",
        "affinity": 0,
        "focusMode": true,
        "focusInterval": 40,
        "statsFirstSeen": "",
        "statsDays": [],
        "statsClicks": 0,
        "statsChats": 0,
        "affinityHistory": [],
        "greetEnabled": true,
        "weatherEnabled": true,
        "hourlyChime": true,
        "photoEyes": null,
        "autoMove": true,
        "updateAutoCheck": true,
        "updateAutoDownload": true,
        "updateChannel": "stable",
        "updateDeferredVersion": "",
        "updateDeferredAt": 0,
        "updateNextAutoCheckAt": 0,
        "updateAutoRetry": 0
    })
}

/// Recursively merge `patch` into `base` (objects merge, everything else replaces).
fn deep_merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                deep_merge(base_map.entry(key.clone()).or_insert(Value::Null), patch_value);
            }
        }
        (base_slot, patch_value) => *base_slot = patch_value.clone(),
    }
}

pub fn init(app: &AppHandle) -> ConfigState {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("config.json");

    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    // Fill in anything the persisted file is missing (new keys, first run).
    deep_merge(&mut value, &defaults());

    ConfigState {
        path,
        value: Mutex::new(value),
    }
}

impl ConfigState {
    pub fn snapshot(&self) -> Value {
        self.value.lock().unwrap().clone()
    }

    /// Apply a partial patch and return the merged document.
    pub fn apply(&self, patch: &Value) -> Value {
        let mut value = self.value.lock().unwrap();
        deep_merge(&mut value, patch);
        value.clone()
    }

    pub fn get(&self, key: &str) -> Value {
        self.value
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn persist(&self) {
        let value = self.snapshot();
        if let Ok(raw) = serde_json::to_string_pretty(&value) {
            let _ = fs::write(&self.path, raw);
        }
    }
}
