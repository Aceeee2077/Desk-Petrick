// ============================================================================
// Petric pet window rendering logic (single script, no import/export, loaded directly by index.html)
//
// Features:
//  - 12 FPS sprite-frame animation driven by requestAnimationFrame (framerate scaled by the animation-speed multiplier)
//  - State machine: idle / walking (dragging) / sleeping (30s of inactivity) / click (click jump)
//  - Eyes follow the mouse + periodic blinking + floating Zzz while sleeping
//  - Drag to move the window (absolute positioning in screen coordinates, no cumulative drift)
//  - Single click: speech bubble / double click: AI chat (history kept in localStorage)
//  - Affinity (好感度): clicking / dragging / chatting raise affinity, shown as hearts in a corner badge
//  - Focus mode (专注模式): while enabled, reminds the user every N minutes to stand up and stretch
//  - Accessories (装扮系统): procedural pixel hat / scarf / glasses overlaid on built-in skins
//  - Idle actions (随机小动作): the pet randomly yawns / stretches / scratches / dances while idle
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
const affinityBadgeEl = document.getElementById('affinity-badge') as HTMLDivElement;

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
  autoCutout: true,
  cutoutTolerance: 25,
  locale: 'zh',
  theme: 'light',
  accessory: 'none',
  affinity: 0,
  focusMode: true,
  focusInterval: 40,
  statsFirstSeen: '',
  statsDays: [],
  statsClicks: 0,
  statsChats: 0,
  affinityHistory: [],
};

// Smoke mode (main loads index.html?smoke=1): skip auto-played idle actions so
// synthetic clicks in the smoke test always land on the pet.
const IS_SMOKE = /[?&]smoke=1/.test(window.location.search);

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

// ---------- Affinity (好感度) ----------
// The pet grows closer to you as you interact: clicking, dragging and chatting all
// add affinity (persisted in the config). Levels show as hearts on a small badge.
const AFFINITY_MAX = 100;
const AFFINITY_LEVEL_MINS = [0, 20, 40, 60, 80]; // a level starts once the value reaches its min

function affinityLevelIndex(value: number): number {
  let idx = 0;
  for (let i = 0; i < AFFINITY_LEVEL_MINS.length; i++) {
    if (value >= AFFINITY_LEVEL_MINS[i]) idx = i;
  }
  return idx;
}

function affinityLevelName(value: number): string {
  return window.PetricI18n.t(`affinity.level${affinityLevelIndex(value) + 1}`);
}

/** Rebuild the hearts badge in the top-right corner of the pet window. */
function renderAffinityBadge() {
  const idx = affinityLevelIndex(config.affinity);
  let hearts = '';
  for (let i = 0; i < 5; i++) {
    hearts += `<span class="${i <= idx ? 'on' : 'off'}">♥</span>`;
  }
  affinityBadgeEl.innerHTML = hearts;
  affinityBadgeEl.title = window.PetricI18n.t('affinity.badgeTitle', {
    value: Math.round(config.affinity),
    level: affinityLevelName(config.affinity),
  });
}

let affinitySaveTimer: number | undefined;

/** Persist affinity + interaction stats (debounced so rapid clicks don't thrash the config file). */
function saveStats() {
  window.clearTimeout(affinitySaveTimer);
  affinitySaveTimer = window.setTimeout(() => {
    void window.api.setConfig({
      affinity: Math.round(config.affinity),
      statsClicks: config.statsClicks,
      statsChats: config.statsChats,
      affinityHistory: config.affinityHistory.slice(-120),
    });
  }, 500);
}

/** Local date as YYYY-MM-DD (matches the main process's companion-day tracking). */
function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Append one affinity snapshot per interaction day (for the growth curve in Settings). */
function recordAffinitySnapshot() {
  const hist = Array.isArray(config.affinityHistory) ? config.affinityHistory.slice() : [];
  const last = hist[hist.length - 1];
  const today = todayStr();
  if (!last || last.date !== today) {
    hist.push({ date: today, value: Math.round(config.affinity) });
    config.affinityHistory = hist;
  }
}

