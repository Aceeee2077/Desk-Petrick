// ============================================================================
// Petric settings panel logic (standalone script, no imports/exports, loaded by settings.html)
// All changes are persisted in real time via window.api.setConfig and synced to the pet window.
// UI strings are localized through window.PetricI18n (dictionary provided by the main process).
// ============================================================================

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// Affinity row state (kept at module level so locale switches can re-render it)
let affinityDisplayEl: HTMLSpanElement | null = null;
let affinityValue = 0;
// Latest config snapshot for the stats section (re-rendered on locale / theme changes)
let lastStatsCfg: AppConfig | null = null;

/** Hearts + value + localized level name for the affinity row (mirrors the app.ts logic). */
function renderAffinityDisplay() {
  if (!affinityDisplayEl) return;
  const i18n = window.PetricI18n;
  const value = Math.round(Math.max(0, Math.min(100, affinityValue)));
  const mins = [0, 20, 40, 60, 80];
  let idx = 0;
  for (let i = 0; i < mins.length; i++) if (value >= mins[i]) idx = i;
  const filled = '❤️'.repeat(idx + 1);
  const empty = '🤍'.repeat(4 - idx);
  affinityDisplayEl.textContent = filled + empty + ' ' + value + ' · ' + i18n.t(`affinity.level${idx + 1}`);
}

/** Draw the affinity growth curve (line chart of daily affinity snapshots). */
function drawAffinityChart(history: AffinityPoint[]) {
  const canvas = $<HTMLCanvasElement>('affinity-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#a78bfa';
  const dim = cs.getPropertyValue('--text-dim').trim() || '#9a8fc4';

  const padL = 26;
  const padR = 10;
  const padT = 8;
  const padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const yOf = (v: number) => padT + plotH * (1 - Math.max(0, Math.min(100, v)) / 100);

  // Gridlines + scale labels at 0 / 25 / 50 / 75 / 100
  c.strokeStyle = dim;
  c.fillStyle = dim;
  c.lineWidth = 1;
  c.font = '9px Nunito, "Noto Sans SC", "Segoe UI", sans-serif';
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  c.globalAlpha = 0.3;
  for (const g of [0, 25, 50, 75, 100]) {
    const y = yOf(g);
    c.beginPath();
    c.moveTo(padL, y);
    c.lineTo(w - padR, y);
    c.stroke();
    c.globalAlpha = 0.75;
    c.fillText(String(g), padL - 4, y);
    c.globalAlpha = 0.3;
  }
  c.globalAlpha = 1;

  const pts = (history || []).slice(-90);
  if (!pts.length) {
    c.fillStyle = dim;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.globalAlpha = 0.9;
    c.fillText(window.PetricI18n.t('settings.statsEmpty'), w / 2, h / 2);
    return;
  }

  const xs = pts.map((_, i) =>
    pts.length === 1 ? (padL + plotW) / 2 : padL + (plotW * i) / (pts.length - 1),
  );
  const ys = pts.map((p) => yOf(p.value));

  // Growth line
  c.strokeStyle = accent;
  c.lineWidth = 2;
  c.lineJoin = 'round';
  c.beginPath();
  xs.forEach((x, i) => (i === 0 ? c.moveTo(x, ys[i]) : c.lineTo(x, ys[i])));
  c.stroke();

  // Points
  c.fillStyle = accent;
  xs.forEach((x, i) => {
    c.beginPath();
    c.arc(x, ys[i], 2.4, 0, Math.PI * 2);
    c.fill();
  });

  // Latest value + first / last dates
  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  c.fillText(String(pts[pts.length - 1].value), xs[xs.length - 1], ys[ys.length - 1] - 5);
  c.fillStyle = dim;
  c.globalAlpha = 0.85;
  c.font = '9px Nunito, "Noto Sans SC", "Segoe UI", sans-serif';
  c.textBaseline = 'top';
  c.textAlign = 'left';
  c.fillText(pts[0].date, xs[0], padT + plotH + 3);
  c.textAlign = 'right';
  c.fillText(pts[pts.length - 1].date, Math.min(w - padR, xs[xs.length - 1] + 12), padT + plotH + 3);
  c.globalAlpha = 1;
}

/** Render the interaction stats rows + affinity chart from a config snapshot. */
function renderStats(cfg: AppConfig) {
  lastStatsCfg = cfg;
  $<HTMLSpanElement>('stats-days').textContent = String((cfg.statsDays || []).length);
  $<HTMLSpanElement>('stats-first-seen').textContent = cfg.statsFirstSeen || '—';
  $<HTMLSpanElement>('stats-clicks').textContent = String(cfg.statsClicks || 0);
  $<HTMLSpanElement>('stats-chats').textContent = String(cfg.statsChats || 0);
  drawAffinityChart(cfg.affinityHistory || []);
}

/** Apply the current locale to all [data-i18n] / [data-i18n-html] / [data-i18n-title] elements. */
function applyI18n() {
  const i18n = window.PetricI18n;
  document.documentElement.lang = i18n.getLocale() === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n || '';
    el.textContent = i18n.t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    const key = el.dataset.i18nHtml || '';
    el.innerHTML = i18n.t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle || '';
    el.title = i18n.t(key);
  });
  // Focus-interval buttons show localized "N 分钟 / N min" labels
  document.querySelectorAll<HTMLButtonElement>('#focus-interval-seg button').forEach((b) => {
    const n = Number(b.dataset.min || 40);
    b.textContent = i18n.t('settings.focusMinute', { n });
  });
  renderAffinityDisplay();
  if (lastStatsCfg) renderStats(lastStatsCfg); // re-render the chart with the new theme colors
}

