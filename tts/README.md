# Egyptian TTS pipeline (VoiceTut, CPU-ready)

A standalone service that turns chat text into Egyptian-Arabic speech with **VoiceTut-TTS** (the Hugging Face model your project
README points to), built to run the same way in **Colab** (test) and on **Railway CPU** (deploy). It is a drop-in for
`voicetut/app.py` as far as `chat/voicetut.js` is concerned: same routes, same headers. Just change `VOICETUT_URL`.

```
text -> prep (numbers, clock, %, Latin handling) -> sentence chunks -> cache? -> engine chain -> trim -> join -> WAV
                                                                          voicetut -> edge (ar-EG) -> espeak-ng
```

## What makes it safe on CPU
| Problem on CPU | What the pipeline does |
|---|---|
| Model is slow (RTF can be > 1) | `num_step` defaults to 12 on CPU (32 on GPU); `tools/bench.py` finds the right value on your machine |
| Same lines repeat (greetings, acks, names) | per-sentence audio cache (memory + disk), `phrases.txt` is pre-rendered while idle |
| Chat bursts | one worker for the model, queue limit `TTS_MAX_QUEUE`; overflow goes straight to the fallback voice |
| A slow or crashed model | per-request deadline, circuit breaker (`TTS_COOLDOWN_S`), the late result still lands in the cache |
| Cold start / sleepy weights | load + real warm-up generation at boot, `/health` stays not-ok until then (your Node client already waits), keep-alive generation when idle |
| Nothing available | espeak-ng always answers; only if *every* engine fails does `/tts` return 503 (Node then falls back to its own Edge) |

## Files
```
egy_tts/prep.py        Python port of chat/egy.js (tables extracted from the JS, not retyped)
egy_tts/engines.py     voicetut | edge | espeak | fake
egy_tts/pipeline.py    chunking, cache, timeouts, breaker, backpressure, metrics
egy_tts/server.py      HTTP API (Starlette)      egy_tts/admin.py + admin_ui.html  dashboard and admin API      egy_tts/phrases.txt  lines to pre-render
tools/bench.py         real-model RTF sweep      tools/extract_tables.js, js_oracle.js  parity tooling
tests/                 python -m unittest discover -s tests -t .
notebooks/egy_tts_colab.ipynb     Dockerfile.cpu + railway.toml
```

## Run
**Colab:** upload `egy-tts-pipeline.zip` to `/content`, open `notebooks/egy_tts_colab.ipynb`, run top to bottom (CPU runtime = what Railway will do).
**Local:** `pip install -r requirements.txt` (+ model: `pip install git+https://github.com/k2-fsa/OmniVoice.git -r requirements-model.txt`), then `uvicorn egy_tts.server:app --port 8000`.
Without the model, `ENGINES=fake` or `ENGINES=edge,espeak` still runs the whole stack.
**Railway:** new service from this folder (it picks up `railway.toml` / `Dockerfile.cpu`), add a **Volume at `/data`** (weights + audio cache survive redeploys), then variables:
`VOICETUT_TOKEN=<secret>`, `VOICETUT_NUM_STEP=<from bench>`, `TORCH_THREADS=<vCPUs>`. Give it enough RAM (a 0.6B model needs a few GB; start with 8 GB and look at usage).
**Stream server:** `VOICETUT_URL=https://<service>.up.railway.app` and the same `VOICETUT_TOKEN`.

