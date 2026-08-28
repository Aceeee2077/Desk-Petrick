// ============================================================================
// Petric pet window rendering logic (single script, no import/export, loaded directly by index.html)
//
// Features:
//  - 12 FPS sprite-frame animation driven by requestAnimationFrame (framerate scaled by the animation-speed multiplier)
//  - State machine: idle / walking (dragging) / sleeping (30s of inactivity) / click (click jump)
//  - Eyes follow the mouse + periodic blinking + floating Zzz while sleeping
//  - Drag to move the window (absolute positioning in screen coordinates, no cumulative drift)
//  - Single click: speech bubble / double click: AI chat (history kept in localStorage)
//  - Hotkeys: Ctrl+Shift+P opens settings; Esc quits the pet
//
// Global types come from src/shared/types.ts (interface declarations, compile-time only).
// ============================================================================

const canvas = document.getElementById('pet-canvas') as HTMLCanvasElement;
const bubbleEl = document.getElementById('bubble') as HTMLDivElement;
const chatUiEl = document.getElementById('chat-ui') as HTMLDivElement;
const chatInputEl = document.getElementById('chat-input') as HTMLInputElement;
const chatSendEl = document.getElementById('chat-send') as HTMLButtonElement;
const chatReplyEl = document.getElementById('chat-reply') as HTMLDivElement;
const chatHistoryBtn = document.getElementById('chat-history-btn') as HTMLButtonElement;
const chatHistoryEl = document.getElementById('chat-history') as HTMLDivElement;
const chatHistoryList = document.getElementById('chat-history-list') as HTMLDivElement;
const chatHistoryClose = document.getElementById('chat-history-close') as HTMLButtonElement;

const ctx = canvas.getContext('2d')!;

// ---------- Sprite-sheet metadata (must match scripts/generate-sprites.mjs output) ----------
const SHEET = {
  frameW: 32,
  frameH: 32,
  cols: 4, // frames per row
  rows: 4, // rows: idle/walking/sleeping/click
  scale: 3, // integer pixel-art upscale, displayed at 96x96
  states: {
    idle: { row: 0, frames: 4, fps: 6 },
    walking: { row: 1, frames: 4, fps: 12 },
    sleeping: { row: 2, frames: 2, fps: 2 },
    click: { row: 3, frames: 4, fps: 12 },
  } as Record<PetState, { row: number; frames: number; fps: number }>,
};

// Pet draw position inside the window (bottom center)
const PET_X = 150 - (SHEET.frameW * SHEET.scale) / 2; // 102
const PET_Y = 300 - SHEET.frameH * SHEET.scale - 4; // 200

// Per-frame vertical offset for each state (used to track the eye overlay, roughly the generator's pose.dy)
const POSE_DY: Record<PetState, number[]> = {
  idle: [0, -1, 0, -1],
  walking: [-1, -2, -1, 0],
  sleeping: [0, -1],
  click: [-1, -3.5, -4.5, 0],
};

// ---------- Config & State ----------
let config: AppConfig = {
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
  locale: 'zh',
};

let state: PetState = 'idle';
let prevState: PetState = 'idle';
let frameIndex = 0;
let frameAcc = 0;
let justWrapped = false;

let lastActivity = Date.now();
const SLEEP_MS = 30_000; // sleeps after 30s of inactivity

let dragging = false;
let dragCandidate = false;
let dragMoved = false;
let dragStartScreen = { x: 0, y: 0 };
let lastClickTime = 0;
let lastMouseDownTime = 0;
let suppressDrag = false; // set on the second press of a double-click so it can't micro-drag the window

let mouse = { x: 150, y: 150 }; // used for eye tracking

// Blinking
let blinkTimer = 2.2;
let blinking = false;
let blinkRemain = 0;

// Sleep Zzz
const zzzs: { x: number; y: number; vx: number; vy: number; alpha: number; size: number }[] = [];
let zzzTimer = 0;

