// ============================================================================
// Petric chat store — the single source of truth for AI conversations.
// Lives in the MAIN process (persisted to userData/chat-store.json) so the pet
// window and the standalone ChatGPT-style chat window always share one dataset.
// All mutations go through these helpers; the main process then broadcasts the
// new state to every window ('chats-changed').
// ============================================================================

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAX_MESSAGES = 60; // keep only the latest 60 messages per conversation
const MAX_TITLE = 24;

interface ChatStoreFile {
  activeId: string;
  conversations: ChatConversation[];
}

let cache: ChatStoreFile | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'chat-store.json');
}

function newConversationId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Auto-title from the first user message. */
function titleFromMessage(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE) + '…' : t;
}

function cleanTitle(title: string): string {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE) + '…' : t;
}

function isValidConversation(v: unknown): v is ChatConversation {
  return !!v && typeof v === 'object' && typeof (v as ChatConversation).id === 'string';
}

function sanitizeConversation(c: ChatConversation, now: number): ChatConversation {
  return {
    id: c.id,
    title: typeof c.title === 'string' ? c.title : '',
    messages: (Array.isArray(c.messages) ? c.messages : []).slice(-MAX_MESSAGES),
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now,
    archived: !!c.archived,
  };
}

function sanitize(raw: unknown): ChatStoreFile {
  const fallback: ChatStoreFile = { activeId: '', conversations: [] };
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<ChatStoreFile>;
  const now = Date.now();
  const conversations = Array.isArray(r.conversations)
    ? (r.conversations as ChatConversation[]).filter(isValidConversation).map((c) => sanitizeConversation(c, now))
    : [];
  return { activeId: typeof r.activeId === 'string' ? r.activeId : '', conversations };
}

function load(): ChatStoreFile {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    cache = { activeId: '', conversations: [] };
  }
  return cache;
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(filePath()), { recursive: true });
      fs.writeFileSync(
        filePath(),
        JSON.stringify({ activeId: cache?.activeId ?? '', conversations: cache?.conversations ?? [] }),
        'utf8',
      );
    } catch (err) {
      console.error('[chat-store] 保存失败:', err);
    }
  }, 250);
}

/** Point the active id at the newest non-archived conversation (or clear it). */
function repickActiveIfNeeded(st: ChatStoreFile): void {
  const live = st.conversations.find((c) => c.id === st.activeId && !c.archived);
  if (live) return;
  const newest = [...st.conversations].filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  st.activeId = newest ? newest.id : '';
}

function cloneConversation(c: ChatConversation): ChatConversation {
  return { ...c, messages: c.messages.slice() };
}

// ---------- Public store API (used by the IPC layer in main.ts) ----------

/** Snapshot handed to windows (safe copies, so nobody can mutate the cache). */
export function getState(): ChatState {
  const st = load();
  return {
    conversations: st.conversations.map(cloneConversation),
    activeId: st.activeId,
  };
}

export function getConversation(id: string): ChatConversation | undefined {
  const c = load().conversations.find((x) => x.id === id);
  return c ? cloneConversation(c) : undefined;
}

/** Create a fresh conversation and make it active. */
export function createConversation(): ChatConversation {
  const st = load();
  const now = Date.now();
  const c: ChatConversation = { id: newConversationId(), title: '', messages: [], createdAt: now, updatedAt: now };
  st.conversations.unshift(c);
  st.activeId = c.id;
  persist();
  return cloneConversation(c);
}

export function setActiveConversation(id: string): void {
  const st = load();
  if (st.conversations.some((c) => c.id === id)) {
    st.activeId = id;
    persist();
  }
}

export function deleteConversation(id: string): void {
  const st = load();
  st.conversations = st.conversations.filter((c) => c.id !== id);
  repickActiveIfNeeded(st);
  persist();
}

/** Toggle a conversation's archived flag; archiving the active one re-selects another. */
export function toggleArchive(id: string): void {
  const st = load();
  const c = st.conversations.find((x) => x.id === id);
  if (!c) return;
  c.archived = !c.archived;
  if (c.archived) repickActiveIfNeeded(st);
  persist();
}

export function renameConversation(id: string, title: string): void {
  const st = load();
  const c = st.conversations.find((x) => x.id === id);
  if (!c) return;
  c.title = cleanTitle(title);
  persist();
}

/** Append one message (user or assistant) to a conversation. */
export function appendMessage(id: string, msg: ChatMessage): boolean {
  const st = load();
  const c = st.conversations.find((x) => x.id === id);
  if (!c) return false;
  if (msg.role === 'user' && !c.title) c.title = titleFromMessage(msg.content); // auto-title
  if (c.archived) c.archived = false; // replying to an archived chat brings it back
  c.messages = [...c.messages, msg].slice(-MAX_MESSAGES);
  c.updatedAt = Date.now();
  persist();
  return true;
}

/**
 * One-time migration of the OLD renderer-local storage (pet window localStorage,
 * written by previous versions). Accepts either the modern conversations array or
 * the very old single message history. Imported only while the store is empty so a
 * real conversation list is never clobbered.
 */
export function importLegacy(payload: unknown): boolean {
  const st = load();
  if (st.conversations.length) return false;
  if (!Array.isArray(payload)) return false;

  const now = Date.now();
  const convShaped = payload.filter(isValidConversation);
  let imported: ChatConversation[] = [];
  if (convShaped.length) {
    imported = convShaped.map((c) => sanitizeConversation(c, now));
  } else {
    const msgs = payload.filter(
      (m): m is ChatMessage => !!m && typeof (m as ChatMessage).content === 'string',
    );
    if (!msgs.length) return false;
    const c: ChatConversation = {
      id: newConversationId(),
      title: '',
      messages: msgs.slice(-MAX_MESSAGES),
      createdAt: now,
      updatedAt: now,
    };
    const firstUser = [...c.messages].find((m) => m.role === 'user');
    if (firstUser) c.title = titleFromMessage(firstUser.content);
    imported = [c];
  }
  st.conversations = imported;
  repickActiveIfNeeded(st);
  persist();
  return true;
}
