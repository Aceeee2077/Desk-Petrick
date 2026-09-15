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
  console.error('✗ 自检超时（30 秒内没有收到报告）');
  child.kill();
  process.exit(1);
}, 30_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('[selfcheck]'));
  if (!line) {
    console.error('✗ 自检没有输出报告');
    console.error(stdout.trim());
    console.error(stderr.trim());
    process.exit(1);
  }
  const report = JSON.parse(line.replace('[selfcheck] ', ''));
  console.log('自检报告:', JSON.stringify(report));
  const ok =
    report.hasApi &&
    report.hasCanvas &&
    report.i18nKeys > 0 &&
    typeof report.skin === 'string' &&
    report.drawnPixels > 0;
  if (!ok) {
    console.error('✗ 自检未通过（见上面的报告）');
    process.exit(1);
  }
  console.log('✓ Tauri 版宠物窗口正常：API 可用、i18n 已注入、宠物已渲染');
  process.exit(code === 0 ? 0 : 1);
});
