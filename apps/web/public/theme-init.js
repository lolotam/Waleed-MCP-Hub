// Applies a saved Light or Dark choice before the first paint. The app module
// loads later, so without this a saved choice that differs from Windows shows
// the other theme for a moment. It is a file because the content security
// policy allows no inline script. It runs after the two `theme-color` tags in
// index.html, so it can give them the chosen colour too. The key, the two
// values and the two colours are the ones in apps/web/src/theme.ts;
// tests/theme.test.ts checks that they stay the same.
(function () {
  try {
    var choice = window.localStorage.getItem('wmh-theme-v1');
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
      var color = choice === 'dark' ? '#0d131c' : '#1f53b8';
      var tags = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < tags.length; i++)
        tags[i].setAttribute('content', color);
    }
  } catch {
    // Blocked storage: the stylesheet follows Windows.
  }
})();