/** Add affinity from an interaction; returns whether it caused a level-up. */
function addAffinity(n: number): boolean {
  const beforeIdx = affinityLevelIndex(config.affinity);
  config.affinity = Math.min(AFFINITY_MAX, config.affinity + n);
  recordAffinitySnapshot();
  saveStats();
  renderAffinityBadge();
  return affinityLevelIndex(config.affinity) > beforeIdx;
}

// ---------- Focus mode / break reminder (专注模式) ----------
// While the pet is open and focus mode is on, Petric reminds you every
// focusInterval minutes to stand up and stretch (text follows the UI language).
let reminderTimer: number | undefined;

function startReminder() {
  window.clearInterval(reminderTimer);
  if (!config.focusMode) return;
  const minutes = Math.max(5, config.focusInterval || 40);
  reminderTimer = window.setInterval(remind, minutes * 60_000);
}

function remind() {
  // Wake the pet and play a little jump so the reminder is hard to miss
  lastActivity = Date.now();
  wake();
  setState('click');
  const text = '⏰ ' + window.PetricI18n.t('reminder.break');
  if (!chatUiEl.classList.contains('hidden')) {
    showChatReply(text);
  } else {
    showBubble(text, { ms: 6000 });
  }
  playChime();
}

// ---------- Random idle actions (随机小动作) ----------
// While the pet idles it occasionally yawns / stretches / scratches / dances.
// These are drawn as canvas transforms on top of the idle sprite (no extra sprite
// rows needed), and only apply to the built-in sprite skins.
type IdleAction = 'yawn' | 'stretch' | 'scratch' | 'dance';

let currentAction: { type: IdleAction; t0: number } | null = null;
let nextActionAt = Date.now() + 8000 + Math.random() * 10000; // first action after 8-18s of idle

const ACTION_DURATION: Record<IdleAction, number> = { yawn: 2.0, stretch: 2.2, scratch: 2.4, dance: 2.6 };
const ACTION_TYPES: IdleAction[] = ['yawn', 'stretch', 'scratch', 'dance'];

/** Compute the per-frame action transform (rotation / scale / yawn mouth / closed eyes). */
function computeActionFx(): {
  rot: number;
  scx: number;
  scy: number;
  mouth: number;
  eyesClosed: boolean;
} | null {
  if (!currentAction || config.skin === 'custom' || state !== 'idle') return null;
  const t = (performance.now() - currentAction.t0) / 1000;
  const T = ACTION_DURATION[currentAction.type];
  const p = Math.min(1, t / T);
  const env = Math.sin(Math.PI * p); // 0 → 1 → 0 envelope
  switch (currentAction.type) {
    case 'yawn': {
      // Mouth opens, holds, then closes; eyes shut while it's open wide
      const mouth = p < 0.35 ? p / 0.35 : p > 0.75 ? (1 - p) / 0.25 : 1;
      return { rot: 0, scx: 1 + env * 0.02, scy: 1 + env * 0.06, mouth, eyesClosed: mouth > 0.55 };
    }
    case 'stretch':
      // Tall stretch: grow upward, slight x-squash
      return { rot: 0, scx: 1 - env * 0.05, scy: 1 + env * 0.18, mouth: 0, eyesClosed: false };
    case 'scratch':
      // Scratch: tilt side to side around the feet
      return { rot: Math.sin(t * 2 * Math.PI * 1.5) * 0.09 * env, scx: 1, scy: 1, mouth: 0, eyesClosed: false };
    case 'dance':
      // Dance: lively side-to-side sway + scale wobble
      return {
        rot: Math.sin(t * 2 * Math.PI * 2.2) * 0.16,
        scx: 1 + Math.sin(t * 2 * Math.PI * 4.4) * 0.03,
        scy: 1,
        mouth: 0,
        eyesClosed: false,
      };
  }
}

