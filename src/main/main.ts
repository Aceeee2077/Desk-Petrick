// ============================================================================
// Petric main process entry
// Responsibilities: transparent always-on-top window, tray, IPC, AI chat (network requests), auto-launch at login, config persistence.
// ============================================================================

import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../shared/config';
import { encodePng } from '../shared/png';
import { getDict, makeT } from '../shared/i18n';

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
    createPetWindow();
    createTray();
    registerIpc();
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

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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
    width: 440,
    height: 640,
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

// ---------- Context menu ----------
function showPetContextMenu() {
  const menu = Menu.buildFromTemplate([
    { label: ts('menu.settings'), click: () => openSettings() },
    { label: ts('menu.chat'), click: () => mainWindow?.webContents.send('pet:chat-request') },
    { label: ts('menu.resetPos'), click: () => mainWindow && centerWindow(mainWindow) },
    { type: 'separator' },
    { label: ts('menu.quitPet'), click: () => app.quit() },
  ]);
  menu.popup({ window: mainWindow ?? undefined });
}

// ---------- AI chat (requests sent from the main process to avoid browser CORS restrictions) ----------
const SYSTEM_PROMPT =
  '你是一只可爱的桌面宠物，名叫 Petric。请用简短、温暖、有趣的中文回答用户，最多 2~3 句话，可以带一点 emoji。';

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
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 120,
        temperature: 0.9,
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

