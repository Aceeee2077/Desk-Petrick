// ============================================================================
// Petric chat window logic (standalone script, no imports/exports — loaded by chat.html)
// A ChatGPT-style conversation UI backed by the main-process chat store:
//  - left sidebar: conversation list (newest first), "new chat", and an archived section
//  - right: message bubbles + composer; Enter sends, Shift+Enter inserts a newline
// The store lives in the main process; every mutation broadcasts 'chats-changed',
// so the pet window and this window always stay in sync.
// Global types come from src/shared/types.ts (interface declarations, compile-time only).
// ============================================================================

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const SKIN_EMOJI: Record<PetSkin, string> = {
  cat: '🐱',
  dog: '🦊',
  default: '🐰',
  bulu: '🐈',
  robot: '🤖',
  custom: '🖼️',
};

let chatCfg: AppConfig = {
  skin: 'cat',
  animSpeed: 1,
  opacity: 1,
  autoLaunch: false,
  aiEnabled: false,
  apiKey: '',
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  soundEnabled: true,
  customImageMode: 'single',
  customImagePath: '',
  autoCutout: true,
  cutoutTolerance: 25,
  locale: 'zh',
  theme: 'dark',
  accessory: 'none',
  affinity: 0,
  focusMode: true,
  focusInterval: 40,
  statsFirstSeen: '',
  statsDays: [],
  statsClicks: 0,
  statsChats: 0,
  affinityHistory: [],
  greetEnabled: true,
  weatherEnabled: true,
  hourlyChime: true,
  photoEyes: null,
  autoMove: true,
};

let conversations: ChatConversation[] = [];
let activeId = '';
let awaitingReply = false; // an AI request for the currently-rendered conversation is in flight
let pendingConvId = '';
let lastError: { convId: string; text: string } | null = null;
let archivedOpen = false;
let brandEmoji = '🐾';

const i18n = () => window.PetricI18n;
const t = (key: string, params?: Record<string, string | number>): string => i18n().t(key, params);

function activeConversation(): ChatConversation | null {
  return conversations.find((c) => c.id === activeId) || null;
}

function petEmoji(): string {
  return SKIN_EMOJI[chatCfg.skin] || '🐾';
}

/** Compact local time: HH:MM today, M/D this year, else YYYY/M/D. */
function formatConvTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

function convDisplayTitle(c: ChatConversation): string {
  return c.title || t('chat.untitled');
}

// ---------- Rendering ----------

/** Build one sidebar row for a conversation. `archived` renders it in the archived section. */
function buildConvRow(c: ChatConversation, archived: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'conv-row' + (c.id === activeId && !archived ? ' active' : '');
  row.dataset.id = c.id;
  if (archived) row.classList.add('archived');

  const title = document.createElement('div');
  title.className = 'conv-title';
  title.textContent = convDisplayTitle(c);

  const time = document.createElement('div');
  time.className = 'conv-time';
  time.textContent = formatConvTime(c.updatedAt);

  const actions = document.createElement('div');
  actions.className = 'conv-actions';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'act';
  renameBtn.textContent = '✎';
  renameBtn.title = t('chat.rename');
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(row, c);
  });

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'act';
  archiveBtn.textContent = archived ? '↩' : '🗂';
  archiveBtn.title = archived ? t('chat.unarchive') : t('chat.archive');
  archiveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (archived) {
      void openArchivedConversation(c.id);
    } else {
      void window.api.chatsArchive(c.id); // broadcast re-renders the list
    }
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'act';
  delBtn.textContent = '🗑';
  delBtn.title = t('chat.deleteTitle');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void confirmAndDelete(c);
  });

  actions.append(renameBtn, archiveBtn, delBtn);
  row.append(title, time, actions);

  row.addEventListener('click', () => {
    if (archived) void openArchivedConversation(c.id);
    else selectConversation(c.id);
  });
  return row;
}