## Admin dashboard (`/admin`) and admin API (`/admin/api/*`)
A separate page on the same service, protected by its **own** secret, for everything about the model and the talking service.
- **Tokens are only environment variables.** Nothing is hard-coded: `ADMIN_TOKEN`, `VOICETUT_TOKEN`, `STREAM_ADMIN_TOKEN`, `STREAM_URL` are read from the environment each time they are used, can be **any length** (1 to thousands of characters, any symbols), and surrounding spaces / newlines / one pair of quotes are ignored. Rotate one in Railway Variables, let it redeploy, done: no code change. Full guide: [`docs/RAILWAY_DEPLOY.md`](docs/RAILWAY_DEPLOY.md), template: `.env.example`.
- **Turn on:** set `ADMIN_TOKEN` on Railway (`openssl rand -hex 32`). Not set = the admin API answers 503 and the page says it is disabled. It is a different secret from `VOICETUT_TOKEN`, and neither opens the other.
- **Sign in:** open `https://<service>/admin`, paste the token. The server returns an HttpOnly, SameSite=Strict, HMAC-signed session cookie (12 h, `ADMIN_SESSION_HOURS`); the token is not kept in the page or the cookie. Changing `ADMIN_TOKEN` signs everyone out. 5 wrong tries per IP in 5 minutes (form **or** Bearer header) locks that IP for the rest of the window. Transport encryption is the HTTPS Railway provides: always use the https URL.
- **Tabs:** Overview (health, model state, RTF, cache hit rate, RAM/CPU/disk) · Engines (reorder, enable/disable, reset breaker, reload model) · Settings (every tunable live, saved across restarts) · Test (speak a line, see the prepared text) · Cache (stats, clear, pre-render list editor) · Activity (recent requests, failures, logins) · **Stream (view/publish)** · Voices (speakers, clone references) · API.
- **Stream tab:** set `STREAM_URL` and `STREAM_ADMIN_TOKEN` (your Node server's address and its `ADMIN_TOKEN`). From there you change the live VoiceTut speaker, pause/resume speech, run its self-test and read its state. Only a fixed allow-list of its routes is reachable.
- **Scripts / other tools:** every dashboard action is a call you can make with `Authorization: Bearer $ADMIN_TOKEN`. `/admin/docs` and `/admin/api/openapi.json` are generated from the same registry that mounts the routes, so they cannot drift (a test enforces it). To add an endpoint: write the handler with `@api(...)` in `egy_tts/admin.py` and it appears in the docs.
- **Persist across redeploys:** `SETTINGS_FILE=/data/settings.json`, `PHRASES_FILE=/data/phrases.txt` (the Volume).

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/api/status
curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"NUM_STEP": 8}' $URL/admin/api/settings
curl -X POST  -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/api/engines/voicetut/reload
```

## Voice service API (used by your Node server)
`POST /tts {text, speaker?, speed?, num_step?, guidance_scale?, ref_id?, cache?, prepare?}` returns 16-bit mono WAV with `X-Duration-Ms`,
`X-Sample-Rate`, `X-Trim-Lead-Ms` (always 0: silence is already trimmed), `X-Engine`, `X-Cache-Hits`, `X-Chunks`, `X-Took-Ms`.
`GET /health` · `GET /ready` · `GET /speakers` · `PUT /ref/{id}` (voice-clone reference, needs the speaker's consent) · `POST /prep` (see the exact string the engine gets) · `GET /metrics` (RTF, cache hit rate, per-engine ok/fail/timeout: your unit-economics numbers).

## Verified here vs not
- Verified (offline, 31 tests, plus a headless-Chromium run of the dashboard: login, every tab, a test line, sign-out): Python prep gives byte-identical output to `egy.js` on 419 inputs (fixed cases plus seeded fuzz, 5 functions each); chunking; cache; timeout, breaker, queue overflow and late-result caching; HTTP contract and auth, admin login/cookie/CSRF/lockout, settings persistence, engine controls, stream-server proxy, docs-match-routes, using a fake engine. The dashboard has not been seen against the real model or a real stream server.
- **Not verified:** the real VoiceTut model, `edge-tts` and `espeak-ng`. The build sandbox cannot reach Hugging Face or PyPI. VoiceTut is called only through the API in its model card (`from_pretrained`, `synthesize`, `list_speakers`); the `device=` argument to `from_pretrained` is best-effort and falls back to the plain call. Run notebook steps 4 and 6 first: they print the device, RTF and audio.
- Not done: streaming audio while it is still generating (the browser path expects a whole WAV), and Egyptianizing LLM output inside the service (`prep.egyptianize` exists and `/prep` shows it; your Node server already does this step).

## Audio cache in a database
Set `CACHE_DATABASE_URL` (or `DATABASE_URL`) to `postgres://...` (Railway Postgres) or `sqlite:///file.db` and the cache moves from files to the table `egy_tts_cache` (`CACHE_DB_MB` cap, oldest first; `CACHE_DB=off` ignores the URL). It is a pure cache: if the database fails the service keeps speaking and retries after 30 s. Not verified here against a real Postgres server (SQLite is tested).
