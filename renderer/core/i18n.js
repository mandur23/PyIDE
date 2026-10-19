// UI text is written in English in the source and translated by looking that text up (gettext style):
// tr('Find in Files') or tr('Run {name}', {name}). Dictionaries are each plugin's locales/<lang>.json, merged by
// the main process. The language is fixed for the session; changing it restarts the IDE, as in PyCharm.
(() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('pyide.settings')) || {}; } catch {}
  const pref = saved['appearance.language'] || 'system';
  const systemLocale = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const locale = pref === 'system' ? systemLocale : pref;
  const dict = locale === 'en' ? {} : api.localeSync(locale);
  const missing = new Set();

  window.tr = (text, vars) => {
    let s = text;
    if (locale !== 'en') {
      if (text in dict) s = dict[text];
      else missing.add(text);
    }
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  };

  window.i18n = {
    locale,
    preference: pref,
    systemLocale,
    languages: [['system', 'System default'], ['en', 'English'], ['ko', '한국어']],
    missing,
    // Static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder.
    translateDom(root = document) {
      for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = tr(n.dataset.i18n);
      for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = tr(n.dataset.i18nTitle);
      for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = tr(n.dataset.i18nPlaceholder);
    },
  };
  document.documentElement.lang = locale;
  i18n.translateDom();
})();
