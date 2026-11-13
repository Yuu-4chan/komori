// Applies the theme chosen in the Themes section before the page is drawn.
try {
  const themes = ["light", "dark", "sakura", "matcha", "hojicha", "midnight", "ember", "forest"];
  const theme = localStorage.getItem("komori-site-theme");
  if (themes.includes(theme)) document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be unavailable (private windows); the page keeps its automatic colors.
}
