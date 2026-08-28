// ============================================================================
// Petric settings panel screenshot compositing (used only in --screenshot mode)
// Reproduces the settings panel look with canvas (DOM capture is unreliable in this session), then prints
// SETTINGS_SHOT_READY; the main process reads pixels with getImageData and encodes a PNG.
// ============================================================================

const settingsShotCanvas = document.getElementById('settings-shot-canvas') as HTMLCanvasElement;
const sc = settingsShotCanvas.getContext('2d')!;

const W = 440;
const H = 640;

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

function rowLabel(txt: string, y: number) {
  text(txt, 18, y, 13, '#e6e0f5');
}

function segButtons(x: number, y: number, items: string[], activeIdx: number) {
  let cx = x;
  items.forEach((label, i) => {
    const w = sc.measureText(label).width + 22;
    const active = i === activeIdx;
    sc.fillStyle = active ? '#a78bfa' : 'rgba(255,255,255,0.08)';
    rrect(cx, y, w, 30, 10);
    sc.fill();
    if (active) {
      sc.strokeStyle = '#a78bfa';
      sc.lineWidth = 1;
      sc.stroke();
    }
    text(label, cx + w / 2, y + 15, 12, active ? '#ffffff' : '#d9d2ef', 400, 'center');
    cx += w + 6;
  });
}

function switch_(x: number, y: number, on: boolean) {
  sc.fillStyle = on ? '#a78bfa' : 'rgba(255,255,255,0.16)';
  rrect(x, y, 40, 22, 11);
  sc.fill();
  sc.fillStyle = '#ffffff';
  sc.beginPath();
  sc.arc(on ? x + 30 : x + 11, y + 11, 8, 0, Math.PI * 2);
  sc.fill();
}

function slider(x: number, y: number, width: number, fill: number) {
  sc.fillStyle = 'rgba(255,255,255,0.16)';
  rrect(x, y, width, 5, 2.5);
  sc.fill();
  sc.fillStyle = '#a78bfa';
  rrect(x, y, width * fill, 5, 2.5);
  sc.fill();
  sc.fillStyle = '#ffffff';
  sc.beginPath();
  sc.arc(x + width * fill, y + 2.5, 7, 0, Math.PI * 2);
  sc.fill();
}

function inputBox(x: number, y: number, width: number, value: string, color = '#e8e4f5') {
  sc.fillStyle = 'rgba(255,255,255,0.08)';
  rrect(x, y, width, 30, 10);
  sc.fill();
  sc.strokeStyle = 'rgba(255,255,255,0.14)';
  sc.lineWidth = 1;
  sc.stroke();
  text(value, x + 10, y + 15, 12.5, color);
}

function ghostButton(x: number, y: number, width: number, label: string) {
  sc.fillStyle = 'rgba(255,255,255,0.08)';
  rrect(x, y, width, 30, 10);
  sc.fill();
  sc.strokeStyle = 'rgba(255,255,255,0.14)';
  sc.lineWidth = 1;
  sc.stroke();
  text(label, x + width / 2, y + 15, 12.5, '#ece7f7', 400, 'center');
}

function sectionTitle(txt: string, y: number) {
  text(txt, 18, y, 12, '#c8bdf0', 800);
}

// ============ Drawing (locale-driven; driven by the main process via window.__drawSettingsShot) ============
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsShotWindow = window as any;

settingsShotWindow.__drawSettingsShot = (locale: Locale, dict: Record<string, I18nValue>) => {
  const T = (k: string): string => {
    const v = dict[k];
    return typeof v === 'string' ? v.replace(/<br\s*\/?>/gi, '  ') : k;
  };

  // Card background
  const panelGradient = sc.createLinearGradient(0, 0, 0, H);
  panelGradient.addColorStop(0, '#28223c');
  panelGradient.addColorStop(1, '#1c182c');
  sc.fillStyle = panelGradient;
  rrect(0, 0, W, H, 18);
  sc.fill();
  sc.strokeStyle = 'rgba(255,255,255,0.12)';
  sc.lineWidth = 1;
  sc.stroke();

  // Header
  text('🐾 Petric Settings', 18, 32, 15, '#ece7f7', 800);
  text('✕', W - 24, 32, 14, '#b9aee0', 400, 'center');

  // Pet
  sectionTitle(T('settings.petSection'), 72);
  rowLabel(T('settings.skin'), 100);
  segButtons(
    108,
    88,
    [T('settings.skinCat'), T('settings.skinDog'), T('settings.skinDango'), T('settings.skinCustom')],
    0,
  );

  rowLabel(T('settings.animSpeed') + ' 1.0x', 140);
  slider(108, 139, 240, 0.6);
  rowLabel(T('settings.opacity') + ' 100%', 176);
  slider(108, 175, 240, 1);
  rowLabel(T('settings.sound'), 212);
  switch_(392, 201, true);
  rowLabel(T('settings.autolaunch'), 248);
  switch_(392, 237, false);
  ghostButton(108, 262, 120, T('settings.resetPos'));

  // AI chat
  sectionTitle(T('settings.aiSection') + ' ' + T('settings.optional'), 322);
  rowLabel(T('settings.aiEnabled'), 350);
  switch_(392, 339, true);
  rowLabel(T('settings.apiBase'), 386);
  inputBox(108, 375, 284, 'https://api.deepseek.com');
  rowLabel(T('settings.apiKey'), 422);
  inputBox(108, 411, 284, '••••••••••••••••••');
  rowLabel(T('settings.model'), 458);
  inputBox(108, 447, 284, 'deepseek-chat');
  ghostButton(108, 486, 110, T('settings.testAi'));
  text(T('settings.apiOk'), 224, 501, 11.5, '#9ef0c0');
  // Draw only the first sentence of the hint (canvas text does not wrap)
  const hint = T('settings.aiHint').split(/[。.]/)[0];
  text(hint, 18, 560, 11, '#9a8fc4');

  console.log('SETTINGS_SHOT_READY');
};
