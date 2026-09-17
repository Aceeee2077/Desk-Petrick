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
  void runChecks(code);
});

/** A second launch must hand off to the running instance and exit by itself. */
async function checkSingleInstance() {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const first = spawn(BIN, [], { stdio: 'ignore' });
  try {
    await delay(4000);
    if (first.exitCode !== null) {
      console.error('✗ 单实例检查：第一个实例意外退出');
      return false;
    }
    const second = spawn(BIN, [], { stdio: 'ignore' });
    for (let waited = 0; second.exitCode === null && waited < 6000; waited += 200) {
      await delay(200);
    }
    const secondExited = second.exitCode !== null;
    if (!secondExited) second.kill();
    if (!secondExited) {
      console.error('✗ 单实例检查：第二个实例没有自动退出');
      return false;
    }
    if (first.exitCode !== null) {
      console.error('✗ 单实例检查：第一个实例在第二个启动后消失了');
      return false;
    }
    return true;
  } finally {
    if (first.exitCode === null) first.kill();
    await delay(300);
  }
}

/** The pet must be fully inside a monitor's work area — an off-screen pet is unusable. */
function petInWorkArea(pet) {
  const monitor = pet.monitors?.monitors?.[0];
  const position = pet.windowPosition;
  const size = pet.monitors?.windowSize;
  if (!monitor || !position || !size) return false;
  const [wx, wy, ww, wh] = monitor.work;
  return (
    position[0] >= wx &&
    position[1] >= wy &&
    position[0] + size[0] <= wx + ww &&
    position[1] + size[1] <= wy + wh
  );
}

async function runChecks(code) {
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
    pet.hitTestCorner === false &&
    pet.ipcStillResponsive === true &&
    petInWorkArea(pet);
  const settingsOk =
    settings &&
    settings.hasApi &&
    settings.hasPanel &&
    settings.configRoundTrip &&
    settings.restored &&
    settings.autoLaunchFlag &&
    settings.customResponds &&
    settings.behaviorRoundTrip &&
    settings.behaviorRestored &&
    settings.sliders >= 6 &&
    settings.providerCount >= 1 &&
    settings.providerActive === 'selfcheck' &&
    settings.chatTuning === true &&
    settings.chatTuningRestored === true &&
    settings.providerListMatches === true &&
    settings.configEventDelivered === true &&
    settings.sliderFollowsConfig === true &&
    settings.updateStatus === 'unsupported' &&
    typeof settings.updateVersion === 'string' &&
    settings.updateVersion.length > 0;
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
  if (!(await checkSingleInstance())) {
    process.exit(1);
  }
  console.log('✓ Tauri 版自检通过：宠物渲染、设置读写、聊天会话增删改查全部正常');
  console.log('✓ 单实例检查通过：重复启动会交给已在运行的实例');
  process.exit(code === 0 ? 0 : 1);
}
