> **Inside the stream-avatar project?** The pipeline is built into the main image; see `../../ALL_IN_ONE.md` (the dashboard token there is `TTS_ADMIN_TOKEN`). This file describes running the pipeline as its own standalone Railway service.

# Deploy on Railway, with a token-protected admin page

One service, two faces:

| URL | Who | Protected by |
|---|---|---|
| `https://<svc>.up.railway.app/tts`, `/speakers`, `/ref/*`, `/metrics` | your Node stream server | `VOICETUT_TOKEN` |
| `https://<svc>.up.railway.app/admin` (dashboard), `/admin/docs`, `/admin/api/*` | you / your scripts | `ADMIN_TOKEN` (a different secret) |

`/health` and `/ready` are open so Railway's health check works. Neither token opens the other area.

## 1. Deploy
1. Railway > New Project > Deploy from GitHub repo (this folder) or `railway up`. `railway.toml` selects `Dockerfile.cpu`.
2. Service > **Volumes** > add one mounted at `/data` (model weights, audio cache, dashboard settings, phrase list survive redeploys).
3. Service > **Variables** > add the ones below. Railway redeploys on every change.
4. Service > Settings > Networking > **Generate Domain** (HTTPS is terminated by Railway; always use the `https://` URL).
5. RAM: start at 8 GB; watch the dashboard Overview tab.

## 2. Variables (the only place any secret lives)
| Variable | Example | Effect |
|---|---|---|
| `ADMIN_TOKEN` | `openssl rand -hex 32` | Turns on `/admin`. Unset = admin answers 503 "disabled". |
| `VOICETUT_TOKEN` | another random string | Protects `/tts`. Put the same value in your Node server. |
| `STREAM_URL`, `STREAM_ADMIN_TOKEN` | `https://stream.example.com`, its admin token | Enables the **Stream (view/publish)** tab: change live voice, pause/resume speech, self-test, state. |
| `VOICETUT_NUM_STEP`, `TORCH_THREADS`, `ENGINES`, ... | see `.env.example` | Starting values; the dashboard Settings tab overrides them live (saved to `/data/settings.json`). |

**Token rules.** Any length (1 to thousands of characters), any symbols. Leading/trailing spaces, a trailing newline and one pair of surrounding quotes are ignored, so a sloppy paste still works. Comparison is constant-time on SHA-256 digests, so length and prefix leak nothing.

**Changing a token = changing the Railway variable. No code change, no rebuild.** Rotating `ADMIN_TOKEN` also signs out every dashboard session (cookies are signed with a key derived from it). Rotating `VOICETUT_TOKEN`: update the Node server's `VOICETUT_TOKEN` too.

## 3. Using the dashboard
Open `https://<svc>.up.railway.app/admin`, paste `ADMIN_TOKEN`. Session = HttpOnly + SameSite=Strict + Secure cookie, 12 h (`ADMIN_SESSION_HOURS`). 5 wrong tries per IP per 5 minutes (form or API) locks that IP out for the window.

Tabs: Overview, Engines, Settings, Test, Cache, Activity, Stream (view/publish), Voices, API.

## 4. Running everything through the API
Every dashboard action is an HTTP call. Auth: `Authorization: Bearer $ADMIN_TOKEN`.
```bash
export URL=https://<svc>.up.railway.app ADMIN_TOKEN=...
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/api/status                       # health, model, RTF, cache, system
curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"NUM_STEP": 8, "SPEED": 1.05}' $URL/admin/api/settings                        # tune live
curl -X PUT   -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"order":["edge","voicetut","espeak"]}' $URL/admin/api/engines/order            # re-prioritise engines
curl -X POST  -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/api/engines/voicetut/reload   # reload the model
curl -X POST  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"ازيك يا باشا"}' $URL/admin/api/test -o test.wav                        # speak through the real pipeline
curl -X POST  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"vt":"Asmaa"}' $URL/admin/api/stream/voice                                      # change the LIVE stream voice
```
Documentation that cannot go stale: `GET /admin/docs` (HTML) and `GET /admin/api/openapi.json` (import into Postman / Swagger) are generated from the same registry that mounts the routes; a test fails if they differ.

**Add a new admin endpoint:** in `egy_tts/admin.py` write `@api("POST", "/thing", "what it does", body={...}, tag="Group")` above an async handler. It is routed, authenticated, documented and listed in OpenAPI automatically.

## 5. Checklist after deploy
1. `GET /health` returns `{"ok": true}` (first boot downloads the weights; up to a few minutes).
2. `/admin` > paste token > Overview shows model loaded and a device.
3. Test tab: speak a line; look at RTF. If RTF > 1, lower `NUM_STEP` in Settings (live).
4. Stream tab: shows the Node server state (needs `STREAM_URL` + `STREAM_ADMIN_TOKEN`).
5. Node server: `VOICETUT_URL=https://<svc>.up.railway.app`, `VOICETUT_TOKEN=<same>`.
