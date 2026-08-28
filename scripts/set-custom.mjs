#!/usr/bin/env node
// ============================================================================
// CLI for setting a custom appearance (dev convenience tool, equivalent to the
// "Choose File" option in the app)
//
// Usage:
//   node scripts/set-custom.mjs <file path> [--mode single|sheet|model]
//   node scripts/set-custom.mjs --clear          # clear the custom appearance and restore the default cat
//
// Features:
//   1) Copy the file into the app data directory userData/petric-custom/custom.<ext>
//      (works for both packaged and dev builds)
//   2) Copy a copy to src/assets/sprites/custom.<ext> (repo copy for direct dev use)
//   3) Write userData/config.json and set skin to custom
//
// Notes:
//   - Images: .png/.jpg/.jpeg/.webp/.gif (modes: single/sheet)
//   - 3D models: .glb (mode: model; other modes are ignored for .glb)
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.glb'];
const MODES = ['single', 'sheet', 'model', 'billboard'];

function userDataDir() {
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', 'petric');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || '', 'petric');
  }
  return join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'petric');
}

function readConfig(cfgPath) {
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);

// ---------- Clear ----------
if (args.includes('--clear')) {
  const dir = join(userDataDir(), 'petric-custom');
  for (const ext of ALLOWED) {
    const p = join(dir, 'custom' + ext);
    if (existsSync(p)) {
      unlinkSync(p);
      console.log('✓ 已删除', p);
    }
  }
  const cfgPath = join(userDataDir(), 'config.json');
  if (existsSync(cfgPath)) {
    const cfg = readConfig(cfgPath);
    cfg.skin = 'cat';
    cfg.customImagePath = '';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('✓ 已重置皮肤为 cat（config.json）');
  } else {
    console.log('（没有 config.json，无需重置）');
  }
  process.exit(0);
}

// ---------- Set ----------
const src = args[0];
const modeIdx = args.indexOf('--mode');
const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'single';

if (!src) {
  console.error('用法: node scripts/set-custom.mjs <文件路径> [--mode single|sheet|model]');
  console.error('      node scripts/set-custom.mjs --clear');
  process.exit(1);
}
if (!existsSync(src) || !statSync(src).isFile()) {
  console.error('文件不存在:', src);
  process.exit(1);
}
const ext = extname(src).toLowerCase();
if (!ALLOWED.includes(ext)) {
  console.error('不支持的格式:', ext, '（支持', ALLOWED.join(' / '), '）');
  process.exit(1);
}
// A .glb file is always a 3D model; images default to 'single'
const finalMode = ext === '.glb' ? 'model' : mode;
if (!MODES.includes(finalMode)) {
  console.error('--mode 只能是 single / sheet / model');
  process.exit(1);
}

// 1) App data directory (primary location, also works after packaging)
const customDir = join(userDataDir(), 'petric-custom');
mkdirSync(customDir, { recursive: true });
const dst = join(customDir, 'custom' + ext);
copyFileSync(src, dst);
console.log('✓ 已复制到', dst);

// 2) Repo copy (directly usable in dev scenarios)
const devDst = join(ROOT, 'src', 'assets', 'sprites', 'custom' + ext);
mkdirSync(dirname(devDst), { recursive: true });
copyFileSync(src, devDst);
console.log('✓ 已复制到', devDst);

// 3) Write the config to enable the custom appearance
const cfgPath = join(userDataDir(), 'config.json');
const cfg = readConfig(cfgPath);
cfg.skin = 'custom';
cfg.customImageMode = finalMode;
cfg.customImagePath = dst;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log('✓ 已启用自定义外观（', mode === 'sheet' ? '精灵表' : '单张图片', '）');
console.log('  启动应用即可看到效果；如需还原请运行 node scripts/set-custom.mjs --clear');
