// Applies the saved theme before first paint to avoid a light/dark flash.
// Kept as an external file so the CSP can forbid inline scripts. Mirrors src/shared/lib/theme.
(() => {
  let preference = 'system';
  try {
    preference = localStorage.getItem('lsv:theme') ?? 'system';
  } catch {
    // Storage unavailable: fall back to the system preference.
  }
  const dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
