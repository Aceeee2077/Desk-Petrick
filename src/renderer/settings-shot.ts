// ============================================================================
// Petric settings panel screenshot compositing (used only in --screenshot mode)
// Reproduces the settings panel look with canvas (DOM capture is unreliable in this session), then prints
// SETTINGS_SHOT_READY; the main process reads pixels with getImageData and encodes a PNG.
// Colors mirror the LIGHT theme (orange-white gradient, the default); layout mirrors the
// wide (880x680) two-column settings window.
// ============================================================================

const settingsShotCanvas = document.getElementById('settings-shot-canvas') as HTMLCanvasElement;
const sc = settingsShotCanvas.getContext('2d')!;

const W = 880;
const H = 680;
const COL_RIGHT = 478; // right column content x offset
const ROW_LABEL_WIDTH = 108;
const LEFT_LONG_CONTROL_X = 150;

function rrect(x: number, y: number, w: number, h: number, r: number) {
  sc.beginPath();
  sc.roundRect(x, y, w, h, r);
}

function text(txt: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = 'left') {
  sc.font = `${weight} ${size}px Nunito, "Noto Sans SC", "Segoe UI", sans-serif`;
  sc.fillStyle = color;
  sc.textAlign = align;
  sc.textBaseline = 'middle';
  sc.fillText(txt, x, y);
}

