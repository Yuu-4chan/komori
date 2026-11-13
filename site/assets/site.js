// Komori website: latest-release download links, the screenshot tabs and the docs outline.
// Everything here is an enhancement; without it the page links to the releases page.

const RELEASE_API = "https://api.github.com/repos/Yuu-4chan/komori/releases/latest";
const RELEASE_CACHE = "komori-latest-release";
const RELEASE_CACHE_MS = 10 * 60 * 1000;

const ASSETS = {
  windows: { suffix: "_x64-setup.exe", note: "Windows 10 and 11" },
  android: { suffix: "_android-arm64.apk", note: "Android 10 and later" },
};

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  for (const [platform, { suffix, note }] of Object.entries(ASSETS)) {
    const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
    // Only GitHub's own download URLs replace the fallback link.
    if (!asset || !asset.url.startsWith("https://github.com/Yuu-4chan/komori/releases/download/")) {
      continue;
    }
    for (const link of document.querySelectorAll(`a[data-download="${platform}"]`)) {
      link.href = asset.url;
    }
    for (const meta of document.querySelectorAll(`[data-release-meta="${platform}"]`)) {
      meta.textContent = `v${release.version} · ${megabytes(asset.size)} · ${note}`;
    }
  }
  for (const tag of document.querySelectorAll("[data-release-tag]")) {
    tag.textContent = `v${release.version}`;
    tag.hidden = false;
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
  const android = /Android/i.test(navigator.userAgent);
  const preferred = android ? "android" : "windows";
  for (const link of document.querySelectorAll(".hero a[data-download]")) {
    link.classList.toggle("button--primary", link.dataset.download === preferred);
  }
  if (android) {
    const actions = document.querySelector(".hero .actions");
    const phone = actions?.querySelector('a[data-download="android"]');
    if (actions && phone) actions.prepend(phone);
  }
  for (const card of document.querySelectorAll(".download[data-platform]")) {
    card.classList.toggle("is-preferred", card.dataset.platform === preferred);
  }
}

// Turns the stacked screenshots into tabs, one panel shown at a time.
function setUpTour(tour) {
  const tabList = tour.querySelector(".tour__tabs");
  const panels = [...tour.querySelectorAll(".tour__panel")];
  if (!tabList || panels.length < 2) return;

  const tabs = panels.map((panel, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tour__tab";
    tab.id = `tour-tab-${index}`;
    tab.textContent = panel.dataset.tab ?? `Screenshot ${index + 1}`;
    tab.setAttribute("role", "tab");
    panel.id = `tour-panel-${index}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tab.setAttribute("aria-controls", panel.id);
    tabList.append(tab);
    return tab;
  });

  function select(index, focus = false) {
    tabs.forEach((tab, at) => {
      const selected = at === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[at].hidden = !selected;
    });
    // Load the image as its panel opens instead of waiting for it to scroll into view.
    panels[index].querySelector("img")?.setAttribute("loading", "eager");
    if (focus) tabs[index].focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step) {
        event.preventDefault();
        select((index + step + tabs.length) % tabs.length, true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        select(event.key === "Home" ? 0 : tabs.length - 1, true);
      }
    });
  });

  tabList.hidden = false;
  select(0);
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
for (const tour of document.querySelectorAll("[data-tour]")) setUpTour(tour);
for (const outline of document.querySelectorAll("[data-outline]")) setUpOutline(outline);
if (document.querySelector("[data-download]")) {
  latestRelease()
    .then(showRelease)
    .catch(() => {
      // Offline or rate-limited: the buttons keep pointing at the releases page.
    });
}
