// ============================================================================
// Weather — the Tauri counterpart of getWeather() in the Electron main process.
//
// Location comes from ipwho.is (no key), the forecast from Open-Meteo (no key).
// Successes are cached for 30 minutes, failures for 5, so clicking the pet
// repeatedly never hammers the endpoints.
// ============================================================================

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

const OK_TTL: Duration = Duration::from_secs(30 * 60);
const FAIL_TTL: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

struct CacheEntry {
    at: Instant,
    data: Value,
}

#[derive(Default)]
pub struct WeatherState(Mutex<Option<CacheEntry>>);

async fn fetch(date: &str) -> Value {
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };

    // 1) Location from the caller's IP.
    let location = match client.get("https://ipwho.is/").send().await {
        Ok(response) => match response.json::<Value>().await {
            Ok(json) => json,
            Err(err) => return json!({ "ok": false, "error": err.to_string() }),
        },
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };

    let latitude = location.get("latitude").and_then(|v| v.as_f64());
    let longitude = location.get("longitude").and_then(|v| v.as_f64());
    let (Some(latitude), Some(longitude)) = (latitude, longitude) else {
        return json!({ "ok": false, "error": "location lookup failed" });
    };

    // 2) Forecast (current temperature + WMO weather code).
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}\
         &current=temperature_2m,weather_code&timezone=auto"
    );
    let forecast = match client.get(&url).send().await {
        Ok(response) => match response.json::<Value>().await {
            Ok(json) => json,
            Err(err) => return json!({ "ok": false, "error": err.to_string() }),
        },
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };

    let city = location
        .get("city")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| location.get("country").and_then(|v| v.as_str()))
        .unwrap_or("Unknown")
        .to_string();
    let temp = forecast
        .pointer("/current/temperature_2m")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .round() as i64;
    let code = forecast
        .pointer("/current/weather_code")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    json!({ "ok": true, "city": city, "temp": temp, "code": code, "date": date })
}

/// `date` is the caller's local YYYY-MM-DD — the webview knows its timezone, Rust
/// would otherwise have to pull in a full timezone database just for this label.
#[tauri::command]
pub async fn weather_get(state: State<'_, WeatherState>, date: String) -> Result<Value, String> {
    {
        let cache = state.0.lock().unwrap();
        if let Some(entry) = cache.as_ref() {
            let ok = entry
                .data
                .get("ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let ttl = if ok { OK_TTL } else { FAIL_TTL };
            if entry.at.elapsed() < ttl {
                return Ok(entry.data.clone());
            }
        }
    }

    let data = fetch(&date).await;
    *state.0.lock().unwrap() = Some(CacheEntry {
        at: Instant::now(),
        data: data.clone(),
    });
    Ok(data)
}
