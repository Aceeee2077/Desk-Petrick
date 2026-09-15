// ============================================================================
// Tauri self-check runner: launches the debug binary with PRISMOO_SELFCHECK=1,
// waits for the pet window to render and report back, then exits.
//
// The binary prints a single "[selfcheck] {json}" line; this script turns that
// into a pass/fail exit code so it can run in CI.
// ============================================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'src-tauri', 'target', 'debug', 'prismoo.exe');

if (!existsSync(BIN)) {
  console.error(`✗ 未找到 ${BIN}，请先运行 npm run tauri:build`);
  process.exit(1);
}

const child = spawn(BIN, [], {
  env: { ...process.env, PRISMOO_SELFCHECK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const timer = setTimeout(() => {
  console.error('✗ 自检超时（90 秒内没有完成三阶段检查）');
  child.kill();
  process.exit(1);
}, 90_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('[selfcheck]'));
  if (!lines.length) {
    console.error('✗ 自检没有输出报告');
    console.error(stdout.trim());
    console.error(stderr.trim());
    process.exit(1);
  }
  const reports = lines.map((l) => JSON.parse(l.replace('[selfcheck] ', '')));
  for (const report of reports) console.log(`自检报告[${report.window}]:`, JSON.stringify(report));

  const pet = reports.find((r) => r.window === 'pet');
  const settings = reports.find((r) => r.window === 'settings');
  const chat = reports.find((r) => r.window === 'chat');

  const petOk =
    pet &&
    pet.hasApi &&
    pet.hasCanvas &&
    pet.i18nKeys > 0 &&
    typeof pet.skin === 'string' &&
    pet.drawnPixels > 0 &&
    pet.hitTestOverPet === true &&
    pet.hitTestCorner === false;
  const settingsOk = settings && settings.hasApi && settings.hasPanel && settings.configRoundTrip;
  const chatOk =
    chat &&
    chat.hasApi &&
    chat.hasList &&
    chat.created &&
    chat.renamed &&
    chat.archived &&
    chat.deleted &&
    chat.countRestored;

  if (!petOk) {
    console.error('✗ 宠物窗口自检未通过');
    process.exit(1);
  }
  if (!settingsOk) {
    console.error('✗ 设置窗口自检未通过');
    process.exit(1);
  }
  if (!chatOk) {
    console.error('✗ 聊天窗口自检未通过');
    process.exit(1);
  }
  console.log('✓ Tauri 版自检通过：宠物渲染、设置读写、聊天会话增删改查全部正常');
  process.exit(code === 0 ? 0 : 1);
});