function textWithin(txt: string, x: number, y: number, maxWidth: number, size: number, color: string, weight = 400) {
  sc.font = `${weight} ${size}px Nunito, "Noto Sans SC", "Segoe UI", sans-serif`;
  if (sc.measureText(txt).width <= maxWidth) {
    text(txt, x, y, size, color, weight);
    return;
  }

  const chars = Array.from(txt);
  while (chars.length && sc.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
  text(`${chars.join('')}…`, x, y, size, color, weight);
}

function rowLabel(txt: string, y: number, x = 18) {
  text(txt, x, y, 13, '#6b4220');
}

function segButtons(x: number, y: number, items: string[], activeIdx: number) {
  let cx = x;
  items.forEach((label, i) => {
    const w = sc.measureText(label).width + 22;
    const active = i === activeIdx;
    sc.fillStyle = active ? '#f97316' : 'rgba(249,115,22,0.08)';
    rrect(cx, y, w, 30, 10);
    sc.fill();
    if (active) {
      sc.strokeStyle = '#f97316';
      sc.lineWidth = 1;
      sc.stroke();
    }
    text(label, cx + w / 2, y + 15, 12, active ? '#ffffff' : '#7a4318', 400, 'center');
    cx += w + 6;
  });
}

function switch_(x: number, y: number, on: boolean) {
  sc.fillStyle = on ? '#f97316' : 'rgba(249,115,22,0.32)';
  rrect(x, y, 40, 22, 11);
  sc.fill();
  sc.fillStyle = '#ffffff';
  sc.beginPath();
  sc.arc(on ? x + 30 : x + 11, y + 11, 8, 0, Math.PI * 2);
  sc.fill();
}

function slider(x: number, y: number, width: number, fill: number) {
  sc.fillStyle = 'rgba(249,115,22,0.32)';
  rrect(x, y, width, 5, 2.5);
  sc.fill();
  sc.fillStyle = '#f97316';
  rrect(x, y, width * fill, 5, 2.5);
  sc.fill();
  sc.fillStyle = '#ffffff';
  sc.beginPath();
  sc.arc(x + width * fill, y + 2.5, 7, 0, Math.PI * 2);
  sc.fill();
}

function inputBox(x: number, y: number, width: number, value: string, color = '#4a2c14') {
  sc.fillStyle = 'rgba(249,115,22,0.07)';
  rrect(x, y, width, 30, 10);
  sc.fill();
  sc.strokeStyle = 'rgba(249,115,22,0.3)';
  sc.lineWidth = 1;
  sc.stroke();
  text(value, x + 10, y + 15, 12.5, color);
}

function ghostButton(x: number, y: number, width: number, label: string) {
  sc.fillStyle = 'rgba(249,115,22,0.08)';
  rrect(x, y, width, 30, 10);
  sc.fill();
  sc.strokeStyle = 'rgba(249,115,22,0.3)';
  sc.lineWidth = 1;
  sc.stroke();
  text(label, x + width / 2, y + 15, 12.5, '#4a2c14', 400, 'center');
}

function sectionTitle(txt: string, y: number, x = 18) {
  text(txt, x, y, 12, '#c2410c', 800);
}

// ============ Drawing (locale-driven; driven by the main process via window.__drawSettingsShot) ============
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsShotWindow = window as any;

settingsShotWindow.__drawSettingsShot = (locale: Locale, dict: Record<string, I18nValue>) => {
  const T = (k: string): string => {
    const v = dict[k];
    return typeof v === 'string' ? v.replace(/<br\s*\/?>/gi, '  ') : k;
  };

  // Card background (light orange-white gradient)
  const panelGradient = sc.createLinearGradient(0, 0, 0, H);
  panelGradient.addColorStop(0, '#fffaf4');
  panelGradient.addColorStop(1, '#ffecd8');
  sc.fillStyle = panelGradient;
  rrect(0, 0, W, H, 18);
  sc.fill();
  sc.strokeStyle = 'rgba(249,115,22,0.28)';
  sc.lineWidth = 1;
  sc.stroke();

  // Header
  text('🐾 Petric Settings', 18, 32, 15, '#4a2c14', 800);
  text('✕', W - 24, 32, 14, '#b45309', 400, 'center');

  // ---------- Left column: language / theme, pet, focus mode ----------
  sectionTitle(T('settings.language'), 66);
  rowLabel(T('settings.language'), 94);
  segButtons(108, 82, ['中文', 'English'], 0);
  rowLabel(T('settings.theme'), 128);
  segButtons(108, 116, [T('settings.themeLight'), T('settings.themeDark')], 0);

  sectionTitle(T('settings.petSection'), 176);
  rowLabel(T('settings.skin'), 204);
  segButtons(
    108,
    192,
    [
      T('settings.skinCat'),
      T('settings.skinDog'),
      T('settings.skinDango'),
      T('settings.skinBulu'),
      T('settings.skinRobot'),
    ],
    0,
  );
  rowLabel(T('affinity.title'), 244);
  text('❤️❤️❤️ 77 · ' + T('affinity.level4'), 200, 244, 13, '#f97316', 700);
  rowLabel(T('settings.accessory'), 282);
  segButtons(
    108,
    270,
    [T('settings.accessoryNone'), T('settings.accessoryHat'), T('settings.accessoryScarf'), T('settings.accessoryGlasses')],
    1,
  );
  rowLabel(T('settings.animSpeed') + ' 1.0x', 322);
  slider(LEFT_LONG_CONTROL_X, 321, 198, 0.6);
  rowLabel(T('settings.opacity') + ' 100%', 358);
  slider(LEFT_LONG_CONTROL_X, 357, 198, 1);
  rowLabel(T('settings.sound'), 394);
  switch_(392, 383, true);
  rowLabel(T('settings.autolaunch'), 430);
  switch_(392, 419, false);
  ghostButton(108, 452, 120, T('settings.resetPos'));

  sectionTitle(T('settings.focusSection'), 500);
  rowLabel(T('settings.focusMode'), 528);
  switch_(392, 517, true);
  rowLabel(T('settings.focusInterval'), 564);
  segButtons(LEFT_LONG_CONTROL_X, 552, ['20', '30', '40', '60', '90'], 2);
  textWithin(T('settings.focusHint').split(/[。.]/)[0], 18, 606, COL_RIGHT - 36, 11, '#a1623a');

  // ---------- Right column: stats, AI chat ----------
  const RX = COL_RIGHT; // content start
  sectionTitle(T('settings.statsSection'), 66, RX);
  rowLabel(T('settings.statsDays'), 94, RX);
  text('6', RX + 130, 94, 13, '#f97316', 700);
  rowLabel(T('settings.statsFirstSeen'), 128, RX);
  text('2026-08-28', RX + 130, 128, 12.5, '#6b4220');
  rowLabel(T('settings.statsClicks'), 162, RX);
  text('128', RX + 130, 162, 13, '#f97316', 700);
  rowLabel(T('settings.statsChats'), 196, RX);
  text('24', RX + 130, 196, 13, '#f97316', 700);
  text(T('settings.statsAffinityChart'), RX, 226, 11, '#a1623a');

  // Affinity growth chart (fake polyline)
  const cx0 = RX;
  const cy0 = 240;
  const cw = W - RX - 18;
  const chh = 110;
  sc.fillStyle = 'rgba(249,115,22,0.07)';
  rrect(cx0, cy0, cw, chh, 10);
  sc.fill();
  sc.strokeStyle = 'rgba(249,115,22,0.3)';
  sc.lineWidth = 1;
  sc.stroke();
  sc.strokeStyle = 'rgba(163,98,58,0.25)';
  for (let g = 0; g <= 4; g++) {
    sc.beginPath();
    sc.moveTo(cx0 + 6, cy0 + 8 + (chh - 24) * (g / 4));
    sc.lineTo(cx0 + cw - 6, cy0 + 8 + (chh - 24) * (g / 4));
    sc.stroke();
  }
  const pts: [number, number][] = [
    [0.1, 0.3],
    [0.3, 0.45],
    [0.5, 0.62],
    [0.7, 0.78],
    [0.9, 0.95],
  ];
  sc.strokeStyle = '#f97316';
  sc.lineWidth = 2;
  sc.beginPath();
  pts.forEach(([fx, fy], i) => {
    const x = cx0 + 10 + fx * (cw - 20);
    const y = cy0 + 14 + (1 - fy) * (chh - 28);
    if (i === 0) sc.moveTo(x, y);
    else sc.lineTo(x, y);
  });
  sc.stroke();
  sc.fillStyle = '#f97316';
  pts.forEach(([fx, fy]) => {
    const x = cx0 + 10 + fx * (cw - 20);
    const y = cy0 + 14 + (1 - fy) * (chh - 28);
    sc.beginPath();
    sc.arc(x, y, 2.6, 0, Math.PI * 2);
    sc.fill();
  });

  sectionTitle(T('settings.aiSection') + ' ' + T('settings.optional'), 396, RX);
  rowLabel(T('settings.aiEnabled'), 424, RX);
  switch_(RX + 344, 413, true);
  rowLabel(T('settings.apiBase'), 460, RX);
  inputBox(RX + ROW_LABEL_WIDTH, 449, W - RX - ROW_LABEL_WIDTH - 18, 'https://api.deepseek.com');
  rowLabel(T('settings.apiKey'), 496, RX);
  inputBox(RX + ROW_LABEL_WIDTH, 485, W - RX - ROW_LABEL_WIDTH - 18, '••••••••••••••••••');
  rowLabel(T('settings.model'), 532, RX);
  inputBox(RX + ROW_LABEL_WIDTH, 521, W - RX - ROW_LABEL_WIDTH - 18, 'deepseek-chat');
  ghostButton(RX, 556, 110, T('settings.testAi'));
  text(T('settings.apiOk'), RX + 116, 571, 11.5, '#15803d');
  textWithin(T('settings.aiHint').split(/[。.]/)[0], RX, 614, W - RX - 18, 11, '#a1623a');

  console.log('SETTINGS_SHOT_READY');
};
