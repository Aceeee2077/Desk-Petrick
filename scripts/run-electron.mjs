#!/usr/bin/env node
// ============================================================================
// Electron launcher wrapper
// Solves two environment issues:
//   1) The Windows PowerShell execution policy blocks npm.ps1 —— all scripts in
//      this project use `node scripts/run-electron.mjs` instead of the
//      `electron` command, with no dependency on .ps1.
//   2) The host environment may inject ELECTRON_RUN_AS_NODE=1, which makes
//      electron.exe degrade to plain Node mode (require('electron') returns a
//      path string instead of the API). This variable is cleared before launch.
// Runs with stdio inherited so console logs and exit codes pass through
// correctly.
// ============================================================================

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const args = process.argv.slice(2); // e.g. . or . --smoke

// Clear the variable that could make Electron run in plain Node mode
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, args, { stdio: 'inherit', env: process.env });

child.on('error', (err) => {
  console.error('[Petric] 无法启动 Electron:', err.message);
  console.error('[Petric] 请确认已执行 npm install，且 node_modules/electron/dist/electron.exe 存在。');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error('[Petric] Electron 被信号终止:', signal);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
