// ============================================================================
// Renderer i18n (standalone script, no imports/exports — loaded via <script>
// before app.js / settings.js). The main process provides the active locale +
// dictionary through window.api.getI18n(); callers then use window.PetricI18n.
// ============================================================================

const PetricI18nImpl: PetricI18n = (() => {
  let locale: Locale = 'zh';
  let dict: Record<string, I18nValue> = {};

  function t(key: string, params?: Record<string, string | number>): string {
    const v = dict[key];
    if (typeof v === 'string' && params) {
      return v.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
    }
    return typeof v === 'string' ? v : key;
  }

  function tArray(key: string): string[] {
    const v = dict[key];
    return Array.isArray(v) ? v.map(String) : [key];
  }

  function setLocaleData(nextLocale: Locale, nextDict: Record<string, I18nValue>) {
    locale = nextLocale;
    dict = nextDict || {};
  }

  function getLocale(): Locale {
    return locale;
  }

  return { t, tArray, setLocaleData, getLocale };
})();

// Single prefixed global used by app.ts / settings.ts
(window as unknown as { PetricI18n: PetricI18n }).PetricI18n = PetricI18nImpl;
