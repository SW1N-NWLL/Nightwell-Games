const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Load local secrets without a dependency. OS environment variables take precedence.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}

const PORT = Number(process.env.PORT || 4173);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "228889399204-6ie8re6f9ra43m6bssfr6vve4lffm42m.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback/google`;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback/discord`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = process.env.DATABASE_SSL === "true";
const DATABASE_CONFIGURED = Boolean(DATABASE_URL);
const ROOT = __dirname;
const INSTALLERS_DIR = path.join(ROOT, "installers");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
let installerCatalogCache = { expiresAt: 0, items: [] };
let dbPool = null;
let dbInitializationError = null;
let dbReady = Promise.resolve();
if (DATABASE_CONFIGURED) {
  dbReady = (async () => {
    const mysql = require("mysql2/promise");
    const databaseUrl = new URL(DATABASE_URL);
    if (databaseUrl.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql:// scheme.");
    dbPool = mysql.createPool({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 3306),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: decodeURIComponent(databaseUrl.pathname.slice(1)),
      // TiDB Cloud Starter presents a certificate trusted by Node's built-in CA store.
      // Keep certificate verification enabled, but do not replace the system trust roots.
      ssl: DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 10000,
      charset: "utf8mb4",
    });
    dbPool.on("error", error => console.error("Account database connection error:", error.message));
    await dbPool.execute(`CREATE TABLE IF NOT EXISTS orbit_users (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      name VARCHAR(60) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  })().catch(error => {
    dbInitializationError = error;
    console.error("Could not initialize account database:", error.message);
  });
}
const desktopOAuthStates = new Map();
const desktopTickets = new Map();
const authRateLimits = new Map();
const PASSWORD_HASH_BYTES = 64;
const DUMMY_PASSWORD_SALT = "orbit-login-dummy-salt";
const DUMMY_PASSWORD_HASH = "00".repeat(PASSWORD_HASH_BYTES);
function pruneDesktopAuth() {
  const now = Date.now();
  for (const [state, expires] of desktopOAuthStates) if (expires <= now) desktopOAuthStates.delete(state);
  for (const [ticket, entry] of desktopTickets) if (entry.expires <= now) desktopTickets.delete(ticket);
}

function passwordHash(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, PASSWORD_HASH_BYTES, { maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key.toString("hex"))));
}
function json(res, status, data, headers = {}) {
  return send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", ...headers });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "", oversized = false;
    req.on("data", chunk => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > 12 * 1024) { oversized = true; body = ""; }
    });
    req.on("end", () => {
      if (oversized) return reject(Object.assign(new Error("Request too large"), { status: 413 }));
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function sameOrigin(req, secure) {
  try {
    const origin = new URL(req.headers.origin);
    return origin.host.toLowerCase() === String(req.headers.host || "").toLowerCase() && origin.protocol === (secure ? "https:" : "http:");
  } catch { return false; }
}
function allowAuthAttempt(req, key, limit) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now(), id = `${key}:${ip}`, entry = authRateLimits.get(id);
  if (!entry || entry.reset < now) { authRateLimits.set(id, { count: 1, reset: now + 15 * 60 * 1000 }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  if (authRateLimits.size > 5000) for (const [k, v] of authRateLimits) if (v.reset < now) authRateLimits.delete(k);
  return true;
}
function sessionHeaders(user, secure) {
  return { "Set-Cookie": cookie("orbit_session", signed({ user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }), 7 * 24 * 60 * 60, secure) };
}

function cookieMap(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim()).filter(Boolean).map(x => { const i=x.indexOf("="); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; })); }
function signed(value) { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url"); return `${payload}.${sig}`; }
function verify(value) { if (!value || !SESSION_SECRET) return null; const [payload, sig] = value.split("."); if (!payload || !sig) return null; const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest(); let actual; try { actual = Buffer.from(sig, "base64url"); } catch { return null; } if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null; try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()); return data.exp > Date.now() ? data.user : null; } catch { return null; } }
function send(res, status, body, headers={}) { res.writeHead(status, { "Cache-Control": "no-store", ...headers }); res.end(body); }
function redirect(res, location, headers={}) { res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers }); res.end(); }
function cookie(name, value, maxAge, secure, sameSite="Lax") { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`; }

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

async function getInstallerCatalog() {
  if (installerCatalogCache.expiresAt > Date.now()) return installerCatalogCache.items;
  let entries;
  try { entries = await fs.promises.readdir(INSTALLERS_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const packages = await Promise.all(entries.filter(entry => entry.isFile() && /\.(exe|msi)$/i.test(entry.name)).map(async entry => {
    const fullPath = path.join(INSTALLERS_DIR, entry.name);
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    const baseName = path.basename(entry.name, path.extname(entry.name));
    let settings = {};
    if (extension === "exe") {
      try { settings = JSON.parse(await fs.promises.readFile(fullPath + ".install.json", "utf8")); }
      catch { settings = {}; }
    }
    const stat = await fs.promises.stat(fullPath);
    const fileHash = await sha256File(fullPath);
    const id = crypto.createHash("sha256").update(entry.name).digest("hex").slice(0, 16);
    const silentArgs = typeof settings.silentArgs === "string" ? settings.silentArgs.slice(0, 512) : "";
    return {
      id: `installer-${id}`,
      name: String(settings.name || baseName).slice(0, 80),
      description: String(settings.description || `Тихая установка пакета .${extension}`).slice(0, 180),
      category: String(settings.category || "Утилиты").slice(0, 40),
      extension,
      size: `${Math.max(1, Math.round(stat.size / 1024 / 1024))} МБ`,
      downloadUrl: `/installers/${encodeURIComponent(entry.name)}`,
      sha256: fileHash,
      silentArgs,
      silentReady: extension === "msi" || Boolean(silentArgs),
    };
  }));
  installerCatalogCache = { expiresAt: Date.now() + 10000, items: packages };
  return packages;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  pruneDesktopAuth();
  const secure = req.headers["x-forwarded-proto"] === "https" || url.protocol === "https:";
  if ((url.pathname === "/auth/register" || url.pathname === "/auth/login") && req.method === "POST") {
    if (!sameOrigin(req, secure)) return json(res, 403, { error: "Запрос отклонён. Обновите страницу и попробуйте снова." });
    if (!DATABASE_CONFIGURED) return json(res, 503, { error: "Регистрация пока не настроена: подключите MySQL-совместимую базу данных." });
    const action = url.pathname === "/auth/register" ? "register" : "login";
    if (!allowAuthAttempt(req, action, action === "register" ? 5 : 20))
      return json(res, 429, { error: "Слишком много попыток. Попробуйте снова через 15 минут." });
    let input;
    try { input = await readJson(req); }
    catch (error) { return json(res, error.status || 400, { error: error.status === 413 ? "Слишком большой запрос." : "Проверьте введённые данные." }); }

    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return json(res, 400, { error: "Введите корректный email." });
    if (password.length < 10 || password.length > 128)
      return json(res, 400, { error: "Пароль должен содержать от 10 до 128 символов." });
    if (action === "register" && (!name || name.length > 60))
      return json(res, 400, { error: "Имя должно содержать от 1 до 60 символов." });

    try {
      await dbReady;
      if (!dbPool) throw dbInitializationError || new Error("Account database is unavailable.");
      if (action === "register") {
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = await passwordHash(password, salt);
        const id = crypto.randomBytes(16).toString("hex");
        await dbPool.execute(
          "INSERT INTO orbit_users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)",
          [id, email, name, salt, hash]
        );
        const user = { id: `local:${id}`, name, email, picture: "" };
        return json(res, 201, { user }, sessionHeaders(user, secure));
      }

      const [accounts] = await dbPool.execute("SELECT id, email, name, password_salt, password_hash FROM orbit_users WHERE email = ? LIMIT 1", [email]);
      const account = accounts[0];
      const actualHash = await passwordHash(password, account ? account.password_salt : DUMMY_PASSWORD_SALT);
      const expectedHash = Buffer.from(account ? account.password_hash : DUMMY_PASSWORD_HASH, "hex");
      const matches = expectedHash.length === PASSWORD_HASH_BYTES && crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), expectedHash);
      if (!account || !matches) return json(res, 401, { error: "Неверный email или пароль." });
      const user = { id: `local:${account.id}`, name: account.name, email: account.email, picture: "" };
      return json(res, 200, { user }, sessionHeaders(user, secure));
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return json(res, 409, { error: "Аккаунт с таким email уже существует. Войдите в него." });
      console.error("Email authentication failed:", error.message);
      return json(res, 503, { error: "Не удалось связаться с базой аккаунтов. Проверьте адрес и настройки MySQL." });
    }
  }
  if (url.pathname === "/auth/google") {
    if (!CLIENT_ID || !SESSION_SECRET) return send(res, 500, "Set GOOGLE_CLIENT_ID and SESSION_SECRET before starting Orbit.");
    const state = crypto.randomBytes(32).toString("base64url");
    if (url.searchParams.get("desktop") === "1") desktopOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email profile", state }).toString();
    return redirect(res, auth.toString(), { "Set-Cookie": cookie("orbit_oauth_state", state, 600, secure) });
  }
  if (url.pathname === "/auth/discord" && req.method === "GET") {
    if (!DISCORD_CLIENT_ID || !SESSION_SECRET) return send(res, 503, "Discord sign-in is not configured. Set Discord settings in .env.");
    const state = crypto.randomBytes(32).toString("base64url");
    if (url.searchParams.get("desktop") === "1") desktopOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    const auth = new URL("https://discord.com/oauth2/authorize");
    auth.search = new URLSearchParams({ client_id:DISCORD_CLIENT_ID, response_type:"code", redirect_uri:DISCORD_REDIRECT_URI, scope:"identify email", state }).toString();
    return redirect(res, auth.toString(), { "Set-Cookie":cookie("orbit_discord_state",state,600,secure) });
  }
  if (url.pathname === "/auth/callback/discord" && req.method === "GET") {
    const cookies = cookieMap(req), state = url.searchParams.get("state"), code = url.searchParams.get("code"), clear = cookie("orbit_discord_state","",0,secure);
    const desktop = Boolean(state && desktopOAuthStates.get(state) > Date.now());
    if (state) desktopOAuthStates.delete(state);
    if (!state || state !== cookies.orbit_discord_state) return send(res, 400, "Discord OAuth state check failed.", { "Set-Cookie":clear });
    if (url.searchParams.get("error") || !code) return redirect(res, "/", { "Set-Cookie":clear });
    if (!DISCORD_CLIENT_SECRET || !SESSION_SECRET) return send(res, 503, "Set DISCORD_CLIENT_SECRET and SESSION_SECRET on the server.", { "Set-Cookie":clear });
    try {
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ client_id:DISCORD_CLIENT_ID, client_secret:DISCORD_CLIENT_SECRET, grant_type:"authorization_code", code, redirect_uri:DISCORD_REDIRECT_URI }) });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.access_token) throw new Error("Discord code exchange failed. Check app and redirect URL.");
      const profileResponse = await fetch("https://discord.com/api/v10/users/@me", { headers:{ Authorization:`Bearer ${tokens.access_token}` } });
      const profile = await profileResponse.json();
      if (!profileResponse.ok || !profile.id) throw new Error("Could not load Discord user profile.");
      const picture = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${profile.avatar.startsWith("a_") ? "gif" : "png"}` : "";
      const value = signed({ user:{ id:`discord:${profile.id}`, name:profile.global_name || profile.username || "Discord user", email:profile.email || "", picture }, exp:Date.now()+7*24*60*60*1000 });
      if (desktop) {
        const ticket = crypto.randomBytes(32).toString("base64url");
        desktopTickets.set(ticket, { value, expires: Date.now() + 2 * 60 * 1000 });
        return redirect(res, `orbitlauncher://auth?ticket=${encodeURIComponent(ticket)}`, { "Set-Cookie": clear });
      }
      return redirect(res, "/", { "Set-Cookie":[cookie("orbit_session",value,7*24*60*60,secure), clear] });
    } catch (err) { console.error("Discord OAuth callback failed:", err.message, err.cause?.code || err.cause?.message || ""); return send(res, 502, "Discord sign-in failed. Check server settings.", { "Set-Cookie":clear }); }
  }
  if (url.pathname === "/auth/callback/google") {
    const cookies = cookieMap(req), state = url.searchParams.get("state"), code = url.searchParams.get("code");
    const desktop = Boolean(state && desktopOAuthStates.get(state) > Date.now());
    if (state) desktopOAuthStates.delete(state);
    if (!state || !cookies.orbit_oauth_state || state !== cookies.orbit_oauth_state) return send(res, 400, "OAuth state check failed.", { "Set-Cookie": cookie("orbit_oauth_state", "", 0, secure) });
    if (url.searchParams.get("error") || !code) return redirect(res, "/", { "Set-Cookie": cookie("orbit_oauth_state", "", 0, secure) });
    if (!CLIENT_SECRET || !SESSION_SECRET) return send(res, 500, "Set GOOGLE_CLIENT_SECRET and SESSION_SECRET on the server.");
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }) });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return send(res, 502, "Google token exchange failed. Check OAuth client and redirect URI.");
      const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const profile = await userRes.json();
      if (!userRes.ok || !profile.sub) return send(res, 502, "Could not load Google account profile.");
      const value = signed({ user: { id: profile.sub, name: profile.name || "", email: profile.email || "", picture: profile.picture || "" }, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      if (desktop) {
        const ticket = crypto.randomBytes(32).toString("base64url");
        desktopTickets.set(ticket, { value, expires: Date.now() + 2 * 60 * 1000 });
        return redirect(res, `orbitlauncher://auth?ticket=${encodeURIComponent(ticket)}`, { "Set-Cookie": cookie("orbit_oauth_state", "", 0, secure) });
      }
      return redirect(res, "/", { "Set-Cookie": [cookie("orbit_session", value, 7 * 24 * 60 * 60, secure), cookie("orbit_oauth_state", "", 0, secure)] });
    } catch (err) { console.error("Google OAuth callback failed:", err.message); return send(res, 502, "Google sign-in failed. Check server logs."); }
  }
  if (url.pathname === "/auth/desktop/exchange" && req.method === "GET") {
    const ticket = url.searchParams.get("ticket"), entry = ticket && desktopTickets.get(ticket);
    if (ticket) desktopTickets.delete(ticket);
    if (!entry || entry.expires < Date.now()) return send(res, 400, "This desktop sign-in link has expired. Please try again.");
    return redirect(res, "/", { "Set-Cookie": cookie("orbit_session", entry.value, 7 * 24 * 60 * 60, secure) });
  }
  if (url.pathname === "/api/me") {
    const user = verify(cookieMap(req).orbit_session);
    return send(res, 200, JSON.stringify({ user }), { "Content-Type": "application/json; charset=utf-8" });
  }
  if (url.pathname === "/api/installers" && req.method === "GET") {
    try { return json(res, 200, await getInstallerCatalog()); }
    catch (error) { console.error("Could not scan installers:", error.message); return json(res, 500, { error: "Не удалось загрузить каталог установщиков." }); }
  }
  if (url.pathname === "/auth/logout") return redirect(res, "/", { "Set-Cookie": cookie("orbit_session", "", 0, secure) });
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => err ? send(res, 404, "Not found") : send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }));
});

server.listen(PORT, () => console.log(`Orbit running at http://localhost:${PORT}`));
async function shutdown() {
  server.close();
  await dbPool?.end().catch(() => {});
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
