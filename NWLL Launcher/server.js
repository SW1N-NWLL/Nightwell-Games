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
const ROOT = __dirname;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function cookieMap(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim()).filter(Boolean).map(x => { const i=x.indexOf("="); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; })); }
function signed(value) { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url"); return `${payload}.${sig}`; }
function verify(value) { if (!value || !SESSION_SECRET) return null; const [payload, sig] = value.split("."); if (!payload || !sig) return null; const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest(); let actual; try { actual = Buffer.from(sig, "base64url"); } catch { return null; } if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null; try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()); return data.exp > Date.now() ? data.user : null; } catch { return null; } }
function send(res, status, body, headers={}) { res.writeHead(status, { "Cache-Control": "no-store", ...headers }); res.end(body); }
function redirect(res, location, headers={}) { res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers }); res.end(); }
function cookie(name, value, maxAge, secure, sameSite="Lax") { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const secure = req.headers["x-forwarded-proto"] === "https" || url.protocol === "https:";
  if (url.pathname === "/auth/google") {
    if (!CLIENT_ID || !SESSION_SECRET) return send(res, 500, "Set GOOGLE_CLIENT_ID and SESSION_SECRET before starting Orbit.");
    const state = crypto.randomBytes(32).toString("base64url");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email profile", state }).toString();
    return redirect(res, auth.toString(), { "Set-Cookie": cookie("orbit_oauth_state", state, 600, secure) });
  }
  if (url.pathname === "/auth/discord" && req.method === "GET") {
    if (!DISCORD_CLIENT_ID || !SESSION_SECRET) return send(res, 503, "Discord sign-in is not configured. Set Discord settings in .env.");
    const state = crypto.randomBytes(32).toString("base64url");
    const auth = new URL("https://discord.com/oauth2/authorize");
    auth.search = new URLSearchParams({ client_id:DISCORD_CLIENT_ID, response_type:"code", redirect_uri:DISCORD_REDIRECT_URI, scope:"identify email", state }).toString();
    return redirect(res, auth.toString(), { "Set-Cookie":cookie("orbit_discord_state",state,600,secure) });
  }
  if (url.pathname === "/auth/callback/discord" && req.method === "GET") {
    const cookies = cookieMap(req), state = url.searchParams.get("state"), code = url.searchParams.get("code"), clear = cookie("orbit_discord_state","",0,secure);
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
      return redirect(res, "/", { "Set-Cookie":[cookie("orbit_session",value,7*24*60*60,secure), clear] });
    } catch (err) { console.error("Discord OAuth callback failed:", err.message, err.cause?.code || err.cause?.message || ""); return send(res, 502, "Discord sign-in failed. Check server settings.", { "Set-Cookie":clear }); }
  }
  if (url.pathname === "/auth/callback/google") {
    const cookies = cookieMap(req), state = url.searchParams.get("state"), code = url.searchParams.get("code");
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
      return redirect(res, "/", { "Set-Cookie": [cookie("orbit_session", value, 7 * 24 * 60 * 60, secure), cookie("orbit_oauth_state", "", 0, secure)] });
    } catch (err) { console.error("Google OAuth callback failed:", err.message); return send(res, 502, "Google sign-in failed. Check server logs."); }
  }
  if (url.pathname === "/api/me") {
    const user = verify(cookieMap(req).orbit_session);
    return send(res, 200, JSON.stringify({ user }), { "Content-Type": "application/json; charset=utf-8" });
  }
  if (url.pathname === "/auth/logout") return redirect(res, "/", { "Set-Cookie": cookie("orbit_session", "", 0, secure) });
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => err ? send(res, 404, "Not found") : send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }));
});

server.listen(PORT, () => console.log(`Orbit running at http://localhost:${PORT}`));