/** Stop the current idle action and schedule the next one. */
function stopAction() {
  if (currentAction) {
    currentAction = null;
    nextActionAt = Date.now() + 6000 + Math.random() * 10000;
  }
}

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
  (['cat', 'dog', 'default', 'robot'] as PetSkin[]).forEach((s) => {
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
    currentAction = null;
    enterSleep();
  }

  // Random idle actions: while awake and idle (and not in smoke mode) the pet
  // occasionally yawns / stretches / scratches / dances on its own.
  if (!IS_SMOKE && state === 'idle' && !dragging && chatUiEl.classList.contains('hidden')) {
    if (!currentAction && now >= nextActionAt) {
      currentAction = { type: ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)], t0: now };
    }
    if (currentAction && now - currentAction.t0 >= ACTION_DURATION[currentAction.type] * 1000) {
      currentAction = null;
      nextActionAt = now + 6000 + Math.random() * 10000;
    }
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

function drawEyes(forceClosed = false) {
  const poseDy = POSE_DY[state][frameIndex] ?? 0;
  const { left, right, head } = eyeScreenPos(poseDy);
  ctx.save();
  ctx.lineCap = 'round';

  if (state === 'sleeping' || forceClosed) {
    // Closed-eye arc while sleeping / yawning
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

// ---------- Accessories (装扮系统) ----------
// Procedural pixel accessories drawn on top of the built-in sprite sheets, at the
// same frame-coordinate positions as the eyes (scaled by SHEET.scale).
const ACC_COLORS = {
  red: '#e05555',
  redDark: '#a03030',
  outline: '#5a2d2d',
  white: '#f4f0ea',
  lens: 'rgba(255,255,255,0.28)',
};

function drawAccessory() {
  const acc = config.accessory;
  if (!acc || acc === 'none') return;
  const poseDy = POSE_DY[state][frameIndex] ?? 0;
  const sx = (fx: number) => PET_X + fx * SHEET.scale;
  const sy = (fy: number) => PET_Y + (fy + poseDy) * SHEET.scale;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (acc === 'hat') {
    // Red beanie: crown + brim + pompom
    ctx.fillStyle = ACC_COLORS.red;
    ctx.strokeStyle = ACC_COLORS.outline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(sx(12.8), sy(0.8), 6.4 * SHEET.scale, 4.6 * SHEET.scale, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACC_COLORS.redDark;
    ctx.beginPath();
    ctx.roundRect(sx(11.4), sy(5.2), 9.2 * SHEET.scale, 1.6 * SHEET.scale, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACC_COLORS.white;
    ctx.beginPath();
    ctx.arc(sx(16), sy(0.8), 1.3 * SHEET.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ACC_COLORS.outline;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else if (acc === 'scarf') {
    // Warm scarf: neck band + hanging tail with a tassel
    ctx.fillStyle = ACC_COLORS.red;
    ctx.strokeStyle = ACC_COLORS.outline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(sx(11.4), sy(16.6), 9.2 * SHEET.scale, 1.7 * SHEET.scale, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(sx(17.6), sy(18.1), 2.0 * SHEET.scale, 3.2 * SHEET.scale, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACC_COLORS.redDark;
    ctx.fillRect(sx(17.6), sy(21), 2.0 * SHEET.scale, 0.7 * SHEET.scale);
  } else if (acc === 'glasses') {
    // Round glasses around the eyes (drawn before the pupils so they show through)
    ctx.strokeStyle = '#3b2f26';
    ctx.lineWidth = 2.2;
    ctx.fillStyle = ACC_COLORS.lens;
    ([[11.5, 13.2], [20.5, 13.2]] as [number, number][]).forEach(([ex, ey]) => {
      ctx.beginPath();
      ctx.arc(sx(ex), sy(ey), 2.5 * SHEET.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    // Bridge
    ctx.beginPath();
    ctx.moveTo(sx(14.2), sy(13.2));
    ctx.lineTo(sx(17.8), sy(13.2));
    ctx.stroke();
    // Temples
    ctx.beginPath();
    ctx.moveTo(sx(9.0), sy(13.2));
    ctx.lineTo(sx(7.4), sy(12.3));
    ctx.moveTo(sx(23.0), sy(13.2));
    ctx.lineTo(sx(24.6), sy(12.3));
    ctx.stroke();
  }

  ctx.restore();
}

/** Open mouth drawn while yawning (mouth: 0 = closed … 1 = wide open). */
function drawYawnMouth(mouth: number) {
  const poseDy = POSE_DY[state][frameIndex] ?? 0;
  const mx = PET_X + 16 * SHEET.scale;
  const my = PET_Y + (16 + poseDy) * SHEET.scale;
  const rx = (1.6 + mouth * 1.8) * SHEET.scale;
  const ry = (0.9 + mouth * 2.2) * SHEET.scale;
  ctx.fillStyle = '#5a3f33';
  ctx.beginPath();
  ctx.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  if (mouth > 0.5) {
    ctx.fillStyle = '#e08a8a';
    ctx.beginPath();
    ctx.ellipse(mx, my + ry * 0.35, rx * 0.55, ry * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function draw() {
  ctx.clearRect(0, 0, 300, 300);

  // Ground shadow (also shown under the 3D model; stays untransformed)
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(150, 296, 34, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  const isCustom = config.skin === 'custom';
  const fx = computeActionFx();

  // Idle actions rotate / stretch the pet around its feet; the pet, its accessory,
  // the eyes and the yawn mouth all live inside the same transform so they stay attached.
  ctx.save();
  if (fx) {
    ctx.translate(150, 292);
    ctx.rotate(fx.rot);
    ctx.scale(fx.scx, fx.scy);
    ctx.translate(-150, -292);
  }

  if (pet3dActive && pet3d) {
    // 3D mode: the model lives on its own canvas (pet3d-canvas); only the shadow + Zzz stay on the 2D canvas
    currentPetTop = 172; // approximate model top for Zzz particles
  } else if (isCustom && customSprite) {
    drawCustomPet();
  } else {
    drawBuiltInPet();
  }

  // Accessories + eyes only apply to built-in sprites (custom images already contain their face)
  if (!isCustom) {
    drawAccessory();
    drawEyes(fx ? fx.eyesClosed : false);
    if (fx && fx.mouth > 0) drawYawnMouth(fx.mouth);
  }
  ctx.restore();

  // Affinity badge: keep it centered directly above the pet (and below the speech bubble /
  // chat console, whose bottom sits at 186px). Follows the pet's current top (built-in,
  // custom image or 3D model) so it never drifts away.
  affinityBadgeEl.style.bottom = `${300 - currentPetTop + 6}px`;

  // Sleep Zzz (color follows the theme: purple in dark mode, orange in light mode)
  if (state === 'sleeping') {
    ctx.font = 'bold 15px Nunito, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    zzzs.forEach((z) => {
      ctx.fillStyle = `rgba(${zzzRgb}, ${z.alpha.toFixed(3)})`;
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

// ---------- Auto cutout (自动抠图) ----------
// Removes the solid / simple background from an imported image: flood-fill from the
// image borders with an edge-connected color tolerance (handles flat AND gradient
// backgrounds), then a fringe pass eats the anti-aliased halo at the cut line.
// Returns a new PNG data URL; falls back to the original on any failure.

function cutoutBackground(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h || w < 8 || h < 8) {
          resolve(dataUrl);
          return;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true })!;
        cx.drawImage(img, 0, 0);
        const imgData = cx.getImageData(0, 0, w, h);
        const d = imgData.data;
        // Tolerance in RGB distance (0..441); slider range 8..60 maps to a useful band
        const tol = ((config.cutoutTolerance ?? 25) / 25) * 110;
        const alphaAt = (p: number) => d[p * 4 + 3];
        const colorDist = (a: number, b: number) => {
          const dr = d[a * 4] - d[b * 4];
          const dg = d[a * 4 + 1] - d[b * 4 + 1];
          const db = d[a * 4 + 2] - d[b * 4 + 2];
          return Math.sqrt(dr * dr + dg * dg + db * db);
        };

        // BFS flood fill from every opaque border pixel (edge-connected tolerance)
        const removed = new Uint8Array(w * h);
        const queue = new Int32Array(w * h);
        let head = 0;
        let tail = 0;
        const seed = (p: number) => {
          if (removed[p] || alphaAt(p) === 0) return;
          removed[p] = 1;
          queue[tail++] = p;
        };
        for (let x = 0; x < w; x++) {
          seed(x);
          seed((h - 1) * w + x);
        }
        for (let y = 1; y < h - 1; y++) {
          seed(y * w);
          seed(y * w + w - 1);
        }
        while (head < tail) {
          const p = queue[head++];
          const x = p % w;
          const y = (p / w) | 0;
          if (x > 0 && !removed[p - 1] && colorDist(p, p - 1) <= tol) {
            removed[p - 1] = 1;
            queue[tail++] = p - 1;
          }
          if (x < w - 1 && !removed[p + 1] && colorDist(p, p + 1) <= tol) {
            removed[p + 1] = 1;
            queue[tail++] = p + 1;
          }
          if (y > 0 && !removed[p - w] && colorDist(p, p - w) <= tol) {
            removed[p - w] = 1;
            queue[tail++] = p - w;
          }
          if (y < h - 1 && !removed[p + w] && colorDist(p, p + w) <= tol) {
            removed[p + w] = 1;
            queue[tail++] = p + w;
          }
        }

        // Fringe pass: also drop opaque pixels hugging the cut line that are close in
        // color to the removed background (eats the anti-aliased halo).
        const fringe = new Uint8Array(w * h);
        for (let p = 0; p < w * h; p++) {
          if (removed[p] || alphaAt(p) === 0) continue;
          const x = p % w;
          const y = (p / w) | 0;
          const near = (q: number) => removed[q] && colorDist(p, q) <= tol * 1.4;
          if (
            (x > 0 && near(p - 1)) ||
            (x < w - 1 && near(p + 1)) ||
            (y > 0 && near(p - w)) ||
            (y < h - 1 && near(p + w))
          ) {
            fringe[p] = 1;
          }
        }
        for (let p = 0; p < w * h; p++) {
          if (removed[p] || fringe[p]) d[p * 4 + 3] = 0;
        }

        cx.putImageData(imgData, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(dataUrl); // never break the custom appearance because of cutout
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
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

  // Auto cutout applies to flat image modes (single / billboard), not sheets or 3D models
  const canCutout = config.autoCutout && (res.mode === 'single' || res.mode === 'billboard');
  const dataUrl = canCutout ? await cutoutBackground(res.dataUrl) : res.dataUrl;

  if (res.mode === 'model' || res.mode === 'billboard') {
    // 3D scene modes: 'model' = GLB mesh, 'billboard' = 2.5D image plane
    if (!pet3d) pet3d = initPet3D();
    if (!pet3d) {
      showBubble(window.PetricI18n.t('bubble.no3d'), { ms: 4000 });
      window.api.setConfig({ skin: 'cat' });
      return;
    }
    const ok =
      res.mode === 'billboard' ? await pet3d.loadBillboard(dataUrl) : await pet3d.loadModel(dataUrl);
    if (!ok) {
      showBubble(window.PetricI18n.t('bubble.modelLoadFail'), { ms: 4000 });
      window.api.setConfig({ skin: 'cat' });
      return;
    }
    pet3dActive = true;
    pet3d.setVisible(true);
  } else {
    customSprite = await buildCustomSprite(dataUrl, res.mode || 'single');
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
    config.statsChats = (config.statsChats || 0) + 1; // interaction stats
    addAffinity(2); // chatting with the pet makes you closer
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

/** A gentle two-note chime used by the focus-mode break reminder (Web Audio synthesis). */
function playChime() {
  if (!config.soundEnabled) return;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = audioCtx || new AC();
    const t = audioCtx.currentTime;
    [660, 880].forEach((freq, i) => {
      const start = t + i * 0.18;
      const o = audioCtx!.createOscillator();
      const g = audioCtx!.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.001, start);
      g.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      o.connect(g);
      g.connect(audioCtx!.destination);
      o.start(start);
      o.stop(start + 0.24);
    });
  } catch {
    /* stay silent when audio is unavailable */
  }
}

// ---------- Interaction ----------
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  // Per-pixel hit: ignore when the cursor is not on the pet (transparent areas pass clicks to the desktop)
  if (!isOverPet(e.clientX, e.clientY)) return;
  // When the chat console or history overlay is open: clicking the pet closes them first,
  // so neither travels with the window while dragging
  if (!chatUiEl.classList.contains('hidden') || !chatHistoryEl.classList.contains('hidden')) {
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
  stopAction(); // a real press interrupts any yawn / stretch / dance
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
      // DOM overlays live inside the same transparent BrowserWindow as the pet. Hide them all
      // before moving that window so they never travel across (or beyond) the screen.
      if (!chatUiEl.classList.contains('hidden') || !chatHistoryEl.classList.contains('hidden')) closeChat();
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
    // Hit state: force interactive while the chat console OR the history overlay is open
    // (otherwise the window would go click-through and the ✕/scroll would stop working);
    // otherwise decide per-pixel.
    const chatOpen = !chatUiEl.classList.contains('hidden') || !chatHistoryEl.classList.contains('hidden');
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
    addAffinity(1); // picking the pet up and carrying it also warms its heart
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
  config.statsClicks = (config.statsClicks || 0) + 1; // interaction stats
  const leveledUp = addAffinity(1);
  if (leveledUp) {
    if (config.affinity >= AFFINITY_MAX) {
      showBubble(window.PetricI18n.t('affinity.maxed'));
    } else {
      showBubble(
        window.PetricI18n.t('affinity.levelUp', {
          level: affinityLevelIndex(config.affinity) + 1,
          name: affinityLevelName(config.affinity),
        }),
      );
    }
  } else if (config.affinity >= AFFINITY_MAX && Math.random() < 0.3) {
    showBubble(window.PetricI18n.t('affinity.maxed'));
  } else {
    showBubble(rand(window.PetricI18n.tArray('lines')));
  }
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
  // Esc: close the chat console / history overlay first, then quit the app
  if (e.key === 'Escape') {
    if (!chatUiEl.classList.contains('hidden') || !chatHistoryEl.classList.contains('hidden')) {
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
/** Zzz particle base color (RGB triple) read from the theme CSS variable */
let zzzRgb = '122, 96, 178';

/** Apply the UI theme: light = orange-white gradient, dark = the original purple tone. */
function applyTheme() {
  document.documentElement.dataset.theme = config.theme;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--zzz').trim();
  if (v) zzzRgb = v;
}

function applyConfig(cfg: AppConfig) {
  const skinChanged = cfg.skin !== config.skin;
  const localeChanged = cfg.locale !== config.locale;
  const cutoutChanged = cfg.autoCutout !== config.autoCutout || cfg.cutoutTolerance !== config.cutoutTolerance;
  config = cfg;
  applyTheme();
  if (localeChanged) {
    void applyLocaleTexts();
  }
  if (skinChanged || (cutoutChanged && config.skin === 'custom')) {
    if (state !== 'idle') setState('idle');
    // (Re)load the custom appearance when the skin or the cutout settings change
    void refreshCustomSprite();
  }
  startReminder(); // restart the break-reminder timer when the interval / mode changes
  renderAffinityBadge(); // keep the hearts badge in sync (incl. changes from the settings panel)
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
  renderAffinityBadge(); // the badge tooltip shows the localized level name
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