/** Sorting newest-first by the last activity. */
function sortByUpdated(list: ChatConversation[]): ChatConversation[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Render the sidebar: live conversations + the collapsible archived section. */
function renderList() {
  const convList = byId('conv-list');
  const archivedList = byId('archived-list');
  convList.textContent = '';
  archivedList.textContent = '';

  const live = sortByUpdated(conversations.filter((c) => !c.archived));
  for (const c of live) convList.appendChild(buildConvRow(c, false));

  const archived = sortByUpdated(conversations.filter((c) => c.archived));
  const archivedBlock = document.querySelector('.archived-block') as HTMLElement;
  const archivedToggle = byId<HTMLButtonElement>('archived-toggle');
  archivedToggle.textContent = t('chat.archivedSection', { n: archived.length });
  if (archived.length === 0) {
    archivedBlock.classList.add('empty');
  } else {
    archivedBlock.classList.remove('empty');
  }
  for (const c of archived) archivedList.appendChild(buildConvRow(c, true));
  archivedList.classList.toggle('collapsed', !archivedOpen);
}

/** Open an archived conversation: unarchive it first, then make it active. */
async function openArchivedConversation(id: string) {
  await window.api.chatsArchive(id); // archived → false (broadcast re-renders)
  window.api.setActiveChat(id);
  activeId = id;
  lastError = null;
  renderList();
  renderActive();
  byId<HTMLTextAreaElement>('chat-input').focus();
}

function selectConversation(id: string) {
  if (activeId === id && activeConversation()) {
    byId<HTMLTextAreaElement>('chat-input').focus();
    return;
  }
  window.api.setActiveChat(id);
  activeId = id;
  lastError = null;
  renderList();
  renderActive();
  byId<HTMLTextAreaElement>('chat-input').focus();
}

function appendMessageRow(box: HTMLElement, m: ChatMessage) {
  const row = document.createElement('div');
  row.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
  if (m.role !== 'user') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = petEmoji();
    row.appendChild(avatar);
  }
  const wrap = document.createElement('div');
  wrap.className = 'content-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.content;
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  box.appendChild(row);
}

function addTypingRow(box: HTMLElement) {
  const row = document.createElement('div');
  row.className = 'msg ai typing';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = petEmoji();
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    bubble.appendChild(dot);
  }
  row.append(avatar, bubble);
  box.appendChild(row);
}

function addErrorRow(box: HTMLElement, message: string) {
  const row = document.createElement('div');
  row.className = 'error-box';
  const text = document.createElement('div');
  text.className = 'err-text';
  text.textContent = '😿 ' + message;
  const btn = document.createElement('button');
  btn.className = 'ghost-btn';
  btn.textContent = t('chat.openSettings');
  btn.addEventListener('click', () => window.api.openSettings());
  row.append(text, btn);
  box.appendChild(row);
}

function addCenteredHint(box: HTMLElement, titleKey: string, subKey: string, big: string) {
  const wrap = document.createElement('div');
  wrap.className = 'welcome';
  const bigEl = document.createElement('div');
  bigEl.className = 'big';
  bigEl.textContent = big;
  const wTitle = document.createElement('div');
  wTitle.className = 'w-title';
  wTitle.textContent = t(titleKey);
  const wSub = document.createElement('div');
  wSub.className = 'w-sub';
  wSub.textContent = t(subKey);
  wrap.append(bigEl, wTitle, wSub);
  box.appendChild(wrap);
}

/** Render the message area for the active conversation (or the welcome state). */
function renderActive() {
  const box = byId<HTMLElement>('messages');
  box.textContent = '';
  const conv = activeConversation();

  const titleEl = byId<HTMLElement>('head-title');
  const archiveBtn = byId<HTMLButtonElement>('btn-header-archive');
  const deleteBtn = byId<HTMLButtonElement>('btn-header-delete');

  if (!conv) {
    titleEl.textContent = t('chat.windowTitle');
    archiveBtn.disabled = true;
    deleteBtn.disabled = true;
    addCenteredHint(box, 'chat.welcomeTitle', 'chat.welcomeSub', brandEmoji);
    return;
  }

  titleEl.textContent = convDisplayTitle(conv);
  archiveBtn.disabled = false;
  deleteBtn.disabled = false;

  if (!conv.messages.length && !(awaitingReply && pendingConvId === conv.id)) {
    addCenteredHint(box, 'chat.emptyConversation', 'chat.welcomeSub', brandEmoji);
  } else {
    for (const m of conv.messages) appendMessageRow(box, m);
    const last = conv.messages[conv.messages.length - 1];
    if (awaitingReply && pendingConvId === conv.id && last && last.role === 'user') {
      addTypingRow(box);
    } else if (lastError && lastError.convId === conv.id && last && last.role === 'user') {
      addErrorRow(box, lastError.text);
    }
  }
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderList();
  renderActive();
}

