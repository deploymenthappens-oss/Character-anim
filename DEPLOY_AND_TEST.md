# Deploying (Railway) and testing locally first

This zip already has the tuned gaze/hair changes baked into `web/avatar-orchestra.js`
(tremor, saccade threshold, hold interval, head-join threshold). Nothing else was changed
from the project as uploaded.

## 1. Local pre-production test — mirrors Railway exactly

Railway builds and runs the root `Dockerfile` as a single container: the `chat/` Node
server (`chat/server.js`) serves the API/SSE endpoints AND the static `web/` files
(`STATIC_ROOT=/web`), on one port, no MediaMTX, no nginx. Running that same Dockerfile
locally is the closest thing to a real pre-production test — same container, same code
path, just on your machine.

```powershell
cd D:\Character-Anim\stream-avatar-v1.2-stg\stream-avatar   # wherever you unzip this
copy .env.example .env
# open .env, set ADMIN_TOKEN to anything (required for any public-facing deploy,
# harmless for local testing) - everything else has working defaults.

docker build -t stream-avatar .
docker run --rm -p 3000:3000 --env-file .env stream-avatar
```

Then open:
- `http://localhost:3000/publish.html` — the control page (mic/cam optional, chat panel, moderation)
- `http://localhost:3000/view.html` — what a viewer sees; this is the page that shows the
  idle gaze/hair behavior with no camera needed

Stop with Ctrl+C. Re-run `docker build` after any further code change.

**Faster iteration loop (animation only, no Docker):** if you're just eyeballing the
gaze/hair numbers again and don't need the chat backend, you can skip Docker entirely —
serve `web/` as static files instead:

```powershell
cd web
npx serve -l 5500 .
```
then open `http://localhost:5500/view.html`. (`python -m http.server 5500` works too if
you don't have Node.) This won't run comments/replies/TTS — only use it for pure motion
checks.

## 2. Deploying to Railway (production)

`Dockerfile` and `railway.json` are already set up for this — nothing to configure beyond
environment variables.

1. Push this project to a GitHub repo (or use `railway up` directly from this folder if you
   have the Railway CLI installed).
2. In Railway: **New Project → Deploy from GitHub repo** (or point the CLI at this folder).
   Railway auto-detects `railway.json` and builds the root `Dockerfile`.
3. In the Railway service's **Variables** tab, set at minimum:
   - `ADMIN_TOKEN` — required before any public deploy; protects the publisher/admin endpoints.
   - Optionally `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for faster/better
     replies — without any key, `FREE_LLM=on` (default) uses free keyless gateways, then
     falls back to built-in rules.
   - Anything else from `.env.example` you want to override (voice, script, dialect, etc.)
     — every value has a working default.
4. Deploy. Railway gives you a URL like `https://<your-app>.up.railway.app`.
5. Open `https://<your-app>.up.railway.app/publish.html` to run the show, share
   `.../view.html` with viewers.
6. Future updates: push to the connected branch (or `railway up` again) — Railway rebuilds
   the same Dockerfile automatically.

**What this mode does *not* include:** a real camera feed composited server-side via
MediaMTX/WHIP (that's the separate `docker-compose.yml` stack, for a UDP-capable host like
your own VM — see the main `README.md`'s "Railway deploy" section for how the two modes
differ). The Railway path above is the pure-virtual-character mode: `view.html` renders the
avatar locally per viewer, no UDP ingress needed, which is why Railway (HTTPS-only) can host
it directly.

## What changed in this build
Only `web/avatar-orchestra.js` — the gaze/hair tuning discussed in this conversation:
tremor amplitude, saccade snap threshold, idle hold interval, and the head-join threshold
(so ordinary gaze shifts now visibly move the head, and hair follows via the existing spring).
No other file was touched.
