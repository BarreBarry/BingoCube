# Cube Bingo — server

Turns the offline Cube Bingo game into a hosted, multiplayer one. A single Node
server **serves the game** and keeps **one shared game state in a database** that
every player reads (polls every 2s) and the host writes.

```
server/
  server.js          the backend: static files + /api + SQLite database
  package.json
  public/            the game client, wired to talk to /api (fetch, not localStorage)
    index.html
    styles.css
    app.js
  game.db            created on first run (the database file)
```

> The offline version (`../rubiks-cube.html` + `../styles.css` + `../app.js`) is
> unchanged and still works by double-clicking. This `server/public/app.js` is a
> copy whose only difference is the data layer — it fetches `/api/game` instead of
> reading `localStorage`.

## Run it locally

Requires **Node.js 18+** (https://nodejs.org).

```bash
cd server
npm install
npm start
```

Open **http://localhost:3000**. To test multiplayer, open it in two browser
windows: log in as host in one (top-right corner, click 5× fast, password
`bingo`) and change something — the other window updates within ~2 seconds.

**Set your own host password** (do this before letting anyone in):

```bash
# macOS/Linux
HOST_PASSWORD="your-secret" npm start
# Windows PowerShell
$env:HOST_PASSWORD="your-secret"; npm start
```

## How it works

- `GET  /api/game`  — public; returns the current shared game JSON. Every client polls this.
- `POST /api/login` — checks the host password so the client can unlock the host UI.
- `POST /api/game`  — host only (requires the `X-Host-Password` header); saves the whole game.

The whole game state is stored as one JSON row in a SQLite file (`game.db`).
Everything else is identical to the offline app.

## Deploying to the internet

This folder ships ready-made deploy configs (`Dockerfile`, `fly.toml`,
`render.yaml`). First move `server/` **out of OneDrive** (e.g. `C:\dev\cube-bingo`),
then push it to a Git repo.

**Fly.io — recommended** (free-ish, and includes a persistent disk the database needs):

```bash
# install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly launch --no-deploy                  # accept fly.toml; choose an app name
fly volumes create cube_data --size 1   # persistent disk for game.db
fly secrets set HOST_PASSWORD=your-strong-password
fly deploy
```

Live at `https://<app-name>.fly.dev`. (Edit `app` / `primary_region` in `fly.toml` first.)

**Docker — any container host or your own VPS:**

```bash
docker build -t cube-bingo .
docker run -p 3000:3000 -e HOST_PASSWORD=your-secret -v cube_data:/data cube-bingo
```

The `-v cube_data:/data` volume keeps the database across restarts.

**Render:** push to Git, then **New → Blueprint** (uses `render.yaml`); set
`HOST_PASSWORD` in the dashboard. The persistent disk needs a paid plan (on the
free plan the game resets on restart).

**Railway:** it auto-detects the `Dockerfile`; add a volume mounted at `/data`,
set `DB_FILE=/data/game.db` and `HOST_PASSWORD` in the variables.

Always serve over **HTTPS** (Fly/Render/Railway give it automatically) — the host
password is sent with each write and must be encrypted in transit.

### Auto-deploy on every push (GitHub Actions → Fly.io)

`.github/workflows/deploy.yml` redeploys to Fly.io automatically whenever you push
to `main`. One-time setup:

1. Deploy manually once (the `fly deploy` steps above) so the app already exists.
2. Create a deploy token:  `fly tokens create deploy -x 999999h`
3. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository
   secret**, name it `FLY_API_TOKEN`, and paste the token.
4. Push to `main` → watch the **Actions** tab; your site updates in ~1–2 minutes.

The workflow assumes `server/` is the repo root (so `.github/` and `fly.toml` are at
the top level). If your repo root is the whole `Bingo/` folder instead, add
`working-directory: server` to the `flyctl deploy` step.

### ⚠ Database persistence

`game.db` is a file. Keep it on a **persistent volume/disk** (the Fly / Docker /
Render configs above all do this) or the game resets whenever the server restarts.
The managed-Postgres swap below is the fully durable option.

## Options

### No-install fallback (JSON file instead of SQLite)

If `npm install` can't build `better-sqlite3` on your machine, you can drop the
native dependency entirely. Remove `better-sqlite3` from `package.json`
(`npm install express` only), then replace the "database" block in `server.js`
with a plain JSON file:

```js
const fs = require('fs');
function dbLoad() { try { return fs.readFileSync(DB_FILE, 'utf8'); } catch { return null; } }
function dbSave(json) { fs.writeFileSync(DB_FILE + '.tmp', json); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
```

(and set `DB_FILE` to e.g. `game.json`). Functionally identical for this app.

### Managed database (Postgres) for scale/durability

Swap the two `dbLoad()/dbSave()` functions for a single-row table in Postgres
(`npm i pg`, use `DATABASE_URL`). Nothing else in `server.js` or the client
changes — those two functions are the only database touch-points.

## Security notes (be honest about it)

- Writes are gated by a shared host password sent per request. Over HTTPS that's
  fine for a friendly team game, but it is **not** strong auth. For something more
  robust, issue a session token on `/api/login` and require it on `/api/game`.
- Players can read the full game state (all teams) from `/api/game` if they know
  the URL. The per-team link tokens hide *which* cube a player lands on, not the
  raw data. If you need players to only receive their own team's data, have the
  server filter `/api/game` by the `?t=` token.
