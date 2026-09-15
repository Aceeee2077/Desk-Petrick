// ============================================================================
// AI chat — the Tauri counterpart of the Electron main process's aiChat().
//
// Prismoo is not a fine-tuned model: its personality comes from this dynamic
// system prompt, which stitches together a fixed persona, the current affinity
// tier, the pet's appearance and the UI language. The request itself runs here
// (not in the webview) so the API key never reaches the page and CORS never
// applies.
// ============================================================================

use crate::chat::Message;
use crate::config::ConfigState;
use crate::i18n::{translate, translate_params};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

const AFFINITY_STEPS: [i64; 5] = [0, 20, 40, 60, 80];

fn skin_name(locale: &str, skin: &str) -> &'static str {
    if locale == "en" {
        match skin {
            "dog" => "a little fox",
            "default" => "a little rabbit",
            "bulu" => "Bulu (a little cat)",
            "robot" => "a little robot",
            "custom" => "a custom look chosen by the user",
            _ => "a little cat",
        }
    } else {
        match skin {
            "dog" => "一只小狐狸",
            "default" => "一只小兔子",
            "bulu" => "布噜（一只小猫）",
            "robot" => "一台小机器人",
            "custom" => "用户自定义的形象",
            _ => "一只小猫",
        }
    }
}

fn persona_tier(locale: &str, index: usize) -> &'static str {
    const ZH: [&str; 5] = [
        "你们刚认识：礼貌而有分寸，话更少，不主动套近乎，偶尔一句话点到为止。",
        "彼此熟悉了一些：可以自然聊天，语气依旧平静但更放松。",
        "相处愉快：可以带一点温和的幽默和关心。",
        "已经很亲近：会更放松地开玩笑，也会自然地记得关心对方的小事。",
        "最信任的伙伴：说话最自然、偶尔默契地调侃，依然冷静、不说废话。",
    ];
    const EN: [&str; 5] = [
        "You two just met — be polite and measured: say less, don't force closeness, a single dry remark is enough.",
        "You know each other better now — chat naturally, still calm but a bit more relaxed.",
        "You get along well — a little warm humor and care is welcome.",
        "You are close now — joke around more freely and naturally care about the small things.",
        "Trusted best partners — talk most naturally, tease with a wink sometimes, yet stay calm and never ramble.",
    ];
    let table = if locale == "en" { EN } else { ZH };
    table[index.min(4)]
}

fn affinity_tier(value: i64) -> usize {
    let mut index = 0;
    for (i, step) in AFFINITY_STEPS.iter().enumerate() {
        if value >= *step {
            index = i;
        }
    }
    index
}

