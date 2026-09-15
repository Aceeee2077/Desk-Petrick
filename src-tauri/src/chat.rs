// ============================================================================
// Chat store — the Tauri counterpart of src/main/chat-store.ts.
//
// Conversations are persisted to chat-store.json in the app config directory and
// shared by the pet window and the standalone chat window through the
// `chats-changed` event.
// ============================================================================

use crate::config::ConfigState;
use crate::i18n::translate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_MESSAGES: usize = 60;
const MAX_TITLE_CHARS: usize = 24;

#[derive(Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub active_id: String,
    #[serde(default)]
    pub conversations: Vec<Conversation>,
}

pub struct ChatState {
    path: PathBuf,
    store: Mutex<Store>,
}

#[derive(Serialize)]
pub struct SendResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("{:x}-{:x}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Collapse whitespace and truncate to the auto-title length.
fn clean_title(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    let mut out: String = collapsed.chars().take(MAX_TITLE_CHARS).collect();
    if collapsed.chars().count() > MAX_TITLE_CHARS {
        out.push('…');
    }
    out
}

impl ChatState {
    pub fn init(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("chat-store.json");

        let store = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Store>(&raw).ok())
            .unwrap_or_default();

        ChatState {
            path,
            store: Mutex::new(store),
        }
    }

    pub fn snapshot(&self) -> Store {
        self.store.lock().unwrap().clone()
    }

    fn persist(&self) {
        let store = self.snapshot();
        if let Ok(raw) = serde_json::to_string(&store) {
            let _ = fs::write(&self.path, raw);
        }
    }

    /// Point the active id at the newest non-archived conversation (or clear it).
    fn repick_active(store: &mut Store) {
        let still_live = store
            .conversations
            .iter()
            .any(|c| c.id == store.active_id && !c.archived);
        if still_live {
            return;
        }
        store.active_id = store
            .conversations
            .iter()
            .filter(|c| !c.archived)
            .max_by_key(|c| c.updated_at)
            .map(|c| c.id.clone())
            .unwrap_or_default();
    }

    pub fn append(&self, id: &str, role: &str, content: &str) -> bool {
        let mut store = self.store.lock().unwrap();
        let Some(conversation) = store.conversations.iter_mut().find(|c| c.id == id) else {
            return false;
        };
        if role == "user" && conversation.title.is_empty() {
            conversation.title = clean_title(content);
        }
        // Replying to an archived conversation brings it back.
        if conversation.archived {
            conversation.archived = false;
        }
        conversation.messages.push(Message {
            role: role.to_string(),
            content: content.to_string(),
        });
        if conversation.messages.len() > MAX_MESSAGES {
            let overflow = conversation.messages.len() - MAX_MESSAGES;
            conversation.messages.drain(0..overflow);
        }
        conversation.updated_at = now_ms();
        drop(store);
        self.persist();
        true
    }

    /// The last `limit` non-system messages of one conversation (AI context window).
    pub fn recent_messages(&self, id: &str, limit: usize) -> Vec<Message> {
        let store = self.store.lock().unwrap();
        let Some(conversation) = store.conversations.iter().find(|c| c.id == id) else {
            return Vec::new();
        };
        let filtered: Vec<Message> = conversation
            .messages
            .iter()
            .filter(|m| m.role != "system")
            .cloned()
            .collect();
        let start = filtered.len().saturating_sub(limit);
        filtered[start..].to_vec()
    }
}

pub fn broadcast(app: &AppHandle, chat: &ChatState) {
    let _ = app.emit("chats-changed", chat.snapshot());
}

#[tauri::command]
pub fn chats_state(chat: State<'_, ChatState>) -> Store {
    chat.snapshot()
}

#[tauri::command]
pub fn chats_create(app: AppHandle, chat: State<'_, ChatState>) -> Conversation {
    let now = now_ms();
    let conversation = Conversation {
        id: new_id(),
        title: String::new(),
        messages: Vec::new(),
        created_at: now,
        updated_at: now,
        archived: false,
    };
    {
        let mut store = chat.store.lock().unwrap();
        store.conversations.insert(0, conversation.clone());
        store.active_id = conversation.id.clone();
    }
    chat.persist();
    broadcast(&app, &chat);
    conversation
}

#[tauri::command]
pub fn chats_delete(app: AppHandle, chat: State<'_, ChatState>, id: String) {
    {
        let mut store = chat.store.lock().unwrap();
        store.conversations.retain(|c| c.id != id);
        ChatState::repick_active(&mut store);
    }
    chat.persist();
    broadcast(&app, &chat);
}

