# Aether — real Spotify integration

This turns the earlier mock UI into a working app backed by:

- **Real Spotify accounts** via OAuth Authorization Code + PKCE (no client secret ever exists — nothing secret-shaped to leak, even server-side)
- **Real Spotify data**: search, playlists, saved albums/tracks, recently played, top artists
- **Real playback** in the browser via the Spotify Web Playback SDK (requires the listener to have **Spotify Premium** — that's a Spotify platform restriction, not something this code can route around)
- **Synced lyrics** via LRCLIB, a free community lyrics database, proxied server-side (no API key needed)

Architecture, in one line: browser (frontend) → your Node server (holds all tokens) → Spotify / LRCLIB. The frontend never talks to Spotify or LRCLIB directly.

## 1. Register a Spotify app

1. Go to https://developer.spotify.com/dashboard → **Create app**.
2. Note the **Client ID** shown (you don't need the Client Secret for this setup — PKCE doesn't use one).
3. Under **Redirect URIs**, add exactly: `https://yourdomain.com/callback` (must match `SPOTIFY_REDIRECT_URI` byte-for-byte). For local testing before you have a domain, Spotify requires a loopback IP rather than `localhost` — use `http://127.0.0.1:8888/callback`.
4. Under **APIs used**, make sure **Web Playback SDK** and **Web API** are enabled.
5. **Important limitation:** new Spotify apps start in *Development Mode*, which only allows up to 25 explicitly-added users (added by email in the dashboard's "User Management" tab) to log in. To let the general public log in, you need to request **Extended Quota Mode** from Spotify — that's a review process on their end, not something this code affects.

## 2. Lyrics: nothing to set up

Synced lyrics come from [LRCLIB](https://lrclib.net), a free, community-run lyrics database — no signup, no API key. The server proxies `matcher.subtitle.get`-style lookups to LRCLIB's `/get` and `/search` endpoints and parses standard `.lrc` timestamps, same as before, so swapping in a different provider later just means changing the one `/api/lyrics` handler in `server/server.js`. Coverage is community-sourced, so some tracks won't have lyrics — the UI shows an honest "no lyrics found" message in that case.

## 3. Configure environment

```bash
cd server
cp .env.example .env
# edit .env: SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SESSION_SECRET, PUBLIC_URL
```

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Run it

**Locally, for testing:**
```bash
cd server
npm install
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback NODE_ENV=development npm start
```
Visit `http://127.0.0.1:8888`. (The Web Playback SDK requires either HTTPS or `127.0.0.1` — plain `localhost`/HTTP over LAN won't work.)

**On your VPS, for real:**

```bash
# on the server
git clone <your repo> /var/www/aether-spotify
cd /var/www/aether-spotify/server
npm install --omit=dev
cp .env.example .env   # fill in production values, NODE_ENV=production
```

1. Point your domain's DNS A record at the VPS.
2. Install nginx + certbot, use `deploy/nginx.conf.example` as your site config, then run `sudo certbot --nginx -d yourdomain.com` to get HTTPS (required in production — cookies are set `secure`, and the Web Playback SDK requires HTTPS off-localhost).
3. Install the systemd unit from `deploy/aether.service.example` so the server survives reboots/crashes:
   ```bash
   sudo cp deploy/aether.service.example /etc/systemd/system/aether.service
   # edit User= and WorkingDirectory= to match your setup
   sudo systemctl daemon-reload
   sudo systemctl enable --now aether
   ```
4. Confirm `SPOTIFY_REDIRECT_URI` in `.env` matches `https://yourdomain.com/callback` and that the same URI is registered in the Spotify Dashboard.

## 5. Deploying on Render (or similar)

Render's free web services restart/sleep when idle, and this app's session store is in-memory by default — so without doing anything else, everyone gets logged out (and search/playback start failing with a generic error) every time that happens. Fix it once:

1. Add a Redis instance — Render's own "Key Value" add-on (Dashboard → New → Key Value) or a free database at https://upstash.com both work.
2. Copy its connection URL into this service's environment variables as `REDIS_URL`.
3. Redeploy. You'll see `Connected to Redis — sessions will survive restarts.` in the logs on boot; if you instead see the `REDIS_URL not set` warning, the env var didn't take.

Also double check `SPOTIFY_REDIRECT_URI` is set to your exact Render URL (`https://your-app.onrender.com/callback`) and that the **identical** string is registered as a Redirect URI in the Spotify Dashboard — a mismatch here is the other common cause of logins silently failing.

## Notes on what's real vs. what still needs a decision

- **Sessions** are stored in-memory in the Node process (fine for a single VPS process; if you ever run multiple instances behind a load balancer, swap in a shared store like Redis via `connect-redis` — the session middleware is already isolated in one spot in `server.js` to make that swap easy).
- **"Downloads"** (offline playback) isn't exposed by Spotify's Web API at all — that's only available inside Spotify's own first-party apps, so that tab is left as an honest empty state rather than faked.
- **Lyric translation toggle** is wired in the UI but not connected to a translation service — hook up whatever provider you prefer in the `translateBtn` handler and the `/api/lyrics` response.
- **Free (non-Premium) Spotify accounts** can log in, search, and browse, but the Web Playback SDK will throw an `account_error` and no audio will play — this is a hard Spotify platform restriction. The UI surfaces a note when this happens rather than failing silently.
