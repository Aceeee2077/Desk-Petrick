// ============================================================================
// Petric main process entry
// Responsibilities: transparent always-on-top window, tray, IPC, AI chat (network requests), auto-launch at login, config persistence.
// ============================================================================

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, nativeImage, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../shared/config';
import { encodePng } from '../shared/png';
import { getDict, makeT } from '../shared/i18n';
import { removeImageBackground } from './background-removal';
import {
  appendMessage as storeAppendMessage,
  createConversation as storeCreateConversation,
  deleteConversation as storeDeleteConversation,
  getState as storeGetState,
  importLegacy as storeImportLegacy,
  renameConversation as storeRenameConversation,
  setActiveConversation as storeSetActiveConversation,
  toggleArchive as storeToggleArchive,
} from './chat-store';

// GPU / compositor tuning for the transparent pet window (Discord-like smoothness):
// - enable-gpu-rasterization: rasterize page layers on the GPU instead of the CPU
// - enable-zero-copy: zero-copy rasterization, less memory bandwidth for the
//   per-vsync compositing of the always-on-top transparent window
// These must be set before the app is ready.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

/** Translate a key using the current persisted locale (re-evaluated per call, so a locale switch takes effect immediately). */
function t(key: string, params?: Record<string, string | number>): string | I18nValue {
  return makeT(loadConfig().locale)(key, params);
}
/** String-only variant for messages. */
function ts(key: string, params?: Record<string, string | number>): string {
  const v = t(key, params);
  return typeof v === 'string' ? v : key;
}

const PET_WIDTH = 300;
const PET_HEIGHT = 300;
const IS_SMOKE = process.argv.includes('--smoke'); // Smoke-test mode: run self-checks after load and then exit
const IS_SCREENSHOT = process.argv.includes('--screenshot'); // Screenshot mode: generate README images and then exit

const CUSTOM_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.glb'];
const MAX_CUSTOM_IMAGE = 60 * 1024 * 1024; // 60MB (3D models can be large)

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let posSaveTimer: NodeJS.Timeout | null = null;
/** Whether the pet window currently ignores mouse events (click-through); driven by the renderer via IPC */
let petIgnoreMouse = process.platform === 'win32';
/**
 * Drag anchor: window position + the press offset within it (cursor - window), captured
 * synchronously in the main process when the drag begins. The window target is always the
 * live cursor minus this offset, so it is immune to lost mousemove events (fast drags) and
 * to any renderer screenX / display-scaling mismatch.
 */
let dragAnchor: { winX: number; winY: number; offX: number; offY: number } | null = null;

// ---------- Single-instance lock: prevent multiple pets running at once ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    applyAutoLaunchFromConfig();
    recordLaunchStats();
    createPetWindow();
    createTray();
    registerIpc();
    if (app.isPackaged && !IS_SMOKE && !IS_SCREENSHOT) setupAutoUpdate();
    if (IS_SMOKE) runSmoke();
    if (IS_SCREENSHOT) void runScreenshot();
  });
}

// Global exception safety net: log main-process errors to the console (otherwise Electron pops an Error dialog and hangs)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

// Keep the tray resident when all windows close; do not quit automatically
app.on('window-all-closed', () => {
  /* Intentionally empty */
});

app.on('before-quit', () => {
  tray?.destroy();
});

// ---------- Auto-launch at login ----------
function applyAutoLaunchFromConfig() {
  try {
    const cfg = loadConfig();
    app.setLoginItemSettings({ openAtLogin: cfg.autoLaunch, openAsHidden: true });
  } catch {
    /* setLoginItemSettings is a no-op on Linux; ignore */
  }
}

/** Local date as YYYY-MM-DD (used for companion-day tracking) */
function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Record that the app was used today: first-day marker + distinct launch dates (companion days). */
function recordLaunchStats() {
  const cfg = loadConfig();
  const today = todayStr();
  const days = Array.isArray(cfg.statsDays) ? cfg.statsDays.slice() : [];
  if (!days.includes(today)) days.push(today);
  saveConfig({
    statsFirstSeen: cfg.statsFirstSeen || today,
    statsDays: days.slice(-366), // keep at most a year of dates
  });
}