// Custom appearance (user-provided image)
interface CustomSprite {
  img: HTMLImageElement;
  mode: CustomImageMode; // 'single' one image / 'sheet' sprite sheet
  frameW: number; // sheet mode: single-frame width
  frameH: number; // sheet mode: single-frame height
  scale: number; // sheet mode: integer upscale factor
}
let customSprite: CustomSprite | null = null;
// Current pet top y (used to position Zzz particles, updated each draw)
let currentPetTop = PET_Y;

// ---------- 3D Model Mode (customImageMode === 'model') ----------
// window.Petric3D is provided by pet3d.js (vendored three.js). Null when unavailable.
let pet3d: Petric3DHandle | null = null;
let pet3dActive = false; // true when the current skin is a custom 3D model

function initPet3D(): Petric3DHandle | null {
  const w = window as unknown as { Petric3D?: Petric3DHandle };
  if (!w.Petric3D) return null;
  const el = document.getElementById('pet3d-canvas') as HTMLCanvasElement | null;
  if (!el) return null;
  const ok = w.Petric3D.init(el);
  return ok ? w.Petric3D : null;
}

// ---------- Per-pixel Hit Detection (2D) ----------
// Each frame the main canvas is downscaled onto a low-res hitCanvas; mousemove reads just 1 pixel to check
// whether the cursor is over the pet (opaque pixels). Transparent areas -> clicks pass through to the desktop (Windows).
const HIT_SCALE = 4; // 75x75 hit canvas
let hitCanvas: HTMLCanvasElement | null = null;
let overPet = false; // whether the cursor is currently over the pet

/** Rebuild the hit canvas after each frame's draw (canvas-to-canvas runs on the GPU, very cheap) */
function buildHitMap() {
  const hw = Math.ceil(300 / HIT_SCALE);
  const hh = Math.ceil(300 / HIT_SCALE);
  if (!hitCanvas) {
    hitCanvas = document.createElement('canvas');
    hitCanvas.width = hw;
    hitCanvas.height = hh;
  }
  const hctx = hitCanvas.getContext('2d', { willReadFrequently: true })!;
  hctx.clearRect(0, 0, hw, hh);
  hctx.drawImage(canvas, 0, 0, 300, 300, 0, 0, hw, hh);
}

/** Whether the cursor (window coordinates) falls on the pet (2D pixel hitmap or 3D raycast) */
function isOverPet(clientX: number, clientY: number): boolean {
  if (pet3dActive && pet3d) return pet3d.isOver(clientX, clientY);
  if (!hitCanvas) return false;
  const hx = Math.floor(clientX / HIT_SCALE);
  const hy = Math.floor(clientY / HIT_SCALE);
  if (hx < 0 || hy < 0 || hx >= hitCanvas.width || hy >= hitCanvas.height) return false;
  const d = hitCanvas.getContext('2d')!.getImageData(hx, hy, 1, 1).data;
  return d[3] > 20; // alpha threshold, ignores semi-transparent edges
}

// Sprite image cache (three skins preloaded, zero-wait switching)
const sheets: Record<string, HTMLImageElement> = {};

// Click speech lines come from the i18n dictionary ('lines' key, locale-aware);
// to customize them, edit the lines array in src/shared/i18n.ts.

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---------- Sprites ----------
function loadSheets() {
  (['cat', 'dog', 'default'] as PetSkin[]).forEach((s) => {
    const img = new Image();
    img.src = `../assets/sprites/${s}.png`;
    sheets[s] = img;
  });
}

// ---------- State Machine ----------
function setState(s: PetState) {
  if (state === s) return;
  prevState = state;
  state = s;
  frameIndex = 0;
  frameAcc = 0;
}

function wake() {
  if (state === 'sleeping') setState('idle');
}

function enterSleep() {
  setState('sleeping');
  zzzs.length = 0;
}

function stepFrame(dt: number) {
  const meta = SHEET.states[state];
  const fps = Math.max(1, meta.fps * config.animSpeed);
  frameAcc += dt;
  justWrapped = false;
  const frameDur = 1 / fps;
  while (frameAcc >= frameDur) {
    frameAcc -= frameDur;
    frameIndex = (frameIndex + 1) % meta.frames;
    justWrapped = true;
  }
  // After a full click animation loop, return to the previous idle state
  if (state === 'click' && justWrapped && frameIndex === 0) {
    state = prevState === 'click' ? 'idle' : prevState;
    frameIndex = 0;
    frameAcc = 0;
  }
}

