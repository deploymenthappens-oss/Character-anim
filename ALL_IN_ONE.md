# One Railway service: stream + chat + Egyptian TTS + TTS admin dashboard

```
Internet ──HTTPS──> Railway ──> $PORT  chat/server.js (Node)   web/ (publish.html, view.html), /events, /chat, /audio ...
                                  │  /admin  /admin/docs  /admin/api/*  ──proxy──┐   (only these paths; own token)
                                  │  VOICETUT_URL=http://127.0.0.1:8000  <───────┤
                                  └──────────────────────────────────────────────┴─> 127.0.0.1:8000  tts/ (Python, Egyptian TTS pipeline)
                                                                                      VoiceTut -> Edge ar-EG -> espeak-ng, cache, dashboard
```
`/tts`, `/ref`, `/speakers`, `/metrics` of the Python service are **not** reachable from the internet; only the chat server talks to them (404 from outside).

## Deploy
Same as before: push this folder, Railway builds the root `Dockerfile` (`railway.toml`). Then:
1. **No Volume needed.** Without one, the dashboard's live settings, phrase list and clone references live in `/tmp` and reset on every redeploy, so put the values you care about in Railway Variables (they are the durable defaults). The **audio cache** is in memory (and `/tmp`) until you add a database; see "Cache in a database" below. (A Volume at `/data` plus `RAILWAY_RUN_UID=0` is still supported if you ever want settings to persist as files.)
2. Service > **Variables** (all secrets live here; any length; spaces/newlines/quotes around a value are ignored; change one = redeploy, no code change):

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | the publisher password for `/publish.html` (unchanged; the value in `chat/config.js` is only a fallback, see note below) |
| `TTS_ADMIN_TOKEN` | **new, separate secret** for `/admin` and `/admin/api/*`. Not set = dashboard disabled. `openssl rand -hex 32` |
| `CACHE_DATABASE_URL` / `DATABASE_URL` | optional, later: Postgres for the audio cache (see below) |
| `TTS_BACKEND` | `egy` (default) · `cairo` (needs build var `WITH_CAIRO=1`) · `none` |
| `VOICETUT_NUM_STEP`, `TORCH_THREADS`, `ENGINES`, ... | start values for the TTS pipeline; the dashboard overrides them live |
| `STREAM_URL`, `STREAM_ADMIN_TOKEN` | optional. Default: this same container and its publisher `ADMIN_TOKEN`, wired automatically for the dashboard's **Stream (view/publish)** tab |

3. Open `https://<app>.up.railway.app/admin`, paste `TTS_ADMIN_TOKEN`. Scripts: `Authorization: Bearer $TTS_ADMIN_TOKEN` on `/admin/api/*`; docs at `/admin/docs`, OpenAPI at `/admin/api/openapi.json`.

The two secrets are independent: the publisher password does not open the dashboard and the dashboard token does not open `/publish.html`.

## Cache in a database (add it whenever you like: variables only, no code change)
The cache stores one row per spoken sentence (`egy_tts_cache`: key, sample rate, PCM bytes, size, time). Add a Postgres service in Railway, then on this service set
`CACHE_DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (or just `DATABASE_URL`; the specific name wins). The table is created on first use, `CACHE_DB_MB` (default 512) caps its size and the oldest rows go first, `CACHE_DB=off` ignores the URL. `sqlite:///path/file.db` also works (tests / local).
The cache is only a speed-up: if the database is down or slow the voice keeps working (a miss just means generating the line), the dashboard **Cache** tab shows the error, and the service retries after 30 s. Dashboard: Cache tab shows the store type, row count and size; "Clear cache" empties the table.

## Image size, memory and first start (what keeps the deploy from failing)
| Setting | Default | Meaning |
|---|---|---|
| `WITH_CAIRO` (build variable) | `0` | `1` also installs the old Cairo-TTS backend: a **second PyTorch (~1 GB more)**. Leave at 0 unless your plan allows a big image. |
| `BAKE_MODEL` (build variable) | `0` | `1` puts the VoiceTut weights inside the image (faster first start, much bigger image). `0` = downloaded on first start into the container (the first boot is slow; every redeploy repeats it unless you later mount a Volume at `/data` and set `HF_HOME=/data/hf`). |
| `WITH_EGY` (build variable) | `1` | `0` drops the Egyptian pipeline (Node + Edge voices only). |
| `TTS_BACKEND` (runtime) | `egy` | `egy` \| `cairo` (needs the image built with `WITH_CAIRO=1`) \| `none`. Only one runs. |
| `EGY_MIN_MEM_MB` (runtime) | `3500` | **Memory guard.** If the container's memory limit is below this, VoiceTut is NOT loaded (it would be OOM-killed) and the pipeline runs on Edge ar-EG + espeak, with a log line saying so. Set `EGY_FORCE_VOICETUT=1` to load it anyway, or set `ENGINES` yourself (an explicit value always wins). |
| healthcheck | 300 s | `railway.toml`. Node answers `/health` immediately; the voice model loads in the background (low CPU priority) and never blocks it. |

The build also prints the installed `torch`/`nvidia` packages and the venv size, so if an image is ever unexpectedly large, the build log shows why (a CUDA build of torch would list `nvidia-*` packages).

## Two backends, one runs
`TTS_BACKEND` chooses at **runtime** which one starts (only one, to save RAM). If the chosen one is not in the image, `start.sh` falls back to the other and logs it. To use Cairo: set the build variable `WITH_CAIRO=1`, redeploy, then `TTS_BACKEND=cairo`.

**"My voice" (clone from `chat/voice/my-voice.wav`)**: the pipeline stores the recording sent by the chat server and clones with VoiceTut. `my-voice.txt` (the transcript of the recording) is optional but gives the best clone; without it the model is asked to transcribe the recording itself. If the clone does not sound like Cairo's, set `TTS_BACKEND=cairo`.

## Verified here vs not
Verified with a fake voice engine, the real `start.sh`, and the real Node server on one port: dashboard page/login/docs/API through the proxy, a 300+ character token, publisher password rejected by the dashboard, the Stream tab reaching Node with the auto-resolved token, a test WAV through the proxy, internal routes 404 from outside, 502 message when the TTS process is down, "disabled" when `TTS_ADMIN_TOKEN` is unset, Node's `/voices/test` reaching the pipeline, 42 Python tests (incl. the database cache on SQLite; the Postgres driver path is not exercised here). **Not verified:** the Docker build itself (no daemon here), the real VoiceTut model (cannot reach Hugging Face from the sandbox), RAM/CPU on Railway.

## Note on `chat/config.js`
It still contains a literal `ADMIN_TOKEN` fallback (the publisher password) that ships in the repo and image. The `ADMIN_TOKEN` Railway variable already overrides it; set that variable and, if the repo is ever not private, replace the literal with an empty string.
