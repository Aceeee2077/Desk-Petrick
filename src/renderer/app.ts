// ============================================================================
// Petric pet window rendering logic (single script, no import/export, loaded directly by index.html)
//
// Features:
//  - 12 FPS sprite-frame animation driven by requestAnimationFrame (framerate scaled by the animation-speed multiplier)
//  - State machine: idle / walking (dragging) / sleeping (30s of inactivity) / click (click jump)
//  - Eyes follow the mouse + periodic blinking + floating Zzz while sleeping
//  - Drag to move the window (absolute positioning in screen coordinates, no cumulative drift)
//  - Single click: speech bubble / double click: opens the AI chat window (conversations
//    are stored in the main process and shared with the ChatGPT-style chat window)
//  - Affinity (好感度): clicking / dragging / chatting raise affinity, shown as hearts in a corner badge
//  - Focus mode (专注模式): while enabled, reminds the user every N minutes to stand up and stretch
//  - Accessories (装扮系统): procedural pixel hat / scarf / glasses for the built-in pixel sheets
//  - Idle actions (随机小动作): the pet randomly yawns / stretches / scratches / dances while idle
//  - Life assistant (生活助手): proactive greetings, weather reports and an hourly chime
//  - Hotkeys: Ctrl+Shift+P opens settings; Esc quits the pet
//
// Global types come from src/shared/types.ts (interface declarations, compile-time only).
// ============================================================================

const canvas = document.getElementById('pet-canvas') as HTMLCanvasElement;
const bubbleEl = document.getElementById('bubble') as HTMLDivElement;
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
  greetEnabled: true,
  weatherEnabled: true,
  hourlyChime: true,
  photoEyes: null,
  autoMove: true,
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
let lastDragScreenX = 0;
let facingDir: -1 | 1 = 1;
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
  // Make the reminder impossible to miss: stop any autonomous walk, dash to the
  // CENTER of the current screen, do a visible hop, then show the bubble.
  lastActivity = Date.now();
  endAutoMove(); // stop gliding so the centering sticks
  nextWanderAt = Date.now() + 25000; // stay at the center while the reminder shows
  wake();
  setState('click');
  window.api.centerHere(); // teleport to the middle of the screen
  window.api.autoJump(20, 480); // a lively hop for attention
  const text = '⏰ ' + window.PetricI18n.t('reminder.break');
  showBubble(text, { ms: 7000 });
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
  if (!currentAction || state !== 'idle') return null;
  // 3D modes render on their own WebGL canvas, so the 2D action transform can't apply.
  // 2D custom images (single / sheet) DO get the actions (dance / stretch / tilt…).
  if (pet3dActive && pet3d) return null;
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
  endAutoMove(); // a real interaction also interrupts any autonomous walk
  nextGreetAt = Date.now() + GREET_IDLE_MS; // a real interaction also defers the proactive greeting
}

// ---------- Autonomous movement (自主走动) ----------
// The pet decides on its own to walk / run / hop around the desktop. The renderer
// orchestrates (it owns the state machine) and the MAIN process glides the window
// (auto:move-start/stop) or hops it (auto:jump). Movement only happens while the
// pet is awake and idle, and any interaction interrupts it immediately.
let autoMoveIntent: { dir: number; speed: number } | null = null;
let autoMoveTimer: number | undefined;
let nextWanderAt = Date.now() + 5000 + Math.random() * 8000; // first wander after ~5-13s of idle

/** Glide the window in `dir` (-1 left / +1 right) for `durationMs`. */
function beginAutoMove(dir: number, speed: number, durationMs: number) {
  endAutoMove();
  facingDir = dir < 0 ? -1 : 1;
  autoMoveIntent = { dir, speed };
  window.api.autoMoveStart(dir, speed);
  autoMoveTimer = window.setTimeout(endAutoMove, durationMs);
}