// ---------- Update ----------
function update(dt: number) {
  const now = Date.now();

  // Sleep check: 30s of inactivity and not dragging / chatting
  if (now - lastActivity > SLEEP_MS && state !== 'sleeping' && !dragging && chatUiEl.classList.contains('hidden')) {
    enterSleep();
  }

  // Zzz particles while sleeping
  if (state === 'sleeping') {
    zzzTimer += dt;
    if (zzzTimer > 0.9) {
      zzzTimer = 0;
      zzzs.push({
        x: 150 + (Math.random() * 30 - 15),
        y: currentPetTop + 14,
        vx: 6 + Math.random() * 8,
        vy: -(10 + Math.random() * 8),
        alpha: 0,
        size: 10 + Math.random() * 8,
      });
    }
    for (let i = zzzs.length - 1; i >= 0; i--) {
      const z = zzzs[i];
      z.y += z.vy * dt;
      z.x += z.vx * dt;
      z.alpha = Math.min(1, z.alpha + dt * 1.4);
      if (z.y < 30) zzzs.splice(i, 1);
    }
  }

  // Blink timer (roughly every 2-3.8s)
  blinkTimer -= dt;
  if (blinking) {
    blinkRemain -= dt;
    if (blinkRemain <= 0) blinking = false;
  } else if (blinkTimer <= 0) {
    blinking = true;
    blinkRemain = 0.13;
    blinkTimer = 2 + Math.random() * 1.8;
  }

  stepFrame(dt);
}

// ---------- Drawing ----------
// Eye base positions (sprite-frame coords 11.5 / 20.5, y≈13.2) converted to screen
function eyeScreenPos(poseDy: number) {
  const px = (fx: number, fy: number) => ({
    x: PET_X + fx * SHEET.scale,
    y: PET_Y + (fy + poseDy) * SHEET.scale,
  });
  return { left: px(11.5, 13.2), right: px(20.5, 13.2), head: px(16, 14) };
}

function drawEyes() {
  const poseDy = POSE_DY[state][frameIndex] ?? 0;
  const { left, right, head } = eyeScreenPos(poseDy);
  ctx.save();
  ctx.lineCap = 'round';

  if (state === 'sleeping') {
    // Closed-eye arc while sleeping
    ctx.strokeStyle = '#3b2f26';
    ctx.lineWidth = 1.8;
    [left, right].forEach((e) => {
      ctx.beginPath();
      ctx.moveTo(e.x - 2.6, e.y + 1.2);
      ctx.quadraticCurveTo(e.x, e.y - 1.8, e.x + 2.6, e.y + 1.2);
      ctx.stroke();
    });
  } else if (!blinking) {
    // Eyes follow the mouse: pupils offset toward the cursor, max 2.6px
    let dx = mouse.x - head.x;
    let dy = mouse.y - head.y;
    const d = Math.hypot(dx, dy) || 1;
    const off = Math.min(2.6, Math.hypot(dx, dy));
    dx = (dx / d) * off;
    dy = (dy / d) * off;

    ctx.fillStyle = '#2f2a26';
    [left, right].forEach((e) => {
      ctx.beginPath();
      ctx.arc(e.x + dx, e.y + dy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // highlight
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(e.x + dx - 0.9, e.y + dy - 0.9, 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2f2a26';
    });
  } else {
    // Blink: a horizontal line
    ctx.strokeStyle = '#2f2a26';
    ctx.lineWidth = 1.8;
    [left, right].forEach((e) => {
      ctx.beginPath();
      ctx.moveTo(e.x - 2.4, e.y);
      ctx.lineTo(e.x + 2.4, e.y);
      ctx.stroke();
    });
  }
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, 300, 300);

  // Ground shadow (also shown under the 3D model)
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(150, 296, 34, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  const isCustom = config.skin === 'custom';
  if (pet3dActive && pet3d) {
    // 3D mode: the model lives on its own canvas (pet3d-canvas); only the shadow + Zzz stay on the 2D canvas
    currentPetTop = 172; // approximate model top for Zzz particles
  } else if (isCustom && customSprite) {
    drawCustomPet();
  } else {
    drawBuiltInPet();
  }

  // Eye tracking only applies to built-in sprites (custom images already contain eyes, and the face can't be located)
  if (!isCustom) drawEyes();

  // Sleep Zzz
  if (state === 'sleeping') {
    ctx.font = 'bold 15px Nunito, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    zzzs.forEach((z) => {
      ctx.fillStyle = `rgba(122, 96, 178, ${z.alpha.toFixed(3)})`;
      ctx.fillText('Z', z.x, z.y);
    });
  }

  // Rebuild the hit canvas (for per-pixel click detection; skipped in 3D mode which uses raycast)
  if (!(pet3dActive && pet3d)) buildHitMap();
}