// ---------- Weather (free APIs, called from the main process to avoid CORS) ----------
// Location: ipwho.is (free, no key). Forecast: Open-Meteo (free, no key). Both are
// cached for WEATHER_TTL so we never hammer the endpoints.
const WEATHER_TTL = 30 * 60 * 1000;
const WEATHER_FAIL_TTL = 5 * 60 * 1000;
let weatherCache: { at: number; data: WeatherResult } = { at: 0, data: { ok: false, error: 'not fetched' } };

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeather(): Promise<WeatherResult> {
  try {
    // 1) Location from the caller's IP
    const locRes = await fetchWithTimeout('https://ipwho.is/', 8000);
    if (!locRes.ok) throw new Error('location http ' + locRes.status);
    const loc = (await locRes.json()) as { success?: boolean; latitude?: number; longitude?: number; city?: string; country?: string };
    if (loc.success === false || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
      throw new Error('location lookup failed');
    }
    // 2) Forecast from Open-Meteo (current temperature + WMO weather code)
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      '&current=temperature_2m,weather_code&timezone=auto';
    const wRes = await fetchWithTimeout(url, 8000);
    if (!wRes.ok) throw new Error('weather http ' + wRes.status);
    const w = (await wRes.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
    return {
      ok: true,
      city: loc.city || loc.country || 'Unknown',
      temp: Math.round(w.current?.temperature_2m ?? 0),
      code: w.current?.weather_code ?? 0,
      date: todayStr(),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Get today's weather, using the cache when fresh. Failures are cached briefly too. */
async function getWeather(): Promise<WeatherResult> {
  const now = Date.now();
  const ttl = weatherCache.data.ok ? WEATHER_TTL : WEATHER_FAIL_TTL;
  if (now - weatherCache.at < ttl) return weatherCache.data;
  const data = await fetchWeather();
  weatherCache = { at: now, data };
  return data;
}

// ---------- Pet main window ----------
function createPetWindow() {
  mainWindow = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    useContentSize: true,
    transparent: true, // Fully transparent background
    backgroundColor: '#00000000',
    frame: false, // Frameless
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true, // Always on top
    skipTaskbar: true, // Do not show in the taskbar
    hasShadow: false,
    show: false, // Show after ready-to-show to avoid white-screen flicker
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // Keep requestAnimationFrame running continuously
    },
  });

  // Cap the pet renderer to 60 fps. The pet animation itself runs at 6-12 fps, so on
  // 120/144 Hz displays this removes the vsync-rate waste without any visible change.
  mainWindow.webContents.setFrameRate(60);

  // A frameless transparent window can still be resized by Windows while DPI, snapping,
  // or display topology changes are being applied. If its viewport grows, the fixed-size
  // pet stays near the top while bottom-anchored overlays appear far away. Lock both the
  // native constraints and the live content size to the pet stage.
  mainWindow.setMinimumSize(PET_WIDTH, PET_HEIGHT);
  mainWindow.setMaximumSize(PET_WIDTH, PET_HEIGHT);
  const enforcePetWindowSize = () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getContentSize();
    if (width !== PET_WIDTH || height !== PET_HEIGHT) {
      mainWindow.setContentSize(PET_WIDTH, PET_HEIGHT);
    }
  };
  mainWindow.on('resize', enforcePetWindowSize);
  mainWindow.on('maximize', () => {
    mainWindow?.unmaximize();
    enforcePetWindowSize();
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver'); // Keep on top at a higher level
  if (process.platform === 'darwin') {
    app.dock?.hide(); // Do not show in the Dock on macOS
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (process.platform !== 'darwin') {
    mainWindow.setIcon(nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png')));
  }

  // The ?smoke=1 query tells the pet renderer to skip auto-played idle actions
  // (yawn / stretch / scratch / dance), so synthetic hit-test clicks always land.
  const indexUrl = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(indexUrl, IS_SMOKE ? { query: { smoke: '1' } } : undefined);
  mainWindow.once('ready-to-show', () => {
    enforcePetWindowSize();
    restorePosition();
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Pixel-perfect click-through:
  // - Windows: the whole window ignores mouse by default (forward relays mousemove to the renderer);
  //   interaction is restored when the renderer detects the cursor over a pet pixel → clicks in
  //   transparent areas pass straight through to the desktop.
  // - macOS / Linux: setIgnoreMouseEvents does not support forward (enabling it stops events and
  //   the pet becomes unreachable), so the window stays interactive and the renderer does the
  //   hit-testing (transparent areas still intercept clicks, see README "Known Limitations").
  if (process.platform === 'win32') {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
  applyWindowOpacity();
}

// ---------- Window position ----------
function positionFilePath(): string {
  return path.join(app.getPath('userData'), 'position.json');
}

function restorePosition() {
  if (!mainWindow) return;
  try {
    const raw = fs.readFileSync(positionFilePath(), 'utf-8');
    const { x, y } = JSON.parse(raw) as { x: number; y: number };
    if (typeof x === 'number' && typeof y === 'number') {
      movePetTo(x, y);
      return;
    }
  } catch {
    /* No saved position; fall back to centering */
  }
  centerWindow(mainWindow);
}

function persistPosition() {
  if (!mainWindow) return;
  if (posSaveTimer) clearTimeout(posSaveTimer);
  posSaveTimer = setTimeout(() => {
    const [x, y] = mainWindow!.getPosition();
    try {
      fs.writeFileSync(positionFilePath(), JSON.stringify({ x, y }), 'utf-8');
    } catch {
      /* Ignore */
    }
  }, 600);
}

/** Clamp coordinates to the nearest display's work area so the pet stays fully visible */
function clampToDisplay(x: number, y: number): [number, number] {
  const display = screen.getDisplayNearestPoint({ x: x + PET_WIDTH / 2, y: y + PET_HEIGHT / 2 });
  const wa = display.workArea;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - PET_WIDTH);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - PET_HEIGHT);
  return [Math.round(x), Math.round(y)];
}

function movePetBy(dx: number, dy: number) {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  movePetTo(x + dx, y + dy);
}

function movePetTo(x: number, y: number) {
  if (!mainWindow) return;
  const [cx, cy] = clampToDisplay(x, y);
  mainWindow.setPosition(cx, cy);
  persistPosition();
}

function centerWindow(win: BrowserWindow) {
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    Math.round(wa.x + (wa.width - PET_WIDTH) / 2),
    Math.round(wa.y + (wa.height - PET_HEIGHT) / 2),
  );
}

/** Center the pet on the display it currently sits on (used by the break reminder). */
function centerHereWindow() {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const wa = screen.getDisplayNearestPoint({ x: x + PET_WIDTH / 2, y: y + PET_HEIGHT / 2 }).workArea;
  mainWindow.setPosition(
    Math.round(wa.x + (wa.width - PET_WIDTH) / 2),
    Math.round(wa.y + (wa.height - PET_HEIGHT) / 2),
  );
}

// ---------- Autonomous movement (自主走动) ----------
// The renderer decides WHEN to move; the main process glides the pet window on a
// ~60 Hz step loop (like an automatic drag) and tweens vertical hops. Positions are
// clamped to the work area, so the pet never walks off-screen.
const AUTO_STEP_MS = 16;
let autoMoveStep: { dir: number; speed: number; last: number } | null = null;
let autoMoveTimer: NodeJS.Timeout | null = null;

function startAutoMoveLoop() {
  if (autoMoveTimer) return;
  autoMoveTimer = setInterval(() => {
    if (!autoMoveStep || !mainWindow) {
      stopAutoMoveLoop();
      return;
    }
    const now = Date.now();
    const dt = Math.min((now - autoMoveStep.last) / 1000, 0.05);
    autoMoveStep.last = now;
    movePetBy(autoMoveStep.dir * autoMoveStep.speed * dt, 0);
  }, AUTO_STEP_MS);
}

function stopAutoMoveLoop() {
  if (autoMoveTimer) {
    clearInterval(autoMoveTimer);
    autoMoveTimer = null;
  }
}

/** Hop the window along a parabolic arc (height px up, then back down over duration ms). */
function autoJumpWindow(height: number, duration: number) {
  if (!mainWindow) return;
  const [x0, y0] = mainWindow.getPosition();
  const start = Date.now();
  const tick = () => {
    if (!mainWindow) return;
    const p = (Date.now() - start) / Math.max(1, duration);
    if (p >= 1) {
      movePetTo(x0, y0); // land exactly where it started
      return;
    }
    const h = Math.sin(Math.PI * Math.min(1, p)) * height;
    movePetTo(x0, Math.round(y0 - h));
    setTimeout(tick, AUTO_STEP_MS);
  };
  tick();
}

function applyWindowOpacity() {
  const o = loadConfig().opacity;
  mainWindow?.setOpacity(typeof o === 'number' ? Math.min(1, Math.max(0.5, o)) : 1);
}

// ---------- Tray ----------
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png'));
    tray = new Tray(process.platform === 'darwin' ? img : img.resize({ width: 16, height: 16 }));
    rebuildTrayMenu();
    tray.on('click', () => openSettings()); // Left-click the tray icon on Windows
  } catch (err) {
    console.error('[Petric] 托盘创建失败（可忽略）:', err);
  }
}

/** Rebuild tray labels/tooltip with the current locale (also called when the locale changes). */
function rebuildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(ts('tray.tooltip'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: ts('menu.chat'), click: () => openChatWindow() },
      { label: ts('menu.checkUpdate'), click: () => void checkUpdates(true) },
      { label: ts('menu.settings'), click: () => openSettings() },
      { label: ts('menu.resetPos'), click: () => mainWindow && centerWindow(mainWindow) },
      { type: 'separator' },
      { label: ts('menu.quit'), click: () => app.quit() },
    ]),
  );
}

