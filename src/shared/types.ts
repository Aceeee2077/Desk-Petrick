// ============================================================================
// Petric shared type definitions
// This file contains only type declarations (no runtime exports). Compiled as
// a "script file", these types are globally visible in the main / preload /
// renderer processes without any imports. Since the renderer's app.ts /
// settings.ts are single scripts (no import/export), the module system is
// deliberately avoided here so all three sides can use them directly.
// ============================================================================

/** Pet skin (legacy IDs dog/default now display the built-in fox/rabbit art). */
type PetSkin = 'cat' | 'dog' | 'default' | 'bulu' | 'robot' | 'custom';

/** UI language */
type Locale = 'zh' | 'en';

/** UI theme: light = orange-white gradient, dark = the original purple tone */
type Theme = 'light' | 'dark';

/** Procedural pixel accessory worn by the generated robot sprite. */
type Accessory = 'none' | 'hat' | 'scarf' | 'glasses';

/** One point of the daily affinity growth history */
interface AffinityPoint {
  /** Local date YYYY-MM-DD */
  date: string;
  /** Affinity value on that date */
  value: number;
}

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

/** One independent AI chat conversation (the pet can hold many) */
interface ChatConversation {
  id: string;
  /** Auto-title derived from the first user message (may be empty = "new chat") */
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** True while the conversation is archived (hidden from the main list). */
  archived?: boolean;
}

/** Full chat-store snapshot shared between the chat window and the pet window. */
interface ChatState {
  conversations: ChatConversation[];
  /** Id of the conversation new messages go to ('' when there is none yet). */
  activeId: string;
}

/** Result of sending one chat message (user + assistant round-trip orchestrated in main). */
interface ChatSendResult {
  ok: boolean;
  /** Localized failure reason (only when ok is false). */
  error?: string;
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
  /** The stored raster has already been converted to a transparent cutout. */
  cutoutApplied?: boolean;
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
  /** Auto-cutout: remove the solid / simple background from imported images (single & billboard modes) */
  autoCutout: boolean;
  /** Cutout color tolerance 8 ~ 60 (higher = more aggressive background removal) */
  cutoutTolerance: number;
  /** UI language */
  locale: Locale;
  /** UI theme: light = orange-white gradient, dark = the original purple tone */
  theme: Theme;
  /** Procedural pixel accessory for built-in sprite pets */
  accessory: Accessory;
  /** Affinity with the pet (0 ~ 100, grows when you interact: click / drag / chat) */
  affinity: number;
  /** Focus mode: periodically remind the user to stand up and stretch (default on) */
  focusMode: boolean;
  /** Break reminder interval in minutes (20 / 30 / 40 / 60 / 90, default 40) */
  focusInterval: number;
  /** Interaction stats: first day the app was launched (YYYY-MM-DD) */
  statsFirstSeen: string;
  /** Interaction stats: distinct launch dates (YYYY-MM-DD) */
  statsDays: string[];
  /** Interaction stats: total clicks on the pet */
  statsClicks: number;
  /** Interaction stats: total AI chat messages sent */
  statsChats: number;
  /** Affinity growth history (one snapshot per interaction day, newest last) */
  affinityHistory: AffinityPoint[];
  /** Proactive chat: the pet greets you after 10 minutes of inactivity */
  greetEnabled: boolean;
  /** Weather: clicking the pet sometimes reports today's weather (fetched by the main process) */
  weatherEnabled: boolean;
  /** Hourly chime: the pet jumps and announces the hour */
  hourlyChime: boolean;
  /** Marked eye positions (normalized 0..1 within the custom photo) for the photo-pet
   *  eye-following overlay. null = not calibrated. */
  photoEyes: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Autonomous movement: the pet walks / runs / jumps around the desktop on its own
   *  (stays awake instead of auto-sleeping while enabled) */
  autoMove: boolean;
}

/** Weather reported by the main process (free APIs: ipwho.is for location + Open-Meteo) */
interface WeatherResult {
  ok: boolean;
  /** City / region name (localized by the API) */
  city?: string;
  /** Temperature in °C */
  temp?: number;
  /** WMO weather code */
  code?: number;
  /** Local date YYYY-MM-DD */
  date?: string;
  /** Failure reason */
  error?: string;
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
  /** Open (or focus) the standalone ChatGPT-style chat window */
  openChat(): void;
  /** Close the chat window (frameless windows close themselves via this IPC) */
  closeChatWindow(): void;
  /** Read the whole chat store (conversations + active id) */
  chatsGetState(): Promise<ChatState>;
  /** Create a fresh conversation and make it active */
  chatsCreate(): Promise<ChatConversation>;
  /** Delete a conversation (the active one is re-selected automatically) */
  chatsDelete(id: string): Promise<void>;
  /** Toggle a conversation's archived flag */
  chatsArchive(id: string): Promise<void>;
  /** Rename a conversation */
  chatsRename(id: string, title: string): Promise<void>;
  /** Remember which conversation is active (used when the chat window reopens) */
  setActiveChat(id: string): void;
  /** Send one message in a conversation; the AI reply is appended by the main process */
  chatsSend(id: string, text: string): Promise<ChatSendResult>;
  /** Import the old localStorage conversations/history once (no-op when the store already has data) */
  chatsImportLegacy(payload: unknown): Promise<boolean>;
  /** Subscribe to chat-store changes, returns an unsubscribe function */
  onChatsChanged(cb: (state: ChatState) => void): () => void;
  /** Subscribe to "an AI reply just completed" (pet adds affinity / stats via this) */
  onChatReward(cb: () => void): () => void;
  /** Read the currently active custom image (userData takes priority, then the project's src/assets/sprites/custom.*) */
  getCustomImage(): Promise<CustomImageResult>;
  /** Open a file picker, copy the selected image into the app data directory and return it */
  pickCustomImage(): Promise<CustomImageResult>;
  /** Delete the custom image in the app data directory */
  clearCustomImage(): Promise<boolean>;
  /** Get the active locale + dictionary for the renderer's i18n */
  getI18n(): Promise<I18nPayload>;
  /** Get today's weather (main process fetches from free APIs to avoid CORS; cached ~30 min) */
  getWeather(): Promise<WeatherResult>;
  /** Start gliding the pet window horizontally (dir: -1 left / +1 right; speed: px per second) */
  autoMoveStart(dir: number, speed: number): void;
  /** Stop the autonomous window glide */
  autoMoveStop(): void;
  /** Hop the pet window vertically (a parabolic jump of `height` px over `duration` ms) */
  autoJump(height: number, duration: number): void;
  /** Center the pet window on the display it currently sits on */
  centerHere(): void;
}

interface Window {
  api: PetApi;
  /** i18n handle provided by src/renderer/i18n.ts (loaded before app.js / settings.js) */
  PetricI18n: PetricI18n;
}