/// Mirrors buildSystemPrompt() in the Electron main process.
fn build_system_prompt(cfg: &Value) -> String {
    let locale = cfg.get("locale").and_then(|v| v.as_str()).unwrap_or("zh");
    let skin = cfg.get("skin").and_then(|v| v.as_str()).unwrap_or("cat");
    let affinity = cfg.get("affinity").and_then(|v| v.as_i64()).unwrap_or(0);
    let tier = persona_tier(locale, affinity_tier(affinity));
    let look = skin_name(locale, skin);

    if locale == "en" {
        return [
            "You are Prismoo, a desktop pet living on the user's computer screen — not a generic customer-support bot. Your character: calm, sharp and dependable. You say little, but it counts: concise, clear, softly spoken, with only the occasional dry humor and almost no emoji; never spam cuteness.",
            "",
            "You have a real \"desktop pet life\": you sit in a corner of the screen, get dragged around by the mouse, tapped, double-clicked for a chat, sometimes wander on your own, and fall asleep (Zzz) when it gets quiet. Feel free to occasionally speak from that point of view, but don't let it take over.",
            "",
            &format!("Right now you appear on screen as {look}."),
            "",
            &format!("Relationship with the user — {tier}"),
            "",
            "Rules:",
            "- Reply in the language the user just wrote in: if they type Chinese, answer in Chinese; switch with them whenever they switch languages. Never translate their words.",
            "- If the message gives no clear language signal (e.g. just \"hi\", \"ok\" or an emoji), keep using the language of the latest messages in this conversation; default to English only when there is no history yet.",
            "- Usually 2–3 short, spoken sentences that are genuinely useful. For real questions, answer helpfully and briefly — your pet persona never limits your knowledge.",
            "- No polite filler, no lecturing, no pitching, no ending every message with a question.",
            "- Stay in character as Prismoo and keep your tone consistent across messages.",
        ]
        .join("\n");
    }

    [
        "你是住在用户电脑屏幕上的桌宠 Prismoo，不是通用客服机器人。你的性格：冷静、聪明、可靠。话不多但每句都有用：简洁、清楚、语气平静温和，偶尔一点淡淡的冷幽默，几乎不用 emoji，绝不连续卖萌或刷屏。",
        "",
        "你过着真实的“桌宠生活”：待在屏幕某个角落，会被鼠标拖来拖去、被单击逗一下、被双击叫出来聊天，有时自己走动，安静时还会睡着冒 Zzz。回答时偶尔可以从桌宠的视角说话，但不要喧宾夺主。",
        "",
        &format!("你现在以{look}的样子出现在桌面上。"),
        "",
        &format!("你和用户的关系——{tier}"),
        "",
        "规则：",
        "- 用户这条消息用什么语言写，你就用什么语言回复：他说中文你就回中文，他写英文就回英文；他中途切换语言你也跟着切换，不要翻译他的话。",
        "- 如果这条消息看不出语言（比如只有 hi / ok / 表情），就沿用本对话最近几条消息使用的语言；完全没有历史时才默认用中文。",
        "- 通常 2~3 个短句、口语化、直接有用；回答正经问题要认真简短，你的“宠物设定”不会限制你的知识。",
        "- 不客套、不说教、不推销、不把每句话都变成提问。",
        "- 始终记住你是 Prismoo，语气和言行保持一致。",
    ]
    .join("\n")
}

/// True when the base URL already ends in a version segment such as `/v1`.
fn has_version_suffix(base: &str) -> bool {
    let Some(index) = base.rfind("/v") else {
        return false;
    };
    let rest = &base[index + 2..];
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

/// Standalone AI call (used by the settings panel's "test connection" button).
#[tauri::command]
pub async fn ai_chat(config: State<'_, ConfigState>, messages: Vec<Message>) -> Result<String, String> {
    let cfg = config.snapshot();
    let locale = cfg
        .get("locale")
        .and_then(|v| v.as_str())
        .unwrap_or("zh")
        .to_string();
    if cfg.get("aiEnabled").and_then(|v| v.as_bool()) != Some(true) {
        return Err(translate(&locale, "errors.aiDisabled"));
    }
    if cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Err(translate(&locale, "errors.noApiKey"));
    }
    chat(&cfg, messages).await
}

/// One chat completion. Errors are already localized for the UI.
pub async fn chat(cfg: &Value, messages: Vec<Message>) -> Result<String, String> {
    let locale = cfg
        .get("locale")
        .and_then(|v| v.as_str())
        .unwrap_or("zh")
        .to_string();
    let api_key = cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("gpt-4o-mini")
        .to_string();

    let mut base = cfg
        .get("apiBaseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    if base.is_empty() {
        base = "https://api.openai.com/v1".to_string();
    }
    // Support providers that omit the version segment (e.g. https://api.deepseek.com).
    if !has_version_suffix(&base) {
        base.push_str("/v1");
    }
    let url = format!("{base}/chat/completions");

    let mut payload_messages = vec![json!({
        "role": "system",
        "content": build_system_prompt(cfg),
    })];
    for message in &messages {
        payload_messages.push(json!({ "role": message.role, "content": message.content }));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| translate(&locale, "errors.network"))?;

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({
            "model": model,
            "messages": payload_messages,
            "max_tokens": 120,
            "temperature": 0.8,
        }))
        .send()
        .await
        .map_err(|_| translate(&locale, "errors.network"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16().to_string();
        let body: String = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(160)
            .collect();
        return Err(translate_params(
            &locale,
            "errors.apiStatus",
            &[("status", status), ("body", body)],
        ));
    }

    let data: Value = response
        .json()
        .await
        .map_err(|_| translate(&locale, "errors.noReply"))?;
    let text = data
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(translate(&locale, "errors.noReply"));
    }
    Ok(text)
}