// ---------- Custom appearance image ----------
/** Directory for custom images under the app data folder (works in both packaged and dev environments) */
function customDir(): string {
  return path.join(app.getPath('userData'), 'petric-custom');
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
    fs.copyFileSync(src, path.join(dir, 'custom' + ext));
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
  return removed;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('config:get', () => loadConfig());

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    const cfg = saveConfig(patch);
    if (typeof patch.opacity === 'number') applyWindowOpacity();
    if (patch.locale) rebuildTrayMenu(); // tray labels/tooltip follow the UI language
    if (mainWindow) mainWindow.webContents.send('config-changed', cfg);
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
  ipcMain.handle('window:position', () => mainWindow?.getPosition() ?? [0, 0]);
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

  ipcMain.handle('ai:chat', async (_e, messages: ChatMessage[]) => aiChat(messages));

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
              probe.src = '../assets/sprites/cat.png';
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
            i18nSend: window.PetricI18n ? window.PetricI18n.t('chat.send') : 'missing',
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
          i18nSend: string;
          drawnPixels: number;
        };
        const expectedSend = d.locale === 'en' ? 'Send' : '发送';
        if (
          !d.hasApi ||
          !['cat', 'dog', 'default', 'custom'].includes(d.skin) ||
          !d.hasCanvas ||
          d.probeNaturalWidth !== 128 ||
          d.i18nSend !== expectedSend ||
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
      await smokeCheckChatBox();
      await smokeCheckChatBoxAfterDrag();
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
        width: 440,
        height: 640,
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
      await readCanvasPng(settingsWin, 'settings-shot-canvas', 440, 640);
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

/** Smoke step: simulate a real double-click on the pet and verify the chat box opens centered above the pet. */
async function smokeCheckChatBox() {
  if (!mainWindow) return;
  const fire = (type: 'mousedown' | 'mouseup', x: number, y: number) =>
    mainWindow!.webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(type)} === 'mousedown' ? document.getElementById('pet-canvas') : window;
      target.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
        clientX: ${x}, clientY: ${y}, screenX: ${x}, screenY: ${y}, button: 0, bubbles: true,
      }));
    })()`);
  // Double-click on the pet body (150, 240 for the 2D cat)
  await fire('mousedown', 150, 240);
  await fire('mouseup', 150, 240);
  await fire('mousedown', 150, 240);
  await fire('mouseup', 150, 240);
  await new Promise((r) => setTimeout(r, 400));
  const rect = (await mainWindow.webContents.executeJavaScript(
    `(() => {
      const el = document.getElementById('chat-ui');
      const r = el.getBoundingClientRect();
      return JSON.stringify({
        hidden: el.classList.contains('hidden'),
        left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
        center: Math.round((r.left + r.right) / 2), bottom: Math.round(r.bottom),
      });
    })()`,
  )) as string;
  console.log('[smoke] chat-box rect:', rect);
  const p = JSON.parse(rect) as { hidden: boolean; left: number; right: number; top: number; center: number; bottom: number };
  // The box must be visible, horizontally centered (center ≈ 150), and above the pet (top < 150)
  if (p.hidden || Math.abs(p.center - 150) > 2 || p.top >= 150) {
    console.error('SMOKE_FAIL chat-box position:', rect);
    app.exit(1);
    return;
  }
  // History overlay: 🕘 opens it (console hidden, empty-state message shown), ✕ closes it back
  const histState = (await mainWindow.webContents.executeJavaScript(
    `(() => {
      try {
        const btn = document.getElementById('chat-history-btn');
        const overlay = document.getElementById('chat-history');
        const ui = document.getElementById('chat-ui');
        const list = document.getElementById('chat-history-list');
        const before = { btnExists: !!btn, overlayExists: !!overlay, uiHidden: ui.classList.contains('hidden'), overlayHidden: overlay.classList.contains('hidden') };
        btn.click();
        const after = {
          uiHidden: ui.classList.contains('hidden'),
          overlayHidden: overlay.classList.contains('hidden'),
          emptyMsg: !!list.querySelector('.msg.empty'),
          listChildren: list.children.length,
        };
        document.getElementById('chat-history-close').click();
        const closed = overlay.classList.contains('hidden') && !ui.classList.contains('hidden');
        return JSON.stringify({ before, after, closed });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    })()`,
  )) as string;
  console.log('[smoke] history toggle:', histState);
  const hs = JSON.parse(histState) as { before?: { btnExists: boolean; overlayExists: boolean; uiHidden: boolean; overlayHidden: boolean }; after?: { uiHidden: boolean; overlayHidden: boolean; emptyMsg: boolean; listChildren: number }; closed?: boolean; error?: string };
  // Accept either the empty state or real messages (the smoke shares the user's localStorage)
  if (hs.error || !hs.after || !(hs.after.emptyMsg || hs.after.listChildren > 0) || !hs.closed) {
    console.error('SMOKE_FAIL chat history toggle:', histState);
    app.exit(1);
    return;
  }
  // Close the chat so later checks are unaffected
  await mainWindow.webContents.executeJavaScript(
    `document.getElementById('chat-ui').classList.add('hidden')`,
  );
  console.log('SMOKE_CHATBOX_OK');
}

/** Smoke step: verify the chat box stays window-anchored (same position relative to the pet) after dragging the window. */
async function smokeCheckChatBoxAfterDrag() {
  if (!mainWindow) return;

  // Wait so the next mousedown is not treated as a double-click's second press (drag suppression)
  await new Promise((r) => setTimeout(r, 500));

  // Helper to open the chat box via a synthetic double-click on the pet (150, 240) and return its rect
  const openAndMeasure = async () => {
    await mainWindow!.webContents.executeJavaScript(`(() => {
      const fire = (t, x, y) => {
        const target = t === 'mousedown' ? document.getElementById('pet-canvas') : window;
        target.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, bubbles: true }));
      };
      fire('mousedown', 150, 240); fire('mouseup', 150, 240);
      fire('mousedown', 150, 240); fire('mouseup', 150, 240);
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const rect = (await mainWindow!.webContents.executeJavaScript(
      `JSON.stringify((() => { const r = document.getElementById('chat-ui').getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), center: Math.round((r.left + r.right) / 2) }; })())`,
    )) as string;
    return JSON.parse(rect) as { left: number; right: number; top: number; bottom: number; center: number };
  };

  const before = await openAndMeasure();

  // Simulate the press and move first, pausing before mouseup so both overlay types can
  // be checked while the drag is active. The main process drives the window from its own
  // cursor, so no exact delta is asserted here.
  await mainWindow.webContents.executeJavaScript(`(() => {
    const fire = (t, x, y, sx, sy, buttons) => {
      const target = t === 'mousedown' ? document.getElementById('pet-canvas') : window;
      target.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, screenX: sx, screenY: sy, button: 0, buttons, bubbles: true }));
    };
    document.getElementById('bubble').textContent = 'drag-test';
    document.getElementById('bubble').classList.add('show');
    fire('mousedown', 150, 240, 150, 240, 1);
    fire('mousemove', 190, 240, 190, 240, 1);
    fire('mousemove', 210, 240, 210, 240, 1);
  })()`);
  const activeDragState = (await mainWindow.webContents.executeJavaScript(
    `JSON.stringify({
      chatHidden: document.getElementById('chat-ui').classList.contains('hidden'),
      bubbleHidden: !document.getElementById('bubble').classList.contains('show'),
    })`,
  )) as string;
  const active = JSON.parse(activeDragState) as { chatHidden: boolean; bubbleHidden: boolean };
  if (!active.chatHidden || !active.bubbleHidden) {
    console.error('SMOKE_FAIL overlay stayed open during a drag:', activeDragState);
    app.exit(1);
    return;
  }
  await mainWindow.webContents.executeJavaScript(`window.dispatchEvent(new MouseEvent('mouseup', {
    clientX: 210, clientY: 240, screenX: 210, screenY: 240, button: 0, buttons: 0, bubbles: true,
  }))`);
  await new Promise((r) => setTimeout(r, 500));

  const afterDragPos = mainWindow!.getPosition();
  // The drag must release its main-process anchor and leave the window on-screen.
  if (dragAnchor !== null) {
    console.error('SMOKE_FAIL drag anchor stayed active after mouseup');
    app.exit(1);
    return;
  }
  const wa = screen.getDisplayMatching({ x: afterDragPos[0], y: afterDragPos[1], width: 300, height: 300 }).workArea;
  const onScreen = afterDragPos[0] >= wa.x && afterDragPos[0] + 300 <= wa.x + wa.width;

  // Reopen and compare the box's window-relative position
  await new Promise((r) => setTimeout(r, 400));
  const after = await openAndMeasure();

  console.log('[smoke] chatbox-drag: before rect=' + JSON.stringify(before) + ', after rect=' + JSON.stringify(after) +
    ', window=' + JSON.stringify(afterDragPos) + ' onScreen=' + onScreen);
  const b = before;
  const a = after;
  if (!onScreen || Math.abs(b.left - a.left) > 1 || Math.abs(b.top - a.top) > 1 || Math.abs(b.center - a.center) > 2) {
    console.error('SMOKE_FAIL chat box moved relative to the window after dragging (or window off-screen)');
    app.exit(1);
    return;
  }
  await mainWindow.webContents.executeJavaScript(
    `document.getElementById('chat-ui').classList.add('hidden')`,
  );
  console.log('SMOKE_CHATBOX_DRAG_OK');
}