async function initSettings() {
  const cfg = await window.api.getConfig();

  // i18n: load the dictionary and apply texts before anything else
  const i18nPayload = await window.api.getI18n();
  window.PetricI18n.setLocaleData(i18nPayload.locale, i18nPayload.dict);
  applyI18n();

  const animSpeedEl = $<HTMLInputElement>('anim-speed');
  const animSpeedVal = $<HTMLSpanElement>('anim-speed-val');
  const opacityEl = $<HTMLInputElement>('opacity');
  const opacityVal = $<HTMLSpanElement>('opacity-val');
  const soundEl = $<HTMLInputElement>('sound');
  const autoLaunchEl = $<HTMLInputElement>('autolaunch');
  const aiEnabledEl = $<HTMLInputElement>('ai-enabled');
  const apiBaseEl = $<HTMLInputElement>('api-base');
  const apiKeyEl = $<HTMLInputElement>('api-key');
  const modelEl = $<HTMLInputElement>('model');
  const statusEl = $<HTMLSpanElement>('ai-status');
  const skinButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#skin-seg button'));
  const localeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#locale-seg button'));
  const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#theme-seg button'));
  const customRows = Array.from(document.querySelectorAll<HTMLElement>('.custom-row'));
  const customModeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#custom-mode-seg button'),
  );
  const customStatusEl = $<HTMLSpanElement>('custom-status');
  const cutoutEl = $<HTMLInputElement>('cutout');
  const cutoutTolEl = $<HTMLInputElement>('cutout-tol');
  const cutoutTolValEl = $<HTMLSpanElement>('cutout-tol-val');
  const cutoutTolRow = cutoutTolEl.closest('.row') as HTMLElement;
  const focusModeEl = $<HTMLInputElement>('focus-mode');
  const focusIntervalButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#focus-interval-seg button'),
  );
  const accessoryButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#accessory-seg button'),
  );
  const accessoryRow = $<HTMLElement>('accessory-row');
  affinityDisplayEl = $<HTMLSpanElement>('affinity-display');

  // Show/hide the custom appearance controls
  const setCustomRows = (show: boolean) => customRows.forEach((el) => (el.hidden = !show));
  // The currently selected appearance type (read from the highlighted button in the UI)
  const selectedCustomMode = (): CustomImageMode =>
    (customModeButtons.find((b) => b.classList.contains('active'))?.dataset.mode as CustomImageMode) ||
    'single';

  // ---------- Populate the form from the current config ----------
  localeButtons.forEach((b) => b.classList.toggle('active', b.dataset.locale === cfg.locale));
  themeButtons.forEach((b) => b.classList.toggle('active', b.dataset.theme === cfg.theme));
  document.documentElement.dataset.theme = cfg.theme;
  skinButtons.forEach((b) => b.classList.toggle('active', b.dataset.skin === cfg.skin));
  customModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === cfg.customImageMode));
  setCustomRows(cfg.skin === 'custom');
  accessoryRow.hidden = cfg.skin !== 'robot';
  cutoutEl.checked = cfg.autoCutout;
  cutoutTolEl.value = String(cfg.cutoutTolerance);
  cutoutTolValEl.textContent = String(cfg.cutoutTolerance);
  cutoutTolRow.hidden = !cfg.autoCutout;
  animSpeedEl.value = String(cfg.animSpeed);
  animSpeedVal.textContent = cfg.animSpeed.toFixed(1) + 'x';
  opacityEl.value = String(cfg.opacity);
  opacityVal.textContent = Math.round(cfg.opacity * 100) + '%';
  soundEl.checked = cfg.soundEnabled;
  autoLaunchEl.checked = cfg.autoLaunch;
  aiEnabledEl.checked = cfg.aiEnabled;
  apiBaseEl.value = cfg.apiBaseUrl;
  apiKeyEl.value = cfg.apiKey;
  modelEl.value = cfg.model;
  focusModeEl.checked = cfg.focusMode;
  focusIntervalButtons.forEach((b) => b.classList.toggle('active', Number(b.dataset.min) === cfg.focusInterval));
  accessoryButtons.forEach((b) => b.classList.toggle('active', b.dataset.accessory === cfg.accessory));
  affinityValue = cfg.affinity;
  renderAffinityDisplay();
  renderStats(cfg);

  // ---------- Event bindings ----------
  // Language switch
  localeButtons.forEach((b) => {
    b.addEventListener('click', async () => {
      localeButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      await window.api.setConfig({ locale: b.dataset.locale as Locale });
      const payload = await window.api.getI18n();
      window.PetricI18n.setLocaleData(payload.locale, payload.dict);
      applyI18n();
    });
  });

  // Theme switch (light = orange-white gradient / dark = original purple tone)
  themeButtons.forEach((b) => {
    b.addEventListener('click', async () => {
      themeButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      // Apply immediately from the returned config (also picked up by the onConfigChanged
      // subscription below, which now receives the broadcast in both windows).
      const cfg = await window.api.setConfig({ theme: b.dataset.theme as Theme });
      document.documentElement.dataset.theme = cfg.theme;
    });
  });

  skinButtons.forEach((b) => {
    b.addEventListener('click', () => {
      skinButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      setCustomRows(b.dataset.skin === 'custom');
      accessoryRow.hidden = b.dataset.skin !== 'robot';
      window.api.setConfig({ skin: b.dataset.skin as PetSkin });
    });
  });

  // Custom appearance: pick / mode / clear
  $('btn-pick-image').addEventListener('click', async () => {
    customStatusEl.classList.remove('err');
    customStatusEl.textContent = window.PetricI18n.t('settings.choosing');
    const r = await window.api.pickCustomImage();
    if (r.ok && r.dataUrl) {
      await window.api.setConfig({
        skin: 'custom',
        customImagePath: r.path || '',
        customImageMode: selectedCustomMode(),
      });
      customStatusEl.textContent = window.PetricI18n.t(
        r.cutoutApplied ? 'settings.cutoutApplied' : 'settings.applied',
      );
    } else {
      customStatusEl.classList.add('err');
      customStatusEl.textContent = r.error || window.PetricI18n.t('settings.cancelled');
      setTimeout(() => {
        customStatusEl.classList.remove('err');
        customStatusEl.textContent = '';
      }, 3000);
    }
  });

  customModeButtons.forEach((b) => {
    b.addEventListener('click', () => {
      customModeButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      window.api.setConfig({ customImageMode: b.dataset.mode as CustomImageMode });
    });
  });

  // Auto cutout: toggle + sensitivity (sensitivity applies on slider release to avoid
  // re-running the cutout on every pixel of the drag)
  cutoutEl.addEventListener('change', () => {
    cutoutTolRow.hidden = !cutoutEl.checked;
    window.api.setConfig({ autoCutout: cutoutEl.checked });
  });
  cutoutTolEl.addEventListener('input', () => {
    cutoutTolValEl.textContent = cutoutTolEl.value;
  });
  cutoutTolEl.addEventListener('change', () => {
    window.api.setConfig({ cutoutTolerance: Number(cutoutTolEl.value) });
  });

  $('btn-clear-custom').addEventListener('click', async () => {
    await window.api.clearCustomImage();
    await window.api.setConfig({ skin: 'cat', customImagePath: '' });
    skinButtons.forEach((x) => x.classList.toggle('active', x.dataset.skin === 'cat'));
    setCustomRows(false);
    accessoryRow.hidden = true;
    customStatusEl.textContent = window.PetricI18n.t('settings.cleared');
  });

  animSpeedEl.addEventListener('input', () => {
    const v = parseFloat(animSpeedEl.value);
    animSpeedVal.textContent = v.toFixed(1) + 'x';
    window.api.setConfig({ animSpeed: v });
  });

  opacityEl.addEventListener('input', () => {
    const v = parseFloat(opacityEl.value);
    opacityVal.textContent = Math.round(v * 100) + '%';
    window.api.setConfig({ opacity: v });
  });

  soundEl.addEventListener('change', () => window.api.setConfig({ soundEnabled: soundEl.checked }));

  autoLaunchEl.addEventListener('change', async () => {
    const ok = await window.api.autoLaunchSet(autoLaunchEl.checked);
    autoLaunchEl.checked = ok;
    window.api.setConfig({ autoLaunch: ok });
  });

  aiEnabledEl.addEventListener('change', () => window.api.setConfig({ aiEnabled: aiEnabledEl.checked }));
  apiBaseEl.addEventListener('change', () => window.api.setConfig({ apiBaseUrl: apiBaseEl.value.trim() }));
  apiKeyEl.addEventListener('change', () => window.api.setConfig({ apiKey: apiKeyEl.value.trim() }));
  modelEl.addEventListener('change', () =>
    window.api.setConfig({ model: modelEl.value.trim() || 'gpt-4o-mini' }),
  );

  // Accessory (procedural pixel accessory for the robot sheet)
  accessoryButtons.forEach((b) => {
    b.addEventListener('click', () => {
      accessoryButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      window.api.setConfig({ accessory: b.dataset.accessory as Accessory });
    });
  });

  // Focus mode: break reminder toggle + interval
  focusModeEl.addEventListener('change', () => window.api.setConfig({ focusMode: focusModeEl.checked }));
  focusIntervalButtons.forEach((b) => {
    b.addEventListener('click', () => {
      focusIntervalButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      window.api.setConfig({ focusInterval: Number(b.dataset.min || 40) });
    });
  });

  // Keep the affinity / focus / theme / stats UI in sync with changes made elsewhere (e.g. by the pet window)
  window.api.onConfigChanged((cfg) => {
    affinityValue = cfg.affinity;
    renderAffinityDisplay();
    focusModeEl.checked = cfg.focusMode;
    focusIntervalButtons.forEach((b) => b.classList.toggle('active', Number(b.dataset.min) === cfg.focusInterval));
    themeButtons.forEach((b) => b.classList.toggle('active', b.dataset.theme === cfg.theme));
    accessoryButtons.forEach((b) => b.classList.toggle('active', b.dataset.accessory === cfg.accessory));
    document.documentElement.dataset.theme = cfg.theme;
    cutoutEl.checked = cfg.autoCutout;
    cutoutTolEl.value = String(cfg.cutoutTolerance);
    cutoutTolValEl.textContent = String(cfg.cutoutTolerance);
    cutoutTolRow.hidden = !cfg.autoCutout;
    renderStats(cfg);
  });

  $('btn-reset').addEventListener('click', () => window.api.resetPosition());
  $('btn-close').addEventListener('click', () => window.close());

  $('btn-test-ai').addEventListener('click', async () => {
    statusEl.classList.remove('err');
    statusEl.textContent = window.PetricI18n.t('settings.requesting');
    try {
      const reply = await window.api.aiChat([
        { role: 'user', content: window.PetricI18n.t('settings.aiTestPrompt') },
      ]);
      statusEl.textContent = reply.length > 60 ? reply.slice(0, 60) + '…' : reply;
    } catch (err) {
      statusEl.classList.add('err');
      statusEl.textContent =
        window.PetricI18n.t('settings.failed') + (err instanceof Error ? err.message : String(err));
    }
  });
}

initSettings();
