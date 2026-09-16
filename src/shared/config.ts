// ============================================================================
// Configuration management (used by the main process)
// Persisted via userData/config.json, with zero runtime dependencies (a
// lightweight replacement for electron-store). All configuration and chat
// history stay on this machine; nothing is uploaded.
// ============================================================================

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_CONFIG: AppConfig = {
  skin: 'cat',
  animSpeed: 1,
  opacity: 1,
  autoLaunch: false,
  aiEnabled: false,
  apiKey: '',
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  aiProviders: [],
  aiProviderId: '',
  chatMaxTokens: 120,
  chatTemperature: 0.8,
  chatVerbosity: 'normal',
  chatEmoji: false,
  chatUsageDate: '',
  chatUsageMessages: 0,
  chatUsageTokens: 0,
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
  petScale: 1,
  stayOnOneDisplay: true,
  snapToEdge: false,
  sleepTimeoutSec: 30,
  wanderSpeed: 1,
  activityFrequency: 1,
  updateAutoCheck: true,
  updateAutoDownload: true,
  updateChannel: 'stable',
  updateDeferredVersion: '',
  updateDeferredAt: 0,
  updateNextAutoCheckAt: 0,
  updateAutoRetry: 0,
};

let cache: AppConfig | null = null;
let writeTimer: NodeJS.Timeout | null = null;
const API_KEY_PREFIX = 'safe:v1:';
const CONFIG_SAVE_DELAY_MS = 250;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** safeStorage only works after the app is ready (Linux may not expose a keyring). */
function encryptionAvailable(): boolean {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptForDisk(plain: string): string {
  try {
    return API_KEY_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    console.error('[Prismoo] API key encryption failed, storing it as plain text:', err);
    return plain;
  }
}

function decryptFromDisk(stored: string): string {
  if (!stored.startsWith(API_KEY_PREFIX)) return stored; // legacy plaintext
  if (!encryptionAvailable()) {
    console.warn('[Prismoo] OS secure storage unavailable, cannot decrypt the saved API key');
    return '';
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(API_KEY_PREFIX.length), 'base64'));
  } catch (err) {
    console.error('[Prismoo] API key decryption failed, ignoring the stored key:', err);
    return '';
  }
}

/** Copy with the apiKey field replaced by its encrypted on-disk form. */
function persistedCopy(next: AppConfig): AppConfig {
  if (!next.apiKey || !encryptionAvailable()) return next;
  return { ...next, apiKey: encryptForDisk(next.apiKey) };
}

/** Atomic write: write to a temp file first, then rename over config.json. */
function writeConfigFile(cfg: AppConfig) {
  const target = configPath();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = JSON.stringify(cfg, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    try {
      fs.renameSync(tmp, target);
    } catch {
      // Windows can refuse rename while another handle reads the file; fall back.
      fs.writeFileSync(target, payload, 'utf-8');
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[Prismoo] saving the config failed:', err);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (cache) writeConfigFile(persistedCopy(cache));
  }, CONFIG_SAVE_DELAY_MS);
}

/** Read the configuration (cached; falls back to defaults when the file is missing or corrupt) */
export function loadConfig(): AppConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cache = { ...DEFAULT_CONFIG, ...parsed };
    const storedKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
    if (storedKey) cache.apiKey = decryptFromDisk(storedKey);
  } catch {
    cache = { ...DEFAULT_CONFIG };
  }
  return cache;
}

/**
 * Partially update the configuration and return the latest one. The in-memory
 * value is updated immediately; the disk write is debounced so slider drags /
 * rapid IPC patches never hammer config.json.
 */
export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  cache = next;
  scheduleWrite();
  return next;
}

/** Flush any pending debounced config write immediately (before quit / update). */
export function flushConfigSync() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (cache) writeConfigFile(persistedCopy(cache));
}

/** One-time startup migration: re-encrypt a legacy plaintext API Key in place. */
export function ensureSecretsEncrypted() {
  if (!cache) loadConfig();
  if (!cache || !cache.apiKey || !encryptionAvailable()) return;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Partial<AppConfig>;
    if (typeof raw.apiKey === 'string' && raw.apiKey && !raw.apiKey.startsWith(API_KEY_PREFIX)) {
      saveConfig({}); // triggers a debounced write through persistedCopy (encrypted)
    }
  } catch {
    /* No config on disk yet; nothing to migrate. */
  }
}
