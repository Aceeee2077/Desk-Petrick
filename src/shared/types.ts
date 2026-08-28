// ============================================================================
// Petric shared type definitions
// This file contains only type declarations (no runtime exports). Compiled as
// a "script file", these types are globally visible in the main / preload /
// renderer processes without any imports. Since the renderer's app.ts /
// settings.ts are single scripts (no import/export), the module system is
// deliberately avoided here so all three sides can use them directly.
// ============================================================================

/** Pet skin (cat/dog/default are built-in sprite sheets; custom is a custom image) */
type PetSkin = 'cat' | 'dog' | 'default' | 'custom';

/** UI language */
type Locale = 'zh' | 'en';

/** Display mode for the custom appearance (image or 3D model) */
type CustomImageMode = 'single' | 'sheet' | 'model' | 'billboard';

/** Animation state */
type PetState = 'idle' | 'walking' | 'sleeping' | 'click';

/** i18n dictionary value: a string, or an array (e.g. the click speech lines) */
type I18nValue = string | string[];

/** Payload returned by the main process for the renderer's i18n */
interface I18nPayload {
  locale: Locale;
  dict: Record<string, I18nValue>;
}

/** Renderer i18n handle exposed by src/renderer/i18n.ts (window.PetricI18n) */
interface PetricI18n {
  /** Translate a key; unknown keys fall back to the key itself. */
  t(key: string, params?: Record<string, string | number>): string;
  /** Translate an array-valued key (e.g. the click speech lines). */
  tArray(key: string): string[];
  /** Set the active locale + dictionary (provided by the main process via IPC). */
  setLocaleData(locale: Locale, dict: Record<string, I18nValue>): void;
  getLocale(): Locale;
}

/** 3D pet renderer handle exposed by pet3d.js (window.Petric3D), used when customImageMode is 'model' or 'billboard' */
interface Petric3DHandle {
  init(canvas: HTMLCanvasElement): boolean;
  /** Load a GLB model from a data URL. Resolves true on success. */
  loadModel(dataUrl: string): Promise<boolean>;
  /** Load a single 2D image as a billboard plane (2.5D). Resolves true on success. */
  loadBillboard(dataUrl: string): Promise<boolean>;
  /** Feed pointer state each frame: cursor x (window coords), dragging flag, drag x-velocity. */
  setPointer(pointerX: number, dragging: boolean, dragVelX: number): void;
  /** Advance the procedural animation (dt in seconds). */
  update(dt: number, state: PetState, frameIndex: number): void;
  render(): void;
  /** Raycast hit test in window coordinates (0..300). */
  isOver(clientX: number, clientY: number): boolean;
  setVisible(v: boolean): void;
  /** Test hook: render a frame and count non-transparent pixels. */
  debugPixelCount(): number;
  dispose(): void;
}

/** AI chat role */
type ChatRole = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Custom image query / selection result */
interface CustomImageResult {
  ok: boolean;
  /** base64 data URL, can be assigned directly to img.src */
  dataUrl?: string;
  /** Currently configured display mode */
  mode?: CustomImageMode;
  /** Absolute path of the image on disk */
  path?: string;
  /** Failure reason */
  error?: string;
}

/** App configuration (persisted to userData/config.json) */
interface AppConfig {
  /** Pet skin */
  skin: PetSkin;
  /** Animation speed multiplier 0.5 ~ 2 */
  animSpeed: number;
  /** Window opacity 0.5 ~ 1 */
  opacity: number;
  /** Launch at startup */
  autoLaunch: boolean;
  /** AI chat toggle */
  aiEnabled: boolean;
  /** API Key (kept only on this machine) */
  apiKey: string;
  /** OpenAI-compatible API base URL, e.g. https://api.openai.com/v1 */
  apiBaseUrl: string;
  /** Model name, e.g. gpt-4o-mini / deepseek-chat */
  model: string;
  /** Click sound toggle */
  soundEnabled: boolean;
  /** Display mode for the custom appearance: single=single image / sheet=sprite sheet / model=3D model */
  customImageMode: CustomImageMode;
  /** Custom image path (for reference) */
  customImagePath: string;
  /** UI language */
  locale: Locale;
}

/** API exposed to the renderer by the preload script via contextBridge */
interface PetApi {
  /** Move the pet window by a delta (dx/dy) */
  moveWindow(dx: number, dy: number): void;
  /** Move the pet window to absolute screen coordinates (clamped to the display work area) */
  moveWindowTo(x: number, y: number): void;
  /** Begin a drag: main captures the window position + cursor offset (anchor) synchronously. */
  dragBegin(): void;
  /** Continue a drag; main targets the window at its own live cursor minus the anchor offset. */
  dragMove(): void;
  /** End a drag and release the main-process cursor/window anchor. */
  dragEnd(): void;
  /** Get the pet window's current position [x, y] */
  getWindowPosition(): Promise<number[]>;
  /** Reset to the center of the screen */
  resetPosition(): void;
  /** Dynamic click-through: true=ignore the mouse (transparent areas click through to the desktop, Windows only) */
  setClickThrough(enabled: boolean): void;
  /** Read the full configuration */
  getConfig(): Promise<AppConfig>;
  /** Partially update the configuration and return the latest one */
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  /** Open the settings panel window */
  openSettings(): void;
  /** Quit the app */
  quitApp(): void;
  /** Show the context menu */
  showContextMenu(): void;
  /** Call AI chat (the network request is made in the main process to avoid CORS) */
  aiChat(messages: ChatMessage[]): Promise<string>;
  /** Query the auto-launch status */
  autoLaunchGet(): Promise<boolean>;
  /** Set auto-launch, returns the final status */
  autoLaunchSet(enabled: boolean): Promise<boolean>;
  /** Subscribe to config changes, returns an unsubscribe function */
  onConfigChanged(cb: (cfg: AppConfig) => void): () => void;
  /** Subscribe to "open chat input" requests (from tray / context menu) */
  onOpenChatRequest(cb: () => void): () => void;
  /** Read the currently active custom image (userData takes priority, then the project's src/assets/sprites/custom.*) */
  getCustomImage(): Promise<CustomImageResult>;
  /** Open a file picker, copy the selected image into the app data directory and return it */
  pickCustomImage(): Promise<CustomImageResult>;
  /** Delete the custom image in the app data directory */
  clearCustomImage(): Promise<boolean>;
  /** Get the active locale + dictionary for the renderer's i18n */
  getI18n(): Promise<I18nPayload>;
}

interface Window {
  api: PetApi;
  /** i18n handle provided by src/renderer/i18n.ts (loaded before app.js / settings.js) */
  PetricI18n: PetricI18n;
}