/** Draw the built-in sprite sheet (cat/dog/default) */
function drawBuiltInPet() {
  const img = sheets[config.skin];
  if (img && img.complete && img.naturalWidth > 0) {
    const meta = SHEET.states[state];
    const sx = frameIndex * SHEET.frameW;
    const sy = meta.row * SHEET.frameH;
    ctx.imageSmoothingEnabled = false; // keep the pixel art sharp
    ctx.drawImage(
      img,
      sx,
      sy,
      SHEET.frameW,
      SHEET.frameH,
      PET_X,
      PET_Y,
      SHEET.frameW * SHEET.scale,
      SHEET.frameH * SHEET.scale,
    );
    currentPetTop = PET_Y;
  } else {
    // Placeholder while the sprite image is still loading
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.ellipse(150, 250, 30, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#999';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('…', 150, 254);
    currentPetTop = 216;
  }
}

/** Draw the custom appearance (single image or sprite sheet) */
function drawCustomPet() {
  const cs = customSprite!;
  ctx.save();

  if (cs.mode === 'sheet') {
    // Sheet mode: 4 rows x 4 cols, row order idle/walking/sleeping/click, frame size auto-computed
    const meta = SHEET.states[state];
    const sx = frameIndex * cs.frameW;
    const sy = meta.row * cs.frameH;
    const dw = cs.frameW * cs.scale;
    const dh = cs.frameH * cs.scale;
    const dx = 150 - dw / 2;
    const dy = 300 - dh - 4;
    ctx.imageSmoothingEnabled = false; // pixel art
    ctx.drawImage(cs.img, sx, sy, cs.frameW, cs.frameH, dx, dy, dw, dh);
    currentPetTop = dy;
  } else {
    // Single-image mode: whole image + procedural pose animation (breathe/walk/sleep/jump)
    const t = performance.now() / 1000;
    const iw = cs.img.naturalWidth;
    const ih = cs.img.naturalHeight;
    const s = Math.min(140 / iw, 120 / ih); // fit the window, roughly 140x120 max
    const dw = iw * s;
    const dh = ih * s;
    let yOff = 0;
    let scaleX = 1;
    let scaleY = 1;
    let alpha = 1;

    if (state === 'idle') {
      yOff = Math.sin(t * 2.2) * 2.5; // gentle bobbing
      scaleY = 1 + Math.sin(t * 2.2 + 1) * 0.02; // breathing
    } else if (state === 'walking') {
      yOff = Math.sin(t * 10) * 3; // fast bouncing while dragging
      scaleX = 1 + Math.sin(t * 10) * 0.03;
    } else if (state === 'sleeping') {
      yOff = 3 + Math.sin(t * 1.5) * 1.5; // slow rise and fall
      scaleX = 0.96;
      scaleY = 0.92;
      alpha = 0.82; // darker to suggest falling asleep
    } else if (state === 'click') {
      const jump = [-4, -20, -28, -8][frameIndex] ?? 0; // jump trajectory
      const squash = [0.94, 1.12, 1.06, 0.9][frameIndex] ?? 1; // squash & stretch
      yOff = jump;
      scaleY = squash;
    }

    const dy = 300 - dh - 4 + yOff;
    currentPetTop = dy;
    ctx.globalAlpha = alpha;
    ctx.translate(150, 300 - 4 + yOff);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(cs.img, -dw / 2, -dh, dw, dh);
  }

  ctx.restore();
}

/** Load / refresh the custom appearance (gets a data URL from the main process) */
async function refreshCustomSprite() {
  customSprite = null;
  pet3dActive = false;
  if (pet3d) pet3d.setVisible(false);

  if (config.skin !== 'custom') return;

  const res = await window.api.getCustomImage();
  if (!res.ok || !res.dataUrl) {
    // Custom skin selected but no file: show a hint and fall back to cat
    showBubble(window.PetricI18n.t('bubble.noCustom'), { ms: 4000 });
    window.api.setConfig({ skin: 'cat' });
    return;
  }

  if (res.mode === 'model' || res.mode === 'billboard') {
    // 3D scene modes: 'model' = GLB mesh, 'billboard' = 2.5D image plane
    if (!pet3d) pet3d = initPet3D();
    if (!pet3d) {
      showBubble(window.PetricI18n.t('bubble.no3d'), { ms: 4000 });
      window.api.setConfig({ skin: 'cat' });
      return;
    }
    const ok =
      res.mode === 'billboard' ? await pet3d.loadBillboard(res.dataUrl) : await pet3d.loadModel(res.dataUrl);
    if (!ok) {
      showBubble(window.PetricI18n.t('bubble.modelLoadFail'), { ms: 4000 });
      window.api.setConfig({ skin: 'cat' });
      return;
    }
    pet3dActive = true;
    pet3d.setVisible(true);
  } else {
    customSprite = await buildCustomSprite(res.dataUrl, res.mode || 'single');
    if (!customSprite) {
      showBubble(window.PetricI18n.t('bubble.imageLoadFail'), { ms: 4000 });
      window.api.setConfig({ skin: 'cat' });
    }
  }
}

function buildCustomSprite(dataUrl: string, mode: CustomImageMode): Promise<CustomSprite | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        resolve(null);
        return;
      }
      if (mode === 'sheet') {
        const frameW = Math.round(w / SHEET.cols);
        const frameH = Math.round(h / SHEET.rows);
        const scale = Math.max(1, Math.round(100 / frameW));
        resolve({ img, mode: 'sheet', frameW, frameH, scale });
      } else {
        resolve({ img, mode: 'single', frameW: w, frameH: h, scale: 1 });
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ---------- Main Loop ----------
let lastTime = performance.now();
let lastMouseX = 150; // for drag velocity (billboard lean)
function loop(now: number) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp to avoid huge jumps after backgrounding
  lastTime = now;
  update(dt);
  // Drive the 3D scene (GLB model or 2.5D billboard) when a 3D mode is active
  if (pet3dActive && pet3d) {
    const dragVelX = dragging ? (mouse.x - lastMouseX) / Math.max(dt, 0.001) : 0;
    pet3d.setPointer(mouse.x, dragging, dragVelX);
    pet3d.update(dt, state, frameIndex);
    pet3d.render();
  }
  lastMouseX = mouse.x;
  draw();
  requestAnimationFrame(loop);
}

