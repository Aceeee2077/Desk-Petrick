// ============================================================================
// Petric pet screenshot compositing (used only in --screenshot mode)
// Draws a "fake desktop + real pet sprite + speech bubble" on an 800x500 canvas.
// The main process drives it: window.__drawPetShot(locale, dict) is called after
// the page loads, then the page logs SCREENSHOT_READY and the main process reads
// the canvas pixels. Text comes from the i18n dictionary (single source).
// ============================================================================

const shotCanvas = document.getElementById('shot-canvas') as HTMLCanvasElement;
const sctx = shotCanvas.getContext('2d')!;

// ---------- Fake desktop background ----------
function drawFakeWindow(x: number, y: number, w: number, h: number, title: string) {
  sctx.fillStyle = 'rgba(33, 43, 61, 0.92)';
  sctx.beginPath();
  sctx.roundRect(x, y, w, h, 10);
  sctx.fill();
  sctx.strokeStyle = 'rgba(255,255,255,0.12)';
  sctx.lineWidth = 1;
  sctx.stroke();
  // Title bar
  sctx.fillStyle = 'rgba(255,255,255,0.08)';
  sctx.fillRect(x + 1, y + 1, w - 2, 26);
  sctx.fillStyle = 'rgba(255,255,255,0.55)';
  sctx.font = '12px "Segoe UI", "Noto Sans SC", sans-serif';
  sctx.fillText(title, x + 12, y + 18);
  // Fake content lines
  sctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 5; i++) {
    sctx.fillRect(x + 14, y + 42 + i * 16, w - 40 - (i % 3) * 24, 7);
  }
}

// ---------- Pet eyes (same frame-coordinate math as app.ts) ----------
function drawEye(x: number, y: number) {
  sctx.fillStyle = '#2f2a26';
  sctx.beginPath();
  sctx.arc(x, y, 2.6, 0, Math.PI * 2);
  sctx.fill();
  sctx.fillStyle = 'rgba(255,255,255,0.9)';
  sctx.beginPath();
  sctx.arc(x - 1, y - 1, 0.9, 0, Math.PI * 2);
  sctx.fill();
}

// ---------- Text bubble ----------
function drawBubble(text: string, bx: number, by: number) {
  sctx.font = '13px Nunito, "Noto Sans SC", "Segoe UI", sans-serif';
  const w = sctx.measureText(text).width + 24;
  sctx.fillStyle = 'rgba(255,255,255,0.97)';
  sctx.beginPath();
  sctx.roundRect(bx - w / 2, by - 30, w, 34, 14);
  sctx.fill();
  sctx.strokeStyle = '#e3d9d2';
  sctx.lineWidth = 1.5;
  sctx.stroke();
  // Little tail pointing at the pet
  sctx.beginPath();
  sctx.moveTo(bx - 7, by);
  sctx.lineTo(bx + 7, by);
  sctx.lineTo(bx, by + 9);
  sctx.closePath();
  sctx.fill();
  sctx.fillStyle = '#4a3f3a';
  sctx.textAlign = 'center';
  sctx.fillText(text, bx, by - 8);
}

// ---------- Main compositing flow (locale-driven) ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shotWindow = window as any;

shotWindow.__drawPetShot = (locale: Locale, dict: Record<string, I18nValue>) => {
  const T = (k: string): string => {
    const v = dict[k];
    return typeof v === 'string' ? v : k;
  };

  // Gradient desktop
  const g = sctx.createLinearGradient(0, 0, 0, 500);
  g.addColorStop(0, '#44577a');
  g.addColorStop(0.6, '#2b3852');
  g.addColorStop(1, '#1b2330');
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, 800, 500);

  // Fake "windows" and taskbar
  drawFakeWindow(50, 36, 340, 210, 'Code · main.ts');
  drawFakeWindow(430, 84, 300, 180, T('shot.browser'));
  drawFakeWindow(60, 280, 260, 140, T('shot.terminal'));
  sctx.fillStyle = 'rgba(14, 18, 28, 0.92)';
  sctx.fillRect(0, 458, 800, 42);
  for (let i = 0; i < 4; i++) {
    sctx.fillStyle = 'rgba(255,255,255,0.18)';
    sctx.beginPath();
    sctx.roundRect(24 + i * 44, 468, 32, 22, 6);
    sctx.fill();
  }

  // Pet (bottom-center, 32x32 frame x 3 = 96x96)
  const petX = 400 - 48;
  const petY = 458 - 96 - 6;

  const img = new Image();
  img.src = '../assets/sprites/cat.png';
  img.onload = () => {
    // Shadow under the feet
    sctx.fillStyle = 'rgba(0,0,0,0.28)';
    sctx.beginPath();
    sctx.ellipse(400, 456, 40, 7, 0, 0, Math.PI * 2);
    sctx.fill();
    // idle frame 0 (real sprite)
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(img, 0, 0, 32, 32, petX, petY, 96, 96);
    // Eyes
    drawEye(petX + 11.5 * 3, petY + 13.2 * 3);
    drawEye(petX + 20.5 * 3, petY + 13.2 * 3);
    // Bubble (localized)
    drawBubble(T('bubble.greeting'), 400, petY + 2);
    console.log('SCREENSHOT_READY');
  };
  img.onerror = () => {
    console.log('SCREENSHOT_IMG_FAIL');
  };
};