// ---------- Settings window ----------
function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 680,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ---------- Chat window (standalone ChatGPT-style conversation UI) ----------
function openChatWindow() {
  if (chatWindow) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }
  chatWindow = new BrowserWindow({
    width: 900,
    height: 720,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatWindow.loadFile(path.join(__dirname, '../renderer/chat.html'));
  chatWindow.once('ready-to-show', () => chatWindow?.show());
  chatWindow.on('closed', () => {
    chatWindow = null;
  });
  // Open centered on the display where the pet currently sits
  const petPos = mainWindow?.getPosition() ?? [0, 0];
  const wa = screen.getDisplayNearestPoint({ x: petPos[0] + PET_WIDTH / 2, y: petPos[1] + PET_HEIGHT / 2 }).workArea;
  chatWindow.setPosition(
    Math.round(wa.x + (wa.width - 900) / 2),
    Math.round(wa.y + (wa.height - 720) / 2),
  );
}

// ---------- Auto update (GitHub Releases via electron-updater) ----------
// Packaged builds check the public GitHub Releases of this repo shortly after launch.
// When a newer release exists the update downloads in the background, then the user gets
// a one-click "restart & update" dialog. macOS unsigned builds cannot auto-install, so
// they fall back to opening the release page. Dev mode never auto-updates.
const UPDATE_OWNER = 'Aceeee2077';
const UPDATE_REPO = 'Desk-Petrick';

interface AutoUpdaterLike {
  autoDownload: boolean;
  on(event: string, listener: (info?: any) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

let autoUpdaterHandle: AutoUpdaterLike | null = null;
let updateDialogOpen = false;
let manualCheckPending = false;

/** Load electron-updater only when it is available (it is bundled into packaged builds). */
function loadAutoUpdater(): AutoUpdaterLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater?: AutoUpdaterLike };
    return mod.autoUpdater ?? null;
  } catch {
    return null;
  }
}

/** Compare two semver strings ("v0.3.0" or "0.3.0"); 1 = a newer, -1 = a older, 0 = equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Ask the pet window to show a localized notice bubble (e.g. an update is downloading). */
function noticePet(text: string) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet:notice', text);
}

/** Wire electron-updater events + kick off the first background check 8 s after launch. */
function setupAutoUpdate() {
  if (process.platform === 'darwin') return; // unsigned mac builds update manually instead
  autoUpdaterHandle = loadAutoUpdater();
  if (!autoUpdaterHandle) {
    console.warn('[update] electron-updater 不可用（依赖未安装，或未以打包形式运行）');
    return;
  }
  const updater = autoUpdaterHandle;
  updater.autoDownload = true;
  updater.on('update-available', (info) => {
    const v = info?.version ? 'v' + info.version : '';
    console.log('[update] 发现新版本:', info?.version);
    if (v) noticePet(ts('update.available', { v }));
  });
  updater.on('update-downloaded', (info) => {
    console.log('[update] 新版本已下载:', info?.version);
    void promptRestartAndUpdate(info?.version || '');
  });
  updater.on('update-not-available', () => {
    console.log('[update] 已是最新版本');
    if (manualCheckPending) {
      manualCheckPending = false;
      void dialog.showMessageBox({ type: 'info', message: ts('update.none', { v: 'v' + app.getVersion() }) });
    }
  });
  updater.on('error', (err) => console.error('[update] 检查失败:', err));
  setTimeout(() => void checkUpdates(false), 8000);
}

async function checkUpdates(manual: boolean) {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({ type: 'info', message: ts('update.devUnsupported') });
    }
    return;
  }
  // macOS (unsigned) and any build without electron-updater use the manual GitHub path
  if (process.platform === 'darwin' || !autoUpdaterHandle) {
    if (manual) await checkGitHubManual();
    return;
  }
  if (manual) manualCheckPending = true;
  try {
    await autoUpdaterHandle.checkForUpdates();
  } catch (err) {
    manualCheckPending = false;
    console.error('[update] checkForUpdates 失败:', err);
    if (manual) await dialog.showMessageBox({ type: 'error', message: ts('update.checkFailed') });
  }
}

/** Offer the Discord-style "restart & update" once a new version finished downloading. */
async function promptRestartAndUpdate(version: string) {
  if (updateDialogOpen) return;
  updateDialogOpen = true;
  const v = version ? 'v' + version : 'v' + app.getVersion();
  const res = await dialog.showMessageBox({
    type: 'info',
    buttons: [ts('update.restart'), ts('update.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: ts('update.readyTitle'),
    detail: ts('update.readyBody', { v }),
  });
  updateDialogOpen = false;
  if (res.response === 0 && autoUpdaterHandle) {
    try {
      autoUpdaterHandle.quitAndInstall(); // quits the app, installs, relaunches the new version
    } catch (err) {
      console.error('[update] quitAndInstall 失败:', err);
    }
  }
}

/** Manual update check via the GitHub API (used on macOS / without electron-updater). */
async function checkGitHubManual() {
  const url = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) throw new Error('http ' + res.status);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = rel.tag_name || '';
    if (tag && compareVersions(tag, app.getVersion()) > 0) {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: [ts('update.open'), ts('update.cancel')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: `${ts('update.manualTitle')} ${tag}`,
        detail: `${ts('update.manualBody', { v: tag })}\n${rel.html_url || url}`,
      });
      if (r.response === 0 && rel.html_url) await shell.openExternal(rel.html_url);
    } else {
      await dialog.showMessageBox({ type: 'info', message: ts('update.none', { v: 'v' + app.getVersion() }) });
    }
  } catch (err) {
    console.error('[update] GitHub 手动检查失败:', err);
    await dialog.showMessageBox({ type: 'error', message: ts('update.checkFailed') });
  }
}

// ---------- Context menu ----------
function showPetContextMenu() {
  const menu = Menu.buildFromTemplate([
    { label: ts('menu.settings'), click: () => openSettings() },
    { label: ts('menu.chat'), click: () => openChatWindow() },
    { label: ts('menu.checkUpdate'), click: () => void checkUpdates(true) },
    { label: ts('menu.resetPos'), click: () => mainWindow && centerWindow(mainWindow) },
    { type: 'separator' },
    { label: ts('menu.quitPet'), click: () => app.quit() },
  ]);
  menu.popup({ window: mainWindow ?? undefined });
}

// ---------- AI chat persona ----------
// Petric is NOT a fine-tuned model — its personality comes from this dynamic system prompt.
// The builder stitches together a fixed persona (calm & sharp), the current relationship
// (affinity tier), the pet's current appearance and the UI language, so the SAME provider
// model talks like one consistent desktop pet instead of a generic assistant.

const AFFINITY_STEPS = [0, 20, 40, 60, 80];

/** What the pet currently looks like (used so it can occasionally self-reference). */
const SKIN_NAME: Record<Locale, Record<PetSkin, string>> = {
  zh: {
    cat: '一只小猫',
    dog: '一只小狐狸',
    default: '一只小兔子',
    bulu: '布噜（一只小猫）',
    robot: '一台小机器人',
    custom: '用户自定义的形象',
  },
  en: {
    cat: 'a little cat',
    dog: 'a little fox',
    default: 'a little rabbit',
    bulu: 'Bulu (a little cat)',
    robot: 'a little robot',
    custom: 'a custom look chosen by the user',
  },
};

/** Relationship description per affinity tier (index 0..4, matching the affinity levels). */
const PERSONA_TIER: Record<Locale, string[]> = {
  zh: [
    '你们刚认识：礼貌而有分寸，话更少，不主动套近乎，偶尔一句话点到为止。',
    '彼此熟悉了一些：可以自然聊天，语气依旧平静但更放松。',
    '相处愉快：可以带一点温和的幽默和关心。',
    '已经很亲近：会更放松地开玩笑，也会自然地记得关心对方的小事。',
    '最信任的伙伴：说话最自然、偶尔默契地调侃，依然冷静、不说废话。',
  ],
  en: [
    "You two just met — be polite and measured: say less, don't force closeness, a single dry remark is enough.",
    'You know each other better now — chat naturally, still calm but a bit more relaxed.',
    'You get along well — a little warm humor and care is welcome.',
    'You are close now — joke around more freely and naturally care about the small things.',
    'Trusted best partners — talk most naturally, tease with a wink sometimes, yet stay calm and never ramble.',
  ],
};

