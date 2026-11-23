// Applies a saved Light or Dark choice before the first paint. The app module
// loads later, so without this a saved choice that differs from Windows shows
// the other theme for a moment. It is a file because the content security
// policy allows no inline script. The key and the two values are the ones in
// apps/web/src/theme.ts; tests/theme.test.ts checks that they stay the same.
(function () {
  try {
    var choice = window.localStorage.getItem('wmh-theme-v1');
    if (choice === 'light' || choice === 'dark')
      document.documentElement.setAttribute('data-theme', choice);
  } catch {
    // Blocked storage: the stylesheet follows Windows.
  }
})();
