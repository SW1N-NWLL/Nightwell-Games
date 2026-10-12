const APPS = [
  { id: "notion", name: "Notion", category: "Работа", description: "Рабочее пространство для заметок и планов", icon: "N", iconClass: "icon-notion", rating: "4.9", size: "веб-приложение", url: "https://www.notion.so" },
  { id: "figma", name: "Figma", category: "Дизайн", description: "Создавайте интерфейсы вместе с командой", icon: "◉", iconClass: "icon-figma", rating: "4.9", size: "веб-приложение", url: "https://www.figma.com" },
  { id: "vscode", name: "Visual Studio Code", category: "Разработка", description: "Лёгкий редактор кода для любых проектов", icon: "⟨/⟩", iconClass: "icon-vscode", rating: "4.8", size: "веб-приложение", url: "https://vscode.dev" },
  { id: "spotify", name: "Spotify", category: "Медиа", description: "Музыка, подкасты и ваши любимые плейлисты", icon: "◖", iconClass: "icon-spotify", rating: "4.8", size: "веб-приложение", url: "https://open.spotify.com" },
  { id: "obsidian", name: "Obsidian", category: "Работа", description: "Связывайте заметки и стройте базу знаний", icon: "◈", iconClass: "icon-obsidian", rating: "4.7", size: "веб-приложение", url: "https://obsidian.md" },
  { id: "slack", name: "Slack", category: "Работа", description: "Общение команды и рабочие процессы", icon: "✣", iconClass: "icon-slack", rating: "4.7", size: "веб-приложение", url: "https://slack.com" },
];
const INITIAL_LIBRARY = ["notion", "figma", "vscode"];
const content = document.querySelector("#content");
const modal = document.querySelector("#auth-modal");
let page = "store", category = "Все приложения", query = "", toastTimer, authMode = "login";
let library = JSON.parse(localStorage.getItem("orbit-library") || "null") || INITIAL_LIBRARY;
let user = null;
const offlineScreen = document.querySelector("#offline-screen");
let connectionLost = false, networkCheckInProgress = false, reconnectTimer = null, networkMonitor = null;

function showOfflineScreen() {
  const wasOffline = connectionLost;
  connectionLost = true;
  offlineScreen.hidden = false;
  offlineScreen.setAttribute("aria-hidden", "false");
  if (!wasOffline) { try { window.chrome?.webview?.postMessage("offline"); } catch {} }
  if (networkMonitor) { clearInterval(networkMonitor); networkMonitor = null; }
  if (!reconnectTimer) reconnectTimer = setInterval(checkConnection, 4000);
}

async function checkConnection() {
  if (networkCheckInProgress) return;
  if (!navigator.onLine) { showOfflineScreen(); return; }
  networkCheckInProgress = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`/api/me?network-check=${Date.now()}`, {
      cache: "no-store", credentials: "same-origin", signal: controller.signal
    });
    if (!response.ok) throw new Error("Network check failed");
    if (connectionLost) {
      document.querySelector("#offline-title").textContent = "Связь восстановлена";
      document.querySelector("#offline-message").textContent = "Загружаем данные лаунчера…";
      if (reconnectTimer) clearInterval(reconnectTimer);
      reconnectTimer = null;
      try { window.chrome?.webview?.postMessage("online"); } catch {}
      window.location.reload();
    }
  } catch {
    showOfflineScreen();
  } finally {
    clearTimeout(timeout);
    networkCheckInProgress = false;
  }
}

window.addEventListener("offline", showOfflineScreen);
window.addEventListener("online", checkConnection);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkConnection(); });
if (!navigator.onLine) showOfflineScreen();
checkConnection();
if (!connectionLost) networkMonitor = setInterval(checkConnection, 15000);

