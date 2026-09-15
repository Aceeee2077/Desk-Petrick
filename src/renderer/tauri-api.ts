// ============================================================================
// Tauri compatibility layer.
//
// The Electron build exposed `window.api` from a preload script. This file
// re-implements the exact same PetApi surface on top of Tauri 2's invoke/listen,
// so app.ts / settings.ts / chat.ts keep working without changes.
//
// It must be loaded before i18n.js / app.js in every window, and it needs
// `"withGlobalTauri": true` (see src-tauri/tauri.conf.json).
//
// Not yet ported to Rust are stubbed here with harmless defaults so the UI stays
// usable; they are listed at the bottom so the remaining work is easy to grep.
// ============================================================================

(() => {
  type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  type Listen = (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;

  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } } })
    .__TAURI__;
  const invoke = tauri?.core?.invoke;
  const listen = tauri?.event?.listen;

  if (!invoke) {
    console.error('[tauri-api] window.__TAURI__ is missing — the pet cannot reach the backend.');
  }

  /** Await a backend command. */
  const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    invoke ? (invoke(cmd, args) as Promise<T>) : Promise.reject(new Error('tauri unavailable'));

  /** Fire-and-forget a backend command (movement, click-through, ...). */
  const send = (cmd: string, args?: Record<string, unknown>): void => {
    if (!invoke) return;
    void invoke(cmd, args).catch((err) => console.error(`[tauri-api] ${cmd} failed:`, err));
  };

  /** Local YYYY-MM-DD: the webview knows the timezone, so Rust does not need one. */
  const localDate = (): string => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  };

  /** Turn an absolute path into an `asset:` URL the <img> tag can load. */
  const toAssetUrl = (path?: string): string | undefined => {
    const convert = (window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } } })
      .__TAURI__?.core?.convertFileSrc;
    if (!path || !convert) return undefined;
    try {
      return convert(path);
    } catch {
      return undefined;
    }
  };

  /** Subscribe to a backend event; returns an unsubscribe function. */
  const subscribe = <T>(event: string, cb: (payload: T) => void): (() => void) => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    if (listen) {
      void listen(event, (e) => cb(e.payload as T))
        .then((un) => {
          if (cancelled) un();
          else unlisten = un;
        })
        .catch((err) => console.error(`[tauri-api] listen ${event} failed:`, err));
    }
    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = null;
    };
  };

  // ---------- Autonomous movement ----------
  // Electron drove this from the main process; the renderer side is equivalent
  // and avoids round-tripping a 60 Hz timer through Rust.
  let autoMoveTimer: number | null = null;

  function autoMoveStop(): void {
    if (autoMoveTimer !== null) {
      window.clearInterval(autoMoveTimer);
      autoMoveTimer = null;
    }
  }

  function autoMoveStart(dir: number, speed: number): void {
    autoMoveStop();
    let last = performance.now();
    autoMoveTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      send('window_move', { dx: Math.round(dir * speed * dt), dy: 0 });
    }, 16);
  }

  async function autoJump(height: number, duration: number): Promise<void> {
    const [x0, y0] = await call<[number, number]>('window_position').catch(() => [0, 0] as [number, number]);
    const start = performance.now();
    const tick = () => {
      const progress = (performance.now() - start) / Math.max(1, duration);
      if (progress >= 1) {
        send('window_move_to', { x: x0, y: y0 });
        return;
      }
      const lift = Math.sin(Math.PI * Math.min(1, progress)) * height;
      send('window_move_to', { x: x0, y: Math.round(y0 - lift) });
      window.setTimeout(tick, 16);
    };
    tick();
  }

  // ---------- Click-through re-entry ----------
  // Electron forwarded mousemove to a click-through window; Tauri does not, so once the
  // pet is click-through nothing in the renderer can notice the cursor coming back.
  // While click-through is on we poll the cursor and flip interaction back on as soon as
  // it re-enters the pet (or the update badge).
  let reentryTimer: number | null = null;
  let reentryFailures = 0;

  function stopReentryPoll(): void {
    if (reentryTimer !== null) {
      window.clearInterval(reentryTimer);
      reentryTimer = null;
    }
    reentryFailures = 0;
  }

  function startReentryPoll(): void {
    if (reentryTimer !== null) return;
    reentryTimer = window.setInterval(() => {
      const hitTest = (window as unknown as { __prismooHitTest?: (x: number, y: number) => boolean })
        .__prismooHitTest;
      if (!hitTest) return;
      void call<[number, number] | null>('cursor_in_window')
        .then((point) => {
          reentryFailures = 0;
          if (!point) return;
          if (hitTest(point[0], point[1])) {
            stopReentryPoll();
            send('set_click_through', { enabled: false });
          }
        })
        .catch(() => {
          // Fail safe: if polling breaks, give the pet its clicks back rather than
          // leaving the window permanently untouchable.
          reentryFailures += 1;
          if (reentryFailures >= 5) {
            stopReentryPoll();
            send('set_click_through', { enabled: false });
          }
        });
    }, 50);
  }

  function setClickThrough(enabled: boolean): void {
    send('set_click_through', { enabled });
    if (enabled) startReentryPoll();
    else stopReentryPoll();
  }

  // ---------- Not ported yet (graceful defaults) ----------
  const updateDevState = (): UpdateState => ({
    status: 'dev',
    currentVersion: '',
    autoCheck: true,
    autoDownload: true,
    channel: 'stable',
  });

  const api: PetApi = {
    // ---- Window ----
    moveWindow: (dx, dy) => send('window_move', { dx: Math.round(dx), dy: Math.round(dy) }),
    moveWindowTo: (x, y) => send('window_move_to', { x: Math.round(x), y: Math.round(y) }),
    dragBegin: () => send('drag_begin'),
    dragMove: () => send('drag_move'),
    dragEnd: () => send('drag_end'),
    getWindowPosition: () => call<number[]>('window_position'),
    resetPosition: () => send('window_center_here'),
    setClickThrough,
    centerHere: () => send('window_center_here'),

    // ---- Config ----
    getConfig: () => call<AppConfig>('config_get'),
    setConfig: (patch) => call<AppConfig>('config_set', { patch }),
    onConfigChanged: (cb) => subscribe<AppConfig>('config-changed', cb),

    // ---- Shell ----
    openSettings: () => send('open_settings'),
    quitApp: () => send('quit_app'),
    showContextMenu: () => send('show_pet_menu'),
    openChat: () => send('open_chat'),
    closeChatWindow: () => send('close_chat'),

    // ---- Autonomous movement ----
    autoMoveStart,
    autoMoveStop,
    autoJump: (height, duration) => void autoJump(height, duration),

    // ---- AI chat (request runs in Rust so the API key stays out of the page) ----
    aiChat: (messages) => call<string>('ai_chat', { messages }),

    // ---- Auto launch ----
    autoLaunchGet: () => call<boolean>('autolaunch_get'),
    autoLaunchSet: (enabled) => call<boolean>('autolaunch_set', { enabled }),

    // ---- Updates (tauri-plugin-updater lands in a later step) ----
    updateGetState: () => Promise.resolve(updateDevState()),
    updateCheck: () => Promise.resolve(updateDevState()),
    updateDownload: () => Promise.resolve(updateDevState()),
    updateInstall: () => Promise.resolve(),
    updateInstallWhenReady: () => Promise.resolve(updateDevState()),
    updateOpenPage: () => Promise.resolve(),
    onUpdateState: (cb) => subscribe<UpdateState>('update-state', cb),

    // ---- Chat store ----
    chatsGetState: () => call<ChatState>('chats_state'),
    chatsCreate: () => call<ChatConversation>('chats_create'),
    chatsDelete: (id) => call<void>('chats_delete', { id }),
    chatsArchive: (id) => call<void>('chats_archive', { id }),
    chatsRename: (id, title) => call<void>('chats_rename', { id, title }),
    setActiveChat: (id) => send('chats_set_active', { id }),
    chatsSend: (id, text) => call<ChatSendResult>('chats_send', { id, text }),
    chatsImportLegacy: (payload) => call<boolean>('chats_import_legacy', { payload }),
    onChatsChanged: (cb) => subscribe<ChatState>('chats-changed', cb),
    onChatReward: (cb) => subscribe<void>('pet:chat-reward', () => cb()),
    onPetNotice: (cb) => subscribe<string>('pet:notice', cb),

    // ---- Custom appearance (image only; ONNX background removal was dropped) ----
    getCustomImage: async () => {
      const res = await call<CustomImageResult>('custom_get');
      return { ...res, url: res.url ?? toAssetUrl(res.path) };
    },
    pickCustomImage: async () => {
      const res = await call<CustomImageResult>('custom_pick');
      return { ...res, url: res.url ?? toAssetUrl(res.path) };
    },
    clearCustomImage: () => call<boolean>('custom_clear'),

    // ---- i18n ----
    getI18n: () => call<I18nPayload>('i18n_get'),

    // ---- Weather (fetched in Rust to dodge CORS) ----
    getWeather: () => call<WeatherResult>('weather_get', { date: localDate() }),
  };

  window.api = api;

  // The pet window starts click-through, matching the Electron build (transparent
  // areas never swallow desktop clicks). The re-entry poll above brings interaction
  // back as soon as the cursor touches the pet — it waits for app.js to publish
  // __prismooHitTest, so running before the renderer is safe.
  if (location.pathname.endsWith('index.html')) {
    setClickThrough(true);
  }
})();
