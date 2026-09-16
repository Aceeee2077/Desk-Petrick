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
        "aiProviders": [],
        "aiProviderId": "",
        "chatMaxTokens": 120,
        "chatTemperature": 0.8,
        "chatVerbosity": "normal",
        "chatEmoji": false,
        "chatUsageDate": "",
        "chatUsageMessages": 0,
        "chatUsageTokens": 0,
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
        "petScale": 1,
        "stayOnOneDisplay": true,
        "snapToEdge": false,
        "sleepTimeoutSec": 30,
        "wanderSpeed": 1,
        "activityFrequency": 1,
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
    seed_provider_from_legacy(&mut value);

    ConfigState {
        path,
        value: Mutex::new(value),
    }
}

/// Best-effort display label derived from a base URL host.
fn provider_label(base_url: &str) -> String {
    let host = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or("");
    if host.contains("openai") {
        "OpenAI".to_string()
    } else if host.contains("deepseek") {
        "DeepSeek".to_string()
    } else if host.contains("moonshot") {
        "Moonshot".to_string()
    } else if host.contains("localhost") || host.starts_with("127.") {
        "Local".to_string()
    } else if host.is_empty() {
        "Default".to_string()
    } else {
        host.to_string()
    }
}

/// Turn the single legacy base URL / key / model into the first saved provider, so
/// the new provider switcher starts populated instead of empty on upgrade.
fn seed_provider_from_legacy(value: &mut Value) {
    let providers_empty = value
        .get("aiProviders")
        .and_then(|v| v.as_array())
        .map(|list| list.is_empty())
        .unwrap_or(true);
    if !providers_empty {
        return;
    }

    let base_url = value
        .get("apiBaseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let api_key = value
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = value
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if base_url.is_empty() && api_key.is_empty() {
        return;
    }

    let provider = json!({
        "id": "default",
        "name": provider_label(&base_url),
        "baseUrl": base_url,
        "apiKey": api_key,
        "model": model,
    });
    if let Some(map) = value.as_object_mut() {
        map.insert("aiProviders".into(), json!([provider]));
        map.insert("aiProviderId".into(), json!("default"));
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