// ---------- Speech Bubble ----------
let bubbleTimer: number | undefined;
let typingTimer: number | undefined;
let deferredBubble: { text: string; opts: { ms?: number; typing?: boolean } } | null = null;

function showBubble(text: string, opts: { ms?: number; typing?: boolean } = {}) {
  // An AI request can finish while the pet is being dragged. Do not let its reply
  // re-open an overlay that travels with the transparent window; show it once the
  // drag has ended instead.
  if (dragging) {
    deferredBubble = { text, opts };
    return;
  }
  const ms = opts.ms ?? 2200;
  window.clearTimeout(bubbleTimer);
  window.clearInterval(typingTimer);
  bubbleEl.classList.add('show');
  bubbleEl.textContent = '';
  if (opts.typing) {
    let i = 0;
    typingTimer = window.setInterval(() => {
      i += 2;
      bubbleEl.textContent = text.slice(0, i);
      if (i >= text.length) window.clearInterval(typingTimer);
    }, 30);
  } else {
    bubbleEl.textContent = text;
  }
  if (ms > 0) {
    bubbleTimer = window.setTimeout(hideBubble, ms);
  }
}

function hideBubble() {
  window.clearInterval(typingTimer);
  bubbleEl.classList.remove('show');
}

// ---------- AI Chat ----------
const HISTORY_KEY = 'petric.chat.history';