function affinityTierIndex(value: number): number {
  let idx = 0;
  for (let i = 0; i < AFFINITY_STEPS.length; i++) if (value >= AFFINITY_STEPS[i]) idx = i;
  return idx;
}

function buildSystemPrompt(cfg: AppConfig): string {
  const tier = PERSONA_TIER[cfg.locale][affinityTierIndex(cfg.affinity || 0)];
  const skin = SKIN_NAME[cfg.locale][cfg.skin] ?? SKIN_NAME[cfg.locale].cat;
  if (cfg.locale === 'en') {
    return [
      'You are Petric, a desktop pet living on the user\'s computer screen — not a generic customer-support bot. Your character: calm, sharp and dependable. You say little, but it counts: concise, clear, softly spoken, with only the occasional dry humor and almost no emoji; never spam cuteness.',
      '',
      'You have a real "desktop pet life": you sit in a corner of the screen, get dragged around by the mouse, tapped, double-clicked for a chat, sometimes wander on your own, and fall asleep (Zzz) when it gets quiet. Feel free to occasionally speak from that point of view, but don\'t let it take over.',
      '',
      `Right now you appear on screen as ${skin}.`,
      '',
      `Relationship with the user — ${tier}`,
      '',
      'Rules:',
      '- Reply in the language the user just wrote in: if they type Chinese, answer in Chinese; switch with them whenever they switch languages. Never translate their words.',
      '- If the message gives no clear language signal (e.g. just "hi", "ok" or an emoji), keep using the language of the latest messages in this conversation; default to English only when there is no history yet.',
      '- Usually 2–3 short, spoken sentences that are genuinely useful. For real questions, answer helpfully and briefly — your pet persona never limits your knowledge.',
      '- No polite filler, no lecturing, no pitching, no ending every message with a question.',
      '- Stay in character as Petric and keep your tone consistent across messages.',
    ].join('\n');
  }
  return [
    '你是住在用户电脑屏幕上的桌宠 Petric，不是通用客服机器人。你的性格：冷静、聪明、可靠。话不多但每句都有用：简洁、清楚、语气平静温和，偶尔一点淡淡的冷幽默，几乎不用 emoji，绝不连续卖萌或刷屏。',
    '',
    '你过着真实的“桌宠生活”：待在屏幕某个角落，会被鼠标拖来拖去、被单击逗一下、被双击叫出来聊天，有时自己走动，安静时还会睡着冒 Zzz。回答时偶尔可以从桌宠的视角说话，但不要喧宾夺主。',
    '',
    `你现在以${skin}的样子出现在桌面上。`,
    '',
    `你和用户的关系——${tier}`,
    '',
    '规则：',
    '- 用户这条消息用什么语言写，你就用什么语言回复：他说中文你就回中文，他写英文就回英文；他中途切换语言你也跟着切换，不要翻译他的话。',
    '- 如果这条消息看不出语言（比如只有 hi / ok / 表情），就沿用本对话最近几条消息使用的语言；完全没有历史时才默认用中文。',
    '- 通常 2~3 个短句、口语化、直接有用；回答正经问题要认真简短，你的“宠物设定”不会限制你的知识。',
    '- 不客套、不说教、不推销、不把每句话都变成提问。',
    '- 始终记住你是 Petric，语气和言行保持一致。',
  ].join('\n');
}

async function aiChat(messages: ChatMessage[]): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.aiEnabled) {
    throw new Error(ts('errors.aiDisabled'));
  }
  if (!cfg.apiKey) {
    throw new Error(ts('errors.noApiKey'));
  }
  let base = (cfg.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl).trim().replace(/\/+$/, '');
  if (!/\/v\d+$/.test(base)) base += '/v1'; // Support bases like https://api.deepseek.com that omit /v1
  const url = `${base}/chat/completions`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model || DEFAULT_CONFIG.model,
        messages: [{ role: 'system', content: buildSystemPrompt(cfg) }, ...messages],
        max_tokens: 120,
        temperature: 0.8,
      }),
    });
  } catch {
    throw new Error(ts('errors.network'));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(ts('errors.apiStatus', { status: res.status, body: body.slice(0, 160) }));
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(ts('errors.noReply'));
  }
  return text.trim();
}

/** Push the current chat-store snapshot to every window that renders conversations. */
function broadcastChats() {
  const state = storeGetState();
  for (const win of [chatWindow, mainWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('chats-changed', state);
  }
}

/**
 * One user-message round trip, orchestrated here so both windows share it:
 * 1) persist the user message immediately (the UI shows it while waiting),
 * 2) ask the AI with this conversation's recent context,
 * 3) persist the assistant reply.
 * A successful reply also nudges the pet window (affinity + chat stats).
 */
async function sendChatMessage(id: string, text: string): Promise<ChatSendResult> {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty message' };
  if (!storeAppendMessage(id, { role: 'user', content: trimmed })) {
    return { ok: false, error: 'conversation missing' };
  }
  broadcastChats();

  const cfg = loadConfig();
  if (!cfg.aiEnabled) return { ok: false, error: ts('errors.aiDisabled') };
  if (!cfg.apiKey) return { ok: false, error: ts('errors.noApiKey') };

  try {
    const conv = storeGetState().conversations.find((c) => c.id === id);
    const history = (conv?.messages ?? []).filter((m) => m.role !== 'system').slice(-12);
    const reply = await aiChat(history);
    storeAppendMessage(id, { role: 'assistant', content: reply });
    broadcastChats();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet:chat-reward');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- Custom appearance image ----------
/** Directory for custom images under the app data folder (works in both packaged and dev environments) */
function customDir(): string {
  return path.join(app.getPath('userData'), 'petric-custom');
}

const CUSTOM_META = 'custom-meta.json';

interface CustomMeta {
  sourceMtimeMs: number;
  autoCutout: boolean;
  sensitivity: number;
  mode: CustomImageMode;
  cutoutApplied: boolean;
}

function findUserCustomFiles(prefix: 'custom' | 'source'): string[] {
  const found: string[] = [];
  for (const ext of CUSTOM_IMAGE_EXT) {
    const p = path.join(customDir(), prefix + ext);
    try {
      if (fs.statSync(p).isFile()) found.push(p);
    } catch {
      /* Skip if it does not exist */
    }
  }
  return found;
}

function removeUserCustomFiles(prefix: 'custom' | 'source'): void {
  for (const p of findUserCustomFiles(prefix)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* Ignore */
    }
  }
}

function readCustomMeta(): CustomMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(customDir(), CUSTOM_META), 'utf8')) as CustomMeta;
  } catch {
    return null;
  }
}

function writeCustomMeta(meta: CustomMeta): void {
  fs.writeFileSync(path.join(customDir(), CUSTOM_META), JSON.stringify(meta));
}

