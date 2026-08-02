// Aether backend
//
// Responsibilities (and ONLY these — the frontend never talks to Spotify or
// Musixmatch directly):
//   1. Spotify OAuth via Authorization Code + PKCE
//   2. Proxying Spotify Web API calls (search, playlists, playback control)
//   3. Proxying Musixmatch synced-lyrics lookups
//
// Tokens (Spotify access/refresh, Musixmatch key) live only in this process —
// server-side session storage — never in the browser, never in a cookie the
// browser can read, and never in client-side JS. The one deliberate exception
// is /api/player-token (see comment above that route) which hands the
// frontend a short-lived Spotify access token so the Web Playback SDK can
// stream audio — that token cannot do anything the SDK doesn't already need
// it to do, and it expires in ~1 hour.

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_REDIRECT_URI,
  MUSIXMATCH_API_KEY,
  SESSION_SECRET,
  REDIS_URL,
  PORT = 8888,
  NODE_ENV = "development",
  PUBLIC_URL = `http://127.0.0.1:${PORT}`,
} = process.env;

for (const [name, val] of Object.entries({ SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SESSION_SECRET })) {
  if (!val) {
    console.error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
app.set("trust proxy", 1); // needed behind nginx/a load balancer for secure cookies
app.use(express.json());

// ---- Session store ----
// IMPORTANT: express-session's default store is in-memory. That means every
// logged-in session (and the Spotify refresh token in it) is wiped the
// instant the Node process restarts — which happens on every deploy, every
// crash, and on host platforms that spin free-tier services down when idle
// (e.g. Render's free plan). Symptom: login works, then at some unpredictable
// later point every API call starts returning 401 "not_authenticated" and
// the frontend shows "Search failed — try reconnecting your account" even
// though nothing about search itself is broken.
//
// Fix: point REDIS_URL at a real Redis instance (Render's own "Key Value"
// add-on, or a free https://upstash.com database both work) and sessions
// survive restarts. Without it, this falls back to MemoryStore so local dev
// still works, but logs a loud warning.
let sessionStore;
if (REDIS_URL) {
  const { createClient } = require("redis");
  const RedisStore = require("connect-redis").default;
  const redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis client error:", err.message));
  redisClient.connect().then(
    () => console.log("Connected to Redis — sessions will survive restarts."),
    (err) => console.error("Redis connection failed, sessions will NOT persist across restarts:", err.message)
  );
  sessionStore = new RedisStore({ client: redisClient, prefix: "aether:sess:" });
} else {
  console.warn(
    "⚠️  REDIS_URL not set — using in-memory sessions. Every restart (including Render free-tier " +
      "spin-down) will log everyone out and break search/playback until they hit /login again. " +
      "Set REDIS_URL to fix this permanently."
  );
}

app.use(
  session({
    name: "aether.sid",
    secret: SESSION_SECRET,
    store: sessionStore, // undefined -> express-session's default MemoryStore
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — holds the Spotify refresh token
    },
  })
);

const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "streaming",
].join(" ");

/* ------------------------- PKCE helpers ------------------------- */
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function newVerifier() {
  return base64url(crypto.randomBytes(32));
}
function challengeFor(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

/* ------------------------- Auth routes ------------------------- */

// Kicks off login: redirect the browser to Spotify's consent screen.
app.get("/login", (req, res) => {
  const verifier = newVerifier();
  const state = base64url(crypto.randomBytes(16));
  req.session.pkceVerifier = verifier;
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challengeFor(verifier),
    state,
  });
  res.redirect(`${SPOTIFY_AUTH}?${params.toString()}`);
});