function loadHistory(): ChatMessage[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(v) ? (v as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(h: ChatMessage[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-20)));
  } catch {
    /* ignore */
  }
}

/** Render the latest AI reply (or a status line) INSIDE the chat console, above the input. */
function showChatReply(text: string, isError = false) {
  chatReplyEl.textContent = text;
  chatReplyEl.classList.toggle('err', isError);
  chatReplyEl.classList.remove('hidden');
}

/** Rebuild the full history overlay from localStorage. */
function renderChatHistory() {
  const hist = loadHistory();
  chatHistoryList.textContent = '';
  if (!hist.length) {
    const empty = document.createElement('div');
    empty.className = 'msg empty';
    empty.textContent = window.PetricI18n.t('chat.historyEmpty');
    chatHistoryList.appendChild(empty);
    return;
  }
  for (const m of hist) {
    const el = document.createElement('div');
    el.className = m.role === 'user' ? 'msg user' : 'msg ai';
    el.textContent = m.content;
    chatHistoryList.appendChild(el);
  }
  chatHistoryList.scrollTop = chatHistoryList.scrollHeight;
}

function openChat() {
  // The window must stay interactive while the chat input is open (it may currently be click-through)
  if (!overPet) {
    overPet = true;
    window.api.setClickThrough(false);
    canvas.style.cursor = 'grab';
  }
  // A newly opened chat supersedes any reply that was waiting for a previous drag to end.
  deferredBubble = null;
  // Hide the speech bubble so it doesn't overlap the chat console
  hideBubble();
  // Close any leftover history overlay and show the console
  chatHistoryEl.classList.add('hidden');
  chatUiEl.classList.remove('hidden');
  // Preview the last AI reply (if any) inside the console
  const hist = loadHistory();
  const lastAi = [...hist].reverse().find((m) => m.role === 'assistant');
  if (lastAi) showChatReply(lastAi.content);
  chatInputEl.focus();
}

function closeChat() {
  chatUiEl.classList.add('hidden');
  chatHistoryEl.classList.add('hidden');
  hideBubble();
}

async function sendChat() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = '';
  const hist = loadHistory();
  hist.push({ role: 'user', content: text });
  saveHistory(hist);

  // While the chat is open, replies render inside the console (never in the speech bubble),
  // so they can't be covered by the input or travel with the window during a drag.
  if (chatHistoryEl.classList.contains('hidden')) {
    showChatReply(window.PetricI18n.t('bubble.thinking'));
  }
  try {
    const reply = await window.api.aiChat(hist.slice(-12));
    hist.push({ role: 'assistant', content: reply });
    saveHistory(hist);
    if (chatHistoryEl.classList.contains('hidden')) {
      // If a drag started while waiting, the console is hidden; just refresh the history data
      showChatReply(reply);
    } else {
      renderChatHistory(); // history overlay is open: show the exchange there
    }
  } catch (err) {
    showChatReply('😿 ' + (err instanceof Error ? err.message : String(err)), true);
  }
}

// ---------- Sound (Web Audio synthesis, a short "meow") ----------
let audioCtx: AudioContext | null = null;

function playSound() {
  if (!config.soundEnabled) return;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = audioCtx || new AC();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(720, t);
    o.frequency.exponentialRampToValueAtTime(340, t + 0.14);
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.24);
  } catch {
    /* stay silent when audio is unavailable */
  }
}