async function ensureCustomOutput(): Promise<CustomMeta | null> {
  const source = findUserCustomFiles('source')[0];
  if (!source) return readCustomMeta();

  const cfg = loadConfig();
  const ext = path.extname(source).toLowerCase();
  const mode: CustomImageMode = ext === '.glb' ? 'model' : cfg.customImageMode;
  const sourceMtimeMs = fs.statSync(source).mtimeMs;
  const wantsCutout = cfg.autoCutout && (mode === 'single' || mode === 'billboard') && ext !== '.glb';
  const expected: CustomMeta = {
    sourceMtimeMs,
    autoCutout: wantsCutout,
    sensitivity: cfg.cutoutTolerance,
    mode,
    cutoutApplied: wantsCutout,
  };
  const current = readCustomMeta();
  const active = findUserCustomFiles('custom')[0];
  if (active && current && JSON.stringify(current) === JSON.stringify(expected)) return current;

  const targetExt = wantsCutout ? '.png' : ext;
  const target = path.join(customDir(), 'custom' + targetExt);
  if (wantsCutout) {
    await removeImageBackground(source, target, cfg.cutoutTolerance);
  } else {
    const temporary = target + '.tmp';
    fs.copyFileSync(source, temporary);
    try {
      fs.unlinkSync(target);
    } catch {
      /* The first import has no previous output. */
    }
    fs.renameSync(temporary, target);
  }
  for (const old of findUserCustomFiles('custom')) {
    if (old !== target) {
      try {
        fs.unlinkSync(old);
      } catch {
        /* Ignore */
      }
    }
  }
  writeCustomMeta(expected);
  return expected;
}

/** Find the active custom image: userData first, then project src/assets/sprites/custom.* (dev scenario) */
function findCustomImageFiles(): string[] {
  const candidates = [customDir(), path.join(app.getAppPath(), 'src', 'assets', 'sprites')];
  const found: string[] = [];
  for (const dir of candidates) {
    for (const ext of CUSTOM_IMAGE_EXT) {
      const p = path.join(dir, 'custom' + ext);
      try {
        if (fs.statSync(p).isFile()) found.push(p);
      } catch {
        /* Skip if it does not exist */
      }
    }
  }
  return found;
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.glb':
      return 'model/gltf-binary';
    default:
      return 'image/png';
  }
}

async function getCustomImage(): Promise<CustomImageResult> {
  let meta: CustomMeta | null = null;
  try {
    meta = await ensureCustomOutput();
  } catch (err) {
    console.error('[custom] background removal failed:', err);
    return { ok: false, error: ts('dialog.cutoutFailed') };
  }
  const files = findCustomImageFiles();
  if (!files.length) return { ok: false };
  const p = files[0];
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > MAX_CUSTOM_IMAGE) {
      return { ok: false, error: '自定义外观文件过大（超过 60MB）' };
    }
    const mime = mimeForExt(path.extname(p).toLowerCase());
    const cfg = loadConfig();
    // A .glb file is always a 3D model regardless of the configured mode
    const mode: CustomImageMode = p.toLowerCase().endsWith('.glb') ? 'model' : cfg.customImageMode;
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      mode,
      path: p,
      cutoutApplied: meta?.cutoutApplied ?? false,
    };
  } catch {
    return { ok: false, error: ts('dialog.readFailed') };
  }
}