/** Stop the autonomous glide (and the walking pose that belongs to it). */
function endAutoMove() {
  if (autoMoveIntent) {
    autoMoveIntent = null;
    window.clearTimeout(autoMoveTimer);
    window.api.autoMoveStop();
    if (state === 'walking') setState('idle');
  }
}

/** Walk (run=false) or run (run=true) in a random direction for a short while. */
function startWanderActivity(run: boolean) {
  const dir = Math.random() < 0.5 ? -1 : 1;
  const speed = run ? 170 + Math.random() * 90 : 70 + Math.random() * 60;
  const duration = run ? 900 + Math.random() * 1300 : 1600 + Math.random() * 2400;
  // Running pets often start with a little hop for extra life
  if (run && Math.random() < 0.6) window.api.autoJump(12, 320);
  setState('walking');
  beginAutoMove(dir, speed, duration);
}

/** Hop in place: the window jumps along a parabolic arc while the pet plays its jump pose. */
function startJumpActivity() {
  const height = 22 + Math.random() * 18;
  setState('click'); // the jump animation; stepFrame returns to idle afterwards
  window.api.autoJump(height, 500);
}

/** Pick the next autonomous activity from a weighted pool (autoMove must be on). */
function pickAutoActivity() {
  const roll = Math.random();
  if (roll < 0.3) {
    startWanderActivity(false); // walk
  } else if (roll < 0.5) {
    startWanderActivity(true); // run
  } else if (roll < 0.66) {
    startJumpActivity(); // hop
  } else if (roll < 0.86) {
    // a familiar idle action (yawn / stretch / scratch / dance)
    currentAction = { type: ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)], t0: Date.now() };
    nextActionAt = Date.now() + 8000 + Math.random() * 10000;
  }
  // otherwise: rest until the next scheduled activity
}

// ---------- Proactive chat (主动搭话) ----------
// After 10 minutes without any interaction the pet wakes up and says hi once.
const GREET_IDLE_MS = 10 * 60 * 1000;
let nextGreetAt = Date.now() + GREET_IDLE_MS;

function maybeGreet(now: number) {
  if (
    config.greetEnabled &&
    now >= nextGreetAt &&
    !dragging &&
    !autoMoveIntent && // don't talk while it's walking around
    !currentAction
  ) {
    nextGreetAt = now + GREET_IDLE_MS;
    wake(); // it was probably sleeping — wake it so the greeting is visible
    showBubble(rand(window.PetricI18n.tArray('greet.lines')), { ms: 4000 });
  }
}

// ---------- Weather (天气播报) ----------
// The main process fetches location + forecast from free APIs and caches them;
// this side only caches the latest result for instant bubbles on clicks.
let weatherData: WeatherResult | null = null;
let weatherLoading = false;

async function refreshWeather(): Promise<WeatherResult | null> {
  if (weatherLoading) return weatherData;
  weatherLoading = true;
  try {
    weatherData = await window.api.getWeather();
  } catch {
    weatherData = { ok: false, error: 'ipc failed' };
  }
  weatherLoading = false;
  return weatherData;
}

/** Map a WMO weather code to one of the localized 'weather.N' descriptions. */
function wmoGroup(code: number): number {
  if (code === 0) return 0;
  if (code >= 1 && code <= 3) return 1;
  if (code === 45 || code === 48) return 3;
  if (code >= 51 && code <= 55) return 4;
  if (code >= 56 && code <= 67) return code >= 56 && code <= 57 ? 6 : 5;
  if (code >= 71 && code <= 77) return 7;
  if (code >= 80 && code <= 82) return 8;
  if (code === 85 || code === 86) return 9;
  if (code === 95) return 10;
  if (code === 96 || code === 99) return 11;
  return 2;
}