// Spotify redirects back here after the user approves/denies access.
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.oauthState) return res.redirect("/?auth_error=state_mismatch");
  if (!req.session.pkceVerifier) return res.redirect("/?auth_error=missing_verifier");

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: SPOTIFY_CLIENT_ID,
      code_verifier: req.session.pkceVerifier,
    });
    const tokenRes = await fetch(SPOTIFY_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenJson.error_description || "token exchange failed");

    req.session.spotify = {
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at: Date.now() + tokenJson.expires_in * 1000,
    };
    delete req.session.pkceVerifier;
    delete req.session.oauthState;
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.redirect("/?auth_error=exchange_failed");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Ensures req.session.spotify.access_token is valid, refreshing if needed.
// Refresh tokens minted via PKCE don't require a client secret either.
async function ensureFreshToken(req) {
  const s = req.session.spotify;
  if (!s) return null;
  if (Date.now() < s.expires_at - 30_000) return s.access_token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
    client_id: SPOTIFY_CLIENT_ID,
  });
  const r = await fetch(SPOTIFY_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    req.session.spotify = null;
    return null;
  }
  s.access_token = j.access_token;
  s.expires_at = Date.now() + j.expires_in * 1000;
  if (j.refresh_token) s.refresh_token = j.refresh_token; // Spotify sometimes rotates it
  return s.access_token;
}

function requireAuth(req, res, next) {
  if (!req.session.spotify) return res.status(401).json({ error: "not_authenticated" });
  next();
}

app.get("/api/session", async (req, res) => {
  const token = await ensureFreshToken(req);
  if (!token) return res.json({ loggedIn: false });
  try {
    const meRes = await fetch(`${SPOTIFY_API}/me`, { headers: { Authorization: `Bearer ${token}` } });
    const me = await meRes.json();
    res.json({ loggedIn: true, user: { id: me.id, name: me.display_name, image: me.images?.[0]?.url || null } });
  } catch {
    res.json({ loggedIn: false });
  }
});

// Hands the frontend a short-lived access token, ONLY for the Spotify Web
// Playback SDK's getOAuthToken callback. The SDK must run in-browser and
// needs the real token to open a streaming connection — this is exactly how
// open.spotify.com's own web player works. The refresh token never leaves
// this server, and this access token expires in under an hour.
app.get("/api/player-token", requireAuth, async (req, res) => {
  const token = await ensureFreshToken(req);
  if (!token) return res.status(401).json({ error: "not_authenticated" });
  res.json({ access_token: token });
});

/* ------------------------- Spotify API proxy ------------------------- */

async function spotify(req, res, method, urlPath, { query, body } = {}) {
  const token = await ensureFreshToken(req);
  if (!token) return res.status(401).json({ error: "not_authenticated" });

  const url = new URL(`${SPOTIFY_API}${urlPath}`);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (r.status === 204) return res.status(204).end();
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) {
    console.error(`Spotify API ${method} ${urlPath} -> ${r.status}:`, JSON.stringify(json).slice(0, 500));
  }
  res.status(r.status).json(json);
}

app.get("/api/search", requireAuth, (req, res) => {
  const { q, type = "track,artist,album,playlist", limit = 5, offset } = req.query;
  if (!q) return res.json({});
  // Spotify's Web API search endpoint caps `limit` at 10 (default 5) for
  // Development Mode apps as of their Feb 2026 changes — anything above 10
  // is rejected with a 400 "Invalid limit" error, which is what sent you
  // down this path. Clamp it here so a stray higher value never breaks search.
  const clampedLimit = Math.max(1, Math.min(10, parseInt(limit, 10) || 5));
  spotify(req, res, "GET", "/search", { query: { q, type, limit: clampedLimit, offset } });
});

app.get("/api/me/playlists", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/playlists", { query: { limit: 30 } });
});

app.get("/api/playlists/:id", requireAuth, (req, res) => {
  spotify(req, res, "GET", `/playlists/${req.params.id}`);
});

app.get("/api/me/tracks", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/tracks", { query: { limit: 50 } });
});

app.get("/api/me/top/artists", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/top/artists", { query: { limit: 10, time_range: "short_term" } });
});

app.get("/api/me/player/recently-played", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/player/recently-played", { query: { limit: 20 } });
});

app.get("/api/me/player", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/player");
});

app.get("/api/me/player/devices", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/player/devices");
});

app.get("/api/me/player/queue", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/player/queue");
});

app.get("/api/me/albums", requireAuth, (req, res) => {
  spotify(req, res, "GET", "/me/albums", { query: { limit: 30 } });
});

