// ============================================================================
// Petric settings panel logic (standalone script, no imports/exports, loaded by settings.html)
// All changes are persisted in real time via window.api.setConfig and synced to the pet window.
// UI strings are localized through window.PetricI18n (dictionary provided by the main process).
// ============================================================================

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
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
  const customRows = Array.from(document.querySelectorAll<HTMLElement>('.custom-row'));
  const customModeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#custom-mode-seg button'),
  );
  const customStatusEl = $<HTMLSpanElement>('custom-status');

  // Show/hide the custom appearance controls
  const setCustomRows = (show: boolean) => customRows.forEach((el) => (el.hidden = !show));
  // The currently selected appearance type (read from the highlighted button in the UI)
  const selectedCustomMode = (): CustomImageMode =>
    (customModeButtons.find((b) => b.classList.contains('active'))?.dataset.mode as CustomImageMode) ||
    'single';

  // ---------- Populate the form from the current config ----------
  localeButtons.forEach((b) => b.classList.toggle('active', b.dataset.locale === cfg.locale));
  skinButtons.forEach((b) => b.classList.toggle('active', b.dataset.skin === cfg.skin));
  customModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === cfg.customImageMode));
  setCustomRows(cfg.skin === 'custom');
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

  skinButtons.forEach((b) => {
    b.addEventListener('click', () => {
      skinButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      setCustomRows(b.dataset.skin === 'custom');
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
      customStatusEl.textContent = window.PetricI18n.t('settings.applied');
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

  $('btn-clear-custom').addEventListener('click', async () => {
    await window.api.clearCustomImage();
    await window.api.setConfig({ skin: 'cat', customImagePath: '' });
    skinButtons.forEach((x) => x.classList.toggle('active', x.dataset.skin === 'cat'));
    setCustomRows(false);
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
