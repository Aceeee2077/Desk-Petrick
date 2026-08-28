// Verify that only comments changed: strips comments from HEAD vs working tree and compares code tokens.
// Usage: node scripts/verify-comments.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// State machine that strips comments: handles // and /* */, skipping '...' "..." `...` strings
function stripJsComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += c; i++; continue; }
      if (c === '"') { mode = 'dq'; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
      i++;
    } else if (mode === 'sq') {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") mode = 'code';
      i++;
    } else if (mode === 'dq') {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') mode = 'code';
      i++;
    } else if (mode === 'tpl') {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') mode = 'code';
      i++;
    }
  }
  return out;
}

// CSS / HTML: strip /* */ and <!-- -->
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
}

function classify(file) {
  if (/\.(ts|mjs|js)$/.test(file)) return 'js';
  if (/\.(css|html)$/.test(file)) return 'css';
  return 'other';
}

const changed = execFileSync('git', ['diff', '--name-only'], { cwd: ROOT, encoding: 'utf-8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

let allOk = true;
for (const file of changed) {
  const kind = classify(file);
  if (kind === 'other') continue;
  const head = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf-8' });
  const work = readFileSync(join(ROOT, file), 'utf-8');
  const a = kind === 'js' ? stripJsComments(head) : stripCssComments(head);
  const b = kind === 'js' ? stripJsComments(work) : stripCssComments(work);
  // Ignore all whitespace (including line-count differences from comment rewrapping); compare code tokens only
  const norm = (s) => s.replace(/\s+/g, '');
  if (norm(a) === norm(b)) {
    console.log(`✓ ${file} 代码 token 一致（仅注释/空白变化）`);
  } else {
    allOk = false;
    console.log(`✗ ${file} 代码 token 不一致！`);
    let idx = 0;
    const na = norm(a);
    const nb = norm(b);
    while (idx < na.length && idx < nb.length && na[idx] === nb[idx]) idx++;
    console.log(`  差异位置 ${idx}: HEAD=…${na.slice(Math.max(0, idx - 40), idx + 60)}…`);
    console.log(`              WORK=…${nb.slice(Math.max(0, idx - 40), idx + 60)}…`);
  }
}
console.log(allOk ? '\n全部通过：只有注释被修改' : '\n存在代码改动，需要修复！');
process.exit(allOk ? 0 : 1);