#[tauri::command]
pub fn chats_archive(app: AppHandle, chat: State<'_, ChatState>, id: String) {
    {
        let mut store = chat.store.lock().unwrap();
        if let Some(conversation) = store.conversations.iter_mut().find(|c| c.id == id) {
            conversation.archived = !conversation.archived;
            if conversation.archived {
                ChatState::repick_active(&mut store);
            }
        }
    }
    chat.persist();
    broadcast(&app, &chat);
}

#[tauri::command]
pub fn chats_rename(app: AppHandle, chat: State<'_, ChatState>, id: String, title: String) {
    {
        let mut store = chat.store.lock().unwrap();
        if let Some(conversation) = store.conversations.iter_mut().find(|c| c.id == id) {
            conversation.title = clean_title(&title);
        }
    }
    chat.persist();
    broadcast(&app, &chat);
}

#[tauri::command]
pub fn chats_set_active(app: AppHandle, chat: State<'_, ChatState>, id: String) {
    {
        let mut store = chat.store.lock().unwrap();
        if store.conversations.iter().any(|c| c.id == id) {
            store.active_id = id;
        }
    }
    chat.persist();
    broadcast(&app, &chat);
}

/// Import the pre-0.4 renderer-localStorage conversations once (only while empty).
#[tauri::command]
pub fn chats_import_legacy(app: AppHandle, chat: State<'_, ChatState>, payload: Value) -> bool {
    let imported = {
        let mut store = chat.store.lock().unwrap();
        if !store.conversations.is_empty() {
            false
        } else {
            let Some(items) = payload.as_array() else {
                return false;
            };
            let now = now_ms();
            let mut conversations: Vec<Conversation> = Vec::new();

            for item in items {
                if let Ok(conversation) = serde_json::from_value::<Conversation>(item.clone()) {
                    if !conversation.id.is_empty() {
                        conversations.push(conversation);
                    }
                }
            }

            if conversations.is_empty() {
                // Very old shape: a bare message list -> wrap it in one conversation.
                let messages: Vec<Message> = items
                    .iter()
                    .filter_map(|m| serde_json::from_value::<Message>(m.clone()).ok())
                    .collect();
                if messages.is_empty() {
                    return false;
                }
                let title = messages
                    .iter()
                    .find(|m| m.role == "user")
                    .map(|m| clean_title(&m.content))
                    .unwrap_or_default();
                conversations.push(Conversation {
                    id: new_id(),
                    title,
                    messages,
                    created_at: now,
                    updated_at: now,
                    archived: false,
                });
            }

            store.conversations = conversations;
            ChatState::repick_active(&mut store);
            true
        }
    };

    if imported {
        chat.persist();
        broadcast(&app, &chat);
    }
    imported
}

/// One user-message round trip: persist the user turn, ask the AI, persist the reply.
#[tauri::command]
pub async fn chats_send(
    app: AppHandle,
    chat: State<'_, ChatState>,
    config: State<'_, ConfigState>,
    id: String,
    text: String,
) -> Result<SendResult, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Ok(SendResult {
            ok: false,
            error: Some("empty message".into()),
        });
    }
    if !chat.append(&id, "user", &trimmed) {
        return Ok(SendResult {
            ok: false,
            error: Some("conversation missing".into()),
        });
    }
    broadcast(&app, &chat);

    let cfg = config.snapshot();
    let locale = cfg
        .get("locale")
        .and_then(|v| v.as_str())
        .unwrap_or("zh")
        .to_string();
    let flag = |key: &str| cfg.get(key).and_then(|v| v.as_bool()).unwrap_or(false);

    if !flag("aiEnabled") {
        return Ok(SendResult {
            ok: false,
            error: Some(translate(&locale, "errors.aiDisabled")),
        });
    }
    if cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Ok(SendResult {
            ok: false,
            error: Some(translate(&locale, "errors.noApiKey")),
        });
    }

    let history = chat.recent_messages(&id, 12);
    match crate::ai::chat(&cfg, history).await {
        Ok(reply) => {
            chat.append(&id, "assistant", &reply);
            broadcast(&app, &chat);
            let _ = app.emit("pet:chat-reward", ());
            Ok(SendResult {
                ok: true,
                error: None,
            })
        }
        // ai::chat already returns a localized, user-facing message.
        Err(message) => Ok(SendResult {
            ok: false,
            error: Some(message),
        }),
    }
}