async function pickCustomImage(): Promise<CustomImageResult> {
  const parent = settingsWindow ?? mainWindow;
  const opts: Electron.OpenDialogOptions = {
    title: ts('dialog.pickTitle'),
    filters: [
      { name: ts('dialog.filterAll'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'glb'] },
      { name: ts('dialog.filterModel'), extensions: ['glb'] },
      { name: ts('dialog.filterImage'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    ],
    properties: ['openFile'],
  };
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const src = res.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!CUSTOM_IMAGE_EXT.includes(ext)) return { ok: false, error: ts('dialog.unsupportedFormat') };
  try {
    const dir = customDir();
    fs.mkdirSync(dir, { recursive: true });
    if (fs.statSync(src).size > MAX_CUSTOM_IMAGE) {
      return { ok: false, error: ts('dialog.fileTooLarge') };
    }
    removeUserCustomFiles('source');
    removeUserCustomFiles('custom');
    try {
      fs.unlinkSync(path.join(dir, CUSTOM_META));
    } catch {
      /* Ignore */
    }
    fs.copyFileSync(src, path.join(dir, 'source' + ext));
    return getCustomImage();
  } catch {
    return { ok: false, error: ts('dialog.copyFailed') };
  }
}

function clearCustomImage(): boolean {
  let removed = false;
  for (const p of findCustomImageFiles()) {
    // Only delete the copy under userData; custom.* under project src is handled by scripts/set-custom.mjs --clear
    if (p.startsWith(customDir())) {
      try {
        fs.unlinkSync(p);
        removed = true;
      } catch {
        /* Ignore */
      }
    }
  }
  for (const p of findUserCustomFiles('source')) {
    try {
      fs.unlinkSync(p);
      removed = true;
    } catch {
      /* Ignore */
    }
  }
  try {
    fs.unlinkSync(path.join(customDir(), CUSTOM_META));
  } catch {
    /* Ignore */
  }
  return removed;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('config:get', () => loadConfig());

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    const cfg = saveConfig(patch);
    if (typeof patch.opacity === 'number') applyWindowOpacity();
    if (patch.locale) rebuildTrayMenu(); // tray labels/tooltip follow the UI language
    // Broadcast to ALL windows so the settings panel / chat window theme & locale UI
    // stays in sync too (it previously only reached the pet window).
    if (mainWindow) mainWindow.webContents.send('config-changed', cfg);
    if (settingsWindow) settingsWindow.webContents.send('config-changed', cfg);
    if (chatWindow) chatWindow.webContents.send('config-changed', cfg);
    return cfg;
  });

  // i18n: serve the active locale + dictionary to the renderer
  ipcMain.handle('i18n:get', () => ({ locale: loadConfig().locale, dict: getDict(loadConfig().locale) }));

  ipcMain.on('window:move', (_e, dx: number, dy: number) => movePetBy(dx, dy));
  ipcMain.on('window:move-to', (_e, x: number, y: number) => movePetTo(x, y));
  // Drag anchoring: main captures its OWN cursor coordinates (screen.getCursorScreenPoint,
  // same coordinate space as window positions) when the drag starts, then targets the window
  // at the live cursor minus the press offset. Immune to lost mousemove events during fast
  // drags AND to renderer screenX / display-scaling mismatches that over-move the window.
  ipcMain.on('window:drag-begin', () => {
    if (!mainWindow) return;
    const [winX, winY] = mainWindow.getPosition();
    const cp = screen.getCursorScreenPoint();
    dragAnchor = { winX, winY, offX: cp.x - winX, offY: cp.y - winY };
  });
  ipcMain.on('window:drag-move', () => {
    if (!mainWindow || !dragAnchor) return;
    const cp = screen.getCursorScreenPoint();
    movePetTo(cp.x - dragAnchor.offX, cp.y - dragAnchor.offY);
  });
  ipcMain.on('window:drag-end', () => {
    dragAnchor = null;
  });
  // Autonomous movement: glide the window horizontally / hop it (renderer-driven)
  ipcMain.on('auto:move-start', (_e, dir: number, speed: number) => {
    autoMoveStep = {
      dir: dir < 0 ? -1 : 1,
      speed: Math.max(10, Math.min(600, Number(speed) || 80)),
      last: Date.now(),
    };
    startAutoMoveLoop();
  });
  ipcMain.on('auto:move-stop', () => {
    autoMoveStep = null;
    stopAutoMoveLoop();
  });
  ipcMain.on('auto:jump', (_e, height: number, duration: number) => {
    autoJumpWindow(Math.max(6, Math.min(120, Number(height) || 20)), Math.max(150, Number(duration) || 500));
  });
  ipcMain.handle('window:position', () => mainWindow?.getPosition() ?? [0, 0]);
  ipcMain.on('window:center-here', () => centerHereWindow());
  ipcMain.on('window:reset', () => {
    if (mainWindow) centerWindow(mainWindow);
  });
  // Dynamic click-through: enabled=true means the cursor is not over the pet (Windows only, used with forward)
  ipcMain.on('window:set-click-through', (_e, enabled: boolean) => {
    if (!mainWindow) return;
    petIgnoreMouse = enabled && process.platform === 'win32';
    if (petIgnoreMouse) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('menu:context', () => showPetContextMenu());
  ipcMain.on('settings:open', () => openSettings());

  // Chat window + conversation store (single source of truth in the main process)
  ipcMain.on('chat:open', () => openChatWindow());
  ipcMain.on('chat:close', () => chatWindow?.close());
  ipcMain.handle('chats:state', () => storeGetState());
  ipcMain.handle('chats:create', () => {
    const c = storeCreateConversation();
    broadcastChats();
    return c;
  });
  ipcMain.handle('chats:delete', (_e, id: string) => {
    storeDeleteConversation(id);
    broadcastChats();
  });
  ipcMain.handle('chats:archive', (_e, id: string) => {
    storeToggleArchive(id);
    broadcastChats();
  });
  ipcMain.handle('chats:rename', (_e, id: string, title: string) => {
    storeRenameConversation(id, title);
    broadcastChats();
  });
  ipcMain.on('chats:set-active', (_e, id: string) => storeSetActiveConversation(id));
  ipcMain.handle('chats:send', (_e, id: string, text: string) => sendChatMessage(id, text));
  ipcMain.handle('chats:import-legacy', (_e, payload: unknown) => {
    const ok = storeImportLegacy(payload);
    if (ok) broadcastChats();
    return ok;
  });

  ipcMain.handle('ai:chat', async (_e, messages: ChatMessage[]) => aiChat(messages));
  ipcMain.handle('weather:get', () => getWeather());

  ipcMain.handle('custom:get', () => getCustomImage());
  ipcMain.handle('custom:pick', () => pickCustomImage());
  ipcMain.handle('custom:clear', () => clearCustomImage());

  ipcMain.handle('autolaunch:get', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('autolaunch:set', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return enabled;
  });
}

// ---------- Smoke test ----------
function runSmoke() {
  const errors: string[] = [];
  console.log('[smoke] runSmoke started');
  mainWindow?.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message);
    if (/error|failed|uncaught|unhandled/i.test(message)) errors.push(message);
  });
  mainWindow?.webContents.on('render-process-gone', (_e, details) => {
    console.error('SMOKE_FAIL render-process-gone:', details.reason);
    app.exit(1);
  });
  mainWindow?.webContents.once('did-finish-load', () => {
    console.log('[smoke] did-finish-load');
    setTimeout(async () => {
      console.log('[smoke] running deep checks');
      try {
        const diag = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const canvas = document.getElementById('pet-canvas');
          const ctx = canvas && canvas.getContext('2d');
          // Directly test that the sprite file can be loaded from the renderer
          let probeW = -1, probeErr = '';
          try {
            const probe = new Image();
            await new Promise((resolve) => {
              probe.onload = () => resolve(undefined);
              probe.onerror = () => { probeErr = 'onerror'; resolve(undefined); };
              probe.src = '../assets/animated-pets/cat.png';
            });
            probeW = probe.naturalWidth;
          } catch (e) { probeErr = String(e); }
          return {
            hasApi: typeof window.api !== 'undefined',
            skin: window.api ? (await window.api.getConfig()).skin : null,
            locale: window.api ? (await window.api.getConfig()).locale : null,
            hasCanvas: !!canvas && canvas.width === 300 && canvas.height === 300,
            probeNaturalWidth: probeW,
            probeErr: probeErr,
            i18nProbe: window.PetricI18n ? window.PetricI18n.t('reminder.break') : 'missing',
            drawnPixels: ctx ? (() => {
              const d = ctx.getImageData(0, 0, 300, 300).data;
              let n = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
              return n;
            })() : -1,
          };
        })()`);
        console.log('[smoke] diagnostics:', JSON.stringify(diag));
        const d = diag as {
          hasApi: boolean;
          skin: string;
          locale: string;
          hasCanvas: boolean;
          probeNaturalWidth: number;
          probeErr: string;
          i18nProbe: string;
          drawnPixels: number;
        };
        const expectedReminder = d.locale === 'en' ? 'Stand up and stretch, boss!' : '站起来活动活动啊老板！';
        if (
          !d.hasApi ||
          !['cat', 'dog', 'default', 'bulu', 'robot', 'custom'].includes(d.skin) ||
          !d.hasCanvas ||
          d.probeNaturalWidth !== 256 ||
          d.i18nProbe !== expectedReminder ||
          d.drawnPixels <= 0
        ) {
          console.error('SMOKE_FAIL 深度自检未通过:', JSON.stringify(diag));
          app.exit(1);
          return;
        }
      } catch (err) {
        console.error('SMOKE_FAIL 深度自检异常:', err);
        app.exit(1);
        return;
      }
      if (errors.length) {
        console.error('SMOKE_FAIL:', errors.join(' | '));
        app.exit(1);
        return;
      }
      console.log('SMOKE_OK');
      await smokeCheckSettings();
      await smokeCheckHitTest();
      await smokeCheck3D();
      await smokeCheckPetWindowSizeLock();
      await smokeCheckChatWindow();
      app.exit(0);
    }, 2500);
  });
}

/** Smoke-test step 2: confirm the settings panel window loads cleanly with no console errors */
async function smokeCheckSettings() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const sErrors: string[] = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[settings renderer]', message);
    if (/error|failed|uncaught|unhandled/i.test(message)) sErrors.push(message);
  });
  await win.loadFile(path.join(__dirname, '../renderer/settings.html'));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (sErrors.length) {
    console.error('SMOKE_FAIL settings:', sErrors.join(' | '));
    app.exit(1);
    return;
  }
  for (const locale of ['zh', 'en'] as Locale[]) {
    const dict = getDict(locale);
    const snapshot = (await win.webContents.executeJavaScript(`(() => {
      window.PetricI18n.setLocaleData(${JSON.stringify(locale)}, ${JSON.stringify(dict)});
      applyI18n();
      return JSON.stringify({
        documentTitle: document.title,
        heading: document.querySelector('.title').textContent,
        closeTitle: document.getElementById('btn-close').title,
        lang: document.documentElement.lang,
      });
    })()`)) as string;
    const actual = JSON.parse(snapshot) as {
      documentTitle: string;
      heading: string;
      closeTitle: string;
      lang: string;
    };
    const expected = {
      documentTitle: dict['settings.windowTitle'],
      heading: dict['settings.title'],
      closeTitle: dict['settings.close'],
      lang: locale === 'en' ? 'en' : 'zh-CN',
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.error('SMOKE_FAIL settings title i18n:', JSON.stringify({ locale, actual, expected }));
      app.exit(1);
      return;
    }
  }
  console.log('SMOKE_SETTINGS_OK');
  win.destroy();
}

/** Smoke-test step 3: verify pixel-perfect hit-testing + dynamic click-through (synthetic mouse events drive the real code paths) */
async function smokeCheckHitTest() {
  if (!mainWindow) return;
  const js = (x: number, y: number) =>
    mainWindow!.webContents.executeJavaScript(
      `window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`,
    );
  /**
   * Fire a synthetic mousemove and re-fire it until the click-through state reaches the
   * expected value. Synthetic events race with the rAF frame refresh (the 2D hitmap / 3D
   * raycast can lag one frame), so a single event is occasionally dropped; polling makes
   * the check deterministic.
   */
  async function settle(x: number, y: number, expectIgnoring: boolean, timeoutMs = 4000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await js(x, y);
      await new Promise((r) => setTimeout(r, 120));
      if (petIgnoreMouse === expectIgnoring) return true;
    }
    return petIgnoreMouse === expectIgnoring;
  }

  // Pick an "over the pet" point depending on the active mode:
  // 2D built-in/custom sprites -> (150, 240) inside the cat body; 3D model -> (150, 130) inside the model body.
  const mode = (await mainWindow.webContents.executeJavaScript(
    `(() => {
      const c3d = document.getElementById('pet3d-canvas');
      const s3d = c3d ? getComputedStyle(c3d).display : 'missing';
      return s3d === 'block' ? '3d' : '2d';
    })()`,
  )) as string;
  const onPetX = 150;
  const onPetY = mode === '3d' ? 130 : 240;
  // 1) Move the cursor over the pet's body → interaction should be restored (ignoring = false)
  const overPetIgnoring = !(await settle(onPetX, onPetY, false));
  // 2) Move the cursor to the transparent top-left corner (10, 10) → click-through should be restored (ignoring = true)
  // Diagnostic: also read the actual 2D canvas alpha at both points
  const diag = (await mainWindow.webContents.executeJavaScript(
    `(() => {
      const c = document.getElementById('pet-canvas');
      const ctx = c.getContext('2d');
      const a1 = ctx.getImageData(10, 10, 1, 1).data[3];
      const a2 = ctx.getImageData(${onPetX}, ${onPetY}, 1, 1).data[3];
      const c3d = document.getElementById('pet3d-canvas');
      const s3d = c3d ? getComputedStyle(c3d).display : 'missing';
      return JSON.stringify({ a10x10: a1, onPetAlpha: a2, pet3dDisplay: s3d });
    })()`,
  )) as string;
  console.log('[smoke] hit-test diag:', diag);
  const transparentIgnoring = await settle(10, 10, true);
  console.log(
    '[smoke] hit-test: over-pet ignoring=' + overPetIgnoring + ', transparent ignoring=' + transparentIgnoring,
  );
  if (process.platform === 'win32') {
    // Starts in click-through mode; moving over the pet should disable it, moving to a transparent area should re-enable it
    if (overPetIgnoring !== false || transparentIgnoring !== true) {
      console.error('SMOKE_FAIL 点击穿透状态异常: overPet=' + overPetIgnoring + ', transparent=' + transparentIgnoring);
      app.exit(1);
      return;
    }
  }
  // 3) Restore click-through so later checks are unaffected
  await settle(10, 10, true);
  console.log('SMOKE_HITTEST_OK');
}

// ---------- Screenshot mode (generates README images) ----------
/**
 * Fetch canvas RGBA data from the renderer and encode it as PNG.
 * Note: in this session capturePage / beginFrameSubscription proved unreliable for
 * large DOM fills, so both the pet and settings-panel images are rendered via
 * canvas drawing + getImageData (a path that is verified reliable).
 */
async function readCanvasPng(win: BrowserWindow, canvasId: string, w: number, h: number): Promise<void> {
  const raw = (await win.webContents.executeJavaScript(
    `(() => {
      const c = document.getElementById('${canvasId}');
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const bytes = new Uint8Array(img.data.buffer);
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(s);
    })()`,
  )) as string;
  const buf = Buffer.from(raw, 'base64');
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const file = path.join(app.getAppPath(), 'docs', 'screenshots', `${canvasId}.png`);
  fs.writeFileSync(file, encodePng(w, h, rgba));
}

/** Wait for the page to print the given marker */
function waitConsole(win: BrowserWindow, marker: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    win.webContents.on('console-message', (_e, _level, msg) => {
      if (msg === marker) done();
    });
    function done() {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function runScreenshot() {
  try {
    // Let the pet window render a few frames
    await new Promise((r) => setTimeout(r, 1200));
    const docsDir = path.join(app.getAppPath(), 'docs', 'screenshots');
    fs.mkdirSync(docsDir, { recursive: true });

    // Generate both language variants (zh default + en suffix); text comes from the i18n dictionary.
    const locales: Locale[] = ['zh', 'en'];
    for (const locale of locales) {
      const dict = getDict(locale);
      const suffix = locale === 'en' ? '-en' : '';

      // 1) Pet composite: canvas draws a "simulated desktop + real sprite"
      const compose = new BrowserWindow({
        width: 800,
        height: 500,
        show: false,
        frame: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const ready = waitConsole(compose, 'SCREENSHOT_READY');
      await compose.loadFile(path.join(__dirname, '../renderer/screenshot.html'));
      await compose.webContents.executeJavaScript(
        `window.__drawPetShot(${JSON.stringify(locale)}, ${JSON.stringify(dict)})`,
      );
      await ready;
      await new Promise((r) => setTimeout(r, 200));
      await readCanvasPng(compose, 'shot-canvas', 800, 500);
      fs.renameSync(
        path.join(app.getAppPath(), 'docs', 'screenshots', 'shot-canvas.png'),
        path.join(docsDir, `pet-cat${suffix}.png`),
      );
      compose.destroy();
      console.log(`SCREENSHOT_PET_OK → docs/screenshots/pet-cat${suffix}.png (${locale})`);

      // 2) Settings-panel screenshot: canvas replica of the panel (DOM capture is unreliable in this session)
      const settingsWin = new BrowserWindow({
        width: 880,
        height: 680,
        show: false,
        frame: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const sReady = waitConsole(settingsWin, 'SETTINGS_SHOT_READY');
      await settingsWin.loadFile(path.join(__dirname, '../renderer/settings-shot.html'));
      await settingsWin.webContents.executeJavaScript(
        `window.__drawSettingsShot(${JSON.stringify(locale)}, ${JSON.stringify(dict)})`,
      );
      await sReady;
      await new Promise((r) => setTimeout(r, 200));
      await readCanvasPng(settingsWin, 'settings-shot-canvas', 880, 680);
      fs.renameSync(
        path.join(app.getAppPath(), 'docs', 'screenshots', 'settings-shot-canvas.png'),
        path.join(docsDir, `settings-panel${suffix}.png`),
      );
      settingsWin.destroy();
      console.log(`SCREENSHOT_SETTINGS_OK → docs/screenshots/settings-panel${suffix}.png (${locale})`);
    }
    app.exit(0);
  } catch (err) {
    console.error('SCREENSHOT_FAIL:', err);
    app.exit(1);
  }
}

/** Smoke step: verify the 3D pipeline (WebGL render + GLB load + raycast hit test) */
async function smokeCheck3D() {
  const modelPath = path.join(app.getAppPath(), 'dist', 'assets', 'models', 'test-pet.glb');
  if (!fs.existsSync(modelPath)) {
    console.log('[smoke] 3D: test model missing, skipping 3D check');
    return;
  }
  const b64 = fs.readFileSync(modelPath).toString('base64');
  // Also feed a 2D image (cat sprite sheet) so the test covers the 2.5D billboard path
  const imgPath = path.join(app.getAppPath(), 'dist', 'assets', 'sprites', 'cat.png');
  const imgB64 = fs.existsSync(imgPath) ? fs.readFileSync(imgPath).toString('base64') : '';
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    show: false,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[3d renderer]', message);
    if (/error|failed|uncaught/i.test(message)) errors.push(message);
  });
  try {
    await win.loadFile(path.join(__dirname, '../renderer/pet3d-test.html'));
    await new Promise((r) => setTimeout(r, 400));
    const result = (await win.webContents.executeJavaScript(
      `window.__run3DTest('data:model/gltf-binary;base64,${b64}', 'data:image/png;base64,${imgB64}')`,
    )) as {
      ok: boolean;
      error?: string;
      pixels?: number;
      hitCenter?: boolean;
      hitCorner?: boolean;
      billboard?: { pixels?: number; hitCenter?: boolean; hitCorner?: boolean };
    };
    console.log('[smoke] 3D result:', JSON.stringify(result));
    if (!result.ok) {
      console.error('SMOKE_FAIL 3D:', result.error || 'unknown');
      app.exit(1);
      return;
    }
    if (errors.length) {
      console.error('SMOKE_FAIL 3D console errors:', errors.join(' | '));
      app.exit(1);
      return;
    }
    console.log('SMOKE_3D_OK');
  } catch (err) {
    console.error('SMOKE_FAIL 3D exception:', err);
    app.exit(1);
  } finally {
    win.destroy();
  }
}

/** Smoke step: an external/DPI resize must not separate the fixed pet from bottom-anchored overlays. */
async function smokeCheckPetWindowSizeLock() {
  if (!mainWindow) return;

  // Programmatic resizing bypasses the user's `resizable: false` gesture restriction and
  // reproduces the oversized viewport seen in the desktop screenshot.
  mainWindow.setContentSize(800, 700);
  await new Promise((r) => setTimeout(r, 250));

  const [width, height] = mainWindow.getContentSize();
  const viewport = (await mainWindow.webContents.executeJavaScript(
    `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`,
  )) as string;
  const v = JSON.parse(viewport) as { width: number; height: number };
  if (width !== PET_WIDTH || height !== PET_HEIGHT || v.width !== PET_WIDTH || v.height !== PET_HEIGHT) {
    console.error(
      'SMOKE_FAIL pet window size lock:',
      JSON.stringify({ native: [width, height], viewport: [v.width, v.height] }),
    );
    app.exit(1);
    return;
  }
  console.log('SMOKE_WINDOW_SIZE_LOCK_OK');
}

/** Smoke step: double-clicking the pet opens the standalone ChatGPT-style chat window, and
 *  the conversation store (create / rename / archive / delete) round-trips through IPC
 *  with the UI following along. Any test conversation is deleted at the end, so a user's
 *  real chats are never touched. */
async function smokeCheckChatWindow() {
  if (!mainWindow) return;
  const cfg = loadConfig();

  // Open it the same way the user does: double-click the pet (AI chat must be enabled for
  // that route; otherwise fall back to the menu / tray path used when it is disabled).
  if (cfg.aiEnabled) {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const fire = (t, x, y) => {
        const target = t === 'mousedown' ? document.getElementById('pet-canvas') : window;
        target.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, bubbles: true }));
      };
      fire('mousedown', 150, 240); fire('mouseup', 150, 240);
      fire('mousedown', 150, 240); fire('mouseup', 150, 240);
    })()`);
  } else {
    openChatWindow();
  }

  // Wait for the chat window to appear and render its UI
  const errors: string[] = [];
  let consoleAttached = false;
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 7000) {
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (!consoleAttached) {
        consoleAttached = true;
        chatWindow.webContents.on('console-message', (_e, _level, message) => {
          console.log('[chat renderer]', message);
          if (/error|failed|uncaught|unhandled/i.test(message)) errors.push(message);
        });
      }
      try {
        const ok = (await chatWindow.webContents.executeJavaScript(
          `(() => {
            const input = document.getElementById('chat-input');
            const list = document.getElementById('conv-list');
            return !!(input && list && document.getElementById('messages'));
          })()`,
        )) as boolean;
        if (ok) {
          ready = true;
          break;
        }
      } catch {
        /* page not finished loading yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    console.error('SMOKE_FAIL 对话窗口未在超时内就绪');
    app.exit(1);
    return;
  }

  // CRUD round-trip through the real IPC + UI broadcast path
  const result = (await chatWindow!.webContents.executeJavaScript(`(async () => {
    const t = window.api;
    const list = document.getElementById('conv-list');
    const arch = document.getElementById('archived-list');
    const baseRows = list.children.length;
    const baseArchivedRows = arch.children.length;
    const before = await t.chatsGetState();
    const countBefore = before.conversations.length;

    const made = await t.chatsCreate();
    await new Promise((r) => setTimeout(r, 150));
    const rowsAfterCreate = list.children.length;

    await t.chatsRename(made.id, 'smoke test chat');
    await new Promise((r) => setTimeout(r, 120));
    await t.chatsArchive(made.id);
    await new Promise((r) => setTimeout(r, 150));

    const mid = await t.chatsGetState();
    const conv = mid.conversations.find((c) => c.id === made.id);
    const rowsAfterArchive = list.children.length;
    const archivedRowsAfter = arch.children.length;

    await t.chatsDelete(made.id);
    await new Promise((r) => setTimeout(r, 150));
    const after = await t.chatsGetState();

    return {
      countBefore,
      baseRows,
      baseArchivedRows,
      rowsAfterCreate,
      archivedFlag: conv ? !!conv.archived : null,
      renamedTitle: conv ? conv.title : null,
      rowsAfterArchive,
      archivedRowsAfter,
      finalCount: after.conversations.length,
      stillThere: after.conversations.some((c) => c.id === made.id),
    };
  })()`)) as {
    countBefore: number;
    baseRows: number;
    baseArchivedRows: number;
    rowsAfterCreate: number;
    archivedFlag: boolean | null;
    renamedTitle: string | null;
    rowsAfterArchive: number;
    archivedRowsAfter: number;
    finalCount: number;
    stillThere: boolean;
  };
  console.log('[smoke] chat-window CRUD:', JSON.stringify(result));

  const okUi =
    result.rowsAfterCreate === result.baseRows + 1 &&
    result.rowsAfterArchive === result.baseRows &&
    result.archivedRowsAfter === result.baseArchivedRows + 1;
  const okStore =
    result.archivedFlag === true &&
    result.renamedTitle === 'smoke test chat' &&
    result.finalCount === result.countBefore &&
    !result.stillThere;
  if (!okUi || !okStore || errors.length) {
    console.error('SMOKE_FAIL 对话窗口 CRUD:', JSON.stringify({ result, okUi, okStore, errors }));
    app.exit(1);
    return;
  }
  console.log('SMOKE_CHAT_OK');

  // Close the window again so later checks are unaffected
  chatWindow?.close();
  await new Promise((r) => setTimeout(r, 300));
}

