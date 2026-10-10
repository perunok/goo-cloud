// Applies the persisted theme before first paint to avoid a flash. Loaded from index.html.
try {
  var t = localStorage.getItem('goo.theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
