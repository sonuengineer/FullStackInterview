/* Small page-level controls: saved theme, reading progress, and return to top. */
(function () {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const progress = document.getElementById("reading-progress-fill");
  const topButton = document.getElementById("back-to-top");
  const key = "how-ai-thinks-theme";

  function currentTheme() {
    return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  function setTheme(theme, save) {
    root.dataset.theme = theme;
    const dark = theme === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", "Switch to " + (dark ? "light" : "dark") + " theme");
    toggle.querySelector(".theme-label").textContent = dark ? "Light" : "Dark";
    if (save) localStorage.setItem(key, theme);
  }

  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") setTheme(saved, false);
    else setTheme(currentTheme(), false);
  } catch (_) {
    setTheme(currentTheme(), false);
  }

  toggle.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark", true));

  function updateScrollControls() {
    const scrollable = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = (scrollable > 0 ? Math.min(100, scrollY / scrollable * 100) : 0) + "%";
    topButton.classList.toggle("visible", scrollY > 500);
  }

  addEventListener("scroll", updateScrollControls, { passive: true });
  addEventListener("resize", updateScrollControls);
  topButton.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));
  updateScrollControls();
})();