/** Build the localized weather bubble text, or null when unavailable. */
function weatherBubbleText(): string | null {
  if (!weatherData?.ok) return null;
  const i18n = window.PetricI18n;
  const d = new Date((weatherData.date || todayStr()) + 'T00:00:00');
  const date =
    i18n.getLocale() === 'en'
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : `${d.getMonth() + 1}月${d.getDate()}日`;
  const desc = i18n.t('weather.' + wmoGroup(weatherData.code ?? 0));
  return i18n.t('weather.today', {
    date,
    city: weatherData.city || '—',
    temp: weatherData.temp ?? 0,
    desc,
  });
}

/** Click-time weather report: cached result, or a loading bubble that resolves. */
async function maybeShowWeather() {
  if (weatherData?.ok) {
    showBubble(weatherBubbleText()!, { ms: 4500 });
    return;
  }
  showBubble(window.PetricI18n.t('weather.loading'), { ms: 3000 });
  await refreshWeather();
  if (weatherData?.ok) showBubble(weatherBubbleText()!, { ms: 4500 });
  else showBubble(window.PetricI18n.t('weather.unavailable'), { ms: 3000 });
}

// ---------- Hourly chime (整点报时) ----------
let chimeTimer: number | undefined;

function scheduleChime() {
  window.clearTimeout(chimeTimer);
  if (!config.hourlyChime) return;
  const now = new Date();
  const ms = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 1500;
  chimeTimer = window.setTimeout(chime, Math.max(1000, ms));
}

function chime() {
  const hour = new Date().getHours();
  const i18n = window.PetricI18n;
  const display =
    i18n.getLocale() === 'en'
      ? `${((hour + 11) % 12) + 1} ${hour < 12 ? 'AM' : 'PM'}`
      : String(hour);
  const text = '⏰ ' + i18n.t('chime.hour', { hour: display });
  lastActivity = Date.now();
  wake();
  setState('click'); // a little jump to draw attention
  showBubble(text, { ms: 5000 });
  playChime();
  scheduleChime();
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
let hitAlpha: Uint8Array | null = null; // JS mirror of the hit map — kills per-move GPU readbacks
let overPet = false; // whether the cursor is currently over the pet

/**
 * Rebuild the hit map after each frame's draw. The canvas-to-canvas downscale runs
 * on the GPU; the alpha plane is then read back ONCE per frame into a JS array so
 * mousemove / clicks never stall the pipeline with getImageData calls.
 */
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
  const d = hctx.getImageData(0, 0, hw, hh).data;
  if (!hitAlpha || hitAlpha.length !== hw * hh) hitAlpha = new Uint8Array(hw * hh);
  for (let i = 0, p = 3; i < hw * hh; i++, p += 4) hitAlpha[i] = d[p];
}

/** Whether the cursor (window coordinates) falls on the pet (2D pixel hitmap or 3D raycast) */
function isOverPet(clientX: number, clientY: number): boolean {
  if (pet3dActive && pet3d) return pet3d.isOver(clientX, clientY);
  if (!hitAlpha || !hitCanvas) return false;
  // Coarse bounding-box early-out: the pet never reaches the far corners of the window.
  if (clientX < 70 || clientX > 230 || clientY < 90) return false;
  const hx = Math.floor(clientX / HIT_SCALE);
  const hy = Math.floor(clientY / HIT_SCALE);
  if (hx < 0 || hy < 0 || hx >= hitCanvas.width || hy >= hitCanvas.height) return false;
  return hitAlpha[hy * hitCanvas.width + hx] > 20; // alpha threshold, ignores semi-transparent edges
}

// Built-in appearance cache (preloaded for zero-wait switching). The four illustrated
// animals use 64px cells with baked-in faces; the procedural robot keeps its 32px cells.
// dog & default remain as legacy IDs so existing fox / rabbit configs keep working.
const sheets: Record<string, HTMLImageElement> = {};
const ILLUSTRATED_PET_SHEETS: Partial<Record<PetSkin, string>> = {
  cat: '../assets/animated-pets/cat.png',
  dog: '../assets/animated-pets/fox.png',
  default: '../assets/animated-pets/rabbit.png',
  bulu: '../assets/animated-pets/bulu.png',
};

