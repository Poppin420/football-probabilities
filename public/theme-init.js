// Applies the saved light/dark choice before the page is painted (no flash).
// Without a saved choice the page follows the system setting through CSS.
try {
  var saved = window.localStorage.getItem('fp-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (e) {
  /* storage blocked: follow the system theme */
}
