/* Shared dark/light theme toggle. One tiny script, loaded on every page, so the choice made on
 * publish.html or view.html is instantly the same everywhere (synced via localStorage). */
(function () {
  'use strict';
  const KEY = 'stream-avatar-theme';
  const media = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');

  function stored() { try { return localStorage.getItem(KEY); } catch { return null; } }
  function resolve() { return stored() || (media && media.matches ? 'light' : 'dark'); }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-theme-icon]').forEach(el => { el.textContent = theme === 'light' ? '🌙' : '☀️'; });
    document.querySelectorAll('[data-theme-label]').forEach(el => { el.textContent = theme === 'light' ? 'Dark mode' : 'Light mode'; });
  }

  window.Theme = {
    get: resolve,
    set(theme) { try { localStorage.setItem(KEY, theme); } catch {} apply(theme); },
    toggle() { window.Theme.set(resolve() === 'light' ? 'dark' : 'light'); },
    init(buttonId) {
      apply(resolve());
      if (buttonId) {
        const btn = document.getElementById(buttonId);
        if (btn) btn.addEventListener('click', () => window.Theme.toggle());
      }
      // Cross-tab / cross-page sync: flipping the toggle on publish.html updates view.html too if
      // both happen to be open, and vice versa.
      window.addEventListener('storage', e => { if (e.key === KEY && e.newValue) apply(e.newValue); });
      if (media && media.addEventListener) media.addEventListener('change', () => { if (!stored()) apply(resolve()); });
    },
  };
  apply(resolve());   // set it before first paint's CSS reads the attribute, not just on init()
})();