function saveLibrary() { localStorage.setItem("orbit-library", JSON.stringify(library)); document.querySelector("#library-count").textContent = library.length; }
function icon(app) { return `<span class="app-icon ${app.iconClass}">${app.icon}</span>`; }
function showToast(message) { const el = document.querySelector("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600); }
function appCard(app, compact = false) { const owned = library.includes(app.id); return `<article class="app-card"><div class="app-card-top">${icon(app)}<span class="rating">★ ${app.rating}</span></div><h3>${app.name}</h3><p>${app.description}</p><div class="app-card-bottom"><span class="app-category">${app.category}</span><button class="small-action ${owned ? "installed" : ""}" data-action="${owned ? "launch" : "install"}" data-id="${app.id}">${owned ? "Открыть ↗" : "Добавить +"}</button></div></article>`; }
function featureCard(app, big, label) { return `<article class="feature-card ${big ? "large" : ""}"><div class="feature-bg">${app.icon}</div><div class="feature-label">${label}</div><h3>${app.name}</h3><p>${app.description}</p><div class="feature-bottom"><div class="feature-mini">${icon(app)}<div><strong>${app.name}</strong><span>★ ${app.rating} · ${app.category}</span></div></div><button class="small-action ${library.includes(app.id) ? "installed" : ""}" data-action="${library.includes(app.id) ? "launch" : "install"}" data-id="${app.id}">${library.includes(app.id) ? "Открыть ↗" : "Добавить +"}</button></div></article>`; }
function renderStore() {
  const list = APPS.filter(a => (category === "Все приложения" || a.category === category) && (a.name + a.description + a.category).toLowerCase().includes(query.toLowerCase()));
  document.querySelector("#breadcrumb-current").textContent = "Магазин";
  content.innerHTML = `<section class="hero"><div class="hero-copy"><div class="eyebrow">ВАШ ЦИФРОВОЙ МИР</div><h1>Всё нужное.<br>В одном месте.</h1><p>Откройте для себя приложения, которые помогают работать, создавать и отдыхать. Ваша коллекция всегда под рукой.</p><div class="hero-actions"><button class="primary-button" data-scroll="catalog">Открыть магазин <span>↗</span></button><button class="secondary-button" data-page="library">Моя библиотека</button></div></div><div class="hero-art"><span>✳</span></div></section>
  <section><div class="section-head"><div><h2 class="section-title">Выбор Orbit</h2><div class="section-subtitle">Приложения, которые нам нравятся</div></div><button class="text-link" data-scroll="catalog">Смотреть все ↗</button></div><div class="featured-grid">${featureCard(APPS[0], true, "ВЫБОР РЕДАКЦИИ")}${featureCard(APPS[1], false, "ПОПУЛЯРНОЕ")}</div></section>
  <section id="catalog"><div class="section-head"><div><h2 class="section-title">Каталог приложений</h2><div class="section-subtitle">${list.length} приложений для вашего пространства</div></div></div><div class="catalog-toolbar"><label class="search-box"><span>⌕</span><input id="search-input" placeholder="Найти приложение..." value="${escapeHtml(query)}" aria-label="Найти приложение"></label>${["Все приложения", "Работа", "Дизайн", "Разработка", "Медиа"].map(c => `<button class="filter-chip ${category === c ? "selected" : ""}" data-filter="${c}">${c}</button>`).join("")}</div><div class="catalog-grid">${list.length ? list.map(a => appCard(a)).join("") : `<div class="empty-state"><strong>Ничего не найдено</strong>Попробуйте изменить запрос или категорию.</div>`}</div></section>`;
  bindContent();
}
function renderLibrary() {
  const apps = APPS.filter(a => library.includes(a.id));
  document.querySelector("#breadcrumb-current").textContent = "Библиотека";
  content.innerHTML = `<div class="page-heading"><div><h1>Моя библиотека</h1><p>Ваша коллекция приложений в одном месте.</p></div><button class="primary-button" data-page="store">＋ Найти приложения</button></div><div class="library-banner"><div><strong>${apps.length} ${plural(apps.length, "приложение", "приложения", "приложений")} в вашей библиотеке</strong><p>Добавляйте приложения из магазина, чтобы они всегда были под рукой.</p></div><span class="eyebrow">✦ ORBIT SPACE</span></div>${apps.length ? `<div class="library-list">${apps.map(a => `<article class="library-row">${icon(a)}<div class="library-info"><strong>${a.name}</strong><p>${a.category} · ${a.size}</p></div><span class="status">Добавлено</span><div class="row-actions"><button class="small-action" data-action="launch" data-id="${a.id}">Открыть ↗</button><button class="small-action" data-action="remove" data-id="${a.id}">Убрать</button></div></article>`).join("")}</div>` : `<div class="empty-state"><strong>Библиотека пока пуста</strong>Загляните в магазин и добавьте первое приложение.</div>`}`;
  bindContent();
}
function plural(n, one, few, many) { const x = n % 100; if (x >= 11 && x <= 14) return many; const y = n % 10; return y === 1 ? one : y >= 2 && y <= 4 ? few : many; }
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function setPage(next) { page = next; document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page && b.classList.contains("nav-item"))); page === "store" ? renderStore() : renderLibrary(); }
function bindContent() {
  content.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => setPage(b.dataset.page)));
  content.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => { category = b.dataset.filter; renderStore(); }));
  content.querySelectorAll("[data-scroll]").forEach(b => b.addEventListener("click", () => document.querySelector("#catalog")?.scrollIntoView({behavior:"smooth"})));
  content.querySelectorAll("[data-action]").forEach(b => b.addEventListener("click", () => { const id = b.dataset.id, app = APPS.find(a => a.id === id); if (b.dataset.action === "install") { if (!library.includes(id)) library.push(id); saveLibrary(); showToast(`${app.name} добавлено в библиотеку`); } else if (b.dataset.action === "remove") { library = library.filter(x => x !== id); saveLibrary(); showToast(`${app.name} удалено из библиотеки`); } else { window.open(app.url, "_blank", "noopener,noreferrer"); } page === "store" ? renderStore() : renderLibrary(); }));
  const search = content.querySelector("#search-input"); if (search) search.addEventListener("input", e => { query = e.target.value; const pos = e.target.selectionStart; renderStore(); const next = content.querySelector("#search-input"); next.focus(); next.setSelectionRange(pos, pos); });
}
function openAuth() { document.querySelector("#auth-title").textContent = user ? "Вы вошли в Orbit" : "Ваше пространство"; document.querySelector(".auth-copy").textContent = user ? `Аккаунт: ${user.email || user.name}` : "Создайте Orbit-аккаунт по email или войдите удобным способом."; document.querySelector("#social-login-options").hidden = Boolean(user); document.querySelector("#email-auth").hidden = Boolean(user); document.querySelector("#auth-note").textContent = user ? "Вход выполнен" : "Для аккаунта Orbit пароль должен содержать не менее 10 символов."; document.querySelector("#logout-button").hidden = !user; modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); }
function setAuthMode(mode) { authMode = mode; const registering = mode === "register"; document.querySelector("#name-field").hidden = !registering; document.querySelector("#auth-name").required = registering; document.querySelector("#auth-password").autocomplete = registering ? "new-password" : "current-password"; document.querySelector("#email-submit").textContent = registering ? "Создать аккаунт" : "Войти"; document.querySelector("#auth-mode-switch").textContent = registering ? "Уже есть аккаунт? Войти" : "Создать аккаунт"; document.querySelector("#auth-form-error").hidden = true; }
function closeAuth() { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }
const downloadsTrigger = document.querySelector("#downloads-trigger");
const downloadsPanel = document.querySelector("#downloads-panel");
function setDownloadsOpen(open) {
  downloadsPanel.classList.toggle("open", open);
  downloadsPanel.setAttribute("aria-hidden", String(!open));
  downloadsTrigger.setAttribute("aria-expanded", String(open));
}
function beginOAuth(provider) {
  if (provider === "google") { location.assign("/auth/google"); return; }
  if (provider === "discord") { location.assign("/auth/discord"); return; }
}
document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => setPage(b.dataset.page)));
document.querySelectorAll(".category-item").forEach(b => b.addEventListener("click", () => { category = b.dataset.category; document.querySelectorAll(".category-item").forEach(x => x.classList.toggle("selected", x === b)); setPage("store"); document.querySelector("#catalog")?.scrollIntoView({behavior:"smooth"}); }));
document.querySelector("#profile-button").addEventListener("click", openAuth);
document.querySelector("#modal-close").addEventListener("click", closeAuth);
modal.addEventListener("click", e => { if (e.target === modal) closeAuth(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeAuth(); setDownloadsOpen(false); } });
downloadsTrigger.addEventListener("click", () => setDownloadsOpen(!downloadsPanel.classList.contains("open")));
document.querySelector("#downloads-close").addEventListener("click", () => setDownloadsOpen(false));
document.addEventListener("click", e => { if (downloadsPanel.classList.contains("open") && !downloadsPanel.contains(e.target) && !downloadsTrigger.contains(e.target)) setDownloadsOpen(false); });
document.querySelector("#google-login").addEventListener("click", () => beginOAuth("google"));
document.querySelector("#discord-login").addEventListener("click", () => beginOAuth("discord"));
document.querySelector("#logout-button").addEventListener("click", () => location.assign("/auth/logout"));
document.querySelector("#auth-mode-switch").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
document.querySelector("#email-auth").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, button = document.querySelector("#email-submit"), error = document.querySelector("#auth-form-error");
  error.hidden = true;
  button.disabled = true;
  button.textContent = authMode === "register" ? "Создаём аккаунт…" : "Входим…";
  try {
    const response = await fetch(authMode === "register" ? "/auth/register" : "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: document.querySelector("#auth-name").value, email: document.querySelector("#auth-email").value, password: document.querySelector("#auth-password").value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось выполнить вход.");
    user = result.user;
    document.querySelector("#profile-name").textContent = user.name || user.email || "Мой аккаунт";
    document.querySelector("#avatar").textContent = (user.name || user.email || "М").charAt(0).toUpperCase();
    form.reset();
    openAuth();
  } catch (err) {
    error.textContent = err.message || "Не удалось связаться с сервером.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = authMode === "register" ? "Создать аккаунт" : "Войти";
  }
});
fetch("/api/me").then(r => r.ok ? r.json() : null).then(data => { user = data?.user || null; if (user) { document.querySelector("#profile-name").textContent = user.name || user.email || "Мой аккаунт"; document.querySelector("#avatar").textContent = (user.name || user.email || "М").charAt(0).toUpperCase(); } if (modal.classList.contains("open")) openAuth(); }).catch(() => {});
saveLibrary(); renderStore();