app.get("/api/me/tracks/contains", requireAuth, (req, res) => {
  // req.query.uris expected as comma-separated Spotify URIs (spotify:track:...)
  spotify(req, res, "GET", "/me/library/contains", { query: { uris: req.query.uris } });
});

app.put("/api/me/player/play", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/play", { query: { device_id: req.query.device_id }, body: req.body });
});
app.put("/api/me/player/pause", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/pause", { query: { device_id: req.query.device_id } });
});
app.post("/api/me/player/next", requireAuth, (req, res) => {
  spotify(req, res, "POST", "/me/player/next", { query: { device_id: req.query.device_id } });
});
app.post("/api/me/player/previous", requireAuth, (req, res) => {
  spotify(req, res, "POST", "/me/player/previous", { query: { device_id: req.query.device_id } });
});
app.put("/api/me/player/seek", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/seek", { query: { position_ms: req.query.position_ms, device_id: req.query.device_id } });
});
app.put("/api/me/player/volume", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/volume", { query: { volume_percent: req.query.volume_percent, device_id: req.query.device_id } });
});
app.put("/api/me/player/shuffle", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/shuffle", { query: { state: req.query.state, device_id: req.query.device_id } });
});
app.put("/api/me/player/repeat", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/player/repeat", { query: { state: req.query.state, device_id: req.query.device_id } });
});
app.put("/api/me/player", requireAuth, (req, res) => {
  // used to transfer playback to this browser's Web Playback SDK device
  spotify(req, res, "PUT", "/me/player", { body: req.body });
});
app.put("/api/me/tracks", requireAuth, (req, res) => {
  spotify(req, res, "PUT", "/me/library", { body: req.body }); // like — body: { uris: [...] }
});
app.delete("/api/me/tracks", requireAuth, (req, res) => {
  spotify(req, res, "DELETE", "/me/library", { body: req.body }); // unlike — body: { uris: [...] }
});

/* ------------------------- Musixmatch lyrics proxy ------------------------- */
// NOTE: track.subtitle.get (synced lyrics) requires a Musixmatch commercial
// license. Without one, this will typically return status_code 401/403 for
// the subtitle body even though matcher.track.get succeeds. Swap in your
// licensed provider's equivalent endpoints if you end up elsewhere.
app.get("/api/lyrics", requireAuth, async (req, res) => {
  const { artist, title } = req.query;
  if (!MUSIXMATCH_API_KEY) return res.status(501).json({ error: "lyrics_provider_not_configured" });
  if (!artist || !title) return res.status(400).json({ error: "artist_and_title_required" });

  try {
    const matchUrl = new URL("https://api.musixmatch.com/ws/1.1/matcher.subtitle.get");
    matchUrl.searchParams.set("q_track", title);
    matchUrl.searchParams.set("q_artist", artist);
    matchUrl.searchParams.set("subtitle_format", "lrc");
    matchUrl.searchParams.set("apikey", MUSIXMATCH_API_KEY);

    const r = await fetch(matchUrl);
    const j = await r.json();
    const header = j?.message?.header;
    if (!header || header.status_code !== 200) {
      return res.status(header?.status_code === 401 ? 402 : 404).json({
        error: "lyrics_unavailable",
        status_code: header?.status_code,
        hint:
          header?.status_code === 401
            ? "Musixmatch returned 401 for synced subtitles — this API key likely doesn't have a commercial/synced-lyrics license yet."
            : "No synced lyrics found for this track.",
      });
    }
    const lrc = j.message.body.subtitle.subtitle_body;
    res.json({ format: "lrc", lrc, lines: parseLRC(lrc) });
  } catch (e) {
    console.error("Lyrics proxy error:", e.message);
    res.status(502).json({ error: "lyrics_provider_error" });
  }
});

function parseLRC(lrc) {
  // Turns "[00:12.34]Some line" into [{ time: 12.34, text: "Some line" }, ...]
  const lines = [];
  for (const raw of lrc.split("\n")) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (!m) continue;
    const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    const text = m[3].trim();
    if (text) lines.push({ time, text });
  }
  return lines;
}

/* ------------------------- Static frontend ------------------------- */
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not_found" });
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Aether server listening on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`OAuth redirect configured as: ${SPOTIFY_REDIRECT_URI}`);
});