// Which illustrated sheets face LEFT in their source art (most AI pose boards come out
// facing right). Such pets must be mirrored when moving RIGHT — the opposite of the rest.
const ILLUSTRATED_FACES_LEFT: Partial<Record<PetSkin, boolean>> = {
  bulu: true,
};

function isIllustratedPet(skin: PetSkin): boolean {
  return Boolean(ILLUSTRATED_PET_SHEETS[skin]);
}

// ---------- Illustrated idle stabilization ----------
// AI pose boards sometimes contain one stray idle frame (body shifted / face changed).
// Played at the normal idle rate it reads as fast left-right swaying and blinking.
// After each illustrated sheet loads we analyse its idle row: if one frame is a clear
// outlier we drop it from the cycle, and illustrated idle is slowed to a calm 3 fps.
const ILLUSTRATED_IDLE_PLANS: Record<string, { fps: number; drop: number }> = {};

function analyzeIdleRow(skin: PetSkin, img: HTMLImageElement) {
  ILLUSTRATED_IDLE_PLANS[skin] = { fps: 3, drop: -1 };
  try {
    const fw = Math.max(1, Math.round(img.naturalWidth / SHEET.cols));
    const fh = Math.max(1, Math.round(img.naturalHeight / SHEET.rows));
    const c = document.createElement('canvas');
    c.width = fw;
    c.height = fh;
    const cx = c.getContext('2d', { willReadFrequently: true })!;
    const masks: Uint8Array[] = [];
    for (let col = 0; col < SHEET.cols; col++) {
      cx.clearRect(0, 0, fw, fh);
      cx.drawImage(img, col * fw, 0, fw, fh, 0, 0, fw, fh);
      const d = cx.getImageData(0, 0, fw, fh).data;
      const m = new Uint8Array(256); // 16x16 occupancy mask
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          let n = 0;
          for (let by = Math.floor((y * fh) / 16); by < Math.ceil(((y + 1) * fh) / 16) && by < fh; by++) {
            for (let bx = Math.floor((x * fw) / 16); bx < Math.ceil(((x + 1) * fw) / 16) && bx < fw; bx++) {
              if (d[(by * fw + bx) * 4 + 3] > 40) n++;
            }
          }
          m[y * 16 + x] = n > 0 ? 1 : 0;
        }
      }
      masks.push(m);
    }
    const diff = (a: Uint8Array, b: Uint8Array) => {
      let s = 0;
      for (let i = 0; i < 256; i++) if (a[i] !== b[i]) s++;
      return s;
    };
    const scores = masks.map((m, i) => {
      let s = 0;
      for (let j = 0; j < masks.length; j++) if (j !== i) s += diff(m, masks[j]);
      return s / (masks.length - 1);
    });
    const maxIdx = scores.indexOf(Math.max(...scores));
    const others = scores.filter((_, i) => i !== maxIdx);
    const meanOther = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    // Drop only a clear outlier (large absolute AND relative difference)
    if (scores[maxIdx] > 45 && scores[maxIdx] > meanOther * 1.5) {
      ILLUSTRATED_IDLE_PLANS[skin] = { fps: 3, drop: maxIdx };
    }
  } catch {
    /* keep the default 4-frame idle on any analysis failure */
  }
}

/** The ordered idle source-columns to cycle for the current skin (drops the outlier). */
function illustratedIdleCycle(): number[] | null {
  if (!isIllustratedPet(config.skin)) return null;
  const plan = ILLUSTRATED_IDLE_PLANS[config.skin];
  if (!plan) return null;
  const cols: number[] = [];
  for (let i = 0; i < SHEET.cols; i++) if (i !== plan.drop) cols.push(i);
  return cols;
}

