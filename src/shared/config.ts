// ============================================================================
// Configuration management (used by the main process)
// Persisted via userData/config.json, with zero runtime dependencies (a
// lightweight replacement for electron-store). All configuration and chat
// history stay on this machine; nothing is uploaded.
// ============================================================================

import { app } from 'electron';
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
  soundEnabled: true,
  customImageMode: 'single',
  customImagePath: '',
  locale: 'zh',
};

let cache: AppConfig | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Read the configuration (cached; falls back to defaults when the file is missing or corrupt) */
export function loadConfig(): AppConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cache = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    cache = { ...DEFAULT_CONFIG };
  }
  return cache;
}

/** Partially update the configuration, persist it, and return the latest one */
export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Petric] 保存配置失败:', err);
  }
  return next;
}
