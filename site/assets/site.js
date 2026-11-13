// Komori website: latest-release download links, the screenshot viewer, the theme picker and the docs outline.
// Everything here is an enhancement; without it the page links to the releases page.

const RELEASE_API = "https://api.github.com/repos/Yuu-4chan/komori/releases/latest";
const RELEASE_CACHE = "komori-latest-release";
const RELEASE_CACHE_MS = 10 * 60 * 1000;

const ASSETS = {
  windows: "_x64-setup.exe",
  android: "_android-arm64.apk",
};

function readCachedRelease() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(RELEASE_CACHE) ?? "null");
    return cached && Date.now() - cached.at < RELEASE_CACHE_MS ? cached.release : null;
  } catch {
    return null;
  }
}

async function latestRelease() {
  const cached = readCachedRelease();
  if (cached) return cached;
  const response = await fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const data = await response.json();
  const release = {
    version: String(data.tag_name ?? "").replace(/^v/, ""),
    published: data.published_at,
    assets: (data.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
  };
  try {
    sessionStorage.setItem(RELEASE_CACHE, JSON.stringify({ at: Date.now(), release }));
  } catch {
    // Storage can be unavailable (private windows); the page works without the cache.
  }
  return release;
}

function showRelease(release) {
  if (!release.version) return;
  for (const [platform, suffix] of Object.entries(ASSETS)) {
    const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
    // Only GitHub's own download URLs replace the fallback link.
    if (!asset || !asset.url.startsWith("https://github.com/Yuu-4chan/komori/releases/download/")) {
      continue;
    }
    for (const link of document.querySelectorAll(`a[data-download="${platform}"]`)) {
      link.href = asset.url;
    }
  }
  for (const version of document.querySelectorAll("[data-release-version]")) {
    version.textContent = release.version;
  }
  const published = new Date(release.published);
  if (!Number.isNaN(published.getTime())) {
    const date = published.toLocaleDateString(undefined, { dateStyle: "long" });
    for (const element of document.querySelectorAll("[data-release-date]")) {
      element.textContent = date;
    }
    for (const line of document.querySelectorAll("[data-release-line]")) {
      line.hidden = false;
    }
  }
}

// Put the visitor's own platform first: the phone build on Android, Windows elsewhere.
function preferPlatform() {
  if (!/Android/i.test(navigator.userAgent)) return;
  const actions = document.querySelector(".hero .actions");
  const windows = actions?.querySelector('a[data-download="windows"]');
  const android = actions?.querySelector('a[data-download="android"]');
  if (!windows || !android) return;
  windows.classList.remove("button--primary");
  android.classList.add("button--primary");
  actions.prepend(android);
}

// Screenshot thumbnails open large in a dialog; the arrow keys move between them.
function setUpGallery(gallery) {
  const viewer = document.querySelector("[data-viewer]");
  const links = [...gallery.querySelectorAll("a[href]")];
  if (!viewer || typeof viewer.showModal !== "function" || links.length === 0) return;
  const image = viewer.querySelector("img");
  const caption = viewer.querySelector("[data-viewer-caption]");
  let current = 0;

  function show(index) {
    current = (index + links.length) % links.length;
    const link = links[current];
    image.src = link.href;
    image.alt = link.querySelector("img")?.alt ?? "";
    caption.textContent = link.querySelector("h3")?.textContent ?? "";
  }

  links.forEach((link, index) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      show(index);
      viewer.showModal();
    });
  });
  viewer
    .querySelector("[data-viewer-previous]")
    ?.addEventListener("click", () => show(current - 1));
  viewer.querySelector("[data-viewer-next]")?.addEventListener("click", () => show(current + 1));
  viewer.querySelector("[data-viewer-close]")?.addEventListener("click", () => viewer.close());
  viewer.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step) {
      event.preventDefault();
      show(current + step);
    }
  });
  // A click on the dimmed backdrop, outside the picture and its buttons, closes it.
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) viewer.close();
  });
}

// The Themes section: choosing one puts the page in that theme and remembers it.
function setUpThemes(picker) {
  const options = [...picker.querySelectorAll("[data-theme-option]")];
  const show = () => {
    const current = document.documentElement.dataset.theme ?? "";
    for (const option of options) {
      option.setAttribute("aria-pressed", String(option.dataset.themeOption === current));
    }
  };
  for (const option of options) {
    option.addEventListener("click", () => {
      const theme = option.dataset.themeOption;
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      try {
        if (theme) localStorage.setItem("komori-site-theme", theme);
        else localStorage.removeItem("komori-site-theme");
      } catch {
        // Storage can be unavailable (private windows); the choice lasts for this visit.
      }
      show();
    });
  }
  show();
}

// Marks the documentation section being read in the outline.
function setUpOutline(outline) {
  const links = new Map();
  for (const link of outline.querySelectorAll('a[href^="#"]')) {
    const section = document.getElementById(link.hash.slice(1));
    if (section) links.set(section, link);
  }
  if (links.size === 0 || !("IntersectionObserver" in window)) return;

  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      const current = [...links.keys()].find((section) => visible.has(section));
      if (!current) return;
      for (const [section, link] of links) {
        link.classList.toggle("is-current", section === current);
      }
    },
    { rootMargin: "-90px 0px -55% 0px" },
  );
  for (const section of links.keys()) observer.observe(section);

  // On small screens the outline is a closed disclosure; choosing a section closes it again.
  const disclosure = outline.querySelector("details");
  const wide = window.matchMedia("(min-width: 901px)");
  const sync = () => {
    if (disclosure) disclosure.open = wide.matches;
  };
  sync();
  wide.addEventListener("change", sync);
  outline.addEventListener("click", (event) => {
    if (disclosure && !wide.matches && event.target.closest("a")) disclosure.open = false;
  });
}

preferPlatform();
for (const gallery of document.querySelectorAll("[data-gallery]")) setUpGallery(gallery);
for (const picker of document.querySelectorAll("[data-themes]")) setUpThemes(picker);
for (const outline of document.querySelectorAll("[data-outline]")) setUpOutline(outline);
if (document.querySelector("[data-download]")) {
  latestRelease()
    .then(showRelease)
    .catch(() => {
      // Offline or rate-limited: the buttons keep pointing at the releases page.
    });
}