/** Source column of the current idle frame (accounts for the dropped outlier). */
function currentIdleSourceColumn(): number {
  const cycle = illustratedIdleCycle();
  return cycle ? cycle[frameIndex % cycle.length] : frameIndex;
}

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
  (['cat', 'dog', 'default', 'bulu', 'robot'] as PetSkin[]).forEach((s) => {
    const img = new Image();
    img.src = ILLUSTRATED_PET_SHEETS[s] ?? `../assets/sprites/${s}.png`;
    if (ILLUSTRATED_PET_SHEETS[s]) {
      img.onload = () => analyzeIdleRow(s, img);
    }
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
  startLoop(); // resume the full-speed loop immediately on any interaction
}

function enterSleep() {
  setState('sleeping');
  zzzs.length = 0;
}

function stepFrame(dt: number) {
  const meta = SHEET.states[state];
  // Illustrated pets idle on a calmer, stabilised cycle (see analyzeIdleRow)
  const plan = state === 'idle' ? ILLUSTRATED_IDLE_PLANS[config.skin] : undefined;
  const cycle = plan && isIllustratedPet(config.skin) ? illustratedIdleCycle() : null;
  const frameCount = cycle ? cycle.length : meta.frames;
  const fps = Math.max(1, (plan && cycle ? plan.fps : meta.fps) * config.animSpeed);
  frameAcc += dt;
  justWrapped = false;
  const frameDur = 1 / fps;
  while (frameAcc >= frameDur) {
    frameAcc -= frameDur;
    frameIndex = (frameIndex + 1) % frameCount;
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

  // Sleep check: 30s of inactivity and not dragging. With autonomous movement
  // enabled the pet stays awake and keeps wandering instead of sleeping.
  if (
    !config.autoMove &&
    now - lastActivity > SLEEP_MS &&
    state !== 'sleeping' &&
    !dragging
  ) {
    currentAction = null;
    endAutoMove();
    enterSleep();
  }

  // Autonomous activity scheduler: while awake and idle the pet occasionally walks,
  // runs or hops around the desktop on its own (autoMove) — or, without autoMove,
  // it just performs the familiar idle actions.
  if (!IS_SMOKE && state === 'idle' && !dragging) {
    if (config.autoMove) {
      if (!currentAction && !autoMoveIntent && now >= nextWanderAt) {
        nextWanderAt = now + 4000 + Math.random() * 6000;
        pickAutoActivity();
      }
    } else if (!currentAction && now >= nextActionAt) {
      currentAction = { type: ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)], t0: now };
    }
    if (currentAction && now - currentAction.t0 >= ACTION_DURATION[currentAction.type] * 1000) {
      currentAction = null;
      nextActionAt = now + 6000 + Math.random() * 10000;
    }
  }

  // Proactive chat: after 10 min of inactivity the pet wakes up and says hi
  // (checked outside the idle block because the pet is usually asleep by then).
  if (!IS_SMOKE) maybeGreet(now);

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
  fxEyesClosed = fx ? fx.eyesClosed : false;

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

  // Illustrated pets already contain their faces. Robot-only overlays are calibrated
  // to the old 32px frame coordinate system and must not be drawn over the new art.
  if (!isCustom && !isIllustratedPet(config.skin)) {
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

/** Draw a built-in pixel sprite sheet (four illustrated animals or robot). */
function drawBuiltInPet() {
  const img = sheets[config.skin];
  if (img && img.complete && img.naturalWidth > 0) {
    const meta = SHEET.states[state];
    const illustrated = isIllustratedPet(config.skin);
    const frameW = illustrated ? Math.round(img.naturalWidth / SHEET.cols) : SHEET.frameW;
    const frameH = illustrated ? Math.round(img.naturalHeight / SHEET.rows) : SHEET.frameH;
    const scale = illustrated ? 2 : SHEET.scale;
    const dw = frameW * scale;
    const dh = frameH * scale;
    const dx = 150 - dw / 2;
    const dy = 300 - dh - 4;
    // Idle frames of stabilised illustrated pets cycle over a subset of source columns
    const sx = (state === 'idle' ? currentIdleSourceColumn() : frameIndex) * frameW;
    const sy = meta.row * frameH;
    ctx.imageSmoothingEnabled = false; // keep the pixel art sharp
    ctx.save();
    // Mirror the illustrated sheet so the pet always faces its movement direction.
    // Sheets that natively face LEFT (e.g. bulu) mirror when moving RIGHT instead.
    const mirror =
      illustrated && (facingDir < 0 ? !ILLUSTRATED_FACES_LEFT[config.skin] : ILLUSTRATED_FACES_LEFT[config.skin] === true);
    if (mirror) {
      ctx.translate(300, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(img, sx, sy, frameW, frameH, dx, dy, dw, dh);
    ctx.restore();
    currentPetTop = dy;
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
    drawSingleImagePet(cs.img, 140, 120, true); // photo pets get the eye overlay
  }

  ctx.restore();
}

/** Draw one transparent character image with lightweight state animation. */
function drawSingleImagePet(img: HTMLImageElement, maxWidth: number, maxHeight: number, isPhoto = false) {
  const t = performance.now() / 1000;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const s = Math.min(maxWidth / iw, maxHeight / ih);
  const dw = iw * s;
  const dh = ih * s;
  let yOff = 0;
  let scaleX = 1;
  let scaleY = 1;
  let alpha = 1;

  if (state === 'idle') {
    yOff = Math.sin(t * 2.2) * 2.5;
    scaleY = 1 + Math.sin(t * 2.2 + 1) * 0.02;
  } else if (state === 'walking') {
    yOff = Math.sin(t * 10) * 3;
    scaleX = 1 + Math.sin(t * 10) * 0.03;
  } else if (state === 'sleeping') {
    yOff = 3 + Math.sin(t * 1.5) * 1.5;
    scaleX = 0.96;
    scaleY = 0.92;
    alpha = 0.82;
  } else if (state === 'click') {
    const jump = [-4, -20, -28, -8][frameIndex] ?? 0;
    const squash = [0.94, 1.12, 1.06, 0.9][frameIndex] ?? 1;
    yOff = jump;
    scaleY = squash;
  }

  const dy = 300 - dh - 4 + yOff;
  currentPetTop = dy;
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(150, 300 - 4 + yOff);
  ctx.scale(scaleX, scaleY);
  ctx.drawImage(img, -dw / 2, -dh, dw, dh);

  // Photo-pet eyes: drawn in the image's LOCAL space (same transform as the photo),
  // so the pupils stay glued to the marked spots through the bob / squash and the
  // idle-action rotation applied further up the transform stack.
  if (isPhoto && config.photoEyes) {
    drawPhotoEyesLocal(-dw / 2, -dh, dw, dh, 300 - 4 + yOff, scaleX, scaleY);
  }
}

// ---------- Photo-pet eyes (眼睛跟随) ----------
// The user marks the two eye positions once in Settings (normalized 0..1); we
// overlay animated pupils on those spots so the photo's eyes follow the cursor
// and blink — the same trick the built-in pets use.
let fxEyesClosed = false; // set each frame from the idle action (yawn closes the eyes)

/** Draw the photo-eye overlay in the image's local coordinate space. */
function drawPhotoEyesLocal(
  lx: number,
  ly: number,
  lw: number,
  lh: number,
  translateY: number,
  scaleX: number,
  scaleY: number,
) {
  const pe = config.photoEyes!;
  const eyeR = Math.max(2, Math.min(lw, lh) * 0.04);
  const e1 = { x: lx + pe.x1 * lw, y: ly + pe.y1 * lh };
  const e2 = { x: lx + pe.x2 * lw, y: ly + pe.y2 * lh };
  const head = { x: (e1.x + e2.x) / 2, y: (e1.y + e2.y) / 2 };
  // Convert the window-space cursor into this local space (inverse of translate+scale)
  const lmX = (mouse.x - 150) / scaleX;
  const lmY = (mouse.y - translateY) / scaleY;
  // Pupil offset toward the cursor (capped so it stays inside the eye)
  let dx = lmX - head.x;
  let dy = lmY - head.y;
  const d = Math.hypot(dx, dy) || 1;
  const off = Math.min(eyeR * 0.65, Math.hypot(dx, dy));
  dx = (dx / d) * off;
  dy = (dy / d) * off;

  ctx.save();
  ctx.lineCap = 'round';
  if (fxEyesClosed) {
    // Closed-eye arcs (during the yawn action)
    ctx.strokeStyle = 'rgba(30,20,15,0.9)';
    ctx.lineWidth = Math.max(1.5, eyeR * 0.5);
    [e1, e2].forEach((e) => {
      ctx.beginPath();
      ctx.moveTo(e.x - eyeR * 1.1, e.y + eyeR * 0.5);
      ctx.quadraticCurveTo(e.x, e.y - eyeR * 0.8, e.x + eyeR * 1.1, e.y + eyeR * 0.5);
      ctx.stroke();
    });
  } else if (!blinking) {
    // Pupils follow the cursor + white highlight
    ctx.fillStyle = 'rgba(30,20,15,0.92)';
    [e1, e2].forEach((e) => {
      ctx.beginPath();
      ctx.arc(e.x + dx, e.y + dy, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(e.x + dx - eyeR * 0.35, e.y + dy - eyeR * 0.35, eyeR * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(30,20,15,0.92)';
    });
  } else {
    // Blink: a horizontal line across each eye
    ctx.strokeStyle = 'rgba(30,20,15,0.92)';
    ctx.lineWidth = Math.max(1.5, eyeR * 0.45);
    [e1, e2].forEach((e) => {
      ctx.beginPath();
      ctx.moveTo(e.x - eyeR * 1.1, e.y);
      ctx.lineTo(e.x + eyeR * 1.1, e.y);
      ctx.stroke();
    });
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
  const canCutout =
    config.autoCutout && !res.cutoutApplied && (res.mode === 'single' || res.mode === 'billboard');
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

// ---------- Main Loop (with sleep throttling) ----------
// While awake the pet renders at the main-process-capped 60 fps. Once it falls
// asleep the vsync loop is PAUSED and a ~2 fps tick keeps the sleep animation,
// the Zzz particles and the wake checks alive — the transparent always-on-top
// window stops submitting per-vsync frames, which is the biggest GPU win.
let lastTime = performance.now();
let lastMouseX = 150; // for drag velocity (billboard lean)
let loopRunning = false;
let sleepTickTimer: number | undefined;

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  window.clearTimeout(sleepTickTimer);
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

function loop(now: number) {
  if (!loopRunning) return;
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

  if (state === 'sleeping') {
    // Pause the vsync loop while sleeping; a slow tick keeps things alive cheaply.
    loopRunning = false;
    window.clearTimeout(sleepTickTimer);
    sleepTickTimer = window.setTimeout(sleepTick, 500);
    return;
  }
  requestAnimationFrame(loop);
}

/** ~2 fps tick used while the pet is asleep (sleep frames + Zzz + wake checks). */
function sleepTick() {
  if (state !== 'sleeping') {
    startLoop();
    return;
  }
  update(0.5); // advances the 2 fps sleep frames + floating Zzz
  if (pet3dActive && pet3d) {
    pet3d.setPointer(mouse.x, dragging, 0);
    pet3d.update(0.5, state, frameIndex);
    pet3d.render();
  }
  draw();
  window.clearTimeout(sleepTickTimer);
  sleepTickTimer = window.setTimeout(sleepTick, 500);
}

// ---------- Speech Bubble ----------
let bubbleTimer: number | undefined;
let typingTimer: number | undefined;
let deferredBubble: { text: string; opts: { ms?: number; typing?: boolean } } | null = null;

function showBubble(text: string, opts: { ms?: number; typing?: boolean } = {}) {
  // A bubble can be requested while the pet is being dragged (reminder / weather /
  // chime / greeting). Do not let it open an overlay that travels with the transparent
  // window; show it once the drag has ended instead.
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
  lastDragScreenX = e.screenX;
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
      // The speech bubble lives inside the same transparent window as the pet. Hide it
      // before moving that window so it never travels across (or beyond) the screen.
      hideBubble();
      setState('walking');
    }
  }

  if (dragging) {
    const dragDx = e.screenX - lastDragScreenX;
    if (Math.abs(dragDx) >= 1) facingDir = dragDx < 0 ? -1 : 1;
    lastDragScreenX = e.screenX;
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
    // Decide the hit state purely per-pixel (the chat UI now lives in its own window,
    // so nothing in this window ever needs to force interactivity).
    const over = isOverPet(e.clientX, e.clientY);
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
  } else if (config.weatherEnabled && Math.random() < 0.25) {
    void maybeShowWeather(); // 25% chance to report today's weather instead of a line
  } else {
    showBubble(rand(window.PetricI18n.tArray('lines')));
  }
}

function handleDoubleClick() {
  if (config.aiEnabled) {
    window.api.openChat(); // opens the standalone ChatGPT-style chat window
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
  // Esc: quit the pet app
  if (e.key === 'Escape') {
    window.api.quitApp();
    return;
  }
  lastActivity = Date.now();
  wake();
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
  scheduleChime(); // restart the hourly-chime timer when the toggle changes
  renderAffinityBadge(); // keep the hearts badge in sync (incl. changes from the settings panel)
}

/** Load the locale dictionary from the main process and refresh localized texts. */
async function applyLocaleTexts() {
  const payload = await window.api.getI18n();
  window.PetricI18n.setLocaleData(payload.locale, payload.dict);
  renderAffinityBadge(); // the badge tooltip shows the localized level name
}

// ---------- Legacy chat data migration ----------
// Versions before the standalone chat window kept conversations in THIS window's
// localStorage. Move them into the main-process store exactly once: the store only
// accepts an import while it is still empty, so chats already in the store are
// never clobbered, and the local keys are removed once migration ran.
async function migrateLegacyChats() {
  try {
    const rawConv = localStorage.getItem('petric.chat.conversations');
    const rawHist = localStorage.getItem('petric.chat.history');
    if (!rawConv && !rawHist) return;
    let payload: unknown = null;
    if (rawConv) {
      try {
        payload = JSON.parse(rawConv);
      } catch {
        payload = null;
      }
    }
    if (!payload && rawHist) {
      try {
        payload = JSON.parse(rawHist);
      } catch {
        payload = null;
      }
    }
    if (payload) await window.api.chatsImportLegacy(payload);
    localStorage.removeItem('petric.chat.conversations');
    localStorage.removeItem('petric.chat.history');
    localStorage.removeItem('petric.chat.active');
  } catch {
    /* Keep the keys so a later launch can retry the migration. */
  }
}

// ---------- Startup ----------
async function initPet() {
  void migrateLegacyChats(); // move the old localStorage chat data into the main store once
  const cfg = await window.api.getConfig();
  applyConfig(cfg);
  await applyLocaleTexts();

  loadSheets();
  window.api.onConfigChanged(applyConfig);

  // Chatting in the chat window warms the pet's heart: affinity + chat stats.
  // (The AI request itself runs in the main process; this event fires per reply.)
  window.api.onChatReward(() => {
    config.statsChats = (config.statsChats || 0) + 1;
    addAffinity(2);
  });

  // Main-process notices (e.g. a new version is downloading) appear as a speech bubble
  window.api.onPetNotice((text) => showBubble(text, { ms: 6000 }));

  // Start in click-through state (Windows); mousemove restores interaction once the cursor is over the pet
  canvas.style.cursor = 'default';
  startLoop();

  // Pre-warm the weather cache so click reports are instant (non-blocking)
  void refreshWeather();

  // First-time greeting
  setTimeout(() => showBubble(window.PetricI18n.t('bubble.greeting'), { ms: 2200 }), 800);
}

initPet();