// ---------- Interaction ----------
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  // Per-pixel hit: ignore when the cursor is not on the pet (transparent areas pass clicks to the desktop)
  if (!isOverPet(e.clientX, e.clientY)) return;
  // When the chat input is open: clicking the pet closes it first, so the input doesn't move with the window while dragging
  if (!chatUiEl.classList.contains('hidden')) {
    closeChat();
  }
  // The second press of a double-click must not start a drag: double-clicks often drift a few
  // pixels (past the 5px drag threshold), which would micro-drag the window and move the chat
  // box around. Suppress drag-start on that press; clicks still register normally.
  const now = Date.now();
  suppressDrag = now - lastMouseDownTime < 350;
  lastMouseDownTime = now;

  lastActivity = Date.now();
  wake();
  dragCandidate = true;
  dragMoved = false;
  dragStartScreen = { x: e.screenX, y: e.screenY };
  // Anchor the drag in the MAIN process (window + cursor offset captured together, synchronously)
  window.api.dragBegin();
  canvas.style.cursor = 'grabbing';
}

function onMouseMove(e: MouseEvent) {
  mouse = { x: e.clientX, y: e.clientY };
  lastActivity = Date.now();
  wake();

  // ---------- Drag state FIRST (before the click-through decision) ----------
  if (dragCandidate && !suppressDrag && !dragging) {
    const dist = Math.hypot(e.screenX - dragStartScreen.x, e.screenY - dragStartScreen.y);
    if (dist > 5) {
      dragging = true;
      dragMoved = true;
      // DOM overlays live inside the same transparent BrowserWindow as the pet. Hide both
      // kinds before moving that window so they never travel across (or beyond) the screen.
      if (!chatUiEl.classList.contains('hidden')) closeChat();
      else hideBubble();
      setState('walking');
    }
  }

  if (dragging) {
    // While dragging, the window MUST stay interactive (never click-through): if it went
    // click-through mid-drag, the mouseup would never be delivered, leaving the drag stuck
    // and the window chasing the cursor across the screen (pet + chat box "move by themselves").
    if (!overPet) {
      overPet = true;
      window.api.setClickThrough(false);
      canvas.style.cursor = 'grabbing';
    }
    if (e.buttons === 0) {
      // Released while the cursor was outside the window: the next in-window mousemove
      // reports buttons=0 — end the drag so the window never chases the cursor.
      endDrag();
      return;
    }
    // Main targets the window at its OWN live cursor (screen.getCursorScreenPoint) minus the
    // drag anchor offset — immune to lost mousemove events (fast drags would otherwise
    // teleport the window) and to renderer screenX/display-scaling mismatches.
    window.api.dragMove();
  } else {
    // Hit state: force interactive when the chat input is open; otherwise decide per-pixel
    const chatOpen = !chatUiEl.classList.contains('hidden');
    const over = chatOpen || isOverPet(e.clientX, e.clientY);
    if (over !== overPet) {
      overPet = over;
      window.api.setClickThrough(!over);
      canvas.style.cursor = over ? 'grab' : 'default';
    }
    if (e.buttons === 0 && dragCandidate) {
      // Mouse released outside the window (buttons already cleared) -> end the drag
      endDrag();
    }
  }
}

function onMouseUp(e: MouseEvent) {
  if (e.button !== 0) return;
  if (dragCandidate && !dragMoved) {
    // Single / double click detection
    const now = Date.now();
    if (now - lastClickTime < 350) {
      lastClickTime = 0;
      handleDoubleClick();
    } else {
      lastClickTime = now;
      handleSingleClick();
    }
  }
  endDrag();
}

function endDrag() {
  const wasDragging = dragging;
  if (wasDragging) {
    setState('idle');
    canvas.style.cursor = overPet ? 'grab' : 'default';
  }
  if (dragCandidate || wasDragging) window.api.dragEnd();
  dragging = false;
  dragCandidate = false;
  dragMoved = false;
  suppressDrag = false;

  // Preserve AI replies that arrived asynchronously during the drag, but only reveal
  // them after the pet window has stopped moving.
  if (wasDragging && deferredBubble) {
    const pending = deferredBubble;
    deferredBubble = null;
    showBubble(pending.text, pending.opts);
  }
}