// ---------- Inline rename ----------
function startRename(row: HTMLElement, conv: ChatConversation) {
  const titleEl = row.querySelector('.conv-title') as HTMLElement | null;
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = conv.title;
  input.placeholder = t('chat.untitled');
  input.maxLength = 40;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      void window.api.chatsRename(conv.id, input.value); // broadcast re-renders the list
    } else {
      renderList();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ---------- Conversation actions ----------
async function confirmAndDelete(c: ChatConversation) {
  const ok = window.confirm(t('chat.deleteConfirm', { title: convDisplayTitle(c) }));
  if (!ok) return;
  await window.api.chatsDelete(c.id); // broadcast re-renders everything
}

function autosizeInput(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

// ---------- Send ----------
async function send() {
  const input = byId<HTMLTextAreaElement>('chat-input');
  const text = input.value.trim();
  if (!text || awaitingReply) return;

  let convId = activeId;
  if (!activeConversation()) {
    const c = await window.api.chatsCreate(); // becomes active via broadcast
    convId = c.id;
  }
  input.value = '';
  autosizeInput(input);

  pendingConvId = convId;
  awaitingReply = true;
  lastError = null;
  renderActive();
  const res = await window.api.chatsSend(convId, text);
  awaitingReply = false;
  pendingConvId = '';
  if (!res.ok) {
    lastError = { convId, text: res.error || 'unknown error' };
  }
  renderActive();
}

// ---------- Theme / locale ----------
function applyChatTheme() {
  document.documentElement.dataset.theme = chatCfg.theme;
}

/** Static labels that come from the dictionary. */
function applyStaticI18n() {
  const dict = i18n();
  document.documentElement.lang = dict.getLocale() === 'en' ? 'en' : 'zh-CN';
  document.title = t('chat.windowTitle');
  byId('btn-new-chat').textContent = t('chat.newChat');
  byId<HTMLButtonElement>('chat-send').textContent = t('chat.send');
  byId<HTMLTextAreaElement>('chat-input').placeholder = t('chat.placeholder');
  byId<HTMLButtonElement>('btn-header-archive').title = t('chat.archive');
  byId<HTMLButtonElement>('btn-header-delete').title = t('chat.deleteTitle');
  byId<HTMLButtonElement>('btn-close').title = t('settings.close');
  brandEmoji = petEmoji();
  byId('brand-avatar').textContent = brandEmoji;
  document.title = t('chat.windowTitle');
}

async function refreshLocale() {
  const payload = await window.api.getI18n();
  window.PetricI18n.setLocaleData(payload.locale, payload.dict);
  applyStaticI18n();
  renderAll();
}

// ---------- Startup ----------
function bindEvents() {
  byId('btn-close').addEventListener('click', () => window.api.closeChatWindow());

  byId<HTMLButtonElement>('btn-new-chat').addEventListener('click', async () => {
    await window.api.chatsCreate(); // broadcast switches the active conversation
    byId<HTMLTextAreaElement>('chat-input').focus();
  });

  byId<HTMLButtonElement>('archived-toggle').addEventListener('click', () => {
    archivedOpen = !archivedOpen;
    byId('archived-list').classList.toggle('collapsed', !archivedOpen);
  });

  byId<HTMLButtonElement>('btn-header-archive').addEventListener('click', async () => {
    const conv = activeConversation();
    if (!conv) return;
    await window.api.chatsArchive(conv.id); // active re-picked by the store
    const next = activeConversation();
    if (!next) renderActive();
  });

  byId<HTMLButtonElement>('btn-header-delete').addEventListener('click', () => {
    const conv = activeConversation();
    if (conv) void confirmAndDelete(conv);
  });

  byId<HTMLButtonElement>('chat-send').addEventListener('click', () => void send());

  const input = byId<HTMLTextAreaElement>('chat-input');
  input.addEventListener('input', () => autosizeInput(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  // Esc: cancel an inline rename first, otherwise close the window
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.classList.contains('rename-input')) return; // rename input handles its own Esc
    window.api.closeChatWindow();
  });
}

async function initChat() {
  const [cfg, state, i18nPayload] = await Promise.all([
    window.api.getConfig(),
    window.api.chatsGetState(),
    window.api.getI18n(),
  ]);
  chatCfg = cfg;
  applyChatTheme();
  window.PetricI18n.setLocaleData(i18nPayload.locale, i18nPayload.dict);
  applyStaticI18n();

  conversations = state.conversations;
  activeId = state.activeId;
  renderAll();

  window.api.onConfigChanged((next) => {
    const localeChanged = next.locale !== chatCfg.locale;
    chatCfg = next;
    applyChatTheme();
    if (localeChanged) void refreshLocale();
    else {
      brandEmoji = petEmoji();
      byId('brand-avatar').textContent = brandEmoji;
      renderAll();
    }
  });

  window.api.onChatsChanged((next) => {
    conversations = next.conversations;
    activeId = next.activeId;
    renderAll();
  });

  bindEvents();
  console.log('[chat] ready');
}

void initChat();