function handleSingleClick() {
  lastActivity = Date.now();
  setState('click'); // play one jump animation
  playSound();
  showBubble(rand(window.PetricI18n.tArray('lines')));
}

function handleDoubleClick() {
  if (config.aiEnabled) {
    openChat();
  } else {
    showBubble(window.PetricI18n.t('bubble.aiNotEnabled'), { ms: 3000 });
    window.api.openSettings();
  }
}

canvas.addEventListener('mousedown', onMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);
window.addEventListener('blur', endDrag);

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // The context menu also only triggers on pet pixels
  if (!isOverPet(e.clientX, e.clientY)) return;
  lastActivity = Date.now();
  wake();
  window.api.showContextMenu();
});

canvas.addEventListener('mouseenter', () => {
  lastActivity = Date.now();
  wake();
});

// Cursor leaves the window: restore click-through (unless dragging)
canvas.addEventListener('mouseleave', () => {
  if (!dragging && overPet) {
    overPet = false;
    window.api.setClickThrough(true);
    canvas.style.cursor = 'default';
  }
});

window.addEventListener('keydown', (e) => {
  // Ctrl + Shift + P: open the settings panel
  if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    e.preventDefault();
    window.api.openSettings();
    return;
  }
  // Esc: close the chat input first, then quit the app
  if (e.key === 'Escape') {
    if (!chatUiEl.classList.contains('hidden')) {
      closeChat();
    } else {
      window.api.quitApp();
    }
    return;
  }
  lastActivity = Date.now();
  wake();
});

chatSendEl.addEventListener('click', sendChat);
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChat();
  }
});

// Chat history: 🕘 opens the overlay (hiding the console), ✕ closes it back
chatHistoryBtn.addEventListener('click', () => {
  renderChatHistory();
  chatUiEl.classList.add('hidden');
  chatHistoryEl.classList.remove('hidden');
});
chatHistoryClose.addEventListener('click', () => {
  chatHistoryEl.classList.add('hidden');
  chatUiEl.classList.remove('hidden');
  chatInputEl.focus();
});

// ---------- Applying Config ----------
function applyConfig(cfg: AppConfig) {
  const skinChanged = cfg.skin !== config.skin;
  const localeChanged = cfg.locale !== config.locale;
  config = cfg;
  if (localeChanged) {
    void applyLocaleTexts();
  }
  if (skinChanged) {
    if (state !== 'idle') setState('idle');
    // (Re)load the custom appearance when the skin changes
    void refreshCustomSprite();
  }
}

/** Load the locale dictionary from the main process and refresh localized texts. */
async function applyLocaleTexts() {
  const payload = await window.api.getI18n();
  window.PetricI18n.setLocaleData(payload.locale, payload.dict);
  chatInputEl.placeholder = window.PetricI18n.t('chat.placeholder');
  chatSendEl.textContent = window.PetricI18n.t('chat.send');
  chatHistoryBtn.title = window.PetricI18n.t('chat.historyBtn');
  const headSpan = chatHistoryEl.querySelector('.chat-history-head span');
  if (headSpan) headSpan.textContent = window.PetricI18n.t('chat.historyTitle');
}

// ---------- Startup ----------
async function initPet() {
  const cfg = await window.api.getConfig();
  applyConfig(cfg);
  await applyLocaleTexts();

  loadSheets();
  window.api.onConfigChanged(applyConfig);
  window.api.onOpenChatRequest(() => {
    if (config.aiEnabled) openChat();
    else window.api.openSettings();
  });

  // Start in click-through state (Windows); mousemove restores interaction once the cursor is over the pet
  canvas.style.cursor = 'default';
  requestAnimationFrame(loop);

  // First-time greeting
  setTimeout(() => showBubble(window.PetricI18n.t('bubble.greeting'), { ms: 2200 }), 800);
}

initPet();
